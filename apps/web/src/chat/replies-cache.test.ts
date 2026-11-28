import type { MessageResponse } from '@raisechat/shared';
import { describe, expect, it } from 'vitest';
import {
  addReply,
  allReplies,
  applyReactionToReplies,
  markParentDeleted,
  removeReply,
  replaceParent,
  replaceReply,
  withReaction,
  type RepliesData,
} from './replies-cache';

function msg(id: number, parentId: number | null = null, extra: Partial<MessageResponse> = {}) {
  return {
    id,
    channelId: 'c1',
    author: { id: 'u1', username: 'u1', displayName: 'u1', avatarUrl: null },
    body: `m${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    parentId,
    editedAt: null,
    replyCount: 0,
    reactions: [],
    mentions: [],
    deleted: false,
    ...extra,
  } as MessageResponse;
}

/** 親 10(返信 2 件)、返信 11・12 */
function data(nextCursor: number | null = null): RepliesData {
  return {
    pages: [
      {
        parent: msg(10, null, { replyCount: 2 }),
        replies: [msg(11, 10), msg(12, 10)],
        nextCursor,
      },
    ],
    pageParams: [undefined],
  };
}

describe('withReaction', () => {
  it('新しい絵文字は末尾に加え、既存は位置を変えずに置き換え、件数 0 で外す', () => {
    const a = { emoji: '👍', count: 1, userIds: ['u1'] };
    const b = { emoji: '🎉', count: 1, userIds: ['u2'] };
    expect(withReaction([a], b)).toEqual([a, b]);
    expect(withReaction([a, b], { ...a, count: 2, userIds: ['u1', 'u3'] })).toEqual([
      { ...a, count: 2, userIds: ['u1', 'u3'] },
      b,
    ]);
    expect(withReaction([a, b], { emoji: '👍', count: 0, userIds: [] })).toEqual([b]);
    const same = [a];
    expect(withReaction(same, { emoji: '😀', count: 0, userIds: [] })).toBe(same);
  });
});

describe('addReply', () => {
  it('末尾に加え、親の返信数を更新する。同じ ID は重ねない(冪等)', () => {
    const next = addReply(data(), msg(13, 10), 3)!;
    expect(next.pages[0]!.replies.map((r) => r.id)).toEqual([11, 12, 13]);
    expect(next.pages[0]!.parent.replyCount).toBe(3);
    const again = addReply(next, msg(13, 10), 3)!;
    expect(again.pages[0]!.replies.map((r) => r.id)).toEqual([11, 12, 13]);
  });

  it('続きのページがあるときは、返信は加えず、返信数だけ更新する', () => {
    const next = addReply(data(12), msg(13, 10), 3)!;
    expect(next.pages[0]!.replies.map((r) => r.id)).toEqual([11, 12]);
    expect(next.pages[0]!.parent.replyCount).toBe(3);
  });

  it('別のスレッドの返信・キャッシュなしは、何もしない', () => {
    const d = data();
    expect(addReply(d, msg(20, 99), 1)).toBe(d);
    expect(addReply(undefined, msg(13, 10), 3)).toBeUndefined();
  });
});

describe('replaceReply / removeReply', () => {
  it('編集された返信で置き換える', () => {
    const next = replaceReply(data(), msg(12, 10, { body: '直した' }))!;
    expect(next.pages[0]!.replies[1]!.body).toBe('直した');
  });

  it('削除された返信を外し、親の返信数を更新する。すでにない返信でも、返信数は更新する', () => {
    const next = removeReply(data(), { id: 11, parentId: 10, replyCount: 1 })!;
    expect(next.pages[0]!.replies.map((r) => r.id)).toEqual([12]);
    expect(next.pages[0]!.parent.replyCount).toBe(1);
    const again = removeReply(next, { id: 11, parentId: 10, replyCount: 1 })!;
    expect(again).toBe(next);
  });
});

describe('親の更新', () => {
  it('編集で置き換える。削除済みの親は、戻さない', () => {
    const next = replaceParent(data(), msg(10, null, { body: '親を直した', replyCount: 2 }))!;
    expect((next.pages[0]!.parent as MessageResponse).body).toBe('親を直した');
    const deleted = markParentDeleted(data(), { id: 10, replyCount: 2 })!;
    expect(deleted.pages[0]!.parent).toMatchObject({ id: 10, deleted: true, replyCount: 2 });
    expect(replaceParent(deleted, msg(10))).toBe(deleted);
  });

  it('別の親の更新は、何もしない', () => {
    const d = data();
    expect(replaceParent(d, msg(99))).toBe(d);
    expect(markParentDeleted(d, { id: 99, replyCount: 0 })).toBe(d);
  });
});

describe('applyReactionToReplies', () => {
  it('返信にも、親にも反映する(その絵文字の、いまの状態で置き換える)', () => {
    const state = { emoji: '👍', count: 1, userIds: ['u1'] };
    let next = applyReactionToReplies(data(), { messageId: 12, ...state })!;
    expect(next.pages[0]!.replies[1]!.reactions).toEqual([state]);
    next = applyReactionToReplies(next, { messageId: 10, ...state })!;
    expect((next.pages[0]!.parent as MessageResponse).reactions).toEqual([state]);
    // 重ねて届いても、同じ結果
    const again = applyReactionToReplies(next, { messageId: 10, ...state })!;
    expect((again.pages[0]!.parent as MessageResponse).reactions).toEqual([state]);
    next = applyReactionToReplies(next, { messageId: 12, emoji: '👍', count: 0, userIds: [] })!;
    expect(next.pages[0]!.replies[1]!.reactions).toEqual([]);
  });

  it('削除済みの親には、反映しない', () => {
    const deleted = markParentDeleted(data(), { id: 10, replyCount: 2 })!;
    const next = applyReactionToReplies(deleted, {
      messageId: 10,
      emoji: '👍',
      count: 1,
      userIds: ['u1'],
    })!;
    expect(next.pages[0]!.parent.deleted).toBe(true);
  });
});

describe('allReplies', () => {
  it('古い順に、同じ ID は 1 つに', () => {
    const d: RepliesData = {
      pages: [
        { parent: msg(10), replies: [msg(12, 10), msg(11, 10)], nextCursor: 12 },
        { parent: msg(10), replies: [msg(12, 10), msg(13, 10)], nextCursor: null },
      ],
      pageParams: [undefined, 12],
    };
    expect(allReplies(d).map((r) => r.id)).toEqual([11, 12, 13]);
    expect(allReplies(undefined)).toEqual([]);
  });
});
