import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { AddressInfo } from 'node:net';
import { io as connectIo, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { channelMembers, memberships, messages } from '../db/schema';
import { SESSION_COOKIE_NAME } from '../session-cookie';
import { LocalDiskStorage } from '../storage/storage';
import { createTestDatabase } from '../test/db';
import { makeTempDir } from '../test/files';

const ORIGIN = 'http://localhost:5173';
const PASSWORD = 'correct-horse-battery';
const NOT_FOUND = { code: 'not_found', message: '見つかりません。' };

let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
let temp: Awaited<ReturnType<typeof makeTempDir>>;
let storage: LocalDiskStorage;
const apps: FastifyInstance[] = [];
const sockets: ClientSocket[] = [];
let counter = 0;

beforeAll(async () => {
  testDb = await createTestDatabase();
  temp = await makeTempDir();
  storage = new LocalDiskStorage(temp.dir);
});

afterAll(async () => {
  await testDb.close();
  await temp.close();
});

afterEach(async () => {
  for (const s of sockets.splice(0)) s.disconnect();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function makeApp() {
  const config = loadConfig({ ALLOWED_ORIGIN: ORIGIN });
  const app = buildApp({ config, db: testDb.db, storage, logger: false });
  apps.push(app);
  return app;
}

interface TestUser {
  username: string;
  token: string;
  id: string;
}

async function createUser(app: FastifyInstance): Promise<TestUser> {
  counter += 1;
  const username = `edit_user_${counter}`;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { origin: ORIGIN },
    payload: { username, password: PASSWORD },
    remoteAddress: `10.160.${Math.floor(counter / 250)}.${counter % 250}`,
  });
  expect(res.statusCode).toBe(201);
  const token = res.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;
  return { username, token, id: res.json().user.id as string };
}

function send(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  user: TestUser | undefined,
  url: string,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    headers: { origin: ORIGIN },
    cookies: user ? { [SESSION_COOKIE_NAME]: user.token } : {},
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

async function newWorkspace(app: FastifyInstance, owner: TestUser) {
  const res = await send(app, 'POST', owner, '/api/workspaces', { name: 'チーム' });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function addMember(workspaceId: string, user: TestUser) {
  await testDb.db.insert(memberships).values({ workspaceId, userId: user.id, role: 'member' });
}

async function createChannel(
  app: FastifyInstance,
  user: TestUser,
  ws: string,
  name: string,
  type: 'public' | 'private' = 'public',
) {
  const res = await send(app, 'POST', user, `/api/workspaces/${ws}/channels`, { name, type });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

async function join(app: FastifyInstance, user: TestUser, ch: string) {
  expect((await send(app, 'POST', user, `/api/channels/${ch}/join`)).statusCode).toBe(200);
}

const post = async (app: FastifyInstance, user: TestUser, ch: string, body: string) => {
  const res = await send(app, 'POST', user, `/api/channels/${ch}/messages`, { body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: number };
};
const patch = (
  app: FastifyInstance,
  user: TestUser | undefined,
  id: number | string,
  body: unknown,
) => send(app, 'PATCH', user, `/api/messages/${id}`, body);
const del = (app: FastifyInstance, user: TestUser | undefined, id: number | string) =>
  send(app, 'DELETE', user, `/api/messages/${id}`);
const list = (app: FastifyInstance, user: TestUser, ch: string) =>
  send(app, 'GET', user, `/api/channels/${ch}/messages`);

async function row(id: number) {
  const [r] = await testDb.db.select().from(messages).where(eq(messages.id, id));
  return r!;
}

/** 返信を、DB に直接作る(返信を作る API は T18)。deleted なら、削除済みの返信 */
async function insertReply(
  channelId: string,
  parentId: number,
  user: TestUser,
  options: { deleted?: boolean; body?: string } = {},
) {
  const [r] = await testDb.db
    .insert(messages)
    .values(
      options.deleted
        ? { channelId, parentId, userId: user.id, body: null, deletedAt: new Date() }
        : { channelId, parentId, userId: user.id, body: options.body ?? '返信' },
    )
    .returning();
  return r!;
}

/** 参加者の 2 人と、部外者がいる、パブリックチャンネル */
async function setup() {
  const app = makeApp();
  const owner = await createUser(app);
  const member = await createUser(app);
  const bystander = await createUser(app); // 同じワークスペースで、チャンネルに未参加
  const outsider = await createUser(app); // 別のワークスペース
  const ws = await newWorkspace(app, owner);
  await newWorkspace(app, outsider);
  await addMember(ws, member);
  await addMember(ws, bystander);
  const ch = await createChannel(app, owner, ws, 'talk');
  await join(app, member, ch);
  return { app, owner, member, bystander, outsider, ws, ch };
}

describe('PATCH /api/messages/:id(FR-103)', () => {
  it('投稿者は編集できる。本文と「編集済み」の日時が変わり、一覧にも反映される', async () => {
    const { app, owner, ch } = await setup();
    const { id } = await post(app, owner, ch, '最初');
    const res = await patch(app, owner, id, { body: '  直した\n二行目  ' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id,
      channelId: ch,
      parentId: null,
      body: '  直した\n二行目  ', // 入力されたまま
      replyCount: 0,
      deleted: false,
      author: { id: owner.id },
      editedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    const stored = await row(id);
    expect(stored.body).toBe('  直した\n二行目  ');
    expect(stored.editedAt).not.toBeNull();
    const first = (await list(app, owner, ch)).json().messages[0];
    expect(first).toMatchObject({ id, body: '  直した\n二行目  ', editedAt: res.json().editedAt });
  });

  it('編集を重ねると、「編集済み」の日時が更新される', async () => {
    const { app, owner, ch } = await setup();
    const { id } = await post(app, owner, ch, 'a');
    const first = (await patch(app, owner, id, { body: 'b' })).json().editedAt as string;
    await new Promise((r) => setTimeout(r, 15));
    const second = (await patch(app, owner, id, { body: 'c' })).json().editedAt as string;
    expect(new Date(second).getTime()).toBeGreaterThan(new Date(first).getTime());
  });

  it('本文が変わらなければ、何もせず成功する(「編集済み」を付けない)', async () => {
    const { app, owner, ch } = await setup();
    const { id } = await post(app, owner, ch, '同じ');
    const res = await patch(app, owner, id, { body: '同じ' });
    expect(res.statusCode).toBe(200);
    expect(res.json().editedAt).toBeNull();
    expect((await row(id)).editedAt).toBeNull();
  });

  it('本文の検証は、投稿と同じ(空・空白・4001 文字・制御文字・型違い・余分な項目は 400。DB は変わらない)', async () => {
    const { app, owner, ch } = await setup();
    const { id } = await post(app, owner, ch, '元の本文');
    await expect(
      patch(app, owner, id, { body: '😀'.repeat(4000) }).then((r) => r.statusCode),
    ).resolves.toBe(200);
    await patch(app, owner, id, { body: '元の本文' });
    for (const body of [
      { body: '' },
      { body: '   ' },
      { body: '😀'.repeat(4001) },
      { body: 'a\u0000b' },
      { body: 123 },
      { body: 'x', userId: owner.id },
      {},
    ]) {
      const res = await patch(app, owner, id, body);
      expect(res.statusCode, JSON.stringify(body).slice(0, 40)).toBe(400);
    }
    expect((await row(id)).body).toBe('元の本文');
  });

  it('他の参加者は 403。本文は変わらない', async () => {
    const { app, owner, member, ch } = await setup();
    const { id } = await post(app, owner, ch, '元');
    const res = await patch(app, member, id, { body: '乗っ取り' });
    expect(res.statusCode).toBe(403);
    expect((await row(id)).body).toBe('元');
  });

  it('参加者でなければ(未参加のパブリック・プライベート・他のワークスペース・存在しない・形式違い)、同じ 404', async () => {
    const { app, owner, member, bystander, outsider, ws, ch } = await setup();
    const { id } = await post(app, owner, ch, '本文');
    const secret = await createChannel(app, owner, ws, 'secret', 'private');
    const secretMsg = await post(app, owner, secret, 'ひみつ');

    const responses = [
      await patch(app, bystander, id, { body: 'x' }), // 同じワークスペースで未参加のパブリック
      await patch(app, member, secretMsg.id, { body: 'x' }), // プライベート
      await patch(app, outsider, id, { body: 'x' }), // 他のワークスペース
      await patch(app, owner, 999999999, { body: 'x' }), // 存在しない
      ...(['abc', '0', '-1', '1.5', '1e3', '9'.repeat(20), '%20'] as const).map((bad) =>
        patch(app, owner, bad, { body: 'x' }),
      ),
    ];
    for (const res of await Promise.all(responses)) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(NOT_FOUND);
    }
  });

  it('退出すると、自分のメッセージも、編集できない(404)', async () => {
    const { app, member, ch } = await setup();
    const { id } = await post(app, member, ch, '退出する前');
    await send(app, 'POST', member, `/api/channels/${ch}/leave`);
    expect((await patch(app, member, id, { body: 'x' })).statusCode).toBe(404);
  });

  it('ログインしていないと 401。Origin がないと 403', async () => {
    const { app, owner, ch } = await setup();
    const { id } = await post(app, owner, ch, 'x');
    expect((await patch(app, undefined, id, { body: 'y' })).statusCode).toBe(401);
    const noOrigin = await app.inject({
      method: 'PATCH',
      url: `/api/messages/${id}`,
      cookies: { [SESSION_COOKIE_NAME]: owner.token },
      payload: { body: 'y' },
    });
    expect(noOrigin.statusCode).toBe(403);
  });

  it('返信も、投稿者が編集できる(parentId つきで返る)', async () => {
    const { app, owner, member, ch } = await setup();
    const parent = await post(app, owner, ch, '親');
    const reply = await insertReply(ch, parent.id, member);
    const res = await patch(app, member, reply.id, { body: '返信を直した' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: reply.id, parentId: parent.id, body: '返信を直した' });
    // 返信は、一覧に出ない
    const ids = (await list(app, owner, ch)).json().messages.map((m: { id: number }) => m.id);
    expect(ids).toEqual([parent.id]);
  });
});

describe('DELETE /api/messages/:id(FR-104)', () => {
  it('投稿者は削除できる(204)。本文は破棄され(null)、一覧から消える', async () => {
    const { app, owner, ch } = await setup();
    const keep = await post(app, owner, ch, '残る');
    const { id } = await post(app, owner, ch, '消える本文');
    expect((await del(app, owner, id)).statusCode).toBe(204);

    const stored = await row(id);
    expect(stored.body).toBeNull(); // 本文は、DB に残らない
    expect(stored.deletedAt).not.toBeNull();
    const page = await list(app, owner, ch);
    expect(page.json().messages.map((m: { id: number }) => m.id)).toEqual([keep.id]);
    expect(page.body).not.toContain('消える本文');
  });

  it('削除済みへの、再削除・編集は 404(投稿者にも、他の参加者にも)。本文は null のまま', async () => {
    const { app, owner, member, ch } = await setup();
    const { id } = await post(app, owner, ch, 'x');
    await del(app, owner, id);
    for (const res of [
      await del(app, owner, id),
      await patch(app, owner, id, { body: '復活' }),
      await del(app, member, id), // 他の参加者も 404(403 より先に判定する)
      await patch(app, member, id, { body: '復活' }),
    ]) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(NOT_FOUND);
    }
    expect((await row(id)).body).toBeNull();
  });

  it('他の参加者は 403(削除されない)。参加者でなければ 404。ログインしていないと 401', async () => {
    const { app, owner, member, bystander, outsider, ch } = await setup();
    const { id } = await post(app, owner, ch, 'x');
    expect((await del(app, member, id)).statusCode).toBe(403);
    expect((await del(app, bystander, id)).statusCode).toBe(404);
    expect((await del(app, outsider, id)).statusCode).toBe(404);
    expect((await del(app, undefined, id)).statusCode).toBe(401);
    expect((await del(app, owner, 'abc')).statusCode).toBe(404);
    expect((await row(id)).deletedAt).toBeNull();
  });

  it('同時に削除しても、成功は 1 回だけ', async () => {
    const { app, owner, ch } = await setup();
    const { id } = await post(app, owner, ch, 'x');
    const results = await Promise.all(Array.from({ length: 6 }, () => del(app, owner, id)));
    expect(results.map((r) => r.statusCode).sort()).toEqual([204, 404, 404, 404, 404, 404]);
  });

  it('同時の編集と削除でも、矛盾が残らない(必ず削除済みで、本文は null)', async () => {
    const { app, owner, ch } = await setup();
    for (let i = 0; i < 8; i++) {
      const { id } = await post(app, owner, ch, `元${i}`);
      const [d, p] = await Promise.all([
        del(app, owner, id),
        patch(app, owner, id, { body: `編集${i}` }),
      ]);
      expect(d.statusCode).toBe(204);
      expect([200, 404]).toContain(p.statusCode);
      const stored = await row(id);
      expect(stored.deletedAt).not.toBeNull();
      expect(stored.body).toBeNull();
    }
  });
});

describe('GET /api/channels/:ch/messages: 返信と削除済みの親(FR-104、105)', () => {
  it('返信は一覧に出ない。親に、返信数(削除済みの返信は数えない)が付く', async () => {
    const { app, owner, member, ch } = await setup();
    const parent = await post(app, owner, ch, '親');
    await insertReply(ch, parent.id, member);
    await insertReply(ch, parent.id, owner);
    await insertReply(ch, parent.id, owner, { deleted: true });
    const messagesList = (await list(app, owner, ch)).json().messages;
    expect(messagesList).toHaveLength(1);
    expect(messagesList[0]).toMatchObject({ id: parent.id, replyCount: 2, deleted: false });
  });

  it('削除済みの親は、返信が残っていれば、本文・投稿者を含まない形で、返信数つきで一覧に残る', async () => {
    const { app, owner, member, ch } = await setup();
    const parent = await post(app, owner, ch, '消える親の本文');
    await insertReply(ch, parent.id, member, { body: '残る返信' });
    await insertReply(ch, parent.id, member);
    await del(app, owner, parent.id);

    const res = await list(app, member, ch);
    const [item] = res.json().messages;
    expect(item).toEqual({
      id: parent.id,
      channelId: ch,
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      replyCount: 2,
      deleted: true,
    });
    expect(res.body).not.toContain('消える親の本文');
    expect(res.body).not.toContain(owner.username); // 投稿者の情報も出さない
  });

  it('削除済みの親は、返信がなければ除外する。削除済みの返信しかない場合も除外する', async () => {
    const { app, owner, member, ch } = await setup();
    const noReplies = await post(app, owner, ch, 'a');
    const onlyDeletedReplies = await post(app, owner, ch, 'b');
    const kept = await post(app, owner, ch, 'c');
    await insertReply(ch, onlyDeletedReplies.id, member, { deleted: true });
    await del(app, owner, noReplies.id);
    await del(app, owner, onlyDeletedReplies.id);
    const ids = (await list(app, owner, ch)).json().messages.map((m: { id: number }) => m.id);
    expect(ids).toEqual([kept.id]);
  });

  it('削除済みの親を含めても、ページングは崩れない(50 件ずつ。除外した分で、ページが欠けない)', async () => {
    const { app, owner, member, ch } = await setup();
    // DB に直接、120 件を作る。偶数番目は削除済みにし、そのうち 4 の倍数だけ、返信を残す(それ以外の削除済みは、一覧から外れる)
    const rows = await testDb.db
      .insert(messages)
      .values(
        Array.from({ length: 120 }, (_, i) => ({ channelId: ch, userId: owner.id, body: `m${i}` })),
      )
      .returning({ id: messages.id });
    const ids = rows.map((r) => r.id).sort((a, b) => a - b);
    for (let i = 0; i < ids.length; i += 4) await insertReply(ch, ids[i]!, member);
    for (let i = 0; i < ids.length; i += 2) {
      await testDb.db
        .update(messages)
        .set({ body: null, deletedAt: new Date() })
        .where(eq(messages.id, ids[i]!));
    }
    const expected = ids.filter((_, i) => i % 2 === 1 || i % 4 === 0).reverse(); // 60 + 30 = 90 件
    expect(expected).toHaveLength(90);

    const p1 = (await list(app, owner, ch)).json();
    expect(p1.messages).toHaveLength(50);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = (
      await send(app, 'GET', owner, `/api/channels/${ch}/messages?cursor=${p1.nextCursor}`)
    ).json();
    expect(p2.messages).toHaveLength(40);
    expect(p2.nextCursor).toBeNull();
    const all = [...p1.messages, ...p2.messages].map((m: { id: number }) => m.id);
    expect(all).toEqual(expected); // 欠落も、重複もない
  });
});

describe('WebSocket のイベント(編集・削除。設計書 §6.4、§10 の T17)', () => {
  async function start() {
    const config = loadConfig({ ALLOWED_ORIGIN: ORIGIN });
    const app = buildApp({ config, db: testDb.db, storage, logger: false });
    apps.push(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    return { app, url: `http://127.0.0.1:${port}` };
  }

  function connect(url: string, token: string): Promise<ClientSocket> {
    const socket = connectIo(url, {
      transports: ['websocket'],
      extraHeaders: { origin: ORIGIN, cookie: `${SESSION_COOKIE_NAME}=${token}` },
      reconnection: false,
      forceNew: true,
    });
    sockets.push(socket);
    return new Promise((resolve, reject) => {
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', reject);
    });
  }

  function record(socket: ClientSocket) {
    const all: { name: string; payload: unknown }[] = [];
    socket.onAny((name: string, payload: unknown) => all.push({ name, payload }));
    return {
      all,
      of: (name: string) => all.filter((e) => e.name === name).map((e) => e.payload),
      names: () => all.map((e) => e.name),
    };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

  async function setupWs() {
    const { app, url } = await start();
    const owner = await createUser(app);
    const member = await createUser(app);
    const bystander = await createUser(app);
    const ws = await newWorkspace(app, owner);
    await addMember(ws, member);
    await addMember(ws, bystander);
    const ch = await createChannel(app, owner, ws, 'live');
    await join(app, member, ch);
    const ownerRec = record(await connect(url, owner.token));
    const memberRec = record(await connect(url, member.token));
    const bystanderRec = record(await connect(url, bystander.token));
    return { app, owner, member, ch, ownerRec, memberRec, bystanderRec };
  }

  it('編集: 参加者に message:updated が届く(REST の応答と同じ形)。未参加者には届かない', async () => {
    const { app, owner, ch, ownerRec, memberRec, bystanderRec } = await setupWs();
    const { id } = await post(app, owner, ch, '前');
    const res = await patch(app, owner, id, { body: '後' });
    await vi.waitFor(() => expect(memberRec.of('message:updated')).toHaveLength(1));
    expect(memberRec.of('message:updated')[0]).toEqual(res.json());
    expect(ownerRec.of('message:updated')).toHaveLength(1);
    await settle();
    expect(bystanderRec.of('message:updated')).toEqual([]);
    expect(memberRec.names()).not.toContain('thread:reply-updated');
  });

  it('本文が変わらない編集では、何も届かない', async () => {
    const { app, owner, ch, memberRec } = await setupWs();
    const { id } = await post(app, owner, ch, '同じ');
    await vi.waitFor(() => expect(memberRec.of('message:created')).toHaveLength(1));
    await patch(app, owner, id, { body: '同じ' });
    await settle();
    expect(memberRec.of('message:updated')).toEqual([]);
  });

  it('削除: message:deleted(ID・チャンネル ID・返信数だけ。本文を含まない)が届く', async () => {
    const { app, owner, member, ch, memberRec, bystanderRec } = await setupWs();
    const { id } = await post(app, owner, ch, '削除される本文');
    await insertReply(ch, id, member);
    await insertReply(ch, id, member);
    await insertReply(ch, id, member, { deleted: true });
    const before = memberRec.all.length; // 投稿のイベントは、本文を含む。削除の後に届いたものだけを見る
    await del(app, owner, id);
    await vi.waitFor(() => expect(memberRec.of('message:deleted')).toHaveLength(1));
    expect(memberRec.of('message:deleted')[0]).toEqual({ id, channelId: ch, replyCount: 2 });
    expect(JSON.stringify(memberRec.all.slice(before))).not.toContain('削除される本文');
    await settle();
    expect(bystanderRec.of('message:deleted')).toEqual([]);
  });

  it('返信の編集は thread:reply-updated だけ、削除は thread:reply-deleted(親の返信数つき)だけが届く(message:* は届かない)', async () => {
    const { app, owner, member, ch, ownerRec, memberRec } = await setupWs();
    const parent = await post(app, owner, ch, '親');
    const reply = await insertReply(ch, parent.id, member);
    await insertReply(ch, parent.id, owner);
    const before = memberRec.all.length;

    const edited = await patch(app, member, reply.id, { body: '返信を直した' });
    await vi.waitFor(() => expect(memberRec.of('thread:reply-updated')).toHaveLength(1));
    expect(memberRec.of('thread:reply-updated')[0]).toEqual(edited.json());

    await del(app, member, reply.id);
    await vi.waitFor(() => expect(ownerRec.of('thread:reply-deleted')).toHaveLength(1));
    expect(ownerRec.of('thread:reply-deleted')[0]).toEqual({
      id: reply.id,
      channelId: ch,
      parentId: parent.id,
      replyCount: 1, // 残りの返信(削除したものは数えない)
    });
    await settle();
    const names = memberRec.all.slice(before).map((e) => e.name);
    expect(names).toEqual(['thread:reply-updated', 'thread:reply-deleted']);
    expect(ownerRec.names()).not.toContain('message:updated');
    expect(ownerRec.names()).not.toContain('message:deleted');
  });
});

describe('参加者の行がなくなった人(キック後など)', () => {
  it('参加者の行だけで判定する: 行が消えると、自分のメッセージも 404', async () => {
    const { app, member, ch } = await setup();
    await join(app, member, ch);
    const { id } = await post(app, member, ch, '自分');
    await testDb.db
      .delete(channelMembers)
      .where(and(eq(channelMembers.channelId, ch), eq(channelMembers.userId, member.id)));
    expect((await patch(app, member, id, { body: 'x' })).statusCode).toBe(404);
    expect((await del(app, member, id)).statusCode).toBe(404);
  });
});
