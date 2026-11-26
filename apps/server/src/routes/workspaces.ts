import {
  createWorkspaceSchema,
  type MemberResponse,
  type WorkspaceResponse,
  type WorkspaceRole,
} from '@raisechat/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { authOf, requireUser } from '../auth/guards';
import { requireMember, workspaceOf } from '../auth/workspace-guards';
import type { Db } from '../db/client';
import { channelMembers, channels, memberships, users, workspaces } from '../db/schema';
import { parseWith } from '../errors';
import { avatarUrlFor } from '../profile/avatar';

/** 既定チャンネルの名前(FR-201) */
export const DEFAULT_CHANNEL_NAME = 'general';

export interface WorkspaceRouteDeps {
  db: Db;
}

export function registerWorkspaceRoutes(app: FastifyInstance, deps: WorkspaceRouteDeps): void {
  const { db } = deps;

  // FR-206: 自分が active に所属しているワークスペースの一覧(古い順)
  app.get(
    '/api/workspaces',
    { preHandler: requireUser(db) },
    async (request): Promise<WorkspaceResponse[]> => {
      const rows = await db
        .select({ id: workspaces.id, name: workspaces.name, role: memberships.role })
        .from(memberships)
        .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
        .where(
          and(eq(memberships.userId, authOf(request).user.id), eq(memberships.status, 'active')),
        )
        .orderBy(asc(memberships.joinedAt), asc(workspaces.id));
      return rows.map((r) => ({ id: r.id, name: r.name, role: r.role as WorkspaceRole }));
    },
  );

  // FR-201: 作成。作成者がオーナーになり、既定チャンネル(general)と、作成者のその参加が作られる。
  // すべて 1 つのトランザクション(general のない、ワークスペースを残さない)
  app.post(
    '/api/workspaces',
    { preHandler: requireUser(db) },
    async (request, reply): Promise<WorkspaceResponse> => {
      const { name } = parseWith(createWorkspaceSchema, request.body);
      const userId = authOf(request).user.id;

      const workspace = await db.transaction(async (tx) => {
        // workspaces と、オーナーの membership は、相互に参照する(外部キーの検査は、コミットまで遅れる)
        const [created] = await tx.insert(workspaces).values({ name, ownerId: userId }).returning();
        await tx.insert(memberships).values({
          workspaceId: created!.id,
          userId,
          role: 'owner',
          status: 'active',
        });
        const [general] = await tx
          .insert(channels)
          .values({
            workspaceId: created!.id,
            type: 'public',
            name: DEFAULT_CHANNEL_NAME,
            createdBy: userId,
            isDefault: true,
          })
          .returning({ id: channels.id });
        await tx.insert(channelMembers).values({ channelId: general!.id, userId });
        return created!;
      });

      return reply.status(201).send({ id: workspace.id, name: workspace.name, role: 'owner' });
    },
  );

  // FR-206: ワークスペースの情報
  app.get<{ Params: { ws: string } }>(
    '/api/workspaces/:ws',
    { preHandler: requireMember(db) },
    async (request): Promise<WorkspaceResponse> => {
      const ctx = workspaceOf(request);
      return { id: ctx.workspaceId, name: ctx.name, role: ctx.role };
    },
  );

  // active なメンバーの一覧(表示名・アバター・ステータス。FR-004)。kicked は含めない
  app.get<{ Params: { ws: string } }>(
    '/api/workspaces/:ws/members',
    { preHandler: requireMember(db) },
    async (request): Promise<MemberResponse[]> => {
      const rows = await db
        .select({
          id: users.id,
          username: users.username,
          displayName: users.displayName,
          statusText: users.statusText,
          avatarKey: users.avatarKey,
          role: memberships.role,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(
            eq(memberships.workspaceId, workspaceOf(request).workspaceId),
            eq(memberships.status, 'active'),
          ),
        )
        .orderBy(asc(memberships.joinedAt), asc(users.id));
      return rows.map((r) => ({
        id: r.id,
        username: r.username,
        displayName: r.displayName,
        statusText: r.statusText,
        avatarUrl: avatarUrlFor(r.id, r.avatarKey),
        role: r.role as WorkspaceRole,
      }));
    },
  );
}
