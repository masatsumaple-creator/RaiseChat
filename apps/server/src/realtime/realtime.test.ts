import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { AddressInfo } from 'node:net';
import { io as connectIo, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp, type BuildAppOptions } from '../app';
import { loadConfig } from '../config';
import { memberships, sessions } from '../db/schema';
import { SESSION_COOKIE_NAME } from '../session-cookie';
import { LocalDiskStorage } from '../storage/storage';
import { createTestDatabase } from '../test/db';
import { fileOfSize, makeTempDir, multipart, PNG_HEADER } from '../test/files';
import { chRoom, sessionRoom, userRoom, wsRoom } from './realtime';
import { hashToken } from '../auth/tokens';

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

interface Running {
  app: FastifyInstance;
  url: string;
}

/** 実際にポートを開いて、起動する(WebSocket のテストは、実際の接続が要る) */
async function start(realtime?: BuildAppOptions['realtime']): Promise<Running> {
  const config = loadConfig({ ALLOWED_ORIGIN: ORIGIN });
  const app = buildApp({ config, db: testDb.db, storage, logger: false, realtime });
  apps.push(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  return { app, url: `http://127.0.0.1:${port}` };
}

interface TestUser {
  username: string;
  token: string;
  id: string;
}

async function createUser(app: FastifyInstance): Promise<TestUser> {
  counter += 1;
  const username = `rt_user_${counter}`;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { origin: ORIGIN },
    payload: { username, password: PASSWORD },
    remoteAddress: `10.150.${Math.floor(counter / 250)}.${counter % 250}`,
  });
  expect(res.statusCode).toBe(201);
  const token = res.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;
  return { username, token, id: res.json().user.id as string };
}

function send(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  user: { token: string } | undefined,
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

interface ConnectOptions {
  origin?: string | null;
  cookie?: string | null;
  transports?: ('websocket' | 'polling')[];
}

/** 接続を試みて、成功なら接続済みのソケット、失敗なら例外(理由つき)にする */
function connect(
  url: string,
  token: string | undefined,
  options: ConnectOptions = {},
): Promise<ClientSocket> {
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  const cookie =
    options.cookie === undefined
      ? token
        ? `${SESSION_COOKIE_NAME}=${token}`
        : null
      : options.cookie;
  const extraHeaders: Record<string, string> = {};
  if (origin) extraHeaders.origin = origin;
  if (cookie) extraHeaders.cookie = cookie;
  const socket = connectIo(url, {
    transports: options.transports ?? ['websocket'],
    extraHeaders,
    reconnection: false,
    forceNew: true,
  });
  sockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (error) => reject(error));
  });
}

interface Recorder {
  all: { name: string; payload: unknown }[];
  of: <T = unknown>(name: string) => T[];
}

/** 受信したイベントを、すべて記録する(接続した直後から) */
function record(socket: ClientSocket): Recorder {
  const all: Recorder['all'] = [];
  socket.onAny((name: string, payload: unknown) => all.push({ name, payload }));
  return {
    all,
    of: <T>(name: string) => all.filter((e) => e.name === name).map((e) => e.payload as T),
  };
}

/** 届かないことの確認のため、少し待つ */
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

async function newWorkspace(app: FastifyInstance, owner: TestUser, name = 'チーム') {
  const res = await send(app, 'POST', owner, '/api/workspaces', { name });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function addMember(ws: string, user: TestUser, status: 'active' | 'kicked' = 'active') {
  await testDb.db
    .insert(memberships)
    .values({ workspaceId: ws, userId: user.id, role: 'member', status });
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

async function generalOf(app: FastifyInstance, user: TestUser, ws: string) {
  const list = (await send(app, 'GET', user, `/api/workspaces/${ws}/channels`)).json() as {
    id: string;
    isDefault: boolean;
  }[];
  return list.find((c) => c.isDefault)!.id;
}

/** サーバー側で見た、ルームに入っているソケットの ID */
async function members(app: FastifyInstance, room: string): Promise<string[]> {
  return (await app.realtime.io.in(room).fetchSockets()).map((s) => s.id);
}

function roomsOf(app: FastifyInstance, socket: ClientSocket): Set<string> {
  return app.realtime.io.sockets.sockets.get(socket.id!)!.rooms;
}

describe('接続(設計書 §6.1)', () => {
  it('Origin がない・許可されていない Origin の接続は拒否される', async () => {
    const { app, url } = await start();
    const user = await createUser(app);
    await expect(connect(url, user.token, { origin: null })).rejects.toThrow();
    await expect(connect(url, user.token, { origin: 'http://evil.example' })).rejects.toThrow();
    expect(await app.realtime.io.fetchSockets()).toEqual([]);
    // 許可された Origin なら、接続できる
    await expect(connect(url, user.token)).resolves.toBeDefined();
  });

  it('セッションがない・不正・期限切れの接続は、拒否される(unauthorized)', async () => {
    const { app, url } = await start();
    const user = await createUser(app);
    await expect(connect(url, undefined)).rejects.toThrow('unauthorized');
    await expect(connect(url, 'not-a-real-token')).rejects.toThrow('unauthorized');
    await expect(connect(url, user.token, { cookie: 'other=1' })).rejects.toThrow('unauthorized');

    await testDb.db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.tokenHash, hashToken(user.token)));
    await expect(connect(url, user.token)).rejects.toThrow('unauthorized');
    expect(await app.realtime.io.fetchSockets()).toEqual([]);
  });

  it('トランスポートは websocket のみ(ポーリングは使えない)', async () => {
    const { app, url } = await start();
    const user = await createUser(app);
    await expect(connect(url, user.token, { transports: ['polling'] })).rejects.toThrow();
  });

  it('接続時に、DB の所属から、ルームに参加する(自分・セッション・所属ワークスペース・参加チャンネルだけ)', async () => {
    const { app, url } = await start();
    const owner = await createUser(app);
    const me = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const otherWs = await newWorkspace(app, owner, '別');
    await addMember(ws, me);
    const general = await generalOf(app, owner, ws);
    const joined = await createChannel(app, me, ws, 'joined');
    const notJoined = await createChannel(app, owner, ws, 'not-joined');
    const secret = await createChannel(app, owner, ws, 'secret', 'private');
    await send(app, 'POST', me, `/api/channels/${general}/join`); // general に参加

    const socket = await connect(url, me.token);
    const rooms = roomsOf(app, socket);
    expect(rooms).toContain(userRoom(me.id));
    expect(rooms).toContain(sessionRoom(hashToken(me.token)));
    expect(rooms).toContain(wsRoom(ws));
    expect(rooms).toContain(chRoom(general));
    expect(rooms).toContain(chRoom(joined));
    expect(rooms).not.toContain(chRoom(notJoined));
    expect(rooms).not.toContain(chRoom(secret));
    expect(rooms).not.toContain(wsRoom(otherWs));
  });

  it('kicked のワークスペースの ws・ch ルームには参加しない(行が残っていても)。他のワークスペースは参加する', async () => {
    const { app, url } = await start();
    const owner = await createUser(app);
    const me = await createUser(app);
    const kickedWs = await newWorkspace(app, owner, '追い出された');
    const okWs = await newWorkspace(app, owner, '残っている');
    await addMember(kickedWs, me);
    await addMember(okWs, me);
    const kickedGeneral = await generalOf(app, owner, kickedWs);
    const okGeneral = await generalOf(app, owner, okWs);
    await send(app, 'POST', me, `/api/channels/${kickedGeneral}/join`);
    await send(app, 'POST', me, `/api/channels/${okGeneral}/join`);
    await testDb.db
      .update(memberships)
      .set({ status: 'kicked' })
      .where(and(eq(memberships.workspaceId, kickedWs), eq(memberships.userId, me.id)));

    const socket = await connect(url, me.token);
    const rooms = roomsOf(app, socket);
    expect(rooms).not.toContain(wsRoom(kickedWs));
    expect(rooms).not.toContain(chRoom(kickedGeneral));
    expect(rooms).toContain(wsRoom(okWs));
    expect(rooms).toContain(chRoom(okGeneral));
  });

  it('同時接続は上限まで。超えると、最も古い接続が切られる(他のユーザーには影響しない)', async () => {
    const { app, url } = await start({ maxConnectionsPerUser: 3 });
    const me = await createUser(app);
    const other = await createUser(app);
    const otherSocket = await connect(url, other.token);
    const first = await connect(url, me.token);
    const second = await connect(url, me.token);
    const third = await connect(url, me.token);
    expect(await members(app, userRoom(me.id))).toHaveLength(3);

    const fourth = await connect(url, me.token);
    await vi.waitFor(() => expect(first.connected).toBe(false));
    expect(second.connected).toBe(true);
    expect(third.connected).toBe(true);
    expect(fourth.connected).toBe(true);
    expect(otherSocket.connected).toBe(true);
    expect(await members(app, userRoom(me.id))).toHaveLength(3);
  });

  it('クライアントからのイベントは無視される(ルームへの参加を要求しても、参加しない)', async () => {
    const { app, url } = await start();
    const owner = await createUser(app);
    const outsider = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const secret = await createChannel(app, owner, ws, 'secret', 'private');
    const socket = await connect(url, outsider.token);
    const rec = record(socket);
    // 任意のチャンネルを購読しようとする試み
    socket.emit('join', chRoom(secret));
    socket.emit('subscribe', { channelId: secret });
    socket.emit('message:created', { body: 'forged' });
    await settle();

    expect(roomsOf(app, socket)).not.toContain(chRoom(secret));
    await send(app, 'POST', owner, `/api/channels/${secret}/messages`, { body: 'secret message' });
    await settle();
    expect(rec.all).toEqual([]);
    expect(socket.connected).toBe(true);
  });

  it('ソケットのセッションの確認: 期限切れ・削除されたセッションの接続を切る(他は残る)', async () => {
    const { app, url } = await start();
    const me = await createUser(app);
    const expired = await connect(url, me.token);

    // 同じユーザーの、別のセッション
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ORIGIN },
      payload: { username: me.username, password: PASSWORD },
      remoteAddress: '10.151.0.1',
    });
    const secondToken = login.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;
    const alive = await connect(url, secondToken);

    await testDb.db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.tokenHash, hashToken(me.token)));
    await app.realtime.checkSessions();
    await vi.waitFor(() => expect(expired.connected).toBe(false));
    expect(alive.connected).toBe(true);
  });

  it('確認は、タイマーで定期的に行われる', async () => {
    const { app, url } = await start({ sessionCheckIntervalMs: 100 });
    const me = await createUser(app);
    const socket = await connect(url, me.token);
    await testDb.db.delete(sessions).where(eq(sessions.tokenHash, hashToken(me.token)));
    await vi.waitFor(() => expect(socket.connected).toBe(false), { timeout: 3000 });
  });

  it('resyncUser: 所属と合わない余分なルームから外し、足りないルームに参加させる', async () => {
    const { app, url } = await start();
    const owner = await createUser(app);
    const me = await createUser(app);
    const ws = await newWorkspace(app, owner);
    await addMember(ws, me);
    const other = await createChannel(app, owner, ws, 'other');
    const socket = await connect(url, me.token);
    // ずれを作る: 参加していないチャンネルのルームに入れ、所属しているワークスペースのルームから外す
    app.realtime.io.in(userRoom(me.id)).socketsJoin(chRoom(other));
    app.realtime.io.in(userRoom(me.id)).socketsLeave(wsRoom(ws));
    expect(roomsOf(app, socket)).toContain(chRoom(other));

    await app.realtime.resyncUser(me.id);
    expect(roomsOf(app, socket)).not.toContain(chRoom(other));
    expect(roomsOf(app, socket)).toContain(wsRoom(ws));
  });
});

describe('message:created(FR-101)', () => {
  it('チャンネルの参加者だけに届く。ペイロードは REST の応答と同じ', async () => {
    const { app, url } = await start();
    const owner = await createUser(app);
    const member = await createUser(app);
    const bystander = await createUser(app); // 同じワークスペースで、チャンネルに未参加
    const outsider = await createUser(app); // 別のワークスペース
    const ws = await newWorkspace(app, owner);
    await addMember(ws, member);
    await addMember(ws, bystander);
    await newWorkspace(app, outsider, '別');
    const ch = await createChannel(app, owner, ws, 'talk');
    await send(app, 'POST', member, `/api/channels/${ch}/join`);

    const ownerSocket = await connect(url, owner.token);
    const memberSocket = await connect(url, member.token);
    const bystanderSocket = await connect(url, bystander.token);
    const outsiderSocket = await connect(url, outsider.token);
    const recs = [ownerSocket, memberSocket, bystanderSocket, outsiderSocket].map(record);

    const res = await send(app, 'POST', owner, `/api/channels/${ch}/messages`, {
      body: 'こんにちは',
    });
    expect(res.statusCode).toBe(201);
    await vi.waitFor(() => expect(recs[0]!.of('message:created')).toHaveLength(1));
    await vi.waitFor(() => expect(recs[1]!.of('message:created')).toHaveLength(1));
    expect(recs[0]!.of('message:created')[0]).toEqual(res.json());
    expect(recs[1]!.of('message:created')[0]).toEqual(res.json());
    await settle();
    expect(recs[2]!.of('message:created')).toEqual([]);
    expect(recs[3]!.of('message:created')).toEqual([]);
  });

  it('プライベートチャンネルのメッセージは、参加者だけに届く(オーナーでも、参加していなければ届かない)', async () => {
    const { app, url } = await start();
    const owner = await createUser(app);
    const member = await createUser(app);
    const ws = await newWorkspace(app, owner);
    await addMember(ws, member);
    const secret = await createChannel(app, member, ws, 'secret', 'private');
    const ownerRec = record(await connect(url, owner.token));
    const memberRec = record(await connect(url, member.token));
    await send(app, 'POST', member, `/api/channels/${secret}/messages`, { body: 'ひみつ' });
    await vi.waitFor(() => expect(memberRec.of('message:created')).toHaveLength(1));
    await settle();
    expect(ownerRec.of('message:created')).toEqual([]);
  });

  it('作成者は、チャンネルを作った直後から、そのチャンネルのイベントを受け取る(再接続なしで)', async () => {
    const { app, url } = await start();
    const owner = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const socket = await connect(url, owner.token); // チャンネルの作成前に接続している
    const rec = record(socket);
    const ch = await createChannel(app, owner, ws, 'fresh', 'private');
    expect(roomsOf(app, socket)).toContain(chRoom(ch));
    await send(app, 'POST', owner, `/api/channels/${ch}/messages`, { body: 'first' });
    await vi.waitFor(() => expect(rec.of('message:created')).toHaveLength(1));
  });
});

describe('チャンネルの作成・参加・退出・招待(設計書 §6.3)', () => {
  it('channel:created: パブリックはワークスペースの全員へ、プライベートは作成者だけへ', async () => {
    const { app, url } = await start();
    const owner = await createUser(app);
    const member = await createUser(app);
    const outsider = await createUser(app);
    const ws = await newWorkspace(app, owner);
    await newWorkspace(app, outsider, '別');
    await addMember(ws, member);
    const ownerRec = record(await connect(url, owner.token));
    const memberRec = record(await connect(url, member.token));
    const outsiderRec = record(await connect(url, outsider.token));

    const open = await createChannel(app, owner, ws, 'open');
    await vi.waitFor(() => expect(memberRec.of('channel:created')).toHaveLength(1));
    expect(memberRec.of('channel:created')[0]).toMatchObject({
      id: open,
      name: 'open',
      type: 'public',
    });
    expect(ownerRec.of('channel:created').length).toBeGreaterThanOrEqual(1);

    await createChannel(app, owner, ws, 'secret', 'private');
    await settle();
    expect(memberRec.of('channel:created')).toHaveLength(1); // プライベートは、届かない
    expect(outsiderRec.of('channel:created')).toEqual([]); // 他のワークスペースにも、届かない
    expect(ownerRec.of('channel:created').map((c) => (c as { type: string }).type)).toContain(
      'private',
    );
  });

  it('参加: 本人に channel:added、参加者に channel:member-joined。以後のメッセージが届く。再参加の通知は重複しない', async () => {
    const { app, url } = await start();
    const owner = await createUser(app);
    const member = await createUser(app);
    const ws = await newWorkspace(app, owner);
    await addMember(ws, member);
    const ch = await createChannel(app, owner, ws, 'open');
    const ownerRec = record(await connect(url, owner.token));
    const memberSocket = await connect(url, member.token);
    const memberRec = record(memberSocket);
    const memberTab2 = record(await connect(url, member.token)); // 別のタブ

    await send(app, 'POST', member, `/api/channels/${ch}/join`);
    await vi.waitFor(() => expect(memberRec.of('channel:added')).toHaveLength(1));
    await vi.waitFor(() => expect(memberTab2.of('channel:added')).toHaveLength(1));
    await vi.waitFor(() => expect(ownerRec.of('channel:member-joined')).toHaveLength(1));
    expect(ownerRec.of('channel:member-joined')[0]).toMatchObject({
      channelId: ch,
      user: { id: member.id, username: member.username },
    });

    await send(app, 'POST', owner, `/api/channels/${ch}/messages`, { body: 'welcome' });
    await vi.waitFor(() => expect(memberRec.of('message:created')).toHaveLength(1));
    await vi.waitFor(() => expect(memberTab2.of('message:created')).toHaveLength(1));

    // 参加済みの再参加は、何も通知しない
    await send(app, 'POST', member, `/api/channels/${ch}/join`);
    await settle();
    expect(memberRec.of('channel:added')).toHaveLength(1);
    expect(ownerRec.of('channel:member-joined')).toHaveLength(1);
  });

  it('退出: 本人(全タブ)に channel:left、残りに channel:member-left(本人には届かない)。以後のメッセージは届かない', async () => {
    const { app, url } = await start();
    const owner = await createUser(app);
    const member = await createUser(app);
    const ws = await newWorkspace(app, owner);
    await addMember(ws, member);
    const ch = await createChannel(app, owner, ws, 'open');
    await send(app, 'POST', member, `/api/channels/${ch}/join`);
    const ownerRec = record(await connect(url, owner.token));
    const memberSocket = await connect(url, member.token);
    const memberRec = record(memberSocket);
    const memberTab2 = record(await connect(url, member.token));

    await send(app, 'POST', member, `/api/channels/${ch}/leave`);
    await vi.waitFor(() => expect(memberRec.of('channel:left')).toEqual([{ channelId: ch }]));
    await vi.waitFor(() => expect(memberTab2.of('channel:left')).toEqual([{ channelId: ch }]));
    await vi.waitFor(() =>
      expect(ownerRec.of('channel:member-left')).toEqual([{ channelId: ch, userId: member.id }]),
    );
    expect(memberRec.of('channel:member-left')).toEqual([]); // 外した後なので、本人には届かない
    expect(roomsOf(app, memberSocket)).not.toContain(chRoom(ch));

    await send(app, 'POST', owner, `/api/channels/${ch}/messages`, { body: 'after leaving' });
    await settle();
    expect(memberRec.of('message:created')).toEqual([]);
    expect(memberTab2.of('message:created')).toEqual([]);
  });

  it('プライベートへの招待: 招待された人に channel:added。以後のメッセージが届く', async () => {
    const { app, url } = await start();
    const owner = await createUser(app);
    const invited = await createUser(app);
    const ws = await newWorkspace(app, owner);
    await addMember(ws, invited);
    const secret = await createChannel(app, owner, ws, 'secret', 'private');
    const ownerRec = record(await connect(url, owner.token));
    const invitedRec = record(await connect(url, invited.token));

    const res = await send(app, 'POST', owner, `/api/channels/${secret}/members`, {
      userId: invited.id,
    });
    expect(res.statusCode).toBe(204);
    await vi.waitFor(() => expect(invitedRec.of('channel:added')).toHaveLength(1));
    expect(invitedRec.of('channel:added')[0]).toMatchObject({ id: secret, type: 'private' });
    await vi.waitFor(() => expect(ownerRec.of('channel:member-joined')).toHaveLength(1));

    await send(app, 'POST', owner, `/api/channels/${secret}/messages`, { body: 'hi' });
    await vi.waitFor(() => expect(invitedRec.of('message:created')).toHaveLength(1));

    // 招待済みの再招待は、通知しない
    await send(app, 'POST', owner, `/api/channels/${secret}/members`, { userId: invited.id });
    await settle();
    expect(invitedRec.of('channel:added')).toHaveLength(1);
  });
});

describe('ワークスペースの作成・招待の受諾(設計書 §6.3)', () => {
  it('作成: 別のタブに workspace:added。作成前に接続していたソケットも、general のイベントを受け取る', async () => {
    const { app, url } = await start();
    const owner = await createUser(app);
    const tab1 = await connect(url, owner.token);
    const rec1 = record(tab1);
    const rec2 = record(await connect(url, owner.token));

    const ws = await newWorkspace(app, owner, '新しい');
    await vi.waitFor(() => expect(rec1.of('workspace:added')).toHaveLength(1));
    await vi.waitFor(() => expect(rec2.of('workspace:added')).toHaveLength(1));
    expect(rec2.of('workspace:added')[0]).toEqual({ id: ws, name: '新しい', role: 'owner' });
    expect(roomsOf(app, tab1)).toContain(wsRoom(ws));

    const general = await generalOf(app, owner, ws);
    await send(app, 'POST', owner, `/api/channels/${general}/messages`, { body: 'hello' });
    await vi.waitFor(() => expect(rec1.of('message:created')).toHaveLength(1));
    await vi.waitFor(() => expect(rec2.of('message:created')).toHaveLength(1));
  });

  it('受諾: 本人に workspace:added、ワークスペースの全員に member:joined。以後 general のメッセージが届く。再受諾は通知しない', async () => {
    const { app, url } = await start();
    const owner = await createUser(app);
    const guest = await createUser(app);
    const bystander = await createUser(app);
    const ws = await newWorkspace(app, owner);
    await newWorkspace(app, bystander, '別');
    const invite = await send(app, 'POST', owner, `/api/workspaces/${ws}/invitations`, {
      maxUses: 'unlimited',
    });
    const token = invite.json().token as string;
    const ownerRec = record(await connect(url, owner.token));
    const guestSocket = await connect(url, guest.token); // 参加前に接続している
    const guestRec = record(guestSocket);
    const bystanderRec = record(await connect(url, bystander.token));

    const res = await send(app, 'POST', guest, `/api/invitations/${token}/accept`);
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(guestRec.of('workspace:added')).toHaveLength(1));
    expect(guestRec.of('workspace:added')[0]).toEqual({ id: ws, name: 'チーム', role: 'member' });
    await vi.waitFor(() => expect(ownerRec.of('member:joined')).toHaveLength(1));
    expect(ownerRec.of('member:joined')[0]).toMatchObject({
      workspaceId: ws,
      member: { id: guest.id, username: guest.username, role: 'member' },
    });
    expect(roomsOf(app, guestSocket)).toContain(wsRoom(ws));

    const general = await generalOf(app, owner, ws);
    await send(app, 'POST', owner, `/api/channels/${general}/messages`, { body: 'ようこそ' });
    await vi.waitFor(() => expect(guestRec.of('message:created')).toHaveLength(1));

    // 再受諾では、何も通知しない
    await send(app, 'POST', guest, `/api/invitations/${token}/accept`);
    await settle();
    expect(guestRec.of('workspace:added')).toHaveLength(1);
    expect(ownerRec.of('member:joined')).toHaveLength(1);
    expect(bystanderRec.of('member:joined')).toEqual([]);
    expect(bystanderRec.of('workspace:added')).toEqual([]);
  });
});

describe('user:updated(FR-004。設計書 §6.4)', () => {
  it('表示名・ステータスの変更が、所属する全ワークスペースのメンバーに届く(他のワークスペースの人には届かない)', async () => {
    const { app, url } = await start();
    const me = await createUser(app);
    const friend = await createUser(app); // 同じワークスペース
    const stranger = await createUser(app);
    const wsA = await newWorkspace(app, me, 'A');
    const wsB = await newWorkspace(app, me, 'B');
    await addMember(wsA, friend);
    await newWorkspace(app, stranger, '無関係');
    const friendRec = record(await connect(url, friend.token));
    const strangerRec = record(await connect(url, stranger.token));
    const myRec = record(await connect(url, me.token));

    const res = await send(app, 'PATCH', me, '/api/me', {
      displayName: '新しい名前',
      statusText: '作業中',
    });
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(friendRec.of('user:updated')).toHaveLength(1));
    expect(friendRec.of('user:updated')[0]).toEqual({
      id: me.id,
      username: me.username,
      displayName: '新しい名前',
      statusText: '作業中',
      avatarUrl: null,
    });
    // 自分の別のタブにも届く(ws ルームに入っている)。2 つのワークスペースに所属していても、1 回だけ
    await vi.waitFor(() => expect(myRec.of('user:updated')).toHaveLength(1));
    await settle();
    expect(strangerRec.of('user:updated')).toEqual([]);
    void wsB;
  });

  it('アバターの差し替えも、版つきの avatarUrl で届く', async () => {
    const { app, url } = await start();
    const me = await createUser(app);
    const friend = await createUser(app);
    const ws = await newWorkspace(app, me);
    await addMember(ws, friend);
    const friendRec = record(await connect(url, friend.token));
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
      cookies: { [SESSION_COOKIE_NAME]: me.token },
      payload,
    });
    expect(put.statusCode).toBe(200);
    await vi.waitFor(() => expect(friendRec.of('user:updated')).toHaveLength(1));
    expect(friendRec.of('user:updated')[0]).toMatchObject({
      id: me.id,
      avatarUrl: put.json().avatarUrl,
    });
  });

  it('kicked のワークスペースには、送らない。ワークスペースがなくても、エラーにならない', async () => {
    const { app, url } = await start();
    const me = await createUser(app);
    const other = await createUser(app);
    const ws = await newWorkspace(app, other);
    await addMember(ws, me, 'kicked');
    const otherRec = record(await connect(url, other.token));
    const res = await send(app, 'PATCH', me, '/api/me', { statusText: 'x' });
    expect(res.statusCode).toBe(200);
    await settle();
    expect(otherRec.of('user:updated')).toEqual([]);
  });
});

describe('ログアウトでの切断(FR-003)', () => {
  it('そのセッションのソケットだけが切断され、同じユーザーの別のセッションは残る', async () => {
    const { app, url } = await start();
    const me = await createUser(app);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ORIGIN },
      payload: { username: me.username, password: PASSWORD },
      remoteAddress: '10.152.0.1',
    });
    const secondToken = login.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;
    const a1 = await connect(url, me.token);
    const a2 = await connect(url, me.token); // 同じセッションの 2 つ目のタブ
    const b = await connect(url, secondToken);

    expect((await send(app, 'POST', me, '/api/auth/logout')).statusCode).toBe(204);
    await vi.waitFor(() => expect(a1.connected).toBe(false));
    await vi.waitFor(() => expect(a2.connected).toBe(false));
    expect(b.connected).toBe(true);
    // 同じ Cookie では、再接続もできない
    await expect(connect(url, me.token)).rejects.toThrow('unauthorized');
  });
});
