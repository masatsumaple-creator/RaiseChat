import type { DeletedMessageResponse, MessageResponse } from '@raisechat/shared';
import { describe, expect, it } from 'vitest';
import {
  addMessage,
  applyMessageDeleted,
  applyReaction,
  keepFirstPage,
  replaceMessage,
  setReplyCount,
  toDisplayOrder,
  updateAuthor,
  type MessagesData,
} from './cache';

function msg(id: number, authorId = 'u1', body = `m${id}`): MessageResponse {
  return {
    id,
    channelId: 'c1',
    author: { id: authorId, username: authorId, displayName: authorId, avatarUrl: null },
    body,
    createdAt: '2026-01-01T00:00:00.000Z',
    parentId: null,
    editedAt: null,
    replyCount: 0,
    reactions: [],
    mentions: [],
    attachments: [],
    deleted: false,
  };
}

/** 新しい順の 2 ページ(5,4 と 3,2) */
function data(): MessagesData {
  return {
    pages: [
      { messages: [msg(5), msg(4)], nextCursor: 4 },
      { messages: [msg(3), msg(2)], nextCursor: null },
    ],
    pageParams: [undefined, 4],
  };
}

describe('addMessage', () => {
  it('先頭のページの先頭に加える', () => {
    const next = addMessage(data(), msg(6))!;
    expect(next.pages[0]!.messages.map((m) => m.id)).toEqual([6, 5, 4]);
    expect(next.pages[1]!.messages.map((m) => m.id)).toEqual([3, 2]);
  });

  it('すでにある ID は、加えない(どのページにあっても)。同じオブジェクトを返す', () => {
    const d = data();
    expect(addMessage(d, msg(5))).toBe(d);
    expect(addMessage(d, msg(2))).toBe(d);
  });

  it('読み込んでいない一覧には、加えない', () => {
    expect(addMessage(undefined, msg(1))).toBeUndefined();
  });

  it('元のデータを変更しない', () => {
    const d = data();
    addMessage(d, msg(6));
    expect(d.pages[0]!.messages).toHaveLength(2);
  });

  it('空の一覧(メッセージなし)にも、加えられる', () => {
    const empty: MessagesData = {
      pages: [{ messages: [], nextCursor: null }],
      pageParams: [undefined],
    };
    expect(addMessage(empty, msg(1))!.pages[0]!.messages.map((m) => m.id)).toEqual([1]);
  });
});

describe('keepFirstPage(再接続後の取り直し)', () => {
  it('先頭のページだけを残す', () => {
    const next = keepFirstPage(data())!;
    expect(next.pages).toHaveLength(1);
    expect(next.pageParams).toEqual([undefined]);
    expect(next.pages[0]!.nextCursor).toBe(4);
  });

  it('1 ページ以下なら、そのまま', () => {
    const one: MessagesData = {
      pages: [{ messages: [], nextCursor: null }],
      pageParams: [undefined],
    };
    expect(keepFirstPage(one)).toBe(one);
    expect(keepFirstPage(undefined)).toBeUndefined();
  });
});

describe('updateAuthor', () => {
  it('その人の投稿の表示名・アバターだけを更新する', () => {
    const d: MessagesData = {
      pages: [{ messages: [msg(2, 'u2'), msg(1, 'u1')], nextCursor: null }],
      pageParams: [undefined],
    };
    const next = updateAuthor(d, {
      id: 'u1',
      username: 'u1',
      displayName: '新しい名前',
      statusText: '',
      avatarUrl: '/api/users/u1/avatar?v=x',
    })!;
    const [a, b] = next.pages[0]!.messages as MessageResponse[];
    expect(a!.author.displayName).toBe('u2');
    expect(b!.author).toMatchObject({
      displayName: '新しい名前',
      avatarUrl: '/api/users/u1/avatar?v=x',
    });
  });
});

describe('toDisplayOrder', () => {
  it('古い順に並べ、ページをまたいだ重複を除く', () => {
    const d = data();
    d.pages[1]!.messages.unshift(msg(4)); // ページの境目で、重なった場合
    expect(toDisplayOrder(d).map((m) => m.id)).toEqual([2, 3, 4, 5]);
    expect(toDisplayOrder(undefined)).toEqual([]);
  });
});

describe('replaceMessage(message:updated)', () => {
  it('同じ ID のメッセージを、編集後のものに置き換える', () => {
    const edited = { ...msg(4), body: '編集後', editedAt: '2026-01-02T00:00:00.000Z' };
    const next = replaceMessage(data(), edited)!;
    expect(next.pages[0]!.messages[1]).toEqual(edited);
    expect(next.pages[0]!.messages[0]!.id).toBe(5);
  });

  it('一覧にないものは、何もしない(同じオブジェクトを返す)。削除済みは、削除を優先する', () => {
    const d = data();
    expect(replaceMessage(d, msg(99))).toBe(d);
    const withDeleted = applyMessageDeleted(d, { id: 4, replyCount: 2 })!;
    // 削除の後に、古い編集が届いても、戻さない
    expect(replaceMessage(withDeleted, { ...msg(4), body: '古い編集' })).toBe(withDeleted);
    expect(replaceMessage(undefined, msg(1))).toBeUndefined();
  });
});

describe('applyMessageDeleted(message:deleted)', () => {
  it('返信が残っていれば、本文のない「削除済みの親」にする(返信数つき)', () => {
    const next = applyMessageDeleted(data(), { id: 4, replyCount: 3 })!;
    const placeholder = next.pages[0]!.messages[1] as DeletedMessageResponse;
    expect(placeholder).toEqual({
      id: 4,
      channelId: 'c1',
      createdAt: '2026-01-01T00:00:00.000Z',
      replyCount: 3,
      deleted: true,
    });
    expect(JSON.stringify(next)).not.toContain('"m4"'); // 本文は残らない
  });

  it('返信がなければ、一覧から外す', () => {
    const next = applyMessageDeleted(data(), { id: 5, replyCount: 0 })!;
    expect(next.pages[0]!.messages.map((m) => m.id)).toEqual([4]);
  });

  it('一覧にない ID は、何もしない', () => {
    const d = data();
    expect(applyMessageDeleted(d, { id: 99, replyCount: 0 })).toBe(d);
  });
});

describe('setReplyCount(thread:reply-deleted)', () => {
  it('親の返信数を更新する', () => {
    const next = setReplyCount(data(), 4, 7)!;
    expect((next.pages[0]!.messages[1] as MessageResponse).replyCount).toBe(7);
  });

  it('削除済みの親は、返信が 0 になったら、一覧から外す。通常の親は、残す', () => {
    const deleted = applyMessageDeleted(data(), { id: 4, replyCount: 1 })!;
    expect(setReplyCount(deleted, 4, 0)!.pages[0]!.messages.map((m) => m.id)).toEqual([5]);
    const normal = setReplyCount(data(), 4, 0)!;
    expect(normal.pages[0]!.messages.map((m) => m.id)).toEqual([5, 4]);
  });

  it('変化がなければ、同じオブジェクトを返す', () => {
    const d = data();
    expect(setReplyCount(d, 4, 0)).toBe(d);
  });
});

describe('applyReaction(reaction:added / reaction:removed)', () => {
  const state = (emoji: string, userIds: string[]) => ({
    messageId: 4,
    channelId: 'c1',
    emoji,
    count: userIds.length,
    userIds,
  });
  const reactionsOf = (d: MessagesData | undefined, id: number) =>
    (d!.pages[0]!.messages.find((m) => m.id === id) as MessageResponse).reactions;

  it('新しい絵文字は、末尾に加わる。すでにある絵文字は、位置を変えず、状態で置き換える', () => {
    let d = applyReaction(data(), state('👍', ['u1']))!;
    d = applyReaction(d, state('❤️', ['u2']))!;
    expect(reactionsOf(d, 4).map((r) => r.emoji)).toEqual(['👍', '❤️']);
    d = applyReaction(d, state('👍', ['u1', 'u3']))!;
    expect(reactionsOf(d, 4)).toEqual([
      { emoji: '👍', count: 2, userIds: ['u1', 'u3'] },
      { emoji: '❤️', count: 1, userIds: ['u2'] },
    ]);
  });

  it('件数が 0 なら、その絵文字を外す。ない絵文字の解除は、何もしない', () => {
    let d = applyReaction(data(), state('👍', ['u1']))!;
    const removed = applyReaction(d, state('👍', []))!;
    expect(reactionsOf(removed, 4)).toEqual([]);
    d = removed;
    expect(applyReaction(d, state('👍', []))).toBe(d);
  });

  it('同じ状態が重ねて届いても、同じ結果(冪等)。一覧にないメッセージには、何もしない', () => {
    const once = applyReaction(data(), state('👍', ['u1']))!;
    const twice = applyReaction(once, state('👍', ['u1']))!;
    expect(reactionsOf(twice, 4)).toEqual(reactionsOf(once, 4));
    const d = data();
    expect(applyReaction(d, { ...state('👍', ['u1']), messageId: 99 })).toBe(d);
    expect(applyReaction(undefined, state('👍', ['u1']))).toBeUndefined();
  });

  it('削除済みの親には、何もしない', () => {
    const deleted = applyMessageDeleted(data(), { id: 4, replyCount: 1 })!;
    expect(applyReaction(deleted, state('👍', ['u1']))).toBe(deleted);
  });
});
