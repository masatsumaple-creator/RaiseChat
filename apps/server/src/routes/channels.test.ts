import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { channelMembers, channels, memberships } from '../db/schema';
import { SESSION_COOKIE_NAME } from '../session-cookie';
import { LocalDiskStorage } from '../storage/storage';
import { createTestDatabase } from '../test/db';
import { makeTempDir } from '../test/files';

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
  const username = `ch_user_${counter}`;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { origin: ORIGIN },
    payload: { username, password: PASSWORD },
    remoteAddress: `10.120.${Math.floor(counter / 250)}.${counter % 250}`,
  });
  expect(res.statusCode).toBe(201);
  const token = res.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;
  return { username, token, id: res.json().user.id as string };
}

const auth = (user: TestUser | undefined): { cookies: Record<string, string> } => ({
  cookies: user ? { [SESSION_COOKIE_NAME]: user.token } : {},
});

function get(
  app: FastifyInstance,
  user: TestUser | undefined,
  url: string,
): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'GET', url, ...auth(user) });
}

function post(
  app: FastifyInstance,
  user: TestUser | undefined,
  url: string,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url,
    headers: { origin: ORIGIN },
    ...auth(user),
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

async function newWorkspace(app: FastifyInstance, owner: TestUser, name = 'チーム') {
  const res = await post(app, owner, '/api/workspaces', { name });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

/** 招待(T12)ができるまでは、テストでは、DB に直接、所属を作る */
async function addMember(
  workspaceId: string,
  user: TestUser,
  status: 'active' | 'kicked' = 'active',
) {
  await testDb.db
    .insert(memberships)
    .values({ workspaceId, userId: user.id, role: 'member', status });
}

async function kick(workspaceId: string, user: TestUser) {
  await testDb.db
    .update(memberships)
    .set({ status: 'kicked' })
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, user.id)));
}

async function createChannel(
  app: FastifyInstance,
  user: TestUser,
  workspaceId: string,
  name: string,
  type: 'public' | 'private' = 'public',
) {
  const res = await post(app, user, `/api/workspaces/${workspaceId}/channels`, { name, type });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
}

async function isParticipant(channelId: string, user: TestUser) {
  const rows = await testDb.db
    .select()
    .from(channelMembers)
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, user.id)));
  return rows.length > 0;
}

/** ワークスペースの general の ID */
async function generalOf(workspaceId: string) {
  const [row] = await testDb.db
    .select()
    .from(channels)
    .where(and(eq(channels.workspaceId, workspaceId), eq(channels.isDefault, true)));
  return row!.id;
}

/** DM のチャンネルを、DB に直接作る(DM の API は、フェーズ 3) */
async function createDm(workspaceId: string, a: TestUser, b: TestUser) {
  const [dm] = await testDb.db
    .insert(channels)
    .values({
      workspaceId,
      type: 'dm',
      name: null,
      dmKey: [a.id, b.id].sort().join(':'),
    })
    .returning();
  await testDb.db.insert(channelMembers).values([
    { channelId: dm!.id, userId: a.id },
    { channelId: dm!.id, userId: b.id },
  ]);
  return dm!.id;
}

describe('POST /api/workspaces/:ws/channels(FR-202)', () => {
  it('作成すると 201。作成者は参加者になる', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const res = await post(app, owner, `/api/workspaces/${ws}/channels`, {
      name: '  雑談  ',
      type: 'private',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      id: expect.any(String),
      workspaceId: ws,
      type: 'private',
      name: '雑談',
      isDefault: false,
      createdBy: owner.id,
      peer: null,
    });
    expect(await isParticipant(res.json().id, owner)).toBe(true);
  });

  it('メンバーも作成できる(パブリック・プライベートとも)', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const member = await createUser(app);
    const ws = await newWorkspace(app, owner);
    await addMember(ws, member);
    await createChannel(app, member, ws, 'pub', 'public');
    await createChannel(app, member, ws, 'priv', 'private');
  });

  it('名前は、同一ワークスペース内で一意(大文字小文字を区別しない。general とも)。別のワークスペースなら同じ名前でよい', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const other = await newWorkspace(app, owner, '別');
    await createChannel(app, owner, ws, 'Dev');
    for (const [name, type] of [
      ['dev', 'public'],
      ['DEV', 'private'],
      ['General', 'public'],
    ] as const) {
      const res = await post(app, owner, `/api/workspaces/${ws}/channels`, { name, type });
      expect(res.statusCode, name).toBe(409);
      expect(res.json().code).toBe('channel_name_taken');
    }
    await createChannel(app, owner, other, 'Dev');
  });

  it('同じ名前を同時に作ると、1 件だけ成功し、残りは 409', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const results = await Promise.all(
      ['race', 'Race', 'RACE', 'rAcE', 'raCe'].map((name) =>
        post(app, owner, `/api/workspaces/${ws}/channels`, { name, type: 'public' }),
      ),
    );
    const statuses = results.map((r) => r.statusCode).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409]);
    // 失敗した分は、参加者の行だけが残る、ということがない(general + 1 件)
    const rows = await testDb.db.select().from(channels).where(eq(channels.workspaceId, ws));
    expect(rows).toHaveLength(2);
  });

  it('名前は、コードポイント数で 1〜80 文字。制御文字・余分な項目・不正な種類は 400', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const url = `/api/workspaces/${ws}/channels`;
    expect(
      (await post(app, owner, url, { name: '😀'.repeat(80), type: 'public' })).statusCode,
    ).toBe(201);
    for (const body of [
      { name: '', type: 'public' },
      { name: '   ', type: 'public' },
      { name: '😀'.repeat(81), type: 'public' },
      { name: 'a\nb', type: 'public' },
      { name: 'x', type: 'dm' },
      { name: 'x', type: 'secret' },
      { name: 'x' },
      { type: 'public' },
      { name: 'x', type: 'public', isDefault: true },
      { name: 123, type: 'public' },
    ]) {
      const res = await post(app, owner, url, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it('所属していないと 404、kicked は 403、ログインしていないと 401', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const member = await createUser(app);
    const outsider = await createUser(app);
    const ws = await newWorkspace(app, owner);
    await addMember(ws, member);
    await kick(ws, member);
    const body = { name: 'x', type: 'public' };
    const url = `/api/workspaces/${ws}/channels`;
    expect((await post(app, outsider, url, body)).statusCode).toBe(404);
    expect((await post(app, member, url, body)).statusCode).toBe(403);
    expect((await post(app, undefined, url, body)).statusCode).toBe(401);
  });
});

describe('GET /api/workspaces/:ws/channels(FR-203)', () => {
  it('参加しているチャンネルだけを返す(general が先、あとは名前順)', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const member = await createUser(app);
    const ws = await newWorkspace(app, owner);
    await addMember(ws, member);
    await createChannel(app, member, ws, 'beta');
    await createChannel(app, member, ws, 'Alpha', 'private');
    await createChannel(app, owner, ws, 'ownerOnly'); // member は未参加

    const res = await get(app, member, `/api/workspaces/${ws}/channels`);
    expect(res.statusCode).toBe(200);
    // member は、general には、まだ参加していない(招待の受諾(T12)で参加する)
    expect((res.json() as { name: string }[]).map((c) => c.name)).toEqual(['Alpha', 'beta']);

    const ownerList = await get(app, owner, `/api/workspaces/${ws}/channels`);
    expect((ownerList.json() as { name: string }[]).map((c) => c.name)).toEqual([
      'general',
      'ownerOnly',
    ]);
  });

  it('joinable=1 は、未参加のパブリックチャンネルだけ(プライベート・参加済み・他のワークスペースは含めない)', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const member = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const other = await newWorkspace(app, owner, '別');
    await addMember(ws, member);
    await createChannel(app, owner, ws, 'open');
    await createChannel(app, owner, ws, 'secret', 'private');
    await createChannel(app, member, ws, 'mine');
    await createChannel(app, owner, other, 'elsewhere');

    const res = await get(app, member, `/api/workspaces/${ws}/channels?joinable=1`);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { name: string }[]).map((c) => c.name)).toEqual(['general', 'open']);
  });

  it('所属していないと 404、kicked は 403、ログインしていないと 401', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const kicked = await createUser(app);
    const outsider = await createUser(app);
    const ws = await newWorkspace(app, owner);
    await addMember(ws, kicked);
    await kick(ws, kicked);
    const url = `/api/workspaces/${ws}/channels`;
    expect((await get(app, outsider, url)).statusCode).toBe(404);
    expect((await get(app, kicked, url)).statusCode).toBe(403);
    expect((await get(app, undefined, url)).statusCode).toBe(401);
  });

  it('不正なクエリは 400', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const ws = await newWorkspace(app, owner);
    expect((await get(app, owner, `/api/workspaces/${ws}/channels?joinable=x`)).statusCode).toBe(
      400,
    );
  });
});

describe('GET /api/workspaces/:ws/channels/admin(FR-204, 303)', () => {
  it('オーナーは、プライベートを含む全チャンネルを、名前だけ(内容なし)で見られる', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const member = await createUser(app);
    const ws = await newWorkspace(app, owner);
    await addMember(ws, member);
    const secret = await createChannel(app, member, ws, 'secret', 'private');
    await createDm(ws, owner, member);

    const res = await get(app, owner, `/api/workspaces/${ws}/channels/admin`);
    expect(res.statusCode).toBe(200);
    const list = res.json() as { id: string; type: string; name: string; isDefault: boolean }[];
    expect(list.map((c) => c.name)).toEqual(['general', 'secret']); // DM は含めない
    expect(list[1]).toEqual({ id: secret, type: 'private', name: 'secret', isDefault: false });
  });

  it('メンバーは 403、所属なしは 404、ログインしていないと 401', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const member = await createUser(app);
    const outsider = await createUser(app);
    const ws = await newWorkspace(app, owner);
    await addMember(ws, member);
    const url = `/api/workspaces/${ws}/channels/admin`;
    expect((await get(app, member, url)).statusCode).toBe(403);
    expect((await get(app, outsider, url)).statusCode).toBe(404);
    expect((await get(app, undefined, url)).statusCode).toBe(401);
  });
});

describe('POST /api/channels/:ch/join(FR-203。§4.4)', () => {
  it('パブリックチャンネルに参加できる。参加済みなら、何度でも成功', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const member = await createUser(app);
    const ws = await newWorkspace(app, owner);
    await addMember(ws, member);
    const ch = await createChannel(app, owner, ws, 'open');
    const res = await post(app, member, `/api/channels/${ch}/join`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: ch, name: 'open', type: 'public' });
    expect(await isParticipant(ch, member)).toBe(true);
    expect((await post(app, member, `/api/channels/${ch}/join`)).statusCode).toBe(200);
    // 同時に参加しても、行は 1 つ
    const rows = await testDb.db
      .select()
      .from(channelMembers)
      .where(and(eq(channelMembers.channelId, ch), eq(channelMembers.userId, member.id)));
    expect(rows).toHaveLength(1);
  });

  it('同時に参加しても、すべて成功し、行は 1 つ', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const member = await createUser(app);
    const ws = await newWorkspace(app, owner);
    await addMember(ws, member);
    const ch = await createChannel(app, owner, ws, 'open2');
    const results = await Promise.all(
      Array.from({ length: 5 }, () => post(app, member, `/api/channels/${ch}/join`)),
    );
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200]);
  });

  it('プライベート・DM・存在しない・形式違い・所属していないワークスペースのチャンネルは、いずれも同じ 404', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const member = await createUser(app);
    const outsider = await createUser(app);
    const ws = await newWorkspace(app, owner);
    await addMember(ws, member);
    const secret = await createChannel(app, owner, ws, 'secret', 'private');
    const open = await createChannel(app, owner, ws, 'open');
    const dm = await createDm(ws, owner, outsider);

    const responses = [
      await post(app, member, `/api/channels/${secret}/join`),
      await post(app, member, `/api/channels/${dm}/join`),
      await post(app, member, `/api/channels/${NIL_UUID}/join`),
      await post(app, member, '/api/channels/not-a-uuid/join'),
      await post(app, outsider, `/api/channels/${open}/join`), // ワークスペースに所属していない
    ];
    for (const res of responses) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(NOT_FOUND);
    }
    expect(await isParticipant(secret, member)).toBe(false);
  });

  it('プライベートの参加者でも、join は 404(プライベートは、join の対象ではない)', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const secret = await createChannel(app, owner, ws, 'secret', 'private');
    expect((await post(app, owner, `/api/channels/${secret}/join`)).statusCode).toBe(404);
  });

  it('kicked は、パブリックなら 403、プライベートなら 404(存在の判定が先)', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const member = await createUser(app);
    const ws = await newWorkspace(app, owner);
    await addMember(ws, member);
    const open = await createChannel(app, owner, ws, 'open');
    const secret = await createChannel(app, owner, ws, 'secret', 'private');
    await kick(ws, member);
    expect((await post(app, member, `/api/channels/${open}/join`)).statusCode).toBe(403);
    expect((await post(app, member, `/api/channels/${secret}/join`)).statusCode).toBe(404);
    expect(await isParticipant(open, member)).toBe(false);
  });

  it('ログインしていないと 401', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const open = await createChannel(app, owner, ws, 'open');
    expect((await post(app, undefined, `/api/channels/${open}/join`)).statusCode).toBe(401);
  });
});

describe('POST /api/channels/:ch/leave(FR-203, 204。§4.4)', () => {
  it('退出できる(204)。退出後は参加者でなく、パブリックなら、また参加できる', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const member = await createUser(app);
    const ws = await newWorkspace(app, owner);
    await addMember(ws, member);
    const open = await createChannel(app, owner, ws, 'open');
    await post(app, member, `/api/channels/${open}/join`);

    expect((await post(app, member, `/api/channels/${open}/leave`)).statusCode).toBe(204);
    expect(await isParticipant(open, member)).toBe(false);
    expect((await post(app, member, `/api/channels/${open}/leave`)).statusCode).toBe(404);
    expect((await post(app, member, `/api/channels/${open}/join`)).statusCode).toBe(200);
  });

  it('プライベートからも退出できる。退出後は、そのチャンネルが 404 になる', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const secret = await createChannel(app, owner, ws, 'secret', 'private');
    expect((await post(app, owner, `/api/channels/${secret}/leave`)).statusCode).toBe(204);
    expect((await get(app, owner, `/api/channels/${secret}/members`)).statusCode).toBe(404);
  });

  it('既定チャンネル(general)と DM は 400(参加者には、存在を隠す必要がない)', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const member = await createUser(app);
    const ws = await newWorkspace(app, owner);
    await addMember(ws, member);
    const general = await generalOf(ws);
    const dm = await createDm(ws, owner, member);
    for (const ch of [general, dm]) {
      const res = await post(app, owner, `/api/channels/${ch}/leave`);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('cannot_leave');
    }
    expect(await isParticipant(general, owner)).toBe(true);
    expect(await isParticipant(dm, owner)).toBe(true);
  });

  it('参加者でない(存在しない・別のワークスペース・kicked を含む)は、いずれも同じ 404。general でも 404 が先', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const member = await createUser(app);
    const outsider = await createUser(app);
    const ws = await newWorkspace(app, owner);
    await addMember(ws, member);
    const general = await generalOf(ws);
    const open = await createChannel(app, owner, ws, 'open');
    const responses = [
      await post(app, member, `/api/channels/${open}/leave`), // 未参加
      await post(app, member, `/api/channels/${general}/leave`), // 未参加の general(400 ではなく 404)
      await post(app, outsider, `/api/channels/${open}/leave`), // 別のワークスペース
      await post(app, member, `/api/channels/${NIL_UUID}/leave`),
      await post(app, member, '/api/channels/not-a-uuid/leave'),
    ];
    for (const res of responses) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(NOT_FOUND);
    }
  });

  it('ログインしていないと 401', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const open = await createChannel(app, owner, ws, 'open');
    expect((await post(app, undefined, `/api/channels/${open}/leave`)).statusCode).toBe(401);
  });
});

describe('GET /api/channels/:ch/members', () => {
  it('参加者の一覧を、参加順に返す。秘密の情報は含めない', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const member = await createUser(app);
    const ws = await newWorkspace(app, owner);
    await addMember(ws, member);
    const open = await createChannel(app, owner, ws, 'open');
    await post(app, member, `/api/channels/${open}/join`);

    const res = await get(app, member, `/api/channels/${open}/members`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      {
        id: owner.id,
        username: owner.username,
        displayName: owner.username,
        statusText: '',
        avatarUrl: null,
      },
      {
        id: member.id,
        username: member.username,
        displayName: member.username,
        statusText: '',
        avatarUrl: null,
      },
    ]);
    expect(res.body).not.toMatch(/hash|password|recovery/i);
  });

  it('q で、ユーザー名・表示名の前方一致(大文字小文字を区別しない)。% や _ は文字そのもの', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const open = await createChannel(app, owner, ws, 'open');
    const prefix = owner.username.slice(0, 8).toUpperCase();
    const url = (q: string) => `/api/channels/${open}/members?q=${encodeURIComponent(q)}`;

    expect((await get(app, owner, url(prefix))).json()).toHaveLength(1);
    expect((await get(app, owner, url('zzz'))).json()).toEqual([]);
    expect((await get(app, owner, url(owner.username.slice(1)))).json()).toEqual([]); // 前方一致のみ
    // ワイルドカードとして働かない
    expect((await get(app, owner, url('%'))).json()).toEqual([]);
    expect((await get(app, owner, url('_'))).json()).toEqual([]);
    expect((await get(app, owner, url('ch_user_%'))).json()).toEqual([]);
  });

  it('表示名でも絞り込める', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const open = await createChannel(app, owner, ws, 'open');
    await app.inject({
      method: 'PATCH',
      url: '/api/me',
      headers: { origin: ORIGIN },
      ...auth(owner),
      payload: { displayName: 'たなか' },
    });
    const res = await get(
      app,
      owner,
      `/api/channels/${open}/members?q=${encodeURIComponent('たな')}`,
    );
    expect(res.json()).toHaveLength(1);
  });

  it('参加者でなければ、パブリックでも、プライベートでも、存在しなくても、同じ 404', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const member = await createUser(app);
    const outsider = await createUser(app);
    const ws = await newWorkspace(app, owner);
    await addMember(ws, member);
    const open = await createChannel(app, owner, ws, 'open');
    const secret = await createChannel(app, owner, ws, 'secret', 'private');
    const responses = [
      await get(app, member, `/api/channels/${open}/members`), // 未参加のパブリック
      await get(app, member, `/api/channels/${secret}/members`),
      await get(app, outsider, `/api/channels/${open}/members`),
      await get(app, member, `/api/channels/${NIL_UUID}/members`),
      await get(app, member, '/api/channels/not-a-uuid/members'),
    ];
    for (const res of responses) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(NOT_FOUND);
    }
    expect((await get(app, undefined, `/api/channels/${open}/members`)).statusCode).toBe(401);
  });

  it('オーナーも、参加者でなければ、プライベートの参加者を見られない(内容を見せない方針)', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const member = await createUser(app);
    const ws = await newWorkspace(app, owner);
    await addMember(ws, member);
    const secret = await createChannel(app, member, ws, 'secret', 'private');
    expect((await get(app, owner, `/api/channels/${secret}/members`)).statusCode).toBe(404);
  });

  it('kicked の人の参加者の行が残っていても、一覧には出さない', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const member = await createUser(app);
    const ws = await newWorkspace(app, owner);
    await addMember(ws, member);
    const open = await createChannel(app, owner, ws, 'open');
    await post(app, member, `/api/channels/${open}/join`);
    await kick(ws, member); // キックの処理(フェーズ 5)が、行を削除し損ねた場合を想定
    const list = (await get(app, owner, `/api/channels/${open}/members`)).json() as {
      id: string;
    }[];
    expect(list.map((m) => m.id)).toEqual([owner.id]);
  });
});

describe('POST /api/channels/:ch/members(FR-204。§4.4 の判定順序)', () => {
  /** オーナー・メンバー(作成者)・別のメンバー・部外者がいる、プライベートチャンネル */
  async function setup() {
    const app = makeApp();
    const owner = await createUser(app);
    const creator = await createUser(app);
    const other = await createUser(app);
    const outsider = await createUser(app);
    const ws = await newWorkspace(app, owner);
    await addMember(ws, creator);
    await addMember(ws, other);
    const secret = await createChannel(app, creator, ws, 'secret', 'private');
    const invite = (user: TestUser | undefined, ch: string, userId: string) =>
      post(app, user, `/api/channels/${ch}/members`, { userId });
    return { app, owner, creator, other, outsider, ws, secret, invite };
  }

  it('(9) 作成者は、同じワークスペースのメンバーを招待できる(204)。招待された人は、チャンネルが見える', async () => {
    const { app, creator, other, secret, ws, invite } = await setup();
    expect((await invite(creator, secret, other.id)).statusCode).toBe(204);
    expect(await isParticipant(secret, other)).toBe(true);
    expect((await get(app, other, `/api/channels/${secret}/members`)).statusCode).toBe(200);
    const names = (
      (await get(app, other, `/api/workspaces/${ws}/channels`)).json() as { name: string }[]
    ).map((c) => c.name);
    expect(names).toContain('secret');
  });

  it('(9) すでに参加している人の招待は成功(冪等)。退出した人は、再度招待できる', async () => {
    const { app, creator, other, secret, invite } = await setup();
    expect((await invite(creator, secret, other.id)).statusCode).toBe(204);
    expect((await invite(creator, secret, other.id)).statusCode).toBe(204);
    expect((await invite(creator, secret, creator.id)).statusCode).toBe(204);
    await post(app, other, `/api/channels/${secret}/leave`);
    expect(await isParticipant(secret, other)).toBe(false);
    expect((await invite(creator, secret, other.id)).statusCode).toBe(204);
    expect(await isParticipant(secret, other)).toBe(true);
  });

  it('(9) オーナーは、参加者でなくても、プライベートに他のユーザーを招待できる', async () => {
    const { owner, other, secret, invite } = await setup();
    expect(await isParticipant(secret, owner)).toBe(false);
    expect((await invite(owner, secret, other.id)).statusCode).toBe(204);
    expect(await isParticipant(secret, other)).toBe(true);
  });

  it('(7) オーナーは、参加者でなければ、自分自身を追加できない(403)。内容も見られない', async () => {
    const { app, owner, secret, invite } = await setup();
    const res = await invite(owner, secret, owner.id);
    expect(res.statusCode).toBe(403);
    expect(await isParticipant(secret, owner)).toBe(false);
    expect((await get(app, owner, `/api/channels/${secret}/members`)).statusCode).toBe(404);
  });

  it('(1) 存在しない・形式違いのチャンネルは 404', async () => {
    const { app, creator, other, invite } = await setup();
    expect((await invite(creator, NIL_UUID, other.id)).statusCode).toBe(404);
    expect((await invite(creator, 'not-a-uuid', other.id)).statusCode).toBe(404);
    expect((await invite(undefined, NIL_UUID, other.id)).statusCode).toBe(401);
    void app;
  });

  it('(2) 参加者でも、オーナーでもない(同じワークスペースのメンバー・部外者)は 404(存在を隠す)', async () => {
    const { creator, other, outsider, secret, invite } = await setup();
    const a = await invite(other, secret, creator.id);
    const b = await invite(outsider, secret, creator.id);
    for (const res of [a, b]) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(NOT_FOUND);
    }
  });

  it('(2) kicked は、オーナーでも参加者でもなく、404', async () => {
    const { creator, other, ws, secret, invite } = await setup();
    await kick(ws, creator);
    // キックで、参加者の行が消える(フェーズ 5 の処理を、ここで再現)
    await testDb.db.delete(channelMembers).where(eq(channelMembers.userId, creator.id));
    expect((await invite(creator, secret, other.id)).statusCode).toBe(404);
  });

  it('(3) オーナーで、参加者でなく、DM → 404(DM の存在を隠す)。(4) DM の参加者が招待すると 400', async () => {
    const { owner, creator, other, ws, invite } = await setup();
    const dm = await createDm(ws, creator, other);
    expect((await invite(owner, dm, other.id)).statusCode).toBe(404);
    const res = await invite(creator, dm, owner.id);
    expect(res.statusCode).toBe(400);
  });

  it('(4) パブリックチャンネルへの招待は 400', async () => {
    const { app, owner, creator, other, ws, invite } = await setup();
    const open = await createChannel(app, creator, ws, 'open');
    expect((await invite(creator, open, other.id)).statusCode).toBe(400); // 参加者
    expect((await invite(owner, open, other.id)).statusCode).toBe(400); // 参加者でないオーナー
  });

  it('(5) 作成者でもオーナーでもない参加者は 403', async () => {
    const { app, creator, other, secret, invite } = await setup();
    await invite(creator, secret, other.id);
    const third = await createUser(app);
    const res = await invite(other, secret, third.id);
    expect(res.statusCode).toBe(403);
  });

  it('(6) 作成者は、退出すると、招待できなくなる(404)', async () => {
    const { app, creator, other, outsider, secret, invite } = await setup();
    await invite(creator, secret, other.id);
    await post(app, creator, `/api/channels/${secret}/leave`);
    expect((await invite(creator, secret, outsider.id)).statusCode).toBe(404);
    // 他の参加者は、作成者ではないので 403
    expect((await invite(other, secret, outsider.id)).statusCode).toBe(403);
  });

  it('(8) 対象が、同じワークスペースの active メンバーでなければ 400(部外者・kicked・他ワークスペース・存在しないユーザー)', async () => {
    const { app, owner, creator, other, outsider, ws, secret, invite } = await setup();
    await kick(ws, other);
    const elsewhere = await newWorkspace(app, outsider, '別');
    expect(elsewhere).toBeTruthy();
    for (const target of [outsider.id, other.id, NIL_UUID]) {
      const res = await invite(creator, secret, target);
      expect(res.statusCode, target).toBe(400);
      expect(
        await testDb.db.select().from(channelMembers).where(eq(channelMembers.userId, target)),
      ).not.toContainEqual(expect.objectContaining({ channelId: secret }));
    }
    // オーナーによる招待でも同じ
    expect((await invite(owner, secret, outsider.id)).statusCode).toBe(400);
  });

  it('本文が不正なら 400(userId なし・uuid でない・余分な項目)', async () => {
    const { app, creator, other, secret } = await setup();
    for (const body of [{}, { userId: 'x' }, { userId: other.id, role: 'owner' }, { userId: 1 }]) {
      const res = await post(app, creator, `/api/channels/${secret}/members`, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
  });
});
