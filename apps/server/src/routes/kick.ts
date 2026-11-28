import type { KickedMemberResponse } from '@raisechat/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authOf } from '../auth/guards';
import { requireOwner, workspaceOf } from '../auth/workspace-guards';
import type { Db } from '../db/client';
import {
  channelMembers,
  channels,
  memberships,
  messages,
  threadMembers,
  users,
} from '../db/schema';
import { AppError } from '../errors';
import { avatarUrlFor } from '../profile/avatar';
import { chRoom, userRoom, wsRoom, type Realtime } from '../realtime/realtime';

export interface KickRouteDeps {
  db: Db;
  realtime: Realtime;
}

const userIdSchema = z.uuid();
const notFound = () => new AppError(404, 'not_found', '見つかりません。');

/**
 * キックとキックの解除(FR-302、304。設計書 §2.1、§4、§6.3)。いずれも、そのワークスペースのオーナーだけ。
 */
export function registerKickRoutes(app: FastifyInstance, deps: KickRouteDeps): void {
  const { db, realtime } = deps;

  // FR-302: キック。1 つのトランザクションで、Membership を kicked にし、そのワークスペースの
  // ChannelMember(DM を含む)と ThreadMember を、対象の分だけ削除する。メッセージは残す。セッションは、削除しない
  app.post<{ Params: { ws: string; userId: string } }>(
    '/api/workspaces/:ws/members/:userId/kick',
    { preHandler: requireOwner(db) },
    async (request, reply) => {
      const parsed = userIdSchema.safeParse(request.params.userId);
      if (!parsed.success) throw notFound();
      const targetId = parsed.data;
      const workspaceId = workspaceOf(request).workspaceId;
      // オーナー(自分自身)は、キックできない(オーナーは、ワークスペースに 1 人。設計書 §2.1)
      if (targetId === authOf(request).user.id) {
        throw new AppError(400, 'cannot_kick_owner', 'オーナーは、キックできません。');
      }

      const channelIds = await db.transaction(async (tx) => {
        // 所属の行をロックして、状態を確かめる(同時の参加・受諾との順序を決める)
        const [target] = await tx
          .select({ role: memberships.role, status: memberships.status })
          .from(memberships)
          .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, targetId)))
          .for('update');
        if (!target || target.status !== 'active') throw notFound();
        if (target.role === 'owner') {
          throw new AppError(400, 'cannot_kick_owner', 'オーナーは、キックできません。');
        }

        await tx
          .update(memberships)
          .set({ status: 'kicked' })
          .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, targetId)));

        const workspaceChannels = tx
          .select({ id: channels.id })
          .from(channels)
          .where(eq(channels.workspaceId, workspaceId));
        const removed = await tx
          .delete(channelMembers)
          .where(
            and(
              eq(channelMembers.userId, targetId),
              sql`${channelMembers.channelId} IN (${workspaceChannels})`,
            ),
          )
          .returning({ channelId: channelMembers.channelId });

        // このワークスペースのスレッド(親が、このワークスペースのチャンネルにあるもの)の参加を、外す
        const roots = tx
          .select({ id: messages.id })
          .from(messages)
          .innerJoin(channels, eq(channels.id, messages.channelId))
          .where(eq(channels.workspaceId, workspaceId));
        await tx
          .delete(threadMembers)
          .where(
            and(
              eq(threadMembers.userId, targetId),
              sql`${threadMembers.rootMessageId} IN (${roots})`,
            ),
          );
        return removed.map((r) => r.channelId);
      });

      // コミットの後に、対象の全ソケットを、そのワークスペースのルームから外し(先に更新)、通知する(§6.3)。
      // ほかのワークスペースのルームと、接続は、維持する
      realtime.leaveUser(targetId, [wsRoom(workspaceId), ...channelIds.map(chRoom)]);
      realtime.emit(userRoom(targetId), 'workspace:removed', { workspaceId });
      realtime.emit(wsRoom(workspaceId), 'member:removed', { workspaceId, userId: targetId });
      for (const channelId of channelIds) {
        realtime.emit(chRoom(channelId), 'channel:member-left', { channelId, userId: targetId });
      }
      return reply.status(204).send();
    },
  );

  // FR-304: キック済みの一覧
  app.get<{ Params: { ws: string } }>(
    '/api/workspaces/:ws/kicked',
    { preHandler: requireOwner(db) },
    async (request): Promise<KickedMemberResponse[]> => {
      const rows = await db
        .select({
          id: users.id,
          username: users.username,
          displayName: users.displayName,
          avatarKey: users.avatarKey,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(
            eq(memberships.workspaceId, workspaceOf(request).workspaceId),
            eq(memberships.status, 'kicked'),
          ),
        )
        .orderBy(asc(memberships.joinedAt), asc(users.id));
      return rows.map((r) => ({
        id: r.id,
        username: r.username,
        displayName: r.displayName,
        avatarUrl: avatarUrlFor(r.id, r.avatarKey),
      }));
    },
  );

  // FR-304: キックの解除。kicked の行を削除する。解除しただけでは、参加しない(新しい招待リンクで、再参加する)。
  // ルームの更新と通知は、なし(§6.3)
  app.delete<{ Params: { ws: string; userId: string } }>(
    '/api/workspaces/:ws/kicked/:userId',
    { preHandler: requireOwner(db) },
    async (request, reply) => {
      const parsed = userIdSchema.safeParse(request.params.userId);
      if (!parsed.success) throw notFound();
      const removed = await db
        .delete(memberships)
        .where(
          and(
            eq(memberships.workspaceId, workspaceOf(request).workspaceId),
            eq(memberships.userId, parsed.data),
            eq(memberships.status, 'kicked'),
          ),
        )
        .returning({ userId: memberships.userId });
      if (removed.length === 0) throw notFound();
      return reply.status(204).send();
    },
  );
}
