import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MessageResponse } from '@raisechat/shared';
import { useCallback, useLayoutEffect, useRef } from 'react';
import {
  addReaction,
  channelMembersKey,
  deleteMessage,
  editMessage,
  listChannelMembers,
  listMessages,
  messagesKey,
  postMessage,
  removeReaction,
} from '../api/channels';
import { errorMessage } from '../api/client';
import { useMe } from '../api/me';
import {
  addMessage,
  applyMessageDeleted,
  applyReaction,
  replaceMessage,
  toDisplayOrder,
  type MessagesData,
} from './cache';
import { MessageComposer } from './MessageComposer';
import { MessageItem, type NameMap } from './MessageItem';

/** 下端から、この距離(px)以内なら、「最新を見ている」とみなして、新しい投稿で下へ追従する */
const NEAR_BOTTOM_PX = 80;

/** チャンネルの参加者の、ID から表示名への表(リアクションを付けた人の表示に使う) */
export function useChannelNames(channelId: string): NameMap {
  const members = useQuery({
    queryKey: channelMembersKey(channelId),
    queryFn: ({ signal }) => listChannelMembers(channelId, signal),
    retry: false,
  });
  return new Map((members.data ?? []).map((m) => [m.id, m.displayName]));
}

/** メンションの候補を取る関数(チャンネルごとに、同じ関数を使い回す) */
export function useCandidates(channelId: string) {
  return useCallback((q: string) => listChannelMembers(channelId, undefined, q), [channelId]);
}

/**
 * チャンネルのメッセージ(FR-101)。古い順に表示し、新しい投稿は、WebSocket と投稿の応答で加わる。
 * onOpenThread で、スレッドのパネルを開く(FR-105)。
 */
export function MessageList({
  channelId,
  onOpenThread,
}: {
  channelId: string;
  onOpenThread: (rootId: number) => void;
}) {
  const queryClient = useQueryClient();
  const { data: me } = useMe();
  const names = useChannelNames(channelId);
  const fetchCandidates = useCandidates(channelId);
  const query = useInfiniteQuery({
    queryKey: messagesKey(channelId),
    queryFn: ({ pageParam, signal }) => listMessages(channelId, pageParam, signal),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    retry: false,
  });

  const messages = toDisplayOrder(query.data);
  const newestId = messages.length > 0 ? messages[messages.length - 1]!.id : null;

  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const lastNewest = useRef<number | null>(null);

  // 最初の表示と、最新を見ているときの新しい投稿で、下端へ移る
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || newestId === lastNewest.current) return;
    if (lastNewest.current === null || stickToBottom.current) el.scrollTop = el.scrollHeight;
    lastNewest.current = newestId;
  }, [newestId]);

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
  }

  async function send(body: string, files: File[] = []) {
    const message = await postMessage(channelId, body, files);
    // WebSocket が届かなくても、自分の投稿は見えるようにする(同じ ID は、重ねて加えない)
    queryClient.setQueryData<MessagesData>(messagesKey(channelId), (data) =>
      addMessage(data, message),
    );
    stickToBottom.current = true;
  }

  async function edit(message: MessageResponse, body: string) {
    const updated = await editMessage(message.id, body);
    // message:updated が先に届いていても、同じ内容で置き換わるだけ(冪等)
    queryClient.setQueryData<MessagesData>(messagesKey(channelId), (data) =>
      replaceMessage(data, updated),
    );
  }

  async function remove(message: MessageResponse) {
    await deleteMessage(message.id);
    queryClient.setQueryData<MessagesData>(messagesKey(channelId), (data) =>
      applyMessageDeleted(data, { id: message.id, replyCount: message.replyCount }),
    );
  }

  async function toggleReaction(message: MessageResponse, emoji: string, mine: boolean) {
    if (mine) {
      await removeReaction(message.id, emoji);
      // 自分の分を外した状態を、すぐ反映する(reaction:removed が届けば、同じ内容で置き換わる)
      const rest = (message.reactions.find((r) => r.emoji === emoji)?.userIds ?? []).filter(
        (id) => id !== me?.id,
      );
      queryClient.setQueryData<MessagesData>(messagesKey(channelId), (data) =>
        applyReaction(data, {
          messageId: message.id,
          channelId,
          emoji,
          count: rest.length,
          userIds: rest,
        }),
      );
      return;
    }
    const state = await addReaction(message.id, emoji);
    queryClient.setQueryData<MessagesData>(messagesKey(channelId), (data) =>
      applyReaction(data, { messageId: message.id, channelId, ...state }),
    );
  }

  return (
    <div className="chat">
      <div className="messages" ref={scroller} onScroll={onScroll}>
        {query.hasNextPage && (
          <button
            type="button"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            さらに古いメッセージを読み込む
          </button>
        )}
        {query.isPending && <p role="status">読み込み中…</p>}
        {query.isError && (
          <div role="alert">
            <p>{errorMessage(query.error)}</p>
            <button type="button" onClick={() => void query.refetch()}>
              再試行
            </button>
          </div>
        )}
        {query.isSuccess && messages.length === 0 && <p>まだ、メッセージはありません。</p>}
        <ul aria-label="メッセージ一覧">
          {messages.map((m) =>
            m.deleted ? (
              // 返信が残っている親だけが、一覧に出る(FR-105)。返信は、ここから開ける
              <li key={m.id} className="message-deleted">
                このメッセージは、削除されました。
                {m.replyCount > 0 && (
                  <button type="button" className="reply-count" onClick={() => onOpenThread(m.id)}>
                    返信 {m.replyCount} 件
                  </button>
                )}
              </li>
            ) : (
              <MessageItem
                key={m.id}
                message={m}
                myId={me?.id}
                names={names}
                onEdit={(body) => edit(m, body)}
                onDelete={() => remove(m)}
                onToggleReaction={(emoji, mine) => toggleReaction(m, emoji, mine)}
                onOpenThread={() => onOpenThread(m.id)}
              />
            ),
          )}
        </ul>
      </div>
      <MessageComposer onSend={send} fetchCandidates={fetchCandidates} allowAttachments />
    </div>
  );
}
