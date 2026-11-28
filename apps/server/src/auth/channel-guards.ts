import { and, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client';
import { channelMembers, channels } from '../db/schema';
import { AppError } from '../errors';
import { authOf, requireUser } from './guards';

export interface ChannelContext {
  id: string;
  workspaceId: string;
  type: 'public' | 'private' | 'dm';
  name: string | null;
  isDefault: boolean;
  createdBy: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** requireChannel を通ったリクエストだけに、設定される */
    channel?: ChannelContext;
  }
}

const channelIdSchema = z.uuid();

const notFound = () => new AppError(404, 'not_found', '見つかりません。');

/**
 * ガード requireChannel(設計書 §4.1): チャンネルが存在し、呼び出し者の ChannelMember の行がある。
 * 判定は、ChannelMember の行だけで行う(kick 時に、そのワークスペースの行は削除されるため、kicked も 404 になる)。
 * 失敗は、常に 404(存在しない・別のワークスペース・非参加・kicked を区別しない。403 は返さない)。
 * requireUser を含む(先に 401 を判定する)。リクエストのたびに DB を引く。
 */
export function requireChannel(db: Db) {
  const user = requireUser(db);
  return async (request: FastifyRequest): Promise<void> => {
    await user(request);
    const parsed = channelIdSchema.safeParse((request.params as { ch?: unknown }).ch);
    if (!parsed.success) throw notFound();

    const [row] = await db
      .select({
        id: channels.id,
        workspaceId: channels.workspaceId,
        type: channels.type,
        name: channels.name,
        isDefault: channels.isDefault,
        createdBy: channels.createdBy,
      })
      .from(channels)
      .innerJoin(channelMembers, eq(channelMembers.channelId, channels.id))
      .where(and(eq(channels.id, parsed.data), eq(channelMembers.userId, authOf(request).user.id)));
    if (!row) throw notFound();
    request.channel = { ...row, type: row.type as ChannelContext['type'] };
  };
}

/** requireChannel を通った後のハンドラで、チャンネルの情報を取り出す */
export function channelOf(request: FastifyRequest): ChannelContext {
  if (!request.channel) throw notFound();
  return request.channel;
}
