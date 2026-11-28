import type {
  DeletedMessageResponse,
  MessageListItem,
  MessagePageResponse,
  MessageResponse,
  UserUpdatedPayload,
} from '@raisechat/shared';
import type { InfiniteData } from '@tanstack/react-query';

/** メッセージの一覧のキャッシュ。ページは、先頭が最新(API が、新しい順に返す) */
export type MessagesData = InfiniteData<MessagePageResponse, unknown>;

/** 全ページの全メッセージに、関数を適用する(null を返すと、その 1 件を取り除く)。変化がなければ、同じ data を返す */
function mapItems(
  data: MessagesData,
  fn: (item: MessageListItem) => MessageListItem | null,
): MessagesData {
  let changed = false;
  const pages = data.pages.map((page) => {
    const messages: MessageListItem[] = [];
    for (const item of page.messages) {
      const next = fn(item);
      if (next !== item) changed = true;
      if (next !== null) messages.push(next);
    }
    return { ...page, messages };
  });
  return changed ? { ...data, pages } : data;
}

/**
 * 新しいメッセージを、先頭のページの先頭に加える。
 * - まだ読み込んでいない一覧(undefined)には、加えない(開いたときに、REST で取る)
 * - すでにある ID は、加えない(WebSocket のイベントと、投稿の応答の、両方から届くため。冪等にする。設計書 §6.5)
 */
export function addMessage(
  data: MessagesData | undefined,
  message: MessageResponse,
): MessagesData | undefined {
  if (!data) return data;
  if (data.pages.some((p) => p.messages.some((m) => m.id === message.id))) return data;
  const [first, ...rest] = data.pages;
  if (!first) return data;
  return {
    ...data,
    pages: [{ ...first, messages: [message, ...first.messages] }, ...rest],
  };
}

/**
 * 編集されたメッセージ(message:updated)に、置き換える。一覧にないものは、何もしない。
 * 削除済みのものは、削除を優先し、後から届いた古い更新で戻さない(設計書 §6.5)。
 */
export function replaceMessage(
  data: MessagesData | undefined,
  message: MessageResponse,
): MessagesData | undefined {
  if (!data) return data;
  return mapItems(data, (item) => {
    if (item.id !== message.id || item.deleted) return item;
    return message;
  });
}

/**
 * 削除されたトップレベルのメッセージ(message:deleted)を反映する。
 * 返信が残っていれば、本文のない「削除されました」の親にし、残っていなければ、一覧から外す(FR-104、105)。
 */
export function applyMessageDeleted(
  data: MessagesData | undefined,
  deleted: { id: number; replyCount: number },
): MessagesData | undefined {
  if (!data) return data;
  return mapItems(data, (item) => {
    if (item.id !== deleted.id) return item;
    if (deleted.replyCount <= 0) return null;
    const placeholder: DeletedMessageResponse = {
      id: item.id,
      channelId: item.channelId,
      createdAt: item.createdAt,
      replyCount: deleted.replyCount,
      deleted: true,
    };
    return placeholder;
  });
}

/**
 * 親の返信数を更新する(返信の削除。thread:reply-deleted)。
 * 削除済みの親は、返信が 0 になったら、一覧から外す(返信のない削除済みの親は、一覧に出ない)。
 */
export function setReplyCount(
  data: MessagesData | undefined,
  parentId: number,
  replyCount: number,
): MessagesData | undefined {
  if (!data) return data;
  return mapItems(data, (item) => {
    if (item.id !== parentId) return item;
    if (item.deleted && replyCount <= 0) return null;
    return item.replyCount === replyCount ? item : { ...item, replyCount };
  });
}

/**
 * 再接続の後に、最新の 50 件を取り直して置き換えるため、先頭のページだけを残す。
 * 古いページは捨て、スクロールで、cursor により取り直す(設計書 §6.5)。
 */
export function keepFirstPage(data: MessagesData | undefined): MessagesData | undefined {
  if (!data || data.pages.length <= 1) return data;
  return { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) };
}

/** 表示名・アバターの変更を、キャッシュ中のメッセージの投稿者に反映する */
export function updateAuthor(
  data: MessagesData | undefined,
  user: UserUpdatedPayload,
): MessagesData | undefined {
  if (!data) return data;
  return mapItems(data, (item) => {
    if (item.deleted || item.author.id !== user.id) return item;
    return {
      ...item,
      author: {
        ...item.author,
        username: user.username,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
      },
    };
  });
}

/** 表示用: 古い順に並べる(ページをまたいで、同じ ID は 1 つにする) */
export function toDisplayOrder(data: MessagesData | undefined): MessageListItem[] {
  if (!data) return [];
  const byId = new Map<number, MessageListItem>();
  for (const page of data.pages) {
    for (const m of page.messages) byId.set(m.id, m);
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}
