import type { MessageResponse } from '@raisechat/shared';
import { describe, expect, it } from 'vitest';
import {
  addMessage,
  keepFirstPage,
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
    const [a, b] = next.pages[0]!.messages;
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
