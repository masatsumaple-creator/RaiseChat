import { extractMentionNames, type MentionResponse } from '@raisechat/shared';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { channelMembers, channels, memberships, mentions, users } from '../db/schema';
import { userRoom, type Realtime } from '../realtime/realtime';

type Executor = Pick<Db, 'select'>;
type Tx = Pick<Db, 'select' | 'insert' | 'delete'>;

export interface MentionSyncResult {
  /** 本文の、有効なメンション(ユーザー名の順) */
  mentions: MentionResponse[];
  /** この更新で、新しく加わった人(通知する相手) */
  addedUserIds: string[];
  workspaceId: string;
}

/**
 * 本文のメンションを、mentions に反映する(FR-109。設計書 §5.6)。投稿と編集で使う。呼び出し側のトランザクションの中で呼ぶ。
 * そのチャンネルの参加者(ワークスペースに active で所属)に当てはまる名前だけを登録し、自分自身は登録しない。
 * 編集では、差分だけを更新する(残る行は、既読の状態も含めて、そのまま)。
 */
export async function syncMentions(
  tx: Tx,
  message: { id: number; channelId: string; authorId: string; body: string },
): Promise<MentionSyncResult> {
  const [channel] = await tx
    .select({ workspaceId: channels.workspaceId })
    .from(channels)
    .where(eq(channels.id, message.channelId));
  const workspaceId = channel!.workspaceId;

  const names = extractMentionNames(message.body);
  const wanted =
    names.length === 0
      ? []
      : await tx
          .select({ id: users.id, username: users.username })
          .from(channelMembers)
          .innerJoin(users, eq(users.id, channelMembers.userId))
          .innerJoin(
            memberships,
            and(
              eq(memberships.workspaceId, workspaceId),
              eq(memberships.userId, channelMembers.userId),
              eq(memberships.status, 'active'),
            ),
          )
          .where(
            and(
              eq(channelMembers.channelId, message.channelId),
              ne(users.id, message.authorId),
              inArray(sql`lower(${users.username})`, names),
            ),
          )
          .orderBy(asc(users.username));

  const current = await tx
    .select({ userId: mentions.userId })
    .from(mentions)
    .where(eq(mentions.messageId, message.id));
  const currentIds = new Set(current.map((r) => r.userId));
  const wantedIds = new Set(wanted.map((u) => u.id));

  const removed = [...currentIds].filter((id) => !wantedIds.has(id));
  const addedUserIds = [...wantedIds].filter((id) => !currentIds.has(id));
  if (removed.length > 0) {
    await tx
      .delete(mentions)
      .where(and(eq(mentions.messageId, message.id), inArray(mentions.userId, removed)));
  }
  if (addedUserIds.length > 0) {
    await tx
      .insert(mentions)
      .values(addedUserIds.map((userId) => ({ messageId: message.id, userId })))
      .onConflictDoNothing();
  }
  return {
    mentions: wanted.map((u) => ({ userId: u.id, username: u.username })),
    addedUserIds,
    workspaceId,
  };
}

/** 複数のメッセージの、有効なメンションを、まとめて取る(1 回の問い合わせ。ユーザー名の順) */
export async function loadMentions(
  db: Executor,
  messageIds: number[],
): Promise<Map<number, MentionResponse[]>> {
  const result = new Map<number, MentionResponse[]>();
  if (messageIds.length === 0) return result;
  const rows = await db
    .select({ messageId: mentions.messageId, userId: users.id, username: users.username })
    .from(mentions)
    .innerJoin(users, eq(users.id, mentions.userId))
    .where(inArray(mentions.messageId, messageIds))
    .orderBy(asc(users.username));
  for (const r of rows) {
    const entry = { userId: r.userId, username: r.username };
    const list = result.get(r.messageId);
    if (list) list.push(entry);
    else result.set(r.messageId, [entry]);
  }
  return result;
}

/** 1 つのメッセージの、有効なメンション */
export async function mentionsOf(db: Executor, messageId: number): Promise<MentionResponse[]> {
  return (await loadMentions(db, [messageId])).get(messageId) ?? [];
}

/** コミットの後に、新しくメンションされた人だけへ通知する(その人の user ルームへ) */
export function notifyMentions(
  realtime: Realtime,
  result: MentionSyncResult,
  message: { id: number; channelId: string },
): void {
  for (const userId of result.addedUserIds) {
    realtime.emit(userRoom(userId), 'mention:created', {
      messageId: message.id,
      channelId: message.channelId,
      workspaceId: result.workspaceId,
    });
  }
}
