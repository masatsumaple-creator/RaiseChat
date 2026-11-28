import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { channelMembers, memberships, messages } from '../db/schema';
import { SESSION_COOKIE_NAME } from '../session-cookie';
import { LocalDiskStorage } from '../storage/storage';
import { createTestDatabase } from '../test/db';
import { fileOfSize, makeTempDir, multipart, PNG_HEADER } from '../test/files';

const ORIGIN = 'http://localhost:5173';
const PASSWORD = 'correct-horse-battery';
const NOT_FOUND = { code: 'not_found', message: '見つかりません。' };
const NIL_UUID = '00000000-0000-4000-8000-000000000000';

let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
let temp: Awaited<ReturnType<typeof makeTempDir>>;
let storage: LocalDiskStorage;
const apps: FastifyInstance[] = [];
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
  const username = `msg_user_${counter}`;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { origin: ORIGIN },
    payload: { username, password: PASSWORD },
    remoteAddress: `10.140.${Math.floor(counter / 250)}.${counter % 250}`,
  });
  expect(res.statusCode).toBe(201);
  const token = res.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;
  return { username, token, id: res.json().user.id as string };
}

function send(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PUT',
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

async function newWorkspace(app: FastifyInstance, owner: TestUser, name = 'チーム') {
  const res = await send(app, 'POST', owner, '/api/workspaces', { name });
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

const post = (app: FastifyInstance, user: TestUser | undefined, ch: string, body: unknown) =>
  send(app, 'POST', user, `/api/channels/${ch}/messages`, { body });
const list = (app: FastifyInstance, user: TestUser | undefined, ch: string, query = '') =>
  send(app, 'GET', user, `/api/channels/${ch}/messages${query}`);

/** メッセージを、DB に直接 n 件作る(投稿者の ID は、本人)。ID の昇順に、"m1"、"m2"… */
async function seed(channelId: string, user: TestUser, count: number, prefix = 'm') {
  const rows = Array.from({ length: count }, (_, i) => ({
    channelId,
    userId: user.id,
    body: `${prefix}${i + 1}`,
  }));
  for (let i = 0; i < rows.length; i += 500) {
    await testDb.db.insert(messages).values(rows.slice(i, i + 500));
  }
}

describe('POST /api/channels/:ch/messages(FR-101)', () => {
  it('参加者は投稿できる(201)。投稿者の情報つきで返り、DB に保存される', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const general = (
      (await send(app, 'GET', owner, `/api/workspaces/${ws}/channels`)).json() as { id: string }[]
    )[0]!.id;

    const res = await post(app, owner, general, 'こんにちは');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      id: expect.any(Number),
      channelId: general,
      author: {
        id: owner.id,
        username: owner.username,
        displayName: owner.username,
        avatarUrl: null,
      },
      body: 'こんにちは',
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      parentId: null,
      editedAt: null,
      replyCount: 0,
      reactions: [],
      mentions: [],
      deleted: false,
    });
    const [row] = await testDb.db.select().from(messages).where(eq(messages.id, res.json().id));
    expect(row).toMatchObject({ channelId: general, userId: owner.id, body: 'こんにちは' });
  });

  it('本文は、入力されたまま保存する(マークダウン・改行・タブ・前後の空白。HTML も加工しない)', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const ch = await createChannel(app, owner, ws, 'free');
    const text = '  # 見出し\n\n- **太字** `code`\r\n\t<script>alert(1)</script> & "quote"  ';
    const res = await post(app, owner, ch, text);
    expect(res.statusCode).toBe(201);
    expect(res.json().body).toBe(text);
    const [row] = await testDb.db.select().from(messages).where(eq(messages.id, res.json().id));
    expect(row!.body).toBe(text);
  });

  it('本文は、コードポイント数で 1〜4000 文字(絵文字も 1 文字)。ちょうど 4000 は可、4001 は 400', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const ch = await createChannel(app, owner, ws, 'limit');
    expect((await post(app, owner, ch, '😀'.repeat(4000))).statusCode).toBe(201);
    expect((await post(app, owner, ch, 'a'.repeat(4000))).statusCode).toBe(201);
    for (const body of ['😀'.repeat(4001), 'a'.repeat(4001)]) {
      const res = await post(app, owner, ch, body);
      expect(res.statusCode).toBe(400);
    }
  });

  it('空・空白だけ・制御文字(NUL を含む)・文字列でない本文・余分な項目は 400(500 にならない)', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const ch = await createChannel(app, owner, ws, 'bad');
    for (const body of [
      '',
      '   ',
      '\n\t\r ',
      'a\u0000b',
      '\u0000',
      'a\u0007b',
      'a\u001bb',
      'a\u007fb',
      123,
      null,
      ['x'],
    ]) {
      const res = await post(app, owner, ch, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    for (const payload of [{}, { body: 'x', userId: owner.id }, { text: 'x' }]) {
      const res = await send(app, 'POST', owner, `/api/channels/${ch}/messages`, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(await testDb.db.select().from(messages).where(eq(messages.channelId, ch))).toEqual([]);
  });

  it('アバターを設定している投稿者は、版つきの avatarUrl が返る', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const ch = await createChannel(app, owner, ws, 'av');
    const { payload, contentType } = multipart([
      {
        name: 'file',
        filename: 'a.png',
        contentType: 'image/png',
        data: fileOfSize(PNG_HEADER, 50),
      },
    ]);
    const put = await app.inject({
      method: 'PUT',
      url: '/api/me/avatar',
      headers: { 'content-type': contentType, origin: ORIGIN },
      cookies: { [SESSION_COOKIE_NAME]: owner.token },
      payload,
    });
    expect(put.statusCode).toBe(200);
    const res = await post(app, owner, ch, 'hi');
    expect(res.json().author.avatarUrl).toBe(put.json().avatarUrl);
  });

  it('同時に投稿しても、すべて保存され、ID は重ならない', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const ch = await createChannel(app, owner, ws, 'race');
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => post(app, owner, ch, `msg ${i}`)),
    );
    expect(results.every((r) => r.statusCode === 201)).toBe(true);
    const ids = results.map((r) => r.json().id as number);
    expect(new Set(ids).size).toBe(20);
    expect(await testDb.db.select().from(messages).where(eq(messages.channelId, ch))).toHaveLength(
      20,
    );
  });

  it('参加者でなければ、パブリックでも、プライベートでも、他のワークスペースでも、存在しなくても、同じ 404。何も保存されない', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const member = await createUser(app);
    const outsider = await createUser(app);
    const ws = await newWorkspace(app, owner);
    await addMember(ws, member);
    const open = await createChannel(app, owner, ws, 'open');
    const secret = await createChannel(app, owner, ws, 'secret', 'private');

    const responses = [
      await post(app, member, open, 'x'), // 同じワークスペースだが、未参加のパブリック
      await post(app, member, secret, 'x'),
      await post(app, outsider, open, 'x'), // 別のワークスペース
      await post(app, owner, NIL_UUID, 'x'),
      await post(app, owner, 'not-a-uuid', 'x'),
    ];
    for (const res of responses) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(NOT_FOUND);
    }
    expect(await testDb.db.select().from(messages).where(eq(messages.channelId, open))).toEqual([]);
  });

  it('オーナーも、参加者でなければ、プライベートに投稿できない。退出後は、投稿できない', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const member = await createUser(app);
    const ws = await newWorkspace(app, owner);
    await addMember(ws, member);
    const secret = await createChannel(app, member, ws, 'secret', 'private');
    expect((await post(app, owner, secret, 'x')).statusCode).toBe(404);

    const open = await createChannel(app, member, ws, 'open');
    expect((await post(app, member, open, 'before')).statusCode).toBe(201);
    await send(app, 'POST', member, `/api/channels/${open}/leave`);
    expect((await post(app, member, open, 'after')).statusCode).toBe(404);
  });

  it('ログインしていないと 401。Origin がないと 403', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const ch = await createChannel(app, owner, ws, 'auth');
    expect((await post(app, undefined, ch, 'x')).statusCode).toBe(401);
    const noOrigin = await app.inject({
      method: 'POST',
      url: `/api/channels/${ch}/messages`,
      cookies: { [SESSION_COOKIE_NAME]: owner.token },
      payload: { body: 'x' },
    });
    expect(noOrigin.statusCode).toBe(403);
  });
});

describe('GET /api/channels/:ch/messages(FR-101)', () => {
  it('新しい順に返す。投稿者の情報つき', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const member = await createUser(app);
    const ws = await newWorkspace(app, owner);
    await addMember(ws, member);
    const ch = await createChannel(app, owner, ws, 'talk');
    await send(app, 'POST', member, `/api/channels/${ch}/join`);
    await post(app, owner, ch, '一つ目');
    await post(app, member, ch, '二つ目');
    await post(app, owner, ch, '三つ目');

    const res = await list(app, member, ch);
    expect(res.statusCode).toBe(200);
    const page = res.json();
    expect(page.nextCursor).toBeNull();
    expect(page.messages.map((m: { body: string }) => m.body)).toEqual([
      '三つ目',
      '二つ目',
      '一つ目',
    ]);
    expect(page.messages[1].author).toMatchObject({ id: member.id, username: member.username });
    expect(res.body).not.toMatch(/hash|password|recovery/i);
  });

  it('メッセージがなければ、空の配列と、cursor なし', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const ch = await createChannel(app, owner, ws, 'empty');
    expect((await list(app, owner, ch)).json()).toEqual({ messages: [], nextCursor: null });
  });

  it('50 件ずつ。cursor で次のページ。最後のページの nextCursor は null(120 件)', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const ch = await createChannel(app, owner, ws, 'paging');
    await seed(ch, owner, 120);

    const p1 = (await list(app, owner, ch)).json();
    expect(p1.messages).toHaveLength(50);
    expect(p1.messages[0].body).toBe('m120');
    expect(p1.messages[49].body).toBe('m71');
    expect(p1.nextCursor).toBe(p1.messages[49].id);

    const p2 = (await list(app, owner, ch, `?cursor=${p1.nextCursor}`)).json();
    expect(p2.messages).toHaveLength(50);
    expect(p2.messages[0].body).toBe('m70');
    expect(p2.messages[49].body).toBe('m21');
    expect(p2.nextCursor).toBe(p2.messages[49].id);

    const p3 = (await list(app, owner, ch, `?cursor=${p2.nextCursor}`)).json();
    expect(p3.messages).toHaveLength(20);
    expect(p3.messages[19].body).toBe('m1');
    expect(p3.nextCursor).toBeNull();

    // 重複も、欠落もない
    const all = [...p1.messages, ...p2.messages, ...p3.messages].map((m: { id: number }) => m.id);
    expect(new Set(all).size).toBe(120);
  });

  it('境界: ちょうど 50 件なら、次のページなし。51 件なら、次のページに 1 件', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const exact = await createChannel(app, owner, ws, 'exact50');
    const over = await createChannel(app, owner, ws, 'over51');
    await seed(exact, owner, 50);
    await seed(over, owner, 51);

    const a = (await list(app, owner, exact)).json();
    expect(a.messages).toHaveLength(50);
    expect(a.nextCursor).toBeNull();

    const b1 = (await list(app, owner, over)).json();
    expect(b1.messages).toHaveLength(50);
    expect(b1.nextCursor).not.toBeNull();
    const b2 = (await list(app, owner, over, `?cursor=${b1.nextCursor}`)).json();
    expect(b2.messages.map((m: { body: string }) => m.body)).toEqual(['m1']);
    expect(b2.nextCursor).toBeNull();
  });

  it('cursor が、最も古い ID 以下なら、空。他のチャンネルのメッセージは混ざらない', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const a = await createChannel(app, owner, ws, 'a');
    const b = await createChannel(app, owner, ws, 'b');
    await seed(a, owner, 3, 'a');
    await seed(b, owner, 3, 'b');
    const first = (await list(app, owner, a)).json();
    expect(first.messages.map((m: { body: string }) => m.body)).toEqual(['a3', 'a2', 'a1']);
    const oldest = first.messages[2].id;
    expect((await list(app, owner, a, `?cursor=${oldest}`)).json()).toEqual({
      messages: [],
      nextCursor: null,
    });
  });

  it('不正な cursor(0・負・小数・文字・巨大な値)は 400', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const ch = await createChannel(app, owner, ws, 'cur');
    for (const cursor of ['0', '-1', '1.5', 'abc', '1e30', '99999999999999999999', '']) {
      const res = await list(app, owner, ch, `?cursor=${cursor}`);
      expect(res.statusCode, cursor).toBe(400);
    }
  });

  it('後から参加した人も、参加前の履歴を読める。退出した人の過去の投稿も残る', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const member = await createUser(app);
    const ws = await newWorkspace(app, owner);
    await addMember(ws, member);
    const ch = await createChannel(app, owner, ws, 'history');
    await post(app, owner, ch, '参加前の投稿');
    expect((await list(app, member, ch)).statusCode).toBe(404); // 参加前は 404

    await send(app, 'POST', member, `/api/channels/${ch}/join`);
    await post(app, member, ch, '参加後の投稿');
    await send(app, 'POST', member, `/api/channels/${ch}/leave`);
    const res = await list(app, owner, ch);
    expect(res.json().messages.map((m: { body: string }) => m.body)).toEqual([
      '参加後の投稿',
      '参加前の投稿',
    ]);
  });

  it('参加者でなければ、同じ 404(パブリック・プライベート・他のワークスペース・存在しない・形式違い)', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const member = await createUser(app);
    const outsider = await createUser(app);
    const ws = await newWorkspace(app, owner);
    await addMember(ws, member);
    const open = await createChannel(app, owner, ws, 'open');
    const secret = await createChannel(app, owner, ws, 'secret', 'private');
    await post(app, owner, open, '見えてはいけない');
    await post(app, owner, secret, '見えてはいけない');

    const responses = [
      await list(app, member, open),
      await list(app, member, secret),
      await list(app, outsider, open),
      await list(app, owner, NIL_UUID),
      await list(app, owner, 'not-a-uuid'),
    ];
    for (const res of responses) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(NOT_FOUND);
    }
    expect((await list(app, undefined, open)).statusCode).toBe(401);
  });

  it('キックで ChannelMember の行が消えた人は、読めない(404)', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const member = await createUser(app);
    const ws = await newWorkspace(app, owner);
    await addMember(ws, member);
    const ch = await createChannel(app, owner, ws, 'kick');
    await send(app, 'POST', member, `/api/channels/${ch}/join`);
    expect((await list(app, member, ch)).statusCode).toBe(200);
    await testDb.db
      .update(memberships)
      .set({ status: 'kicked' })
      .where(and(eq(memberships.workspaceId, ws), eq(memberships.userId, member.id)));
    await testDb.db.delete(channelMembers).where(eq(channelMembers.userId, member.id));
    expect((await list(app, member, ch)).statusCode).toBe(404);
    expect((await post(app, member, ch, 'x')).statusCode).toBe(404);
  });
});

describe('採番の順とコミットの順の一致(設計書 §1.1。チャンネル単位の advisory lock)', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('同じチャンネルのロックが保持されている間、投稿は待たされる。別のチャンネルは待たされない', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const locked = await createChannel(app, owner, ws, 'locked');
    const free = await createChannel(app, owner, ws, 'free');

    // 別の接続で、同じキーの advisory lock を保持する
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let acquired!: () => void;
    const gotLock = new Promise<void>((resolve) => (acquired = resolve));
    const holder = testDb.client.begin(async (sql) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${locked}::text, 0))`;
      acquired();
      await held;
    });
    await gotLock;

    let done = false;
    const posting = post(app, owner, locked, 'blocked').then((res) => {
      done = true;
      return res;
    });
    const other = await post(app, owner, free, 'not blocked'); // 別のチャンネルは、すぐに終わる
    expect(other.statusCode).toBe(201);
    await sleep(300);
    expect(done).toBe(false); // ロックの解放を、待っている

    release();
    await holder;
    const res = await posting;
    expect(res.statusCode).toBe(201);
    expect(done).toBe(true);
  });

  it('同じチャンネルへの同時投稿は、ID の順に、1 件ずつ確定する(ID の欠落・重複なし)', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const ch = await createChannel(app, owner, ws, 'serial');
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => post(app, owner, ch, `n${i}`)),
    );
    expect(results.every((r) => r.statusCode === 201)).toBe(true);
    const page = (await list(app, owner, ch)).json();
    expect(page.messages).toHaveLength(30);
    expect(new Set(page.messages.map((m: { id: number }) => m.id)).size).toBe(30);
  });
});
