import {
  createInvitationSchema,
  type InvitationAcceptResponse,
  type InvitationCreatedResponse,
  type InvitationPreviewResponse,
  type InvitationResponse,
  type InvitationStatus,
  type WorkspaceRole,
} from '@raisechat/shared';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authOf, requireUser } from '../auth/guards';
import { generateSessionToken, hashToken } from '../auth/tokens';
import { requireOwner, workspaceOf } from '../auth/workspace-guards';
import type { Db } from '../db/client';
import { channelMembers, channels, invitations, memberships, workspaces } from '../db/schema';
import { AppError, parseWith } from '../errors';
import { rateLimitedError, type RateLimiter } from '../rate-limit';

export interface InvitationRouteDeps {
  db: Db;
  /** 無効なトークンの試行を、ユーザー単位で数える(設計書 §4.1: 15 分に 10 回) */
  failureUserLimiter: RateLimiter;
  /** 無効なトークンの試行を、接続元の全体で数える(設計書 §4.1: 15 分に 30 回) */
  failureIpLimiter: RateLimiter;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 発行するトークンの形(256 ビットの base64url)。これ以外は、DB を引かずに、無効として扱う */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

const idSchema = z.uuid();

/**
 * 無効なリンク。存在しない・期限切れ・取り消し・回数超過・kicked を、区別しない(設計書 §5.2)。
 * 同じステータス・同じ文言で返す。
 */
const invalidInvitation = () =>
  new AppError(404, 'invalid_invitation', 'この招待リンクは、無効です。');

/** トランザクション内で無効と分かったときの、ロールバック用の例外 */
class InvalidInvitationError extends Error {}

type InvitationRow = typeof invitations.$inferSelect;

function statusOf(row: InvitationRow, now: Date): InvitationStatus {
  if (row.revokedAt) return 'revoked';
  if (row.expiresAt <= now) return 'expired';
  if (row.maxUses !== null && row.usedCount >= row.maxUses) return 'exhausted';
  return 'active';
}

function toInvitationResponse(row: InvitationRow, now = new Date()): InvitationResponse {
  return {
    id: row.id,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    maxUses: row.maxUses,
    usedCount: row.usedCount,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    status: statusOf(row, now),
  };
}

export function registerInvitationRoutes(app: FastifyInstance, deps: InvitationRouteDeps): void {
  const { db, failureUserLimiter, failureIpLimiter } = deps;

  const limitKeys = (request: FastifyRequest) => ({
    user: `invite-user:${authOf(request).user.id}`,
    ip: `invite-ip:${request.ip}`,
  });

  /** すでに上限に達していれば、429(トークンを調べる前に判定する) */
  function assertNotLimited(request: FastifyRequest): void {
    const keys = limitKeys(request);
    const wait = Math.max(
      failureUserLimiter.isLimited(keys.user) ? failureUserLimiter.retryAfterSeconds(keys.user) : 0,
      failureIpLimiter.isLimited(keys.ip) ? failureIpLimiter.retryAfterSeconds(keys.ip) : 0,
    );
    if (wait > 0) throw rateLimitedError(wait);
  }

  /** 無効だった試行だけを数え、無効のエラーを返す(有効なリンクの利用は、数えない) */
  function failed(request: FastifyRequest): AppError {
    const keys = limitKeys(request);
    failureUserLimiter.record(keys.user);
    failureIpLimiter.record(keys.ip);
    return invalidInvitation();
  }

  // FR-301: 招待リンクの発行(オーナーのみ)。トークンは、この応答でだけ返す
  app.post<{ Params: { ws: string } }>(
    '/api/workspaces/:ws/invitations',
    { preHandler: requireOwner(db) },
    async (request, reply): Promise<InvitationCreatedResponse> => {
      const { expiresInDays, maxUses } = parseWith(createInvitationSchema, request.body ?? {});
      const token = generateSessionToken();
      const [row] = await db
        .insert(invitations)
        .values({
          workspaceId: workspaceOf(request).workspaceId,
          tokenHash: hashToken(token),
          createdBy: authOf(request).user.id,
          expiresAt: new Date(Date.now() + expiresInDays * DAY_MS),
          maxUses: maxUses === 'unlimited' ? null : maxUses,
        })
        .returning();
      return reply.status(201).send({ ...toInvitationResponse(row!), token });
    },
  );

  // 発行済みリンクの一覧(オーナーのみ。トークンは返さない)
  app.get<{ Params: { ws: string } }>(
    '/api/workspaces/:ws/invitations',
    { preHandler: requireOwner(db) },
    async (request): Promise<InvitationResponse[]> => {
      const rows = await db
        .select()
        .from(invitations)
        .where(eq(invitations.workspaceId, workspaceOf(request).workspaceId))
        .orderBy(desc(invitations.createdAt), desc(invitations.id));
      const now = new Date();
      return rows.map((r) => toInvitationResponse(r, now));
    },
  );

  // リンクの取り消し(オーナーのみ)。取り消し済みなら、何もせず成功(最初の取り消しの時刻を残す)
  app.delete<{ Params: { ws: string; id: string } }>(
    '/api/workspaces/:ws/invitations/:id',
    { preHandler: requireOwner(db) },
    async (request, reply) => {
      const id = idSchema.safeParse(request.params.id);
      if (!id.success) throw new AppError(404, 'not_found', '見つかりません。');
      const updated = await db
        .update(invitations)
        .set({ revokedAt: sql`coalesce(${invitations.revokedAt}, now())` })
        .where(
          and(
            eq(invitations.id, id.data),
            // 別のワークスペースのリンクは、取り消せない(存在も教えない)
            eq(invitations.workspaceId, workspaceOf(request).workspaceId),
          ),
        )
        .returning({ id: invitations.id });
      if (updated.length === 0) throw new AppError(404, 'not_found', '見つかりません。');
      return reply.status(204).send();
    },
  );

  // 受諾前の確認。ワークスペース名と、有効かどうかだけ。無効の理由は区別しない(kicked も同じ)
  app.get<{ Params: { token: string } }>(
    '/api/invitations/:token',
    { preHandler: requireUser(db) },
    async (request): Promise<InvitationPreviewResponse> => {
      assertNotLimited(request);
      const { token } = request.params;
      if (!TOKEN_PATTERN.test(token)) throw failed(request);

      const userId = authOf(request).user.id;
      const [row] = await db
        .select({
          workspaceName: workspaces.name,
          maxUses: invitations.maxUses,
          usedCount: invitations.usedCount,
          status: memberships.status,
        })
        .from(invitations)
        .innerJoin(workspaces, eq(workspaces.id, invitations.workspaceId))
        .leftJoin(
          memberships,
          and(eq(memberships.workspaceId, invitations.workspaceId), eq(memberships.userId, userId)),
        )
        .where(
          and(
            eq(invitations.tokenHash, hashToken(token)),
            isNull(invitations.revokedAt),
            sql`${invitations.expiresAt} > now()`,
          ),
        );
      if (!row) throw failed(request);
      if (row.status === 'kicked') throw failed(request);
      // 回数を使い切っていても、すでに参加している人には、有効(受諾は、成功する)
      const exhausted = row.maxUses !== null && row.usedCount >= row.maxUses;
      if (exhausted && row.status !== 'active') throw failed(request);
      return { workspaceName: row.workspaceName };
    },
  );

  // FR-301: 招待の受諾。設計書 §3.1 の順序で、1 つのトランザクションで行う(順序を変えない)
  app.post<{ Params: { token: string } }>(
    '/api/invitations/:token/accept',
    { preHandler: requireUser(db) },
    async (request): Promise<InvitationAcceptResponse> => {
      assertNotLimited(request);
      const { token } = request.params;
      if (!TOKEN_PATTERN.test(token)) throw failed(request);
      const userId = authOf(request).user.id;

      try {
        return await db.transaction(async (tx): Promise<InvitationAcceptResponse> => {
          // 1. 存在と有効(取り消されていない、期限内)を確認して、workspace_id を得る
          const [invitation] = await tx
            .select({
              id: invitations.id,
              workspaceId: invitations.workspaceId,
              workspaceName: workspaces.name,
            })
            .from(invitations)
            .innerJoin(workspaces, eq(workspaces.id, invitations.workspaceId))
            .where(
              and(
                eq(invitations.tokenHash, hashToken(token)),
                isNull(invitations.revokedAt),
                sql`${invitations.expiresAt} > now()`,
              ),
            );
          if (!invitation) throw new InvalidInvitationError();

          // 2. Membership を、ON CONFLICT DO NOTHING で挿入する
          const inserted = await tx
            .insert(memberships)
            .values({
              workspaceId: invitation.workspaceId,
              userId,
              role: 'member',
              status: 'active',
            })
            .onConflictDoNothing()
            .returning({ userId: memberships.userId });

          // 3. 挿入できなかった(すでに行がある)場合は、既存の status を見る
          if (inserted.length === 0) {
            const [existing] = await tx
              .select({ role: memberships.role, status: memberships.status })
              .from(memberships)
              .where(
                and(
                  eq(memberships.workspaceId, invitation.workspaceId),
                  eq(memberships.userId, userId),
                ),
              );
            // kicked は、再参加できない(無効なリンクと区別しない)
            if (!existing || existing.status !== 'active') throw new InvalidInvitationError();
            // active なら、何もせず成功(使用回数は、増やさない)
            return {
              id: invitation.workspaceId,
              name: invitation.workspaceName,
              role: existing.role as WorkspaceRole,
            };
          }

          // 4. 挿入できた場合だけ、使用回数を、条件付き更新で原子的に消費する。0 件ならロールバック
          const consumed = await tx
            .update(invitations)
            .set({ usedCount: sql`${invitations.usedCount} + 1` })
            .where(
              and(
                eq(invitations.id, invitation.id),
                isNull(invitations.revokedAt),
                sql`${invitations.expiresAt} > now()`,
                sql`(${invitations.maxUses} IS NULL OR ${invitations.usedCount} < ${invitations.maxUses})`,
              ),
            )
            .returning({ id: invitations.id });
          if (consumed.length === 0) throw new InvalidInvitationError();

          // 5. 既定チャンネル(general)の ChannelMember を挿入する
          const [general] = await tx
            .select({ id: channels.id })
            .from(channels)
            .where(
              and(eq(channels.workspaceId, invitation.workspaceId), eq(channels.isDefault, true)),
            );
          if (general) {
            await tx
              .insert(channelMembers)
              .values({ channelId: general.id, userId })
              .onConflictDoNothing();
          }

          return { id: invitation.workspaceId, name: invitation.workspaceName, role: 'member' };
        });
      } catch (error) {
        if (error instanceof InvalidInvitationError) throw failed(request);
        throw error;
      }
    },
  );
}
