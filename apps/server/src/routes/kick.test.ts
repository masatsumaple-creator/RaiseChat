import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { AddressInfo } from 'node:net';
import { io as connectIo, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import {
  channelMembers,
  channels,
  memberships,
  messages,
  sessions,
  threadMembers,
} from '../db/schema';
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
  const username = `kick_user_${counter}`;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { origin: ORIGIN },
    payload: { username, password: PASSWORD },
    remoteAddress: `10.220.${Math.floor(counter / 250)}.${counter % 250}`,
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

const kick = (app: FastifyInstance, by: TestUser | undefined, ws: string, target: string) =>
  send(app, 'POST', by, `/api/workspaces/${ws}/members/${target}/kick`);
const unkick = (app: FastifyInstance, by: TestUser | undefined, ws: string, target: string) =>
  send(app, 'DELETE', by, `/api/workspaces/${ws}/kicked/${target}`);

async function newWorkspace(app: FastifyInstance, owner: TestUser, name = 'A') {
  const res = await send(app, 'POST', owner, '/api/workspaces', { name });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function addMember(ws: string, user: TestUser) {
  await testDb.db.insert(memberships).values({ workspaceId: ws, userId: user.id, role: 'member' });
}

async function channel(
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

/** 準備: オーナー・alice・bob。alice・bob は、open・DM・スレッドに参加。alice は、private にも参加。alice は、別のワークスペースにも所属 */
async function setup() {
  const app = makeApp();
  const owner = await createUser(app);
  const alice = await createUser(app);
  const bob = await createUser(app);
  const other = await createUser(app); // 別のワークスペースのオーナー
  const ws = await newWorkspace(app, owner);
  const ws2 = await newWorkspace(app, other, 'B');
  for (const u of [alice, bob]) await addMember(ws, u);
  await addMember(ws2, alice);
  const open = await channel(app, owner, ws, 'open');
  await join(app, alice, open);
  await join(app, bob, open);
  const secret = await channel(app, owner, ws, 'secret', 'private');
  expect(
    (await send(app, 'POST', owner, `/api/channels/${secret}/members`, { userId: alice.id }))
      .statusCode,
  ).toBe(204);
  const dm = (
    await send(app, 'POST', alice, `/api/workspaces/${ws}/dms`, { userId: bob.id })
  ).json().id as string;
  const root = await post(app, bob, open, 'スレッドの親');
  await send(app, 'POST', alice, `/api/messages/${root.id}/replies`, { body: '返信' });
  const aliceMessage = await post(app, alice, open, 'aliceの投稿');
  const other2 = await channel(app, other, ws2, 'b-open');
  await join(app, alice, other2);
  return { app, owner, alice, bob, other, ws, ws2, open, secret, dm, root, aliceMessage, other2 };
}

async function memberRows(userId: string, ws: string) {
  return testDb.db
    .select({ channelId: channelMembers.channelId })
    .from(channelMembers)
    .innerJoin(channels, eq(channels.id, channelMembers.channelId))
    .where(and(eq(channelMembers.userId, userId), eq(channels.workspaceId, ws)));
}

describe('POST /api/workspaces/:ws/members/:userId/kick(FR-302)', () => {
  it('オーナーだけ。メンバーは 403、所属なしは 404、未ログインは 401', async () => {
    const { app, alice, bob, other, ws } = await setup();
    expect((await kick(app, bob, ws, alice.id)).statusCode).toBe(403);
    expect((await kick(app, other, ws, alice.id)).statusCode).toBe(404);
    expect((await kick(app, undefined, ws, alice.id)).statusCode).toBe(401);
    const [row] = await testDb.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.workspaceId, ws), eq(memberships.userId, alice.id)));
    expect(row!.status).toBe('active');
  });

  it('オーナー自身は、キックできない(400)。存在しない・所属していない・形式違いのユーザーは 404。キック済みは 404', async () => {
    const { app, owner, alice, other, ws } = await setup();
    const res = await kick(app, owner, ws, owner.id);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('cannot_kick_owner');
    expect((await kick(app, owner, ws, other.id)).statusCode).toBe(404); // このワークスペースの所属ではない
    expect((await kick(app, owner, ws, '00000000-0000-4000-8000-000000000000')).statusCode).toBe(
      404,
    );
    expect((await kick(app, owner, ws, 'not-a-uuid')).statusCode).toBe(404);
    expect((await kick(app, owner, ws, alice.id)).statusCode).toBe(204);
    expect((await kick(app, owner, ws, alice.id)).statusCode).toBe(404);
    // オーナーは、まだ active
    const [row] = await testDb.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.workspaceId, ws), eq(memberships.userId, owner.id)));
    expect(row).toMatchObject({ role: 'owner', status: 'active' });
  });

  it('Membership が kicked になり、そのワークスペースの ChannelMember(DM・プライベートを含む)と ThreadMember が消える。メッセージは残り、他のワークスペースと、セッションは、そのまま', async () => {
    const { app, owner, alice, ws, ws2, open, secret, dm, root } = await setup();
    const messageCount = async () =>
      (await testDb.db.select({ n: sql<number>`count(*)::int` }).from(messages))[0]!.n;
    const before = await messageCount();
    expect((await memberRows(alice.id, ws)).map((r) => r.channelId).sort()).toEqual(
      [open, secret, dm].sort(),
    );
    expect(
      (await testDb.db.select().from(threadMembers).where(eq(threadMembers.userId, alice.id)))
        .length,
    ).toBeGreaterThan(0);

    expect((await kick(app, owner, ws, alice.id)).statusCode).toBe(204);

    const [row] = await testDb.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.workspaceId, ws), eq(memberships.userId, alice.id)));
    expect(row!.status).toBe('kicked');
    expect(await memberRows(alice.id, ws)).toEqual([]);
    expect(
      await testDb.db
        .select()
        .from(threadMembers)
        .where(and(eq(threadMembers.userId, alice.id), eq(threadMembers.rootMessageId, root.id))),
    ).toEqual([]);
    // 過去のメッセージは残る
    expect(await messageCount()).toBe(before);
    // 他のワークスペースの参加は、そのまま
    expect((await memberRows(alice.id, ws2)).length).toBe(1);
    // セッションは、失効しない。他のワークスペースは、使い続けられる
    expect(
      await testDb.db.select().from(sessions).where(eq(sessions.userId, alice.id)),
    ).not.toEqual([]);
    expect((await send(app, 'GET', alice, '/api/me')).statusCode).toBe(200);
    expect((await send(app, 'GET', alice, `/api/workspaces/${ws2}`)).statusCode).toBe(200);
    const list = (await send(app, 'GET', alice, '/api/workspaces')).json() as Array<{ id: string }>;
    expect(list.map((w) => w.id)).toEqual([ws2]);
  });

  it('キック後の遮断: ワークスペースを指定する API は 403、チャンネル・メッセージを指定する API は 404', async () => {
    const { app, owner, alice, ws, open, secret, dm, root, aliceMessage } = await setup();
    await kick(app, owner, ws, alice.id);

    const workspaceScoped = [
      send(app, 'GET', alice, `/api/workspaces/${ws}`),
      send(app, 'GET', alice, `/api/workspaces/${ws}/members`),
      send(app, 'GET', alice, `/api/workspaces/${ws}/channels`),
      send(app, 'GET', alice, `/api/workspaces/${ws}/search?q=スレッド`),
      send(app, 'POST', alice, `/api/workspaces/${ws}/channels`, { name: 'x', type: 'public' }),
      send(app, 'POST', alice, `/api/workspaces/${ws}/dms`, { userId: owner.id }),
    ];
    for (const res of await Promise.all(workspaceScoped)) expect(res.statusCode).toBe(403);

    const channelScoped = [
      send(app, 'GET', alice, `/api/channels/${open}/messages`),
      send(app, 'POST', alice, `/api/channels/${open}/messages`, { body: 'x' }),
      send(app, 'GET', alice, `/api/channels/${open}/members`),
      send(app, 'GET', alice, `/api/channels/${secret}/messages`),
      send(app, 'GET', alice, `/api/channels/${dm}/messages`),
      send(app, 'POST', alice, `/api/channels/${open}/leave`),
      send(app, 'GET', alice, `/api/messages/${root.id}/replies`),
      send(app, 'POST', alice, `/api/messages/${root.id}/replies`, { body: 'x' }),
      send(app, 'PUT', alice, `/api/messages/${root.id}/reactions/${encodeURIComponent('👍')}`),
      send(app, 'PATCH', alice, `/api/messages/${aliceMessage.id}`, { body: '直す' }),
      send(app, 'DELETE', alice, `/api/messages/${aliceMessage.id}`),
    ];
    for (const res of await Promise.all(channelScoped)) expect(res.statusCode).toBe(404);

    // パブリックへの参加は、kicked なので 403(存在は、キック前から知り得た)
    expect((await send(app, 'POST', alice, `/api/channels/${open}/join`)).statusCode).toBe(403);
  });

  it('キック済みの人の過去の投稿は、他の人には、そのまま見える', async () => {
    const { app, owner, bob, alice, ws, open, aliceMessage } = await setup();
    await kick(app, owner, ws, alice.id);
    const res = await send(app, 'GET', bob, `/api/channels/${open}/messages`);
    const bodies = (res.json().messages as Array<{ id: number; author?: { id: string } }>).filter(
      (m) => m.id === aliceMessage.id,
    );
    expect(bodies[0]!.author!.id).toBe(alice.id);
    // メンバー一覧・参加者一覧からは、いなくなる
    const members = (await send(app, 'GET', bob, `/api/workspaces/${ws}/members`)).json() as Array<{
      id: string;
    }>;
    expect(members.map((m) => m.id)).not.toContain(alice.id);
    const participants = (
      await send(app, 'GET', bob, `/api/channels/${open}/members`)
    ).json() as Array<{
      id: string;
    }>;
    expect(participants.map((m) => m.id)).not.toContain(alice.id);
  });

  /**
   * キックの途中(Membership を kicked にして、まだコミットしていない状態)で、別のリクエストを実行し、
   * そのあとで、キックをコミットする。順序を固定して、同時のキックとの競合を、確実に再現する。
   * 実装が、所属の行を共有ロックしていなければ、リクエストは、ロックを待たずに、ChannelMember を作ってしまう。
   */
  async function duringKick<T>(ws: string, victimId: string, action: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const inFlight = new Promise<void>((resolve) => (locked = resolve));
    const kickTx = testDb.db.transaction(async (tx) => {
      await tx
        .update(memberships)
        .set({ status: 'kicked' })
        .where(and(eq(memberships.workspaceId, ws), eq(memberships.userId, victimId)));
      locked();
      await gate;
      // キックのトランザクションの、残りの処理(このワークスペースの ChannelMember の削除)
      await tx.execute(
        sql`DELETE FROM channel_members WHERE user_id = ${victimId} AND channel_id IN (SELECT id FROM channels WHERE workspace_id = ${ws})`,
      );
    });
    await inFlight;
    const pending = action();
    // リクエストが、所属の行のロックの待ちに、入るまで待つ
    await new Promise((resolve) => setTimeout(resolve, 400));
    release();
    await kickTx;
    return pending;
  }

  async function raceSetup() {
    const app = makeApp();
    const owner = await createUser(app);
    const victim = await createUser(app);
    const friend = await createUser(app);
    const ws = await newWorkspace(app, owner);
    await addMember(ws, victim);
    await addMember(ws, friend);
    const open = await channel(app, owner, ws, 'open');
    const secret = await channel(app, owner, ws, 'secret', 'private');
    return { app, owner, victim, friend, ws, open, secret };
  }

  it('キックの途中の参加(パブリック)は、キックのあとに判定されて、403 になり、ChannelMember が残らない', async () => {
    const { app, victim, ws, open } = await raceSetup();
    const res = await duringKick(ws, victim.id, () =>
      send(app, 'POST', victim, `/api/channels/${open}/join`),
    );
    expect(res.statusCode).toBe(403);
    expect(await memberRows(victim.id, ws)).toEqual([]);
  });

  it('キックの途中の招待(プライベート)は、400 になり、ChannelMember が残らない', async () => {
    const { app, owner, victim, ws, secret } = await raceSetup();
    const res = await duringKick(ws, victim.id, () =>
      send(app, 'POST', owner, `/api/channels/${secret}/members`, { userId: victim.id }),
    );
    expect(res.statusCode).toBe(400);
    expect(await memberRows(victim.id, ws)).toEqual([]);
  });

  it('キックの途中の DM の作成は、400 になり、DM も ChannelMember も残らない', async () => {
    const { app, friend, victim, ws } = await raceSetup();
    const res = await duringKick(ws, victim.id, () =>
      send(app, 'POST', friend, `/api/workspaces/${ws}/dms`, { userId: victim.id }),
    );
    expect(res.statusCode).toBe(400);
    expect(await memberRows(victim.id, ws)).toEqual([]);
    expect(
      await testDb.db
        .select()
        .from(channels)
        .where(and(eq(channels.workspaceId, ws), eq(channels.type, 'dm'))),
    ).toEqual([]);
  });

  it('本物のキックと、同時の参加・招待・DM の作成を、並べても、kicked の人に、ChannelMember が残らない', async () => {
    for (let i = 0; i < 4; i += 1) {
      const { app, owner, victim, friend, ws, open, secret } = await raceSetup();
      await Promise.all([
        kick(app, owner, ws, victim.id),
        send(app, 'POST', victim, `/api/channels/${open}/join`),
        send(app, 'POST', owner, `/api/channels/${secret}/members`, { userId: victim.id }),
        send(app, 'POST', friend, `/api/workspaces/${ws}/dms`, { userId: victim.id }),
      ]);
      const [row] = await testDb.db
        .select()
        .from(memberships)
        .where(and(eq(memberships.workspaceId, ws), eq(memberships.userId, victim.id)));
      expect(row!.status).toBe('kicked');
      expect(await memberRows(victim.id, ws), `試行 ${i}`).toEqual([]);
    }
  });
});

describe('GET /kicked と DELETE /kicked/:userId(FR-304)', () => {
  it('キック済みの一覧は、オーナーだけが見られる(メンバーは 403)。解除は、オーナーだけ', async () => {
    const { app, owner, alice, bob, ws } = await setup();
    await kick(app, owner, ws, alice.id);
    const list = await send(app, 'GET', owner, `/api/workspaces/${ws}/kicked`);
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([
      { id: alice.id, username: alice.username, displayName: alice.username, avatarUrl: null },
    ]);
    expect((await send(app, 'GET', bob, `/api/workspaces/${ws}/kicked`)).statusCode).toBe(403);
    expect((await send(app, 'GET', undefined, `/api/workspaces/${ws}/kicked`)).statusCode).toBe(
      401,
    );
    expect((await unkick(app, bob, ws, alice.id)).statusCode).toBe(403);
    // 解除されていない
    expect((await send(app, 'GET', owner, `/api/workspaces/${ws}/kicked`)).json()).toHaveLength(1);
  });

  it('active なメンバー・存在しないユーザー・形式違いの解除は 404(active な所属は、消えない)', async () => {
    const { app, owner, bob, ws } = await setup();
    expect((await unkick(app, owner, ws, bob.id)).statusCode).toBe(404);
    expect((await unkick(app, owner, ws, owner.id)).statusCode).toBe(404);
    expect((await unkick(app, owner, ws, '00000000-0000-4000-8000-000000000000')).statusCode).toBe(
      404,
    );
    expect((await unkick(app, owner, ws, 'not-a-uuid')).statusCode).toBe(404);
    const rows = await testDb.db.select().from(memberships).where(eq(memberships.workspaceId, ws));
    expect(rows.map((r) => r.status).every((s) => s === 'active')).toBe(true);
    expect(rows.some((r) => r.userId === bob.id)).toBe(true);
    expect(rows.some((r) => r.userId === owner.id)).toBe(true);
  });

  it('キックされた人は、有効な招待リンクでも再参加できない(無効なリンクと同じ応答)。解除すると、新しいリンクで再参加でき、プライベートには、自動では戻らない', async () => {
    const { app, owner, alice, ws, open, secret, dm } = await setup();
    const issue = async () =>
      (await send(app, 'POST', owner, `/api/workspaces/${ws}/invitations`, { maxUses: 10 })).json()
        .token as string;
    const link = await issue();
    await kick(app, owner, ws, alice.id);

    const kickedAccept = await send(app, 'POST', alice, `/api/invitations/${link}/accept`);
    const invalid = await send(app, 'POST', alice, `/api/invitations/${'x'.repeat(43)}/accept`);
    expect(kickedAccept.statusCode).toBe(404);
    expect(kickedAccept.json()).toEqual(invalid.json());
    expect((await send(app, 'GET', alice, `/api/workspaces/${ws}`)).statusCode).toBe(403);

    // 解除: Membership の行が消える。解除しただけでは、参加しない
    expect((await unkick(app, owner, ws, alice.id)).statusCode).toBe(204);
    expect((await send(app, 'GET', owner, `/api/workspaces/${ws}/kicked`)).json()).toEqual([]);
    expect((await send(app, 'GET', alice, `/api/workspaces/${ws}`)).statusCode).toBe(404);
    expect(
      await testDb.db
        .select()
        .from(memberships)
        .where(and(eq(memberships.workspaceId, ws), eq(memberships.userId, alice.id))),
    ).toEqual([]);

    // 新しい招待リンクで、再参加できる(general だけ。以前のチャンネルには、戻らない)
    const fresh = await issue();
    const accepted = await send(app, 'POST', alice, `/api/invitations/${fresh}/accept`);
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect((await send(app, 'GET', alice, `/api/workspaces/${ws}`)).statusCode).toBe(200);
    const rejoined = (await memberRows(alice.id, ws)).map((r) => r.channelId);
    expect(rejoined).toHaveLength(1);
    for (const old of [open, secret, dm]) expect(rejoined).not.toContain(old);
    expect((await send(app, 'GET', alice, `/api/channels/${secret}/messages`)).statusCode).toBe(
      404,
    );
    // パブリックには、自分で参加できる。プライベートは、再招待が必要
    expect((await send(app, 'POST', alice, `/api/channels/${open}/join`)).statusCode).toBe(200);
    expect(
      (await send(app, 'POST', owner, `/api/channels/${secret}/members`, { userId: alice.id }))
        .statusCode,
    ).toBe(204);
  });

  it('キックされた人は、招待の対象にも、DM の相手にもできない(400)', async () => {
    const { app, owner, alice, bob, ws, secret } = await setup();
    await kick(app, owner, ws, alice.id);
    expect(
      (await send(app, 'POST', owner, `/api/channels/${secret}/members`, { userId: alice.id }))
        .statusCode,
    ).toBe(400);
    expect(
      (await send(app, 'POST', bob, `/api/workspaces/${ws}/dms`, { userId: alice.id })).statusCode,
    ).toBe(400);
  });
});

describe('WebSocket(FR-302。設計書 §6.3)', () => {
  async function setupWs() {
    const config = loadConfig({ ALLOWED_ORIGIN: ORIGIN });
    const app = buildApp({ config, db: testDb.db, storage, logger: false });
    apps.push(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const owner = await createUser(app);
    const alice = await createUser(app);
    const bob = await createUser(app);
    const other = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const ws2 = await newWorkspace(app, other, 'B');
    for (const u of [alice, bob]) await addMember(ws, u);
    await addMember(ws2, alice);
    const open = await channel(app, owner, ws, 'live');
    await join(app, alice, open);
    await join(app, bob, open);
    const other2 = await channel(app, other, ws2, 'b-live');
    await join(app, alice, other2);
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
      return new Promise<{ of: (n: string) => unknown[]; socket: ClientSocket }>(
        (resolve, reject) => {
          socket.once('connect', () =>
            resolve({ socket, of: (n) => all.filter((e) => e.name === n).map((e) => e.payload) }),
          );
          socket.once('connect_error', reject);
        },
      );
    };
    return { app, owner, alice, bob, other, ws, ws2, open, other2, connect };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

  it('キックされた人の全ソケット(別のタブも)に workspace:removed が届き、そのワークスペースのイベントは、届かなくなる。他のワークスペースは、届き続ける', async () => {
    const { app, owner, alice, bob, other, ws, ws2, open, other2, connect } = await setupWs();
    const aliceRec = await connect(alice);
    const aliceTab = await connect(alice);
    const bobRec = await connect(bob);
    await post(app, owner, open, '前');
    await vi.waitFor(() => expect(aliceRec.of('message:created')).toHaveLength(1));

    expect((await kick(app, owner, ws, alice.id)).statusCode).toBe(204);
    for (const rec of [aliceRec, aliceTab]) {
      await vi.waitFor(() => expect(rec.of('workspace:removed')).toEqual([{ workspaceId: ws }]));
    }
    // 残りのメンバーには、member:removed と、channel:member-left が届く
    await vi.waitFor(() =>
      expect(bobRec.of('member:removed')).toEqual([{ workspaceId: ws, userId: alice.id }]),
    );
    await vi.waitFor(() =>
      expect(bobRec.of('channel:member-left')).toContainEqual({
        channelId: open,
        userId: alice.id,
      }),
    );
    // 本人には、member:removed(ws ルーム)も、channel:member-left も届かない(先にルームから外している)
    expect(aliceRec.of('member:removed')).toEqual([]);

    // その後の、そのワークスペースのイベントは、届かない
    await post(app, owner, open, '後');
    await vi.waitFor(() => expect(bobRec.of('message:created')).toHaveLength(2));
    await settle();
    expect(aliceRec.of('message:created')).toHaveLength(1);
    expect(aliceTab.of('message:created')).toHaveLength(1);

    // 他のワークスペースの接続は、維持され、イベントは、届き続ける
    expect(aliceRec.socket.connected).toBe(true);
    await post(app, other, other2, '別のワークスペース');
    await vi.waitFor(() => expect(aliceRec.of('message:created')).toHaveLength(2));
    await vi.waitFor(() => expect(aliceTab.of('message:created')).toHaveLength(2));
    void ws2;
  });

  it('キックの後に、つなぎ直しても、そのワークスペースのルームには入らない(他のワークスペースには入る)', async () => {
    const { app, owner, alice, other, ws, open, other2, connect } = await setupWs();
    await kick(app, owner, ws, alice.id);
    const fresh = await connect(alice);
    await post(app, owner, open, 'キック後の投稿');
    await post(app, other, other2, '別のワークスペース');
    await vi.waitFor(() => expect(fresh.of('message:created')).toHaveLength(1));
    await settle();
    expect(fresh.of('message:created')).toEqual([
      expect.objectContaining({ body: '別のワークスペース' }),
    ]);
  });

  it('解除しただけでは、ルームに入らない。再参加(新しい招待)で、general のイベントが届く', async () => {
    const { app, owner, alice, ws, connect } = await setupWs();
    const link = (
      await send(app, 'POST', owner, `/api/workspaces/${ws}/invitations`, { maxUses: 10 })
    ).json().token as string;
    await kick(app, owner, ws, alice.id);
    const aliceRec = await connect(alice);
    await unkick(app, owner, ws, alice.id);
    expect((await send(app, 'POST', alice, `/api/invitations/${link}/accept`)).statusCode).toBe(
      200,
    );
    const general = (
      await testDb.db
        .select()
        .from(channels)
        .where(and(eq(channels.workspaceId, ws), eq(channels.isDefault, true)))
    )[0]!;
    await post(app, owner, general.id, '戻った');
    await vi.waitFor(() =>
      expect(aliceRec.of('message:created')).toContainEqual(
        expect.objectContaining({ body: '戻った' }),
      ),
    );
  });
});
