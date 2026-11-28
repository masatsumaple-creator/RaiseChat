import type { MessageResponse } from '@raisechat/shared';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import {
  addReaction,
  deleteMessage,
  editMessage,
  listReplies,
  postReply,
  removeReaction,
  repliesKey,
} from '../api/channels';
import { errorMessage } from '../api/client';
import { useMe } from '../api/me';
import { MessageComposer } from './MessageComposer';
import { MessageItem } from './MessageItem';
import { useChannelNames } from './MessageList';
import {
  addReply,
  allReplies,
  applyReactionToReplies,
  removeReply,
  replaceParent,
  replaceReply,
  type RepliesData,
} from './replies-cache';

/**
 * スレッドのパネル(FR-105)。親と、返信の一覧(古い順)、返信の投稿・編集・削除、リアクション。
 * 親が削除済みなら、「削除されました」と表示して、返信は残す(返信の投稿はできない)。
 */
export function ThreadPanel({
  channelId,
  rootId,
  onClose,
}: {
  channelId: string;
  rootId: number;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { data: me } = useMe();
  const names = useChannelNames(channelId);
  const key = repliesKey(rootId);
  const query = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam, signal }) => listReplies(rootId, pageParam, signal),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    retry: false,
  });

  const parent = query.data?.pages[0]?.parent;
  const replies = allReplies(query.data);
  const update = (fn: (data: RepliesData | undefined) => RepliesData | undefined) =>
    queryClient.setQueryData<RepliesData>(key, fn);

  async function send(body: string) {
    const reply = await postReply(rootId, body);
    // thread:reply-created が先に届いていても、同じ ID は重ねない。返信数は、イベントで更新される
    update((data) => addReply(data, reply, (parent?.replyCount ?? 0) + 1));
  }

  async function edit(reply: MessageResponse, body: string) {
    const updated = await editMessage(reply.id, body);
    update((data) => replaceReply(data, updated));
  }

  async function remove(reply: MessageResponse) {
    await deleteMessage(reply.id);
    update((data) =>
      removeReply(data, {
        id: reply.id,
        parentId: rootId,
        replyCount: Math.max(0, (parent?.replyCount ?? 1) - 1),
      }),
    );
  }

  /** 返信・親の、リアクションの付与・解除 */
  async function toggle(target: MessageResponse, emoji: string, mine: boolean) {
    if (mine) {
      await removeReaction(target.id, emoji);
      const rest = (target.reactions.find((r) => r.emoji === emoji)?.userIds ?? []).filter(
        (id) => id !== me?.id,
      );
      update((data) =>
        applyReactionToReplies(data, {
          messageId: target.id,
          emoji,
          count: rest.length,
          userIds: rest,
        }),
      );
      return;
    }
    const state = await addReaction(target.id, emoji);
    update((data) => applyReactionToReplies(data, { messageId: target.id, ...state }));
  }

  return (
    <aside className="thread-panel" aria-label="スレッド">
      <header>
        <h3>スレッド</h3>
        <button type="button" onClick={onClose}>
          閉じる
        </button>
      </header>
      {query.isPending && <p role="status">読み込み中…</p>}
      {query.isError && (
        <div role="alert">
          <p>{errorMessage(query.error)}</p>
          <button type="button" onClick={() => void query.refetch()}>
            再試行
          </button>
        </div>
      )}
      {parent && (
        <>
          <ul aria-label="スレッドの親">
            {parent.deleted ? (
              <li className="message-deleted">このメッセージは、削除されました。</li>
            ) : (
              <MessageItem
                message={parent}
                myId={me?.id}
                names={names}
                onEdit={async (body) => {
                  const updated = await editMessage(parent.id, body);
                  update((data) => replaceParent(data, updated));
                }}
                onDelete={async () => {
                  await deleteMessage(parent.id);
                  await query.refetch();
                }}
                onToggleReaction={(emoji, mine) => toggle(parent, emoji, mine)}
              />
            )}
          </ul>
          <p className="reply-count">返信 {parent.replyCount} 件</p>
          <ul aria-label="返信一覧">
            {replies.map((r) => (
              <MessageItem
                key={r.id}
                message={r}
                myId={me?.id}
                names={names}
                onEdit={(body) => edit(r, body)}
                onDelete={() => remove(r)}
                onToggleReaction={(emoji, mine) => toggle(r, emoji, mine)}
              />
            ))}
          </ul>
          {query.hasNextPage && (
            <button
              type="button"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              続きの返信を読み込む
            </button>
          )}
          {!parent.deleted && <MessageComposer onSend={send} label="返信" />}
        </>
      )}
    </aside>
  );
}
