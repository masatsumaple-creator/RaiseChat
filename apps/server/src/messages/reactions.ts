import type { ReactionSummary } from '@raisechat/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { reactions } from '../db/schema';

type Executor = Pick<Db, 'select'>;

/** 行を、絵文字ごとにまとめる(付けた順。最初に付けられた絵文字が、先) */
function summarize(rows: { emoji: string; userId: string }[]): ReactionSummary[] {
  const byEmoji = new Map<string, string[]>();
  for (const row of rows) {
    const users = byEmoji.get(row.emoji);
    if (users) users.push(row.userId);
    else byEmoji.set(row.emoji, [row.userId]);
  }
  return [...byEmoji].map(([emoji, userIds]) => ({ emoji, count: userIds.length, userIds }));
}

/**
 * 複数のメッセージの、リアクションを、まとめて取る(一覧・返信の一覧の応答に含めるため。1 回の問い合わせ)。
 * リアクションがないメッセージは、空の配列。
 */
export async function loadReactions(
  db: Executor,
  messageIds: number[],
): Promise<Map<number, ReactionSummary[]>> {
  const result = new Map<number, ReactionSummary[]>();
  if (messageIds.length === 0) return result;
  const rows = await db
    .select({ messageId: reactions.messageId, emoji: reactions.emoji, userId: reactions.userId })
    .from(reactions)
    .where(inArray(reactions.messageId, messageIds))
    .orderBy(asc(reactions.createdAt), asc(reactions.emoji), asc(reactions.userId));
  const grouped = new Map<number, { emoji: string; userId: string }[]>();
  for (const row of rows) {
    const list = grouped.get(row.messageId);
    if (list) list.push(row);
    else grouped.set(row.messageId, [row]);
  }
  for (const [id, list] of grouped) result.set(id, summarize(list));
  return result;
}

/** 1 つのメッセージの、リアクション */
export async function reactionsOf(db: Executor, messageId: number): Promise<ReactionSummary[]> {
  return (await loadReactions(db, [messageId])).get(messageId) ?? [];
}

/**
 * ある絵文字の、いまの状態(件数と、付けた人)。リアクションのイベントに使う。
 * 誰も付けていなければ、件数 0(クライアントは、その絵文字を外す)。
 */
export async function emojiState(
  db: Executor,
  messageId: number,
  emoji: string,
): Promise<ReactionSummary> {
  const rows = await db
    .select({ userId: reactions.userId })
    .from(reactions)
    .where(and(eq(reactions.messageId, messageId), eq(reactions.emoji, emoji)))
    .orderBy(asc(reactions.createdAt), asc(reactions.userId));
  const userIds = rows.map((r) => r.userId);
  return { emoji, count: userIds.length, userIds };
}
