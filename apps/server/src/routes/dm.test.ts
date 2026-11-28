import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { AddressInfo } from 'node:net';
import { io as connectIo, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { channelMembers, channels, memberships } from '../db/schema';
import { SESSION_COOKIE_NAME } from '../session-cookie';
import { LocalDiskStorage } from '../storage/storage';
import { createTestDatabase } from '../test/db';
import { makeTempDir } from '../test/files';

const ORIGIN = 'http://localhost:5173';
const PASSWORD = 'correct-horse-battery';

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
  const username = `dm_user_${counter}`;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { origin: ORIGIN },
    payload: { username, password: PASSWORD },
    remoteAddress: `10.180.${Math.floor(counter / 250)}.${counter % 250}`,
  });
  expect(res.statusCode).toBe(201);
  const token = res.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;
  return { username, token, id: res.json().user.id as string };
}

function send(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
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

const createDm = (app: FastifyInstance, user: TestUser | undefined, ws: string, userId: unknown) =>
  send(app, 'POST', user, `/api/workspaces/${ws}/dms`, { userId });

async function setup() {
  const app = makeApp();
  const owner = await createUser(app);
  const alice = await createUser(app);
  const bob = await createUser(app);
  const outsider = await createUser(app); // 別のワークスペース
  const ws = await newWorkspace(app, owner);
  await newWorkspace(app, outsider);
  await addMember(ws, alice);
  await addMember(ws, bob);
  return { app, owner, alice, bob, outsider, ws };
}

async function dmRows(ws: string) {
  return testDb.db
    .select()
    .from(channels)
    .where(and(eq(channels.workspaceId, ws), eq(channels.type, 'dm')));
}

interface ListedChannel {
  id: string;
  type: string;
  peer: { id: string } | null;
}

describe('POST /api/workspaces/:ws/dms(FR-102)', () => {
  it('作成すると 201。2 人が参加者になり、応答に相手の情報が入る。name・createdBy は null', async () => {
    const { app, alice, bob, ws } = await setup();
    const res = await createDm(app, alice, ws, bob.id);
    expect(res.statusCode, res.body).toBe(201);
    const dm = res.json();
    expect(dm).toMatchObject({
      workspaceId: ws,
      type: 'dm',
      name: null,
      isDefault: false,
      createdBy: null,
      peer: { id: bob.id, username: bob.username, avatarUrl: null },
    });
    const members = await testDb.db
      .select()
      .from(channelMembers)
      .where(eq(channelMembers.channelId, dm.id));
    expect(members.map((m) => m.userId).sort()).toEqual([alice.id, bob.id].sort());
    const [row] = await dmRows(ws);
    expect(row!.dmKey).toBe([alice.id, bob.id].sort().join(':'));
  });

  it('すでにあれば、それを返す(200)。どちらから作っても同じ。相手の情報は、呼び出した人から見たもの', async () => {
    const { app, alice, bob, ws } = await setup();
    const first = (await createDm(app, alice, ws, bob.id)).json();
    const again = await createDm(app, alice, ws, bob.id);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first);
    const reverse = await createDm(app, bob, ws, alice.id);
    expect(reverse.statusCode).toBe(200);
    expect(reverse.json().id).toBe(first.id);
    expect(reverse.json().peer.id).toBe(alice.id);
    expect(await dmRows(ws)).toHaveLength(1);
  });

  it('同時に作っても 1 つになる(どちらの向きでも。全員が同じ ID を受け取る)', async () => {
    const { app, alice, bob, ws } = await setup();
    const results = await Promise.all(
      [alice, bob, alice, bob, alice, bob].map((u) =>
        createDm(app, u, ws, u === alice ? bob.id : alice.id),
      ),
    );
    for (const r of results) expect([200, 201]).toContain(r.statusCode);
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(new Set(results.map((r) => r.json().id)).size).toBe(1);
    expect(await dmRows(ws)).toHaveLength(1);
  });

  it('別のワークスペースでは、同じ 2 人でも、別の DM になる', async () => {
    const { app, alice, bob, ws } = await setup();
    const ws2 = await newWorkspace(app, alice);
    await addMember(ws2, bob);
    const a = (await createDm(app, alice, ws, bob.id)).json();
    const b = (await createDm(app, alice, ws2, bob.id)).json();
    expect(a.id).not.toBe(b.id);
  });

  it('相手の検証: 自分自身・他のワークスペースのユーザー・kicked・存在しない ID・形式違い・未指定は 400', async () => {
    const { app, alice, bob, outsider, ws } = await setup();
    await testDb.db
      .update(memberships)
      .set({ status: 'kicked' })
      .where(and(eq(memberships.workspaceId, ws), eq(memberships.userId, bob.id)));
    const cases: unknown[] = [
      alice.id,
      outsider.id,
      bob.id,
      '00000000-0000-4000-8000-000000000000',
      'not-a-uuid',
      undefined,
    ];
    for (const target of cases) {
      const res = await createDm(app, alice, ws, target);
      expect(res.statusCode, String(target)).toBe(400);
    }
    expect(await dmRows(ws)).toEqual([]);
  });

  it('余分な項目は 400。未ログインは 401。ワークスペースに所属していない人は 404', async () => {
    const { app, alice, bob, outsider, ws } = await setup();
    const extra = await send(app, 'POST', alice, `/api/workspaces/${ws}/dms`, {
      userId: bob.id,
      x: 1,
    });
    expect(extra.statusCode).toBe(400);
    expect((await createDm(app, undefined, ws, bob.id)).statusCode).toBe(401);
    expect((await createDm(app, outsider, ws, bob.id)).statusCode).toBe(404);
    expect(await dmRows(ws)).toHaveLength(0);
  });
});

describe('GET /api/workspaces/:ws/channels(DM を含む)', () => {
  it('自分が参加する DM が、相手の情報つきで含まれる。他人の DM は含まれない', async () => {
    const { app, owner, alice, bob, ws } = await setup();
    const ab = (await createDm(app, alice, ws, bob.id)).json();
    const ao = (await createDm(app, alice, ws, owner.id)).json();

    const aliceList = (
      await send(app, 'GET', alice, `/api/workspaces/${ws}/channels`)
    ).json() as ListedChannel[];
    const dms = aliceList.filter((c) => c.type === 'dm');
    expect(dms.map((c) => c.id).sort()).toEqual([ab.id, ao.id].sort());
    expect(dms.find((c) => c.id === ab.id)!.peer!.id).toBe(bob.id);
    expect(dms.find((c) => c.id === ao.id)!.peer!.id).toBe(owner.id);
    expect(aliceList.filter((c) => c.type !== 'dm').every((c) => c.peer === null)).toBe(true);

    const bobList = (
      await send(app, 'GET', bob, `/api/workspaces/${ws}/channels`)
    ).json() as ListedChannel[];
    const bobDms = bobList.filter((c) => c.type === 'dm');
    expect(bobDms).toHaveLength(1);
    expect(bobDms[0]!.peer!.id).toBe(alice.id);

    // オーナーも、自分が参加しない DM(alice と bob)は、見えない
    const ownerList = (
      await send(app, 'GET', owner, `/api/workspaces/${ws}/channels`)
    ).json() as ListedChannel[];
    expect(ownerList.map((c) => c.id)).not.toContain(ab.id);
  });
});

describe('DM の認可と操作(設計書 §4)', () => {
  async function withDm() {
    const ctx = await setup();
    const dm = (await createDm(ctx.app, ctx.alice, ctx.ws, ctx.bob.id)).json() as { id: string };
    return { ...ctx, ch: dm.id };
  }
  const thumbsUp = encodeURIComponent('👍');

  it('参加者以外(ワークスペースのオーナーを含む)は、見られず、操作できず、404', async () => {
    const { app, owner, outsider, alice, ch } = await withDm();
    const posted = await send(app, 'POST', alice, `/api/channels/${ch}/messages`, { body: 'hi' });
    expect(posted.statusCode).toBe(201);
    const id = posted.json().id as number;
    for (const user of [owner, outsider]) {
      const codes = [
        await send(app, 'GET', user, `/api/channels/${ch}/messages`),
        await send(app, 'POST', user, `/api/channels/${ch}/messages`, { body: 'x' }),
        await send(app, 'GET', user, `/api/channels/${ch}/members`),
        await send(app, 'PATCH', user, `/api/messages/${id}`, { body: 'x' }),
        await send(app, 'DELETE', user, `/api/messages/${id}`),
        await send(app, 'POST', user, `/api/messages/${id}/replies`, { body: 'x' }),
        await send(app, 'PUT', user, `/api/messages/${id}/reactions/${thumbsUp}`),
        await send(app, 'POST', user, `/api/channels/${ch}/join`),
        await send(app, 'POST', user, `/api/channels/${ch}/leave`),
      ].map((r) => r.statusCode);
      expect(codes).toEqual(codes.map(() => 404));
    }
    // オーナーは、DM を削除できず、(参加者でないので)存在も分からない
    expect((await send(app, 'DELETE', owner, `/api/channels/${ch}`)).statusCode).toBe(404);
  });

  it('退出・招待・削除はできない(参加者には 400。参加者でないオーナーの招待は 404)', async () => {
    const { app, owner, alice, bob, ch } = await withDm();
    expect((await send(app, 'POST', alice, `/api/channels/${ch}/leave`)).statusCode).toBe(400);
    expect(
      (await send(app, 'POST', alice, `/api/channels/${ch}/members`, { userId: owner.id }))
        .statusCode,
    ).toBe(400);
    expect(
      (await send(app, 'POST', owner, `/api/channels/${ch}/members`, { userId: owner.id }))
        .statusCode,
    ).toBe(404);
    expect((await send(app, 'DELETE', alice, `/api/channels/${ch}`)).statusCode).not.toBe(204);
    const members = await testDb.db
      .select()
      .from(channelMembers)
      .where(eq(channelMembers.channelId, ch));
    expect(members.map((m) => m.userId).sort()).toEqual([alice.id, bob.id].sort());
  });

  it('投稿・編集・スレッド返信・リアクション・削除が、チャンネルと同じ規則で動く', async () => {
    const { app, alice, bob, ch } = await withDm();
    const posted = await send(app, 'POST', alice, `/api/channels/${ch}/messages`, {
      body: `こんにちは @${bob.username}`,
    });
    expect(posted.statusCode).toBe(201);
    expect(posted.json().mentions).toEqual([{ userId: bob.id, username: bob.username }]);
    const id = posted.json().id as number;

    // 相手の投稿は、編集できない(403)。自分のは、できる
    expect((await send(app, 'PATCH', bob, `/api/messages/${id}`, { body: 'x' })).statusCode).toBe(
      403,
    );
    const edited = await send(app, 'PATCH', alice, `/api/messages/${id}`, { body: '直した' });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().editedAt).not.toBeNull();

    const replied = await send(app, 'POST', bob, `/api/messages/${id}/replies`, { body: '返信' });
    expect(replied.statusCode).toBe(201);
    const reaction = await send(app, 'PUT', bob, `/api/messages/${id}/reactions/${thumbsUp}`);
    expect(reaction.statusCode).toBe(200);

    const list = await send(app, 'GET', bob, `/api/channels/${ch}/messages`);
    expect(list.json().messages[0]).toMatchObject({
      id,
      body: '直した',
      replyCount: 1,
      reactions: [{ emoji: '👍', count: 1, userIds: [bob.id] }],
    });

    expect((await send(app, 'DELETE', alice, `/api/messages/${id}`)).statusCode).toBe(204);
  });
});

describe('WebSocket のイベント: dm:created', () => {
  async function setupWs() {
    const config = loadConfig({ ALLOWED_ORIGIN: ORIGIN });
    const app = buildApp({ config, db: testDb.db, storage, logger: false });
    apps.push(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const owner = await createUser(app);
    const alice = await createUser(app);
    const bob = await createUser(app);
    const ws = await newWorkspace(app, owner);
    await addMember(ws, alice);
    await addMember(ws, bob);
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
      return new Promise<{ of: (n: string) => unknown[] }>((resolve, reject) => {
        socket.once('connect', () =>
          resolve({ of: (n) => all.filter((e) => e.name === n).map((e) => e.payload) }),
        );
        socket.once('connect_error', reject);
      });
    };
    return {
      app,
      alice,
      bob,
      ws,
      ownerRec: await connect(owner),
      aliceRec: await connect(alice),
      bobRec: await connect(bob),
      // alice の、2 つ目のソケット(別のタブ)
      aliceTab: await connect(alice),
    };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

  it('2 人の user ルームに、それぞれ相手の情報つきで届く。第三者(オーナー)には届かない。既存の DM を返すだけなら、通知しない', async () => {
    const { app, alice, bob, ws, ownerRec, aliceRec, aliceTab, bobRec } = await setupWs();
    const dm = (await createDm(app, alice, ws, bob.id)).json();
    await vi.waitFor(() => expect(bobRec.of('dm:created')).toHaveLength(1));
    await vi.waitFor(() => expect(aliceTab.of('dm:created')).toHaveLength(1));
    expect(aliceRec.of('dm:created')).toEqual([dm]);
    expect(aliceTab.of('dm:created')).toEqual([dm]);
    expect(bobRec.of('dm:created')).toEqual([
      { ...dm, peer: expect.objectContaining({ id: alice.id }) },
    ]);
    await settle();
    expect(ownerRec.of('dm:created')).toEqual([]);

    await createDm(app, bob, ws, alice.id);
    await settle();
    expect(bobRec.of('dm:created')).toHaveLength(1);
    expect(aliceRec.of('dm:created')).toHaveLength(1);
  });

  it('2 人の全ソケットが、ch ルームに参加する(DM を作る前に接続していても、投稿が届く)。第三者には届かない', async () => {
    const { app, alice, bob, ws, ownerRec, aliceTab, bobRec } = await setupWs();
    const dm = (await createDm(app, alice, ws, bob.id)).json();
    const res = await send(app, 'POST', alice, `/api/channels/${dm.id}/messages`, {
      body: 'hello',
    });
    expect(res.statusCode).toBe(201);
    await vi.waitFor(() => expect(bobRec.of('message:created')).toHaveLength(1));
    await vi.waitFor(() => expect(aliceTab.of('message:created')).toHaveLength(1));
    await settle();
    expect(ownerRec.of('message:created')).toEqual([]);
  });
});
