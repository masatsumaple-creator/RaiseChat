// @vitest-environment jsdom
import type { MessageResponse, ServerToClientEvents } from '@raisechat/shared';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import type { Socket } from 'socket.io-client';
import { describe, expect, it, vi } from 'vitest';
import { channelsKey, messagesKey, repliesKey } from '../api/channels';
import type { MessagesData } from './cache';
import type { RepliesData } from './replies-cache';
import { applyServerEvents, resyncAfterReconnect } from './realtime';

function msg(id: number, authorId = 'u1'): MessageResponse {
  return {
    id,
    channelId: 'c1',
    author: { id: authorId, username: authorId, displayName: authorId, avatarUrl: null },
    body: `m${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    parentId: null,
    editedAt: null,
    replyCount: 0,
    reactions: [],
    mentions: [],
    deleted: false,
  };
}

/** socket.io-client の代わり。登録されたハンドラを、テストから呼べる */
function fakeSocket() {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const socket = {
    on: (event: string, fn: (...args: unknown[]) => void) => {
      handlers[event] = fn;
    },
  } as unknown as Socket<ServerToClientEvents>;
  return { socket, emit: (event: string, ...args: unknown[]) => handlers[event]!(...args) };
}

function twoPages(): MessagesData {
  return {
    pages: [
      { messages: [msg(5), msg(4)], nextCursor: 4 },
      { messages: [msg(3), msg(2)], nextCursor: null },
    ],
    pageParams: [undefined, 4],
  };
}

describe('applyServerEvents(受信したイベントを、キャッシュに反映する)', () => {
  it('message:created: 読み込み済みのチャンネルの先頭に加える。同じ ID は、重ねて加えない', () => {
    const client = new QueryClient();
    client.setQueryData(messagesKey('c1'), twoPages());
    const { socket, emit } = fakeSocket();
    applyServerEvents(socket, client);

    emit('message:created', msg(6));
    emit('message:created', msg(6)); // 投稿の応答と、イベントの両方で届いた場合
    const data = client.getQueryData<MessagesData>(messagesKey('c1'))!;
    expect(data.pages[0]!.messages.map((m) => m.id)).toEqual([6, 5, 4]);
  });

  it('message:created: 開いていない(読み込んでいない)チャンネルのキャッシュは、作らない', () => {
    const client = new QueryClient();
    const { socket, emit } = fakeSocket();
    applyServerEvents(socket, client);
    emit('message:created', msg(1));
    expect(client.getQueryData(messagesKey('c1'))).toBeUndefined();
  });

  it('message:created: 一覧を取得している最中(まだデータがない)に届いたら、その取得を取り消して、取り直す(応答が、この投稿より前の状態かもしれないため)', async () => {
    const client = new QueryClient();
    const loaded: MessagesData = {
      pages: [{ messages: [msg(1)], nextCursor: null }],
      pageParams: [undefined],
    };
    // 1 回目の取得は、終わらない(投稿より前の状態を読んだ応答が、遅れて届く場合を、表す)。2 回目は、投稿を含む
    const queryFn = vi
      .fn<() => Promise<MessagesData>>()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue(loaded);
    // 画面が、このクエリを使っている(購読している)状態
    const observer = new QueryObserver(client, { queryKey: messagesKey('c1'), queryFn });
    const unsubscribe = observer.subscribe(() => {});
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));
    expect(client.getQueryData(messagesKey('c1'))).toBeUndefined();

    const { socket, emit } = fakeSocket();
    applyServerEvents(socket, client);
    emit('message:created', msg(1));

    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(client.getQueryData(messagesKey('c1'))).toEqual(loaded));
    unsubscribe();
  });

  it('channel:created / channel:added: そのワークスペースのチャンネル一覧を、取り直す対象にする', () => {
    const client = new QueryClient();
    client.setQueryData(channelsKey('ws1'), []);
    client.setQueryData(channelsKey('ws2'), []);
    const { socket, emit } = fakeSocket();
    applyServerEvents(socket, client);

    emit('channel:created', { id: 'c9', workspaceId: 'ws1', type: 'public', name: 'x' });
    expect(client.getQueryState(channelsKey('ws1'))!.isInvalidated).toBe(true);
    expect(client.getQueryState(channelsKey('ws2'))!.isInvalidated).toBe(false);
  });

  it('channel:left: すべてのチャンネル一覧を、取り直す対象にする', () => {
    const client = new QueryClient();
    client.setQueryData(channelsKey('ws1'), []);
    client.setQueryData(channelsKey('ws2'), []);
    const { socket, emit } = fakeSocket();
    applyServerEvents(socket, client);
    emit('channel:left', { channelId: 'c1' });
    expect(client.getQueryState(channelsKey('ws1'))!.isInvalidated).toBe(true);
    expect(client.getQueryState(channelsKey('ws2'))!.isInvalidated).toBe(true);
  });

  it('user:updated: キャッシュ中のメッセージの投稿者の表示名を更新する', () => {
    const client = new QueryClient();
    client.setQueryData(messagesKey('c1'), {
      pages: [{ messages: [msg(2, 'u2'), msg(1, 'u1')], nextCursor: null }],
      pageParams: [undefined],
    } satisfies MessagesData);
    const { socket, emit } = fakeSocket();
    applyServerEvents(socket, client);
    emit('user:updated', {
      id: 'u1',
      username: 'u1',
      displayName: '改名',
      statusText: '',
      avatarUrl: null,
    });
    const data = client.getQueryData<MessagesData>(messagesKey('c1'))!;
    expect((data.pages[0]!.messages as MessageResponse[]).map((m) => m.author.displayName)).toEqual(
      ['u2', '改名'],
    );
  });
});

describe('applyServerEvents: 編集・削除', () => {
  function setup() {
    const client = new QueryClient();
    client.setQueryData(messagesKey('c1'), twoPages());
    const { socket, emit } = fakeSocket();
    applyServerEvents(socket, client);
    const read = () => client.getQueryData<MessagesData>(messagesKey('c1'))!.pages[0]!.messages;
    return { emit, read };
  }

  it('message:updated: 本文と「編集済み」を反映する', () => {
    const { emit, read } = setup();
    emit('message:updated', { ...msg(5), body: '直した', editedAt: '2026-01-02T00:00:00.000Z' });
    expect(read()[0]).toMatchObject({
      id: 5,
      body: '直した',
      editedAt: '2026-01-02T00:00:00.000Z',
    });
  });

  it('message:deleted: 返信があれば、削除済みの親にし、なければ、外す', () => {
    const { emit, read } = setup();
    emit('message:deleted', { id: 5, channelId: 'c1', replyCount: 2 });
    expect(read()[0]).toMatchObject({ id: 5, deleted: true, replyCount: 2 });
    emit('message:deleted', { id: 4, channelId: 'c1', replyCount: 0 });
    expect(read().map((m) => m.id)).toEqual([5]);
  });

  it('reaction:added / reaction:removed: リアクションの状態を反映する', () => {
    const { emit, read } = setup();
    emit('reaction:added', {
      messageId: 5,
      channelId: 'c1',
      emoji: '👍',
      count: 2,
      userIds: ['u1', 'u2'],
    });
    expect(read()[0]).toMatchObject({
      id: 5,
      reactions: [{ emoji: '👍', count: 2, userIds: ['u1', 'u2'] }],
    });
    emit('reaction:removed', {
      messageId: 5,
      channelId: 'c1',
      emoji: '👍',
      count: 1,
      userIds: ['u2'],
    });
    expect(read()[0]).toMatchObject({ reactions: [{ emoji: '👍', count: 1, userIds: ['u2'] }] });
    emit('reaction:removed', { messageId: 5, channelId: 'c1', emoji: '👍', count: 0, userIds: [] });
    expect(read()[0]).toMatchObject({ reactions: [] });
  });

  it('thread:reply-created: 親の返信数を更新する。返信は、一覧に加えない', () => {
    const { emit, read } = setup();
    emit('thread:reply-created', { reply: { ...msg(9), parentId: 5 }, replyCount: 3 });
    expect(read()[0]).toMatchObject({ id: 5, replyCount: 3 });
    expect(read().map((m) => m.id)).toEqual([5, 4]);
  });

  it('thread:reply-deleted: 親の返信数を更新する。返信は、一覧に加えない', () => {
    const { emit, read } = setup();
    emit('thread:reply-deleted', { id: 9, channelId: 'c1', parentId: 5, replyCount: 4 });
    expect(read()[0]).toMatchObject({ id: 5, replyCount: 4 });
    expect(read().map((m) => m.id)).toEqual([5, 4]);
  });
});

describe('applyServerEvents: スレッドのパネル(返信のキャッシュ)', () => {
  function setupReplies() {
    const client = new QueryClient();
    const reply = (id: number) => ({ ...msg(id), parentId: 5 });
    const initial: RepliesData = {
      pages: [{ parent: { ...msg(5), replyCount: 1 }, replies: [reply(9)], nextCursor: null }],
      pageParams: [undefined],
    };
    client.setQueryData(repliesKey(5), initial);
    const { socket, emit } = fakeSocket();
    applyServerEvents(socket, client);
    const read = () => client.getQueryData<RepliesData>(repliesKey(5))!.pages[0]!;
    return { emit, read, reply };
  }

  it('thread:reply-created: 返信を末尾に加え、親の返信数を更新する(重ねて届いても 1 件)', () => {
    const { emit, read, reply } = setupReplies();
    emit('thread:reply-created', { reply: reply(10), replyCount: 2 });
    emit('thread:reply-created', { reply: reply(10), replyCount: 2 });
    expect(read().replies.map((r) => r.id)).toEqual([9, 10]);
    expect(read().parent.replyCount).toBe(2);
  });

  it('thread:reply-updated / thread:reply-deleted: 返信を置き換え、外し、返信数を更新する', () => {
    const { emit, read, reply } = setupReplies();
    emit('thread:reply-updated', { ...reply(9), body: '直した' });
    expect(read().replies[0]!.body).toBe('直した');
    emit('thread:reply-deleted', { id: 9, channelId: 'c1', parentId: 5, replyCount: 0 });
    expect(read().replies).toEqual([]);
    expect(read().parent.replyCount).toBe(0);
  });

  it('message:updated / message:deleted: 開いている親に反映する', () => {
    const { emit, read } = setupReplies();
    emit('message:updated', { ...msg(5), body: '親を直した', replyCount: 1 });
    expect((read().parent as MessageResponse).body).toBe('親を直した');
    emit('message:deleted', { id: 5, channelId: 'c1', replyCount: 1 });
    expect(read().parent).toMatchObject({ id: 5, deleted: true, replyCount: 1 });
  });

  it('reaction:added: 返信のリアクションに反映する', () => {
    const { emit, read } = setupReplies();
    emit('reaction:added', {
      messageId: 9,
      channelId: 'c1',
      emoji: '👍',
      count: 1,
      userIds: ['u2'],
    });
    expect(read().replies[0]!.reactions).toEqual([{ emoji: '👍', count: 1, userIds: ['u2'] }]);
  });

  it('再接続のあと: 開いているスレッドの返信を、取り直す対象にする', () => {
    const { read } = setupReplies();
    expect(read()).toBeDefined();
    const client = new QueryClient();
    client.setQueryData(repliesKey(5), { pages: [], pageParams: [] });
    resyncAfterReconnect(client);
    expect(client.getQueryState(repliesKey(5))!.isInvalidated).toBe(true);
  });
});

describe('resyncAfterReconnect(再接続のあとの取り直し。設計書 §6.5)', () => {
  it('メッセージは先頭の 50 件のページだけを残して取り直す(古いページは捨てる)。一覧も取り直す対象にする', () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    client.setQueryData(messagesKey('c1'), twoPages());
    client.setQueryData(channelsKey('ws1'), []);

    resyncAfterReconnect(client);

    const data = client.getQueryData<MessagesData>(messagesKey('c1'))!;
    expect(data.pages).toHaveLength(1);
    expect(data.pages[0]!.messages.map((m) => m.id)).toEqual([5, 4]);
    expect(client.getQueryState(channelsKey('ws1'))!.isInvalidated).toBe(true);
    const keys = invalidate.mock.calls.map((c) => (c[0] as { queryKey: string[] }).queryKey[0]);
    expect(keys).toEqual(expect.arrayContaining(['workspaces', 'channels', 'messages']));
  });
});

describe('applyServerEvents: dm:created', () => {
  it('そのワークスペースのチャンネル一覧(DM を含む)を、取り直す対象にする', () => {
    const client = new QueryClient();
    client.setQueryData(channelsKey('ws1'), []);
    client.setQueryData(channelsKey('ws2'), []);
    const { socket, emit } = fakeSocket();
    applyServerEvents(socket, client);
    emit('dm:created', {
      id: 'd1',
      workspaceId: 'ws1',
      type: 'dm',
      name: null,
      isDefault: false,
      createdBy: null,
      peer: { id: 'u9', username: 'hanako', displayName: '花子', avatarUrl: null },
    });
    expect(client.getQueryState(channelsKey('ws1'))!.isInvalidated).toBe(true);
    expect(client.getQueryState(channelsKey('ws2'))!.isInvalidated).toBe(false);
  });
});
