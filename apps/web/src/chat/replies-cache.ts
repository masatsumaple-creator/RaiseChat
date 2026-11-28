import type {
  DeletedMessageResponse,
  MessageListItem,
  MessageResponse,
  ReactionEventPayload,
  ReactionSummary,
  ReplyPageResponse,
  UserUpdatedPayload,
} from '@raisechat/shared';
import type { InfiniteData } from '@tanstack/react-query';

/** スレッドの返信のキャッシュ(GET /messages/:id/replies)。ページは、古い返信が先 */
export type RepliesData = InfiniteData<ReplyPageResponse, unknown>;

/** 絵文字の、いまの状態(件数と付けた人)で置き換える。件数が 0 なら外す。位置は変えず、新しい絵文字は末尾 */
export function withReaction(
  reactions: ReactionSummary[],
  state: ReactionSummary,
): ReactionSummary[] {
  const index = reactions.findIndex((r) => r.emoji === state.emoji);
  if (state.count <= 0) return index < 0 ? reactions : reactions.filter((_, i) => i !== index);
  const next = { emoji: state.emoji, count: state.count, userIds: state.userIds };
  if (index < 0) return [...reactions, next];
  return reactions.map((r, i) => (i === index ? next : r));
}

function mapParent(
  data: RepliesData,
  parentId: number,
  fn: (parent: MessageListItem) => MessageListItem,
): RepliesData {
  const first = data.pages[0];
  if (!first || first.parent.id !== parentId) return data;
  const parent = fn(first.parent);
  if (parent === first.parent) return data;
  return { ...data, pages: data.pages.map((p) => ({ ...p, parent })) };
}

function mapReplies(
  data: RepliesData,
  fn: (reply: MessageResponse) => MessageResponse | null,
): RepliesData {
  let changed = false;
  const pages = data.pages.map((page) => {
    const replies: MessageResponse[] = [];
    for (const reply of page.replies) {
      const next = fn(reply);
      if (next !== reply) changed = true;
      if (next !== null) replies.push(next);
    }
    return { ...page, replies };
  });
  return changed ? { ...data, pages } : data;
}

/**
 * 新しい返信(thread:reply-created と、投稿の応答)を、末尾に加え、親の返信数を更新する。
 * 同じ ID は加えない(冪等)。まだ続きのページがあるときは、加えない(順序に穴ができるため。続きを読むときに、取れる)。
 */
export function addReply(
  data: RepliesData | undefined,
  reply: MessageResponse,
  replyCount: number,
): RepliesData | undefined {
  if (!data || reply.parentId === null) return data;
  const first = data.pages[0];
  if (!first || first.parent.id !== reply.parentId) return data;
  const next = mapParent(data, reply.parentId, (p) =>
    p.replyCount === replyCount ? p : { ...p, replyCount },
  );
  const exists = next.pages.some((p) => p.replies.some((r) => r.id === reply.id));
  const lastIndex = next.pages.length - 1;
  if (exists || next.pages[lastIndex]!.nextCursor !== null) return next;
  return {
    ...next,
    pages: next.pages.map((p, i) =>
      i === lastIndex ? { ...p, replies: [...p.replies, reply] } : p,
    ),
  };
}

/** 編集された返信(thread:reply-updated)で置き換える */
export function replaceReply(
  data: RepliesData | undefined,
  reply: MessageResponse,
): RepliesData | undefined {
  if (!data) return data;
  return mapReplies(data, (r) => (r.id === reply.id ? reply : r));
}

/** 削除された返信(thread:reply-deleted)を外し、親の返信数を更新する */
export function removeReply(
  data: RepliesData | undefined,
  deleted: { id: number; parentId: number; replyCount: number },
): RepliesData | undefined {
  if (!data) return data;
  const next = mapReplies(data, (r) => (r.id === deleted.id ? null : r));
  return mapParent(next, deleted.parentId, (p) =>
    p.replyCount === deleted.replyCount ? p : { ...p, replyCount: deleted.replyCount },
  );
}

/** 親の編集(message:updated)を反映する。削除済みの親は、戻さない */
export function replaceParent(
  data: RepliesData | undefined,
  message: MessageResponse,
): RepliesData | undefined {
  if (!data) return data;
  return mapParent(data, message.id, (p) => (p.deleted ? p : message));
}

/** 親の削除(message:deleted)を反映する。「削除されました」の親にする */
export function markParentDeleted(
  data: RepliesData | undefined,
  deleted: { id: number; replyCount: number },
): RepliesData | undefined {
  if (!data) return data;
  return mapParent(data, deleted.id, (p) => {
    if (p.deleted) return p;
    const placeholder: DeletedMessageResponse = {
      id: p.id,
      channelId: p.channelId,
      createdAt: p.createdAt,
      replyCount: deleted.replyCount,
      deleted: true,
    };
    return placeholder;
  });
}

/** リアクション(reaction:added / reaction:removed と、操作の応答)を、親と返信に反映する */
export function applyReactionToReplies(
  data: RepliesData | undefined,
  payload: Pick<ReactionEventPayload, 'messageId'> & ReactionSummary,
): RepliesData | undefined {
  if (!data) return data;
  const next = mapReplies(data, (r) =>
    r.id === payload.messageId ? { ...r, reactions: withReaction(r.reactions, payload) } : r,
  );
  return mapParent(next, payload.messageId, (p) =>
    p.deleted ? p : { ...p, reactions: withReaction(p.reactions, payload) },
  );
}

/** 表示名・アバターの変更を、親と返信の投稿者に反映する */
export function updateReplyAuthor(
  data: RepliesData | undefined,
  user: UserUpdatedPayload,
): RepliesData | undefined {
  if (!data) return data;
  const author = (a: MessageResponse['author']) => ({
    ...a,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
  });
  const next = mapReplies(data, (r) =>
    r.author.id === user.id ? { ...r, author: author(r.author) } : r,
  );
  const first = next.pages[0];
  if (!first || first.parent.deleted || first.parent.author.id !== user.id) return next;
  const parent = { ...first.parent, author: author(first.parent.author) };
  return { ...next, pages: next.pages.map((p) => ({ ...p, parent })) };
}

/** 表示用: 全ページの返信を、古い順に(同じ ID は 1 つ) */
export function allReplies(data: RepliesData | undefined): MessageResponse[] {
  if (!data) return [];
  const byId = new Map<number, MessageResponse>();
  for (const page of data.pages) for (const r of page.replies) byId.set(r.id, r);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}
