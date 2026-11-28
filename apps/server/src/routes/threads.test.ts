import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { AddressInfo } from 'node:net';
import { io as connectIo, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { channelMembers, memberships, messages, threadMembers } from '../db/schema';
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
  const username = `thr_user_${counter}`;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { origin: ORIGIN },
    payload: { username, password: PASSWORD },
    remoteAddress: `10.170.${Math.floor(counter / 250)}.${counter % 250}`,
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
const reply = (
  app: FastifyInstance,
  user: TestUser | undefined,
  id: number | string,
  body: unknown,
) => send(app, 'POST', user, `/api/messages/${id}/replies`, { body });
const replies = (
  app: FastifyInstance,
  user: TestUser | undefined,
  id: number | string,
  query = '',
) => send(app, 'GET', user, `/api/messages/${id}/replies${query}`);
const list = (app: FastifyInstance, user: TestUser, ch: string) =>
  send(app, 'GET', user, `/api/channels/${ch}/messages`);

async function row(id: number) {
  const [r] = await testDb.db.select().from(messages).where(eq(messages.id, id));
  return r!;
}

async function threadMemberIds(rootId: number) {
  const rows = await testDb.db
    .select()
    .from(threadMembers)
    .where(eq(threadMembers.rootMessageId, rootId));
  return rows.map((r) => r.userId).sort();
}

/** 参加者の 2 人と、未参加者・他のワークスペースの人がいる、パブリックチャンネル */
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

describe('POST /api/messages/:id/replies(FR-105)', () => {
  it('参加者は返信できる(201)。親(parentId)と投稿者つきで返り、DB に保存される', async () => {
    const { app, owner, member, ch } = await setup();
    const parent = await post(app, owner, ch, '親');
    const res = await reply(app, member, parent.id, '返信です');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      id: expect.any(Number),
      channelId: ch,
      parentId: parent.id,
      author: {
        id: member.id,
        username: member.username,
        displayName: member.username,
        avatarUrl: null,
      },
      body: '返信です',
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      editedAt: null,
      replyCount: 0,
      reactions: [],
      mentions: [],
      attachments: [],
      deleted: false,
    });
    expect(await row(res.json().id)).toMatchObject({ parentId: parent.id, channelId: ch });
  });

  it('返信数が増え、親の一覧の応答に反映される。返信は、チャンネルの一覧に出ない', async () => {
    const { app, owner, member, ch } = await setup();
    const parent = await post(app, owner, ch, '親');
    await reply(app, member, parent.id, '1');
    await reply(app, owner, parent.id, '2');
    const items = (await list(app, owner, ch)).json().messages;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: parent.id, replyCount: 2 });
  });

  it('返信した人と、親の投稿者が、スレッドの参加者になる(重複しない)', async () => {
    const { app, owner, member, ch } = await setup();
    const parent = await post(app, owner, ch, '親');
    expect(await threadMemberIds(parent.id)).toEqual([]);
    await reply(app, member, parent.id, '1');
    expect(await threadMemberIds(parent.id)).toEqual([owner.id, member.id].sort());
    await reply(app, member, parent.id, '2');
    await reply(app, owner, parent.id, '3'); // 親の投稿者自身の返信でも、重複しない
    expect(await threadMemberIds(parent.id)).toEqual([owner.id, member.id].sort());
  });

  it('本文は、入力されたまま保存し、検証は投稿と同じ(空・空白・4001 文字・制御文字・型違い・余分な項目は 400)', async () => {
    const { app, owner, ch } = await setup();
    const parent = await post(app, owner, ch, '親');
    const text = '  # 見出し\n\n- 返信 `code`  ';
    const ok = await reply(app, owner, parent.id, text);
    expect(ok.statusCode).toBe(201);
    expect(ok.json().body).toBe(text);
    expect((await reply(app, owner, parent.id, '😀'.repeat(4000))).statusCode).toBe(201);
    for (const body of ['', '   ', '😀'.repeat(4001), 'a\u0000b', 123, null]) {
      const res = await reply(app, owner, parent.id, body);
      expect(res.statusCode, JSON.stringify(body)?.slice(0, 30)).toBe(400);
    }
    const extra = await send(app, 'POST', owner, `/api/messages/${parent.id}/replies`, {
      body: 'x',
      parentId: 1,
    });
    expect(extra.statusCode).toBe(400);
  });

  it('返信への返信は 400(返信は、1 段だけ)。何も作られない', async () => {
    const { app, owner, ch } = await setup();
    const parent = await post(app, owner, ch, '親');
    const first = await reply(app, owner, parent.id, '返信');
    const res = await reply(app, owner, first.json().id, '返信への返信');
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('bad_request');
    expect(await replies(app, owner, parent.id).then((r) => r.json().replies)).toHaveLength(1);
  });

  it('削除済みの親には、返信できない(404)。削除済みの返信への返信も 404(400 より先)', async () => {
    const { app, owner, member, ch } = await setup();
    const parent = await post(app, owner, ch, '親');
    const r = await reply(app, member, parent.id, '返信');
    await send(app, 'DELETE', member, `/api/messages/${r.json().id}`);
    expect((await reply(app, owner, r.json().id, 'x')).statusCode).toBe(404);

    await send(app, 'DELETE', owner, `/api/messages/${parent.id}`);
    const res = await reply(app, owner, parent.id, '遅れた返信');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual(NOT_FOUND);
  });

  it('参加者でなければ(未参加のパブリック・プライベート・他のワークスペース・存在しない・形式違い)、同じ 404', async () => {
    const { app, owner, member, bystander, outsider, ws, ch } = await setup();
    const parent = await post(app, owner, ch, '親');
    const secret = await createChannel(app, owner, ws, 'secret', 'private');
    const secretMsg = await post(app, owner, secret, 'ひみつ');
    const results = await Promise.all([
      reply(app, bystander, parent.id, 'x'),
      reply(app, member, secretMsg.id, 'x'),
      reply(app, outsider, parent.id, 'x'),
      reply(app, owner, 999999999, 'x'),
      ...['abc', '0', '-1', '1.5', '9'.repeat(20)].map((bad) => reply(app, owner, bad, 'x')),
    ]);
    for (const res of results) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(NOT_FOUND);
    }
    expect(await threadMemberIds(parent.id)).toEqual([]);
  });

  it('退出すると、返信できない(404)。ログインしていないと 401、Origin がないと 403', async () => {
    const { app, owner, member, ch } = await setup();
    const parent = await post(app, owner, ch, '親');
    expect((await reply(app, undefined, parent.id, 'x')).statusCode).toBe(401);
    const noOrigin = await app.inject({
      method: 'POST',
      url: `/api/messages/${parent.id}/replies`,
      cookies: { [SESSION_COOKIE_NAME]: member.token },
      payload: { body: 'x' },
    });
    expect(noOrigin.statusCode).toBe(403);
    await send(app, 'POST', member, `/api/channels/${ch}/leave`);
    expect((await reply(app, member, parent.id, 'x')).statusCode).toBe(404);
  });

  it('同時に返信しても、すべて保存され、返信数が正しい。ID は重ならない', async () => {
    const { app, owner, member, ch } = await setup();
    const parent = await post(app, owner, ch, '親');
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, i) => reply(app, i % 2 ? owner : member, parent.id, `r${i}`)),
    );
    expect(results.every((r) => r.statusCode === 201)).toBe(true);
    expect(new Set(results.map((r) => r.json().id)).size).toBe(24);
    expect((await list(app, owner, ch)).json().messages[0].replyCount).toBe(24);
  });

  it('親の削除と同時に返信しても、「削除済みの親に、返信が加わる」ことは、返信より削除が先の場合に起きない', async () => {
    const { app, owner, member, ch } = await setup();
    for (let i = 0; i < 8; i++) {
      const parent = await post(app, owner, ch, `親${i}`);
      const [d, r] = await Promise.all([
        send(app, 'DELETE', owner, `/api/messages/${parent.id}`),
        reply(app, member, parent.id, `返信${i}`),
      ]);
      expect(d.statusCode).toBe(204);
      expect([201, 404]).toContain(r.statusCode);
      // 返信が成功したなら、その返信は、親の削除より前に確定している(削除済みの親の下に、新しい返信は加わらない)
      const stored = await testDb.db
        .select()
        .from(messages)
        .where(eq(messages.parentId, parent.id));
      expect(stored).toHaveLength(r.statusCode === 201 ? 1 : 0);
      expect((await row(parent.id)).deletedAt).not.toBeNull();
    }
  });

  it('親の削除が進行中(行がロックされている)の間は、返信は待たされ、削除が確定した後に、404 になる(削除済みの親に、返信が加わらない)', async () => {
    const { app, owner, member, ch } = await setup();
    const parent = await post(app, owner, ch, '親');

    // 別の接続で、親の行をロックして、削除を、途中の状態にする
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const gotLock = new Promise<void>((resolve) => (locked = resolve));
    const deleting = testDb.client.begin(async (sql) => {
      await sql`SELECT id FROM messages WHERE id = ${parent.id} FOR UPDATE`;
      locked();
      await held;
      await sql`UPDATE messages SET body = NULL, deleted_at = now() WHERE id = ${parent.id}`;
    });
    await gotLock;

    let done = false;
    const replying = reply(app, member, parent.id, '遅れた返信').then((res) => {
      done = true;
      return res;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(done).toBe(false); // 親の行のロックの解放を、待っている

    release();
    await deleting;
    const res = await replying;
    expect(res.statusCode).toBe(404);
    expect(await testDb.db.select().from(messages).where(eq(messages.parentId, parent.id))).toEqual(
      [],
    );
  });

  it('返信の採番も、チャンネル単位の advisory lock を取る(保持されている間は待たされ、別のチャンネルは待たされない)', async () => {
    const { app, owner, ws, ch } = await setup();
    const parent = await post(app, owner, ch, '親');
    const otherCh = await createChannel(app, owner, ws, 'free');
    const otherParent = await post(app, owner, otherCh, '別の親');

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let acquired!: () => void;
    const gotLock = new Promise<void>((resolve) => (acquired = resolve));
    const holder = testDb.client.begin(async (sql) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${ch}::text, 0))`;
      acquired();
      await held;
    });
    await gotLock;

    let done = false;
    const posting = reply(app, owner, parent.id, 'blocked').then((res) => {
      done = true;
      return res;
    });
    expect((await reply(app, owner, otherParent.id, 'not blocked')).statusCode).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(done).toBe(false);
    release();
    await holder;
    expect((await posting).statusCode).toBe(201);
  });
});

describe('GET /api/messages/:id/replies', () => {
  it('古い順に返す。親(返信数つき)と、投稿者の情報つき', async () => {
    const { app, owner, member, ch } = await setup();
    const parent = await post(app, owner, ch, '親の本文');
    await reply(app, member, parent.id, '一つ目');
    await reply(app, owner, parent.id, '二つ目');
    const res = await replies(app, member, parent.id);
    expect(res.statusCode).toBe(200);
    const page = res.json();
    expect(page.replies.map((r: { body: string }) => r.body)).toEqual(['一つ目', '二つ目']);
    expect(page.replies[0].author).toMatchObject({ id: member.id, username: member.username });
    expect(page.replies.every((r: { parentId: number }) => r.parentId === parent.id)).toBe(true);
    expect(page.parent).toMatchObject({
      id: parent.id,
      body: '親の本文',
      replyCount: 2,
      deleted: false,
    });
    expect(page.nextCursor).toBeNull();
    expect(res.body).not.toMatch(/hash|password|recovery/i);
  });

  it('返信がなければ、空の配列。他のスレッドの返信は混ざらない', async () => {
    const { app, owner, ch } = await setup();
    const a = await post(app, owner, ch, 'a');
    const b = await post(app, owner, ch, 'b');
    await reply(app, owner, b.id, 'bの返信');
    expect((await replies(app, owner, a.id)).json()).toMatchObject({
      replies: [],
      nextCursor: null,
    });
    expect((await replies(app, owner, b.id)).json().replies).toHaveLength(1);
  });

  it('削除済みの返信は含めない(返信数にも数えない)', async () => {
    const { app, owner, member, ch } = await setup();
    const parent = await post(app, owner, ch, '親');
    await reply(app, member, parent.id, '残る');
    const gone = await reply(app, member, parent.id, '消える');
    await send(app, 'DELETE', member, `/api/messages/${gone.json().id}`);
    const page = (await replies(app, owner, parent.id)).json();
    expect(page.replies.map((r: { body: string }) => r.body)).toEqual(['残る']);
    expect(page.parent.replyCount).toBe(1);
  });

  it('50 件ずつ。cursor で続きを取る(120 件の 3 ページ。ちょうど 50 件は、次なし)', async () => {
    const { app, owner, member, ch } = await setup();
    const parent = await post(app, owner, ch, '親');
    const exact = await post(app, owner, ch, '50 件ちょうど');
    await testDb.db.insert(messages).values(
      Array.from({ length: 120 }, (_, i) => ({
        channelId: ch,
        parentId: parent.id,
        userId: member.id,
        body: `r${i + 1}`,
      })),
    );
    await testDb.db.insert(messages).values(
      Array.from({ length: 50 }, (_, i) => ({
        channelId: ch,
        parentId: exact.id,
        userId: member.id,
        body: `e${i + 1}`,
      })),
    );

    const p1 = (await replies(app, owner, parent.id)).json();
    expect(p1.replies).toHaveLength(50);
    expect(p1.replies[0].body).toBe('r1');
    expect(p1.nextCursor).toBe(p1.replies[49].id);
    const p2 = (await replies(app, owner, parent.id, `?cursor=${p1.nextCursor}`)).json();
    expect(p2.replies[0].body).toBe('r51');
    expect(p2.replies).toHaveLength(50);
    const p3 = (await replies(app, owner, parent.id, `?cursor=${p2.nextCursor}`)).json();
    expect(p3.replies.map((r: { body: string }) => r.body)[0]).toBe('r101');
    expect(p3.replies).toHaveLength(20);
    expect(p3.nextCursor).toBeNull();
    const all = [...p1.replies, ...p2.replies, ...p3.replies].map((r: { id: number }) => r.id);
    expect(new Set(all).size).toBe(120);

    const e = (await replies(app, owner, exact.id)).json();
    expect(e.replies).toHaveLength(50);
    expect(e.nextCursor).toBeNull();
  });

  it('不正な cursor は 400', async () => {
    const { app, owner, ch } = await setup();
    const parent = await post(app, owner, ch, '親');
    for (const cursor of ['0', '-1', '1.5', 'abc', '99999999999999999999']) {
      expect((await replies(app, owner, parent.id, `?cursor=${cursor}`)).statusCode, cursor).toBe(
        400,
      );
    }
  });

  it('親が削除済みでも、返信は読める。親は、本文・投稿者を含まない形で返る(「削除されました」)', async () => {
    const { app, owner, member, ch } = await setup();
    const parent = await post(app, owner, ch, '消える親の本文');
    await reply(app, member, parent.id, '残る返信');
    await send(app, 'DELETE', owner, `/api/messages/${parent.id}`);
    const res = await replies(app, member, parent.id);
    expect(res.statusCode).toBe(200);
    expect(res.json().parent).toEqual({
      id: parent.id,
      channelId: ch,
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      replyCount: 1,
      deleted: true,
    });
    expect(res.json().replies.map((r: { body: string }) => r.body)).toEqual(['残る返信']);
    expect(res.body).not.toContain('消える親の本文');
  });

  it('返信の ID を指定すると 400(返信は、スレッドの親にならない)', async () => {
    const { app, owner, ch } = await setup();
    const parent = await post(app, owner, ch, '親');
    const r = await reply(app, owner, parent.id, '返信');
    expect((await replies(app, owner, r.json().id)).statusCode).toBe(400);
  });

  it('参加者でなければ、同じ 404。退出すると読めない。ログインしていないと 401', async () => {
    const { app, owner, member, bystander, outsider, ws, ch } = await setup();
    const parent = await post(app, owner, ch, '親');
    await reply(app, owner, parent.id, '見えてはいけない');
    const secret = await createChannel(app, owner, ws, 'secret', 'private');
    const secretMsg = await post(app, owner, secret, 'ひみつ');
    for (const res of await Promise.all([
      replies(app, bystander, parent.id),
      replies(app, outsider, parent.id),
      replies(app, member, secretMsg.id),
      replies(app, owner, 999999999),
      replies(app, owner, 'abc'),
    ])) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(NOT_FOUND);
    }
    expect((await replies(app, undefined, parent.id)).statusCode).toBe(401);
    await send(app, 'POST', member, `/api/channels/${ch}/leave`);
    expect((await replies(app, member, parent.id)).statusCode).toBe(404);
  });

  it('参加者の行がない人(キック後など)は、読めない(404)', async () => {
    const { app, owner, member, ch } = await setup();
    const parent = await post(app, owner, ch, '親');
    await testDb.db
      .delete(channelMembers)
      .where(and(eq(channelMembers.channelId, ch), eq(channelMembers.userId, member.id)));
    expect((await replies(app, member, parent.id)).statusCode).toBe(404);
    expect((await reply(app, member, parent.id, 'x')).statusCode).toBe(404);
  });
});

describe('WebSocket のイベント: thread:reply-created', () => {
  async function setupWs() {
    const config = loadConfig({ ALLOWED_ORIGIN: ORIGIN });
    const app = buildApp({ config, db: testDb.db, storage, logger: false });
    apps.push(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const owner = await createUser(app);
    const member = await createUser(app);
    const bystander = await createUser(app);
    const ws = await newWorkspace(app, owner);
    await addMember(ws, member);
    await addMember(ws, bystander);
    const ch = await createChannel(app, owner, ws, 'live');
    await join(app, member, ch);

    const connect = (user: TestUser) => {
      const socket = connectIo(url, {
        transports: ['websocket'],
        extraHeaders: { origin: ORIGIN, cookie: `${SESSION_COOKIE_NAME}=${user.token}` },
        reconnection: false,
        forceNew: true,
      });
      sockets.push(socket);
      const all: { name: string; payload: unknown }[] = [];
      socket.onAny((name: string, payload: unknown) => all.push({ name, payload }));
      return new Promise<{ all: typeof all; of: (n: string) => unknown[] }>((resolve, reject) => {
        socket.once('connect', () =>
          resolve({ all, of: (n) => all.filter((e) => e.name === n).map((e) => e.payload) }),
        );
        socket.once('connect_error', reject);
      });
    };
    return {
      app,
      owner,
      member,
      ch,
      ownerRec: await connect(owner),
      memberRec: await connect(member),
      bystanderRec: await connect(bystander),
    };
  }

  it('参加者に、返信と、親の返信数(この返信を含む)が届く。トップレベルの message:created は届かない。未参加者には届かない', async () => {
    const { app, owner, member, ch, ownerRec, memberRec, bystanderRec } = await setupWs();
    const parent = await post(app, owner, ch, '親');
    await vi.waitFor(() => expect(memberRec.of('message:created')).toHaveLength(1));
    const before = memberRec.all.length;

    const first = await reply(app, member, parent.id, '一つ目');
    const second = await reply(app, owner, parent.id, '二つ目');
    await vi.waitFor(() => expect(memberRec.of('thread:reply-created')).toHaveLength(2));
    expect(memberRec.of('thread:reply-created')).toEqual([
      { reply: first.json(), replyCount: 1 },
      { reply: second.json(), replyCount: 2 },
    ]);
    expect(ownerRec.of('thread:reply-created')).toHaveLength(2);
    // 返信では、message:created を送らない
    expect(memberRec.all.slice(before).map((e) => e.name)).toEqual([
      'thread:reply-created',
      'thread:reply-created',
    ]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(bystanderRec.of('thread:reply-created')).toEqual([]);
  });

  it('返信の削除では、親の返信数が減って届く(thread:reply-deleted)', async () => {
    const { app, owner, member, ch, ownerRec } = await setupWs();
    const parent = await post(app, owner, ch, '親');
    const a = await reply(app, member, parent.id, 'a');
    await reply(app, member, parent.id, 'b');
    await send(app, 'DELETE', member, `/api/messages/${a.json().id}`);
    await vi.waitFor(() => expect(ownerRec.of('thread:reply-deleted')).toHaveLength(1));
    expect(ownerRec.of('thread:reply-deleted')[0]).toEqual({
      id: a.json().id,
      channelId: ch,
      parentId: parent.id,
      replyCount: 1,
    });
  });
});
