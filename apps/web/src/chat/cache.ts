import type { MessagePageResponse, MessageResponse, UserUpdatedPayload } from '@raisechat/shared';
import type { InfiniteData } from '@tanstack/react-query';

/** メッセージの一覧のキャッシュ。ページは、先頭が最新(API が、新しい順に返す) */
export type MessagesData = InfiniteData<MessagePageResponse, unknown>;

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
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      messages: page.messages.map((m) =>
        m.author.id === user.id
          ? {
              ...m,
              author: {
                ...m.author,
                username: user.username,
                displayName: user.displayName,
                avatarUrl: user.avatarUrl,
              },
            }
          : m,
      ),
    })),
  };
}

/** 表示用: 古い順に並べる(ページをまたいで、同じ ID は 1 つにする) */
export function toDisplayOrder(data: MessagesData | undefined): MessageResponse[] {
  if (!data) return [];
  const byId = new Map<number, MessageResponse>();
  for (const page of data.pages) {
    for (const m of page.messages) byId.set(m.id, m);
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}
