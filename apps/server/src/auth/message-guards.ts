import { and, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client';
import { channelMembers, messages } from '../db/schema';
import { AppError } from '../errors';
import { authOf, requireUser } from './guards';

/** メッセージの行(削除済みを含む) */
export interface MessageRow {
  id: number;
  channelId: string;
  userId: string;
  /** スレッドの返信なら、親の ID。トップレベルは null */
  parentId: number | null;
  /** 削除済みなら null */
  body: string | null;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
}

/** requireAuthor を通ったメッセージ(削除済みでないので、本文は常にある) */
export interface MessageContext extends MessageRow {
  body: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** requireAuthor を通ったリクエストだけに、設定される */
    message?: MessageContext;
    /** requireMessageChannel を通ったリクエストだけに、設定される(削除済みの場合もある) */
    targetMessage?: MessageRow;
  }
}

/** メッセージの ID: 正の整数(bigint の範囲のうち、JavaScript で正確に扱える範囲) */
const messageIdSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,15}$/)
  .transform(Number);

const notFound = () => new AppError(404, 'not_found', '見つかりません。');

/**
 * メッセージを、ID から引く。呼び出し者が、そのチャンネルの参加者でなければ、見つからない(null)ものとして扱う
 * (requireChannel と同じ。参加者の行だけで判定する。存在しない場合と区別しない)。
 */
async function findForParticipant(db: Db, request: FastifyRequest): Promise<MessageRow | null> {
  const parsed = messageIdSchema.safeParse((request.params as { id?: unknown }).id);
  if (!parsed.success) return null;
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
    .innerJoin(
      channelMembers,
      and(eq(channelMembers.channelId, messages.channelId), eq(channelMembers.userId, me)),
    )
    .where(eq(messages.id, parsed.data));
  return row ?? null;
}

/**
 * ガード requireMessageChannel(設計書 §4.1): メッセージが存在し、そのチャンネルに対する requireChannel を満たす。
 * 満たさなければ、常に 404(存在しない・別のワークスペース・非参加・kicked を区別しない)。
 * 削除済みかどうかは、ここでは見ない(操作ごとに、ハンドラが決める。§4.1 の削除済みのメッセージへの操作)。
 * requireUser を含む(先に 401 を判定する)。パスのパラメータは :id。
 */
export function requireMessageChannel(db: Db) {
  const user = requireUser(db);
  return async (request: FastifyRequest): Promise<void> => {
    await user(request);
    const row = await findForParticipant(db, request);
    if (!row) throw notFound();
    request.targetMessage = row;
  };
}

/** requireMessageChannel を通った後のハンドラで、メッセージの情報を取り出す */
export function targetMessageOf(request: FastifyRequest): MessageRow {
  if (!request.targetMessage) throw notFound();
  return request.targetMessage;
}

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
    const row = await findForParticipant(db, request);
    if (!row) throw notFound();
    if (row.deletedAt !== null || row.body === null) throw notFound();
    if (row.userId !== authOf(request).user.id) {
      throw new AppError(403, 'forbidden', '自分のメッセージだけ、操作できます。');
    }
    request.message = { ...row, body: row.body };
  };
}

/** requireAuthor を通った後のハンドラで、メッセージの情報を取り出す */
export function messageOf(request: FastifyRequest): MessageContext {
  if (!request.message) throw notFound();
  return request.message;
}
