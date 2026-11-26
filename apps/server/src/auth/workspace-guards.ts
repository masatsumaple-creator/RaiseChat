import { and, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client';
import { memberships, workspaces } from '../db/schema';
import { AppError } from '../errors';
import { authOf, requireUser } from './guards';

export interface WorkspaceContext {
  workspaceId: string;
  name: string;
  role: 'owner' | 'member';
}

declare module 'fastify' {
  interface FastifyRequest {
    /** requireMember / requireOwner を通ったリクエストだけに、設定される */
    workspace?: WorkspaceContext;
  }
}

const workspaceIdSchema = z.uuid();

/**
 * ガード requireMember(設計書 §4.1): パスの :ws のワークスペースに、active で所属している。
 * - 所属の行がない(ワークスペースが存在しない、uuid の形式が違う場合を含む)→ 404
 * - kicked → 403(FR-302)
 * requireUser を含む(先に 401 を判定する)。リクエストのたびに DB を引く。
 */
export function requireMember(db: Db) {
  const user = requireUser(db);
  return async (request: FastifyRequest): Promise<void> => {
    await user(request);
    const parsed = workspaceIdSchema.safeParse((request.params as { ws?: unknown }).ws);
    if (!parsed.success) throw new AppError(404, 'not_found', '見つかりません。');

    const [row] = await db
      .select({ name: workspaces.name, role: memberships.role, status: memberships.status })
      .from(memberships)
      .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
      .where(
        and(
          eq(memberships.workspaceId, parsed.data),
          eq(memberships.userId, authOf(request).user.id),
        ),
      );
    if (!row) throw new AppError(404, 'not_found', '見つかりません。');
    if (row.status !== 'active') {
      throw new AppError(403, 'forbidden', 'このワークスペースは、利用できません。');
    }
    request.workspace = {
      workspaceId: parsed.data,
      name: row.name,
      role: row.role as WorkspaceContext['role'],
    };
  };
}

/** ガード requireOwner: requireMember を満たし、role が owner。満たさなければ 403 */
export function requireOwner(db: Db) {
  const member = requireMember(db);
  return async (request: FastifyRequest): Promise<void> => {
    await member(request);
    if (workspaceOf(request).role !== 'owner') {
      throw new AppError(403, 'forbidden', 'この操作は、オーナーだけが行えます。');
    }
  };
}

/** requireMember / requireOwner を通った後のハンドラで、ワークスペースの情報を取り出す */
export function workspaceOf(request: FastifyRequest): WorkspaceContext {
  if (!request.workspace) throw new AppError(404, 'not_found', '見つかりません。');
  return request.workspace;
}
