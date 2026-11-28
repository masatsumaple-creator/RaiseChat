import { and, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client';
import { channelMembers, messages } from '../db/schema';
import { AppError } from '../errors';
import { authOf, requireUser } from './guards';

export interface MessageContext {
  id: number;
  channelId: string;
  userId: string;
  /** スレッドの返信なら、親の ID。トップレベルは null */
  parentId: number | null;
  /** 削除済みでないので、常に文字列 */
  body: string;
  createdAt: Date;
  editedAt: Date | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** requireAuthor を通ったリクエストだけに、設定される */
    message?: MessageContext;
  }
}

/** メッセージの ID: 正の整数(bigint の範囲のうち、JavaScript で正確に扱える範囲) */
const messageIdSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,15}$/)
  .transform(Number);

const notFound = () => new AppError(404, 'not_found', '見つかりません。');

/**
 * ガード requireAuthor(設計書 §4.1)。次の順に判定し、最初に当てはまったところで終了する。
 * 1. メッセージが存在しない → 404
 * 2. そのチャンネルに対する requireChannel を満たさない(参加者でない。別のワークスペース・kicked を含む)→ 404
 * 3. メッセージが削除済み → 404(投稿者以外にも 404。403 より先に判定する)
 * 4. 投稿者が本人でない → 403
 * requireUser を含む(先に 401 を判定する)。パスのパラメータは :id。
 */
export function requireAuthor(db: Db) {
  const user = requireUser(db);
  return async (request: FastifyRequest): Promise<void> => {
    await user(request);
    const parsed = messageIdSchema.safeParse((request.params as { id?: unknown }).id);
    if (!parsed.success) throw notFound();
    const me = authOf(request).user.id;

    const [row] = await db
      .select({
        id: messages.id,
        channelId: messages.channelId,
        userId: messages.userId,
        parentId: messages.parentId,
        body: messages.body,
        createdAt: messages.createdAt,
        editedAt: messages.editedAt,
        deletedAt: messages.deletedAt,
      })
      .from(messages)
      // 2: 呼び出し者が、そのチャンネルの参加者であること(参加者の行だけで判定する)
      .innerJoin(
        channelMembers,
        and(eq(channelMembers.channelId, messages.channelId), eq(channelMembers.userId, me)),
      )
      .where(eq(messages.id, parsed.data));
    if (!row) throw notFound();
    if (row.deletedAt !== null || row.body === null) throw notFound();
    if (row.userId !== me) {
      throw new AppError(403, 'forbidden', '自分のメッセージだけ、操作できます。');
    }
    request.message = {
      id: row.id,
      channelId: row.channelId,
      userId: row.userId,
      parentId: row.parentId,
      body: row.body,
      createdAt: row.createdAt,
      editedAt: row.editedAt,
    };
  };
}

/** requireAuthor を通った後のハンドラで、メッセージの情報を取り出す */
export function messageOf(request: FastifyRequest): MessageContext {
  if (!request.message) throw notFound();
  return request.message;
}
