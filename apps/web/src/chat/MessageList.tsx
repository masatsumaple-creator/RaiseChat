import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useLayoutEffect, useRef } from 'react';
import { listMessages, messagesKey, postMessage } from '../api/channels';
import { errorMessage } from '../api/client';
import { addMessage, toDisplayOrder, type MessagesData } from './cache';
import { MessageComposer } from './MessageComposer';

/** 下端から、この距離(px)以内なら、「最新を見ている」とみなして、新しい投稿で下へ追従する */
const NEAR_BOTTOM_PX = 80;

/** チャンネルのメッセージ(FR-101)。古い順に表示し、新しい投稿は、WebSocket と投稿の応答で加わる */
export function MessageList({ channelId }: { channelId: string }) {
  const queryClient = useQueryClient();
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

  async function send(body: string) {
    const message = await postMessage(channelId, body);
    // WebSocket が届かなくても、自分の投稿は見えるようにする(同じ ID は、重ねて加えない)
    queryClient.setQueryData<MessagesData>(messagesKey(channelId), (data) =>
      addMessage(data, message),
    );
    stickToBottom.current = true;
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
              // 返信が残っている親だけが、一覧に出る(FR-105)
              <li key={m.id} className="message-deleted">
                このメッセージは、削除されました。
                {m.replyCount > 0 && <span>(返信 {m.replyCount} 件)</span>}
              </li>
            ) : (
              <li key={m.id}>
                {m.author.avatarUrl && (
                  <img src={m.author.avatarUrl} alt="" width={24} height={24} />
                )}
                <strong>{m.author.displayName}</strong>{' '}
                <time dateTime={m.createdAt}>{new Date(m.createdAt).toLocaleString('ja-JP')}</time>
                {m.editedAt && <span className="edited">(編集済み)</span>}
                <div className="message-body">{m.body}</div>
                {m.replyCount > 0 && <div className="reply-count">返信 {m.replyCount} 件</div>}
              </li>
            ),
          )}
        </ul>
      </div>
      <MessageComposer onSend={send} />
    </div>
  );
}
