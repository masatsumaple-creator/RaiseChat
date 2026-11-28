import {
  addChannelMemberSchema,
  createChannelSchema,
  type AdminChannelResponse,
  type ChannelMemberResponse,
  type ChannelResponse,
} from '@raisechat/shared';
import { and, asc, desc, eq, ilike, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { channelOf, requireChannel } from '../auth/channel-guards';
import { authOf, requireUser } from '../auth/guards';
import { requireMember, requireOwner, workspaceOf } from '../auth/workspace-guards';
import type { Db } from '../db/client';
import { isUniqueViolation } from '../db/errors';
import { channelMembers, channels, memberships, users } from '../db/schema';
import { AppError, parseWith } from '../errors';
import { avatarUrlFor } from '../profile/avatar';
import { chRoom, userRoom, wsRoom, type Realtime } from '../realtime/realtime';

export interface ChannelRouteDeps {
  db: Db;
  realtime: Realtime;
}

const notFound = () => new AppError(404, 'not_found', '見つかりません。');
const channelIdSchema = z.uuid();

type ChannelRow = typeof channels.$inferSelect;

function toChannelResponse(row: ChannelRow): ChannelResponse {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    type: row.type as ChannelResponse['type'],
    name: row.name,
    isDefault: row.isDefault,
    createdBy: row.createdBy,
  };
}

/** LIKE の特殊文字(% _ \)を、文字そのものとして扱うためにエスケープする */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** 参加した人の情報(channel:member-joined のペイロード) */
async function loadChannelMember(db: Db, userId: string): Promise<ChannelMemberResponse> {
  const [u] = await db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      statusText: users.statusText,
      avatarKey: users.avatarKey,
    })
    .from(users)
    .where(eq(users.id, userId));
  return {
    id: u!.id,
    username: u!.username,
    displayName: u!.displayName,
    statusText: u!.statusText,
    avatarUrl: avatarUrlFor(u!.id, u!.avatarKey),
  };
}

const listQuerySchema = z.object({
  // joinable=1: 未参加のパブリックチャンネルの一覧(FR-203)
  joinable: z.enum(['1', 'true']).optional(),
});

const membersQuerySchema = z.object({
  // メンション候補などの絞り込み。ユーザー名・表示名の前方一致(大文字小文字を区別しない)
  q: z.string().max(64).optional(),
});

export function registerChannelRoutes(app: FastifyInstance, deps: ChannelRouteDeps): void {
  const { db, realtime } = deps;

  /** チャンネルに加わった人の全ソケットを、ch ルームに参加させ(先に更新)、本人と参加者に知らせる(設計書 §6.3) */
  async function announceJoined(
    channelId: string,
    userId: string,
    channel: ChannelResponse,
  ): Promise<void> {
    realtime.joinUser(userId, [chRoom(channelId)]);
    realtime.emit(userRoom(userId), 'channel:added', channel);
    realtime.emit(chRoom(channelId), 'channel:member-joined', {
      channelId,
      user: await loadChannelMember(db, userId),
    });
  }

  // FR-202: 作成。作成者は参加者になる。名前は、同一ワークスペース内で一意(大文字小文字を区別しない)
  app.post<{ Params: { ws: string } }>(
    '/api/workspaces/:ws/channels',
    { preHandler: requireMember(db) },
    async (request, reply): Promise<ChannelResponse> => {
      const { name, type } = parseWith(createChannelSchema, request.body);
      const userId = authOf(request).user.id;
      const workspaceId = workspaceOf(request).workspaceId;
      try {
        const created = await db.transaction(async (tx) => {
          const [row] = await tx
            .insert(channels)
            .values({ workspaceId, type, name, createdBy: userId })
            .returning();
          await tx.insert(channelMembers).values({ channelId: row!.id, userId });
          return row!;
        });
        const body = toChannelResponse(created);
        // 作成者の全ソケットを、ch ルームに参加させてから(先に更新)、通知する(設計書 §6.3)。
        // パブリックは ws ルームへ、プライベートは作成者の user ルームへ
        realtime.joinUser(userId, [chRoom(created.id)]);
        realtime.emit(
          type === 'public' ? wsRoom(workspaceId) : userRoom(userId),
          'channel:created',
          body,
        );
        return reply.status(201).send(body);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new AppError(
            409,
            'channel_name_taken',
            'このチャンネル名は、すでに使われています。',
          );
        }
        throw error;
      }
    },
  );

  // FR-203: 自分が参加しているチャンネル。joinable=1 なら、未参加のパブリックチャンネル
  app.get<{ Params: { ws: string } }>(
    '/api/workspaces/:ws/channels',
    { preHandler: requireMember(db) },
    async (request): Promise<ChannelResponse[]> => {
      const query = parseWith(listQuerySchema, request.query);
      const userId = authOf(request).user.id;
      const workspaceId = workspaceOf(request).workspaceId;
      const mine = db
        .select({ channelId: channelMembers.channelId })
        .from(channelMembers)
        .where(eq(channelMembers.userId, userId));

      const rows = await db
        .select()
        .from(channels)
        .where(
          and(
            eq(channels.workspaceId, workspaceId),
            query.joinable
              ? and(eq(channels.type, 'public'), sql`${channels.id} NOT IN (${mine})`)
              : sql`${channels.id} IN (${mine})`,
          ),
        )
        .orderBy(desc(channels.isDefault), asc(sql`lower(${channels.name})`), asc(channels.id));
      return rows.map(toChannelResponse);
    },
  );

  // FR-204, 303: オーナーの管理一覧。プライベートも含めるが、見せるのは名前だけ(内容は見せない)
  app.get<{ Params: { ws: string } }>(
    '/api/workspaces/:ws/channels/admin',
    { preHandler: requireOwner(db) },
    async (request): Promise<AdminChannelResponse[]> => {
      const rows = await db
        .select({
          id: channels.id,
          type: channels.type,
          name: channels.name,
          isDefault: channels.isDefault,
        })
        .from(channels)
        .where(
          and(
            eq(channels.workspaceId, workspaceOf(request).workspaceId),
            sql`${channels.type} <> 'dm'`,
          ),
        )
        .orderBy(desc(channels.isDefault), asc(sql`lower(${channels.name})`), asc(channels.id));
      return rows.map((r) => ({
        id: r.id,
        type: r.type as AdminChannelResponse['type'],
        name: r.name!,
        isDefault: r.isDefault,
      }));
    },
  );

  // FR-203: パブリックチャンネルへの参加。判定の順序は、設計書 §4.4
  app.post<{ Params: { ch: string } }>(
    '/api/channels/:ch/join',
    { preHandler: requireUser(db) },
    async (request): Promise<ChannelResponse> => {
      const userId = authOf(request).user.id;
      const parsed = channelIdSchema.safeParse(request.params.ch);
      if (!parsed.success) throw notFound();

      // (1) チャンネルが存在しない、ワークスペースに所属の行がない、プライベート・DM は、いずれも同じ 404
      const [row] = await db
        .select({ channel: channels, status: memberships.status })
        .from(channels)
        .innerJoin(
          memberships,
          and(eq(memberships.workspaceId, channels.workspaceId), eq(memberships.userId, userId)),
        )
        .where(eq(channels.id, parsed.data));
      if (!row || row.channel.type !== 'public') throw notFound();

      // (2) kicked は 403
      if (row.status !== 'active') {
        throw new AppError(403, 'forbidden', 'このワークスペースは、利用できません。');
      }

      // (3) 参加する(参加済みなら、何もせず成功)
      const inserted = await db
        .insert(channelMembers)
        .values({ channelId: row.channel.id, userId })
        .onConflictDoNothing()
        .returning({ userId: channelMembers.userId });
      const body = toChannelResponse(row.channel);
      // 新しく参加したときだけ、ルームを更新して(先に更新)、通知する(設計書 §6.3)
      if (inserted.length > 0) {
        await announceJoined(row.channel.id, userId, body);
      }
      return body;
    },
  );

  // FR-203, 204: 退出。(1) 参加者でなければ 404 (2) 既定チャンネル・DM は 400 (3) 退出する
  app.post<{ Params: { ch: string } }>(
    '/api/channels/:ch/leave',
    { preHandler: requireChannel(db) },
    async (request, reply) => {
      const channel = channelOf(request);
      if (channel.isDefault || channel.type === 'dm') {
        throw new AppError(400, 'cannot_leave', 'このチャンネルからは、退出できません。');
      }
      await db
        .delete(channelMembers)
        .where(
          and(
            eq(channelMembers.channelId, channel.id),
            eq(channelMembers.userId, authOf(request).user.id),
          ),
        );
      // ルームから外してから(先に更新)、通知する。外した後なので、member-left は、本人には届かない
      const userId = authOf(request).user.id;
      realtime.leaveUser(userId, [chRoom(channel.id)]);
      realtime.emit(userRoom(userId), 'channel:left', { channelId: channel.id });
      realtime.emit(chRoom(channel.id), 'channel:member-left', { channelId: channel.id, userId });
      return reply.status(204).send();
    },
  );

  // 参加者の一覧。q で、ユーザー名・表示名の前方一致で絞り込める(メンション候補。FR-109)
  app.get<{ Params: { ch: string } }>(
    '/api/channels/:ch/members',
    { preHandler: requireChannel(db) },
    async (request): Promise<ChannelMemberResponse[]> => {
      const { q } = parseWith(membersQuerySchema, request.query);
      const channel = channelOf(request);
      const prefix = q ? `${escapeLike(q)}%` : undefined;

      const rows = await db
        .select({
          id: users.id,
          username: users.username,
          displayName: users.displayName,
          statusText: users.statusText,
          avatarKey: users.avatarKey,
        })
        .from(channelMembers)
        .innerJoin(users, eq(users.id, channelMembers.userId))
        // 念のため、ワークスペースに active で所属している人だけ(キックの取りこぼしを、見せない)
        .innerJoin(
          memberships,
          and(
            eq(memberships.workspaceId, channel.workspaceId),
            eq(memberships.userId, channelMembers.userId),
            eq(memberships.status, 'active'),
          ),
        )
        .where(
          and(
            eq(channelMembers.channelId, channel.id),
            prefix
              ? sql`(${ilike(users.username, prefix)} OR ${ilike(users.displayName, prefix)})`
              : undefined,
          ),
        )
        .orderBy(asc(channelMembers.joinedAt), asc(users.id));
      return rows.map((r) => ({
        id: r.id,
        username: r.username,
        displayName: r.displayName,
        statusText: r.statusText,
        avatarUrl: avatarUrlFor(r.id, r.avatarKey),
      }));
    },
  );

  // FR-204: プライベートチャンネルへの招待。判定の順序は、設計書 §4.4
  app.post<{ Params: { ch: string } }>(
    '/api/channels/:ch/members',
    { preHandler: requireUser(db) },
    async (request, reply) => {
      const { userId: targetId } = parseWith(addChannelMemberSchema, request.body);
      const me = authOf(request).user.id;
      const parsed = channelIdSchema.safeParse(request.params.ch);
      if (!parsed.success) throw notFound();

      // (1) チャンネルが存在しない → 404
      const [channel] = await db.select().from(channels).where(eq(channels.id, parsed.data));
      if (!channel) throw notFound();

      const [mine] = await db
        .select({ one: sql<number>`1` })
        .from(channelMembers)
        .where(and(eq(channelMembers.channelId, channel.id), eq(channelMembers.userId, me)));
      const isParticipant = mine !== undefined;
      const [membership] = await db
        .select({ role: memberships.role, status: memberships.status })
        .from(memberships)
        .where(and(eq(memberships.workspaceId, channel.workspaceId), eq(memberships.userId, me)));
      const isOwner = membership?.role === 'owner' && membership.status === 'active';

      // (2) 参加者でも、active なオーナーでもない(別のワークスペース、kicked を含む) → 404
      if (!isParticipant && !isOwner) throw notFound();
      // (3) オーナーで、参加者でなく、DM → 404(DM の存在を隠す)
      if (!isParticipant && channel.type === 'dm') throw notFound();
      // (4) DM またはパブリック → 400
      if (channel.type !== 'private') {
        throw new AppError(400, 'bad_request', 'プライベートチャンネルにだけ、招待できます。');
      }
      // (5)(6) 作成者でもオーナーでもない(参加者だけ) → 403。作成者は、参加者である間だけ有効
      const isCreator = channel.createdBy === me && isParticipant;
      if (!isCreator && !isOwner) {
        throw new AppError(403, 'forbidden', 'この操作は、作成者かオーナーだけが行えます。');
      }
      // (7) オーナーで、参加者でなく、自分自身を追加しようとした → 403
      if (!isParticipant && targetId === me) {
        throw new AppError(403, 'forbidden', 'オーナーは、自分自身を追加できません。');
      }
      // (8) 対象が、同じワークスペースの active メンバーでない → 400
      const [target] = await db
        .select({ one: sql<number>`1` })
        .from(memberships)
        .where(
          and(
            eq(memberships.workspaceId, channel.workspaceId),
            eq(memberships.userId, targetId),
            eq(memberships.status, 'active'),
          ),
        );
      if (!target) {
        throw new AppError(
          400,
          'bad_request',
          '招待できるのは、同じワークスペースのメンバーだけです。',
        );
      }
      // (9) 招待する(すでに参加していれば、成功)
      const inserted = await db
        .insert(channelMembers)
        .values({ channelId: channel.id, userId: targetId })
        .onConflictDoNothing()
        .returning({ userId: channelMembers.userId });
      if (inserted.length > 0) {
        await announceJoined(channel.id, targetId, toChannelResponse(channel));
      }
      return reply.status(204).send();
    },
  );
}
