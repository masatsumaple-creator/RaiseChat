import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import type { MessageResponse } from '@raisechat/shared';
import { useLayoutEffect, useRef, useState } from 'react';
import {
  deleteMessage,
  editMessage,
  listMessages,
  messagesKey,
  postMessage,
} from '../api/channels';
import { errorMessage } from '../api/client';
import { useMe } from '../api/me';
import {
  addMessage,
  applyMessageDeleted,
  replaceMessage,
  toDisplayOrder,
  type MessagesData,
} from './cache';
import { Markdown } from './Markdown';
import { MessageComposer } from './MessageComposer';
import { MessageEditor } from './MessageEditor';

/** 下端から、この距離(px)以内なら、「最新を見ている」とみなして、新しい投稿で下へ追従する */
const NEAR_BOTTOM_PX = 80;

/**
 * メッセージ 1 件。本文は、マークダウンで整形して表示する(FR-106)。
 * 自分のメッセージは、編集(FR-103)と削除(確認つき。FR-104)ができる。
 */
function MessageItem({
  message: m,
  mine,
  onEdit,
  onDelete,
}: {
  message: MessageResponse;
  mine: boolean;
  onEdit: (body: string) => Promise<unknown>;
  onDelete: () => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setDeleting(true);
    setError(null);
    try {
      await onDelete();
    } catch (e) {
      setError(errorMessage(e));
      setDeleting(false);
    }
  }

  return (
    <li>
      {m.author.avatarUrl && <img src={m.author.avatarUrl} alt="" width={24} height={24} />}
      <strong>{m.author.displayName}</strong>{' '}
      <time dateTime={m.createdAt}>{new Date(m.createdAt).toLocaleString('ja-JP')}</time>
      {m.editedAt && <span className="edited">(編集済み)</span>}
      {editing ? (
        <MessageEditor
          initialBody={m.body}
          onSave={async (body) => {
            await onEdit(body);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <Markdown>{m.body}</Markdown>
      )}
      {m.replyCount > 0 && <div className="reply-count">返信 {m.replyCount} 件</div>}
      {mine && !editing && (
        <div className="message-actions">
          {confirming ? (
            <>
              <span>このメッセージを削除しますか?</span>
              <button type="button" disabled={deleting} onClick={() => void remove()}>
                削除する
              </button>
              <button type="button" disabled={deleting} onClick={() => setConfirming(false)}>
                キャンセル
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => setEditing(true)}>
                編集
              </button>
              <button type="button" onClick={() => setConfirming(true)}>
                削除
              </button>
            </>
          )}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </li>
  );
}

/** チャンネルのメッセージ(FR-101)。古い順に表示し、新しい投稿は、WebSocket と投稿の応答で加わる */
export function MessageList({ channelId }: { channelId: string }) {
  const queryClient = useQueryClient();
  const { data: me } = useMe();
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
              <MessageItem
                key={m.id}
                message={m}
                mine={m.author.id === me?.id}
                onEdit={(body) => edit(m, body)}
                onDelete={() => remove(m)}
              />
            ),
          )}
        </ul>
      </div>
      <MessageComposer onSend={send} />
    </div>
  );
}
