import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { requireOwner } from '../auth/workspace-guards';
import { loadConfig } from '../config';
import { channelMembers, channels, memberships, workspaces } from '../db/schema';
import { SESSION_COOKIE_NAME } from '../session-cookie';
import { LocalDiskStorage } from '../storage/storage';
import { createTestDatabase } from '../test/db';
import { fileOfSize, makeTempDir, multipart, PNG_HEADER } from '../test/files';

const ORIGIN = 'http://localhost:5173';
const PASSWORD = 'correct-horse-battery';
const NOT_FOUND = { code: 'not_found', message: '見つかりません。' };

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
  const username = `ws_user_${counter}`;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { origin: ORIGIN },
    payload: { username, password: PASSWORD },
    remoteAddress: `10.110.${Math.floor(counter / 250)}.${counter % 250}`,
  });
  expect(res.statusCode).toBe(201);
  const token = res.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;
  return { username, token, id: res.json().user.id as string };
}

const auth = (user: TestUser | undefined): { cookies: Record<string, string> } => ({
  cookies: user ? { [SESSION_COOKIE_NAME]: user.token } : {},
});

function createWorkspace(app: FastifyInstance, user: TestUser | undefined, body: unknown) {
  return app.inject({
    method: 'POST',
    url: '/api/workspaces',
    headers: { origin: ORIGIN },
    ...auth(user),
    payload: body as object,
  });
}

function get(
  app: FastifyInstance,
  user: TestUser | undefined,
  url: string,
): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'GET', url, ...auth(user) });
}

/** ワークスペースを作り、ID を返す */
async function newWorkspace(app: FastifyInstance, owner: TestUser, name = 'チーム') {
  const res = await createWorkspace(app, owner, { name });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

/** 招待(T12)ができるまで、テストでは、DB に直接、所属を作る */
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

describe('POST /api/workspaces(FR-201)', () => {
  it('作成すると 201。作成者がオーナーになる', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const res = await createWorkspace(app, owner, { name: 'チーム' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ id: expect.any(String), name: 'チーム', role: 'owner' });

    const [ws] = await testDb.db.select().from(workspaces).where(eq(workspaces.id, res.json().id));
    expect(ws!.ownerId).toBe(owner.id);
    const [m] = await testDb.db
      .select()
      .from(memberships)
      .where(eq(memberships.workspaceId, ws!.id));
    expect(m).toMatchObject({ userId: owner.id, role: 'owner', status: 'active' });
  });

  it('既定チャンネル general(パブリック・退出不可の印つき)が作られ、作成者が参加している', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const id = await newWorkspace(app, owner);
    const rows = await testDb.db.select().from(channels).where(eq(channels.workspaceId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: 'general',
      type: 'public',
      isDefault: true,
      createdBy: owner.id,
    });
    const members = await testDb.db
      .select()
      .from(channelMembers)
      .where(eq(channelMembers.channelId, rows[0]!.id));
    expect(members.map((m) => m.userId)).toEqual([owner.id]);
  });

  it('名前の前後の空白は取り除く。同じ名前のワークスペースは、いくつでも作れる', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const a = await createWorkspace(app, owner, { name: '  同じ名前  ' });
    const b = await createWorkspace(app, owner, { name: '同じ名前' });
    expect(a.json().name).toBe('同じ名前');
    expect(b.statusCode).toBe(201);
    expect(b.json().id).not.toBe(a.json().id);
  });

  it('名前は、コードポイント数で、1〜50 文字(絵文字も 1 文字)', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    expect((await createWorkspace(app, owner, { name: '😀'.repeat(50) })).statusCode).toBe(201);
    for (const name of ['', '   ', '😀'.repeat(51), 'a'.repeat(51)]) {
      const res = await createWorkspace(app, owner, { name });
      expect(res.statusCode, JSON.stringify(name)).toBe(400);
    }
  });

  it('制御文字・余分な項目・名前なし・文字列でない名前は 400', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    for (const body of [
      { name: 'a\nb' },
      { name: 'a\tb' },
      { name: 'x', ownerId: owner.id },
      {},
      { name: 123 },
      { name: null },
    ]) {
      const res = await createWorkspace(app, owner, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it('ログインしていないと 401。Origin がないと 403', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    expect((await createWorkspace(app, undefined, { name: 'x' })).statusCode).toBe(401);
    const noOrigin = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      ...auth(owner),
      payload: { name: 'x' },
    });
    expect(noOrigin.statusCode).toBe(403);
  });

  it('途中で失敗したら、ワークスペースも、メンバーも、チャンネルも、残らない(原子性)', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    // general への参加の登録で、必ず失敗する仕掛けを、一時的に入れる
    await testDb.db.execute(sql`
      CREATE FUNCTION fail_channel_members() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'テスト用の失敗'; END; $$ LANGUAGE plpgsql`);
    await testDb.db.execute(sql`
      CREATE TRIGGER fail_channel_members BEFORE INSERT ON channel_members
      FOR EACH ROW EXECUTE FUNCTION fail_channel_members()`);
    try {
      const res = await createWorkspace(app, owner, { name: '失敗するはず' });
      expect(res.statusCode).toBe(500);
    } finally {
      await testDb.db.execute(sql`DROP TRIGGER fail_channel_members ON channel_members`);
      await testDb.db.execute(sql`DROP FUNCTION fail_channel_members()`);
    }
    expect(
      await testDb.db.select().from(workspaces).where(eq(workspaces.name, '失敗するはず')),
    ).toEqual([]);
    expect(
      await testDb.db.select().from(memberships).where(eq(memberships.userId, owner.id)),
    ).toEqual([]);
    expect(await testDb.db.select().from(channels).where(eq(channels.createdBy, owner.id))).toEqual(
      [],
    );
  });
});

describe('GET /api/workspaces(FR-206)', () => {
  it('自分が active に所属しているものだけを、古い順に返す', async () => {
    const app = makeApp();
    const me = await createUser(app);
    const other = await createUser(app);
    const first = await newWorkspace(app, me, '最初');
    const second = await newWorkspace(app, other, '他人の');
    await addMember(second, me); // 他人のワークスペースに、メンバーとして所属
    const third = await newWorkspace(app, me, '三つ目');
    await newWorkspace(app, other, '無関係'); // 所属していない

    const res = await get(app, me, '/api/workspaces');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { id: first, name: '最初', role: 'owner' },
      { id: second, name: '他人の', role: 'member' },
      { id: third, name: '三つ目', role: 'owner' },
    ]);
  });

  it('kicked のワークスペースは、一覧に出ない', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const member = await createUser(app);
    const id = await newWorkspace(app, owner);
    await addMember(id, member);
    expect((await get(app, member, '/api/workspaces')).json()).toHaveLength(1);
    await kick(id, member);
    expect((await get(app, member, '/api/workspaces')).json()).toEqual([]);
  });

  it('所属がなければ空の配列。ログインしていないと 401', async () => {
    const app = makeApp();
    const me = await createUser(app);
    expect((await get(app, me, '/api/workspaces')).json()).toEqual([]);
    expect((await get(app, undefined, '/api/workspaces')).statusCode).toBe(401);
  });
});

describe('ガード requireMember(GET /api/workspaces/:ws)', () => {
  it('メンバーは取得できる(役割つき)', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const member = await createUser(app);
    const id = await newWorkspace(app, owner, 'ガード');
    await addMember(id, member);
    expect((await get(app, owner, `/api/workspaces/${id}`)).json()).toEqual({
      id,
      name: 'ガード',
      role: 'owner',
    });
    expect((await get(app, member, `/api/workspaces/${id}`)).json()).toEqual({
      id,
      name: 'ガード',
      role: 'member',
    });
  });

  it('所属していない・存在しない・形式の違う ID は、いずれも同じ 404(存在を隠す)', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const outsider = await createUser(app);
    const id = await newWorkspace(app, owner);
    const responses = [
      await get(app, outsider, `/api/workspaces/${id}`),
      await get(app, outsider, '/api/workspaces/00000000-0000-4000-8000-000000000000'),
      await get(app, outsider, '/api/workspaces/not-a-uuid'),
    ];
    for (const res of responses) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(NOT_FOUND);
    }
  });

  it('kicked は 403(行がない 404 と区別される。FR-302)', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const member = await createUser(app);
    const id = await newWorkspace(app, owner);
    await addMember(id, member);
    await kick(id, member);
    expect((await get(app, member, `/api/workspaces/${id}`)).statusCode).toBe(403);
    expect((await get(app, member, `/api/workspaces/${id}/members`)).statusCode).toBe(403);
  });

  it('ログインしていないと 401(所属の判定より先)', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const id = await newWorkspace(app, owner);
    expect((await get(app, undefined, `/api/workspaces/${id}`)).statusCode).toBe(401);
    expect((await get(app, undefined, '/api/workspaces/not-a-uuid')).statusCode).toBe(401);
  });

  it('所属の状態は、リクエストのたびに DB で確認する(キックの直後から、遮断される)', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const member = await createUser(app);
    const id = await newWorkspace(app, owner);
    await addMember(id, member);
    expect((await get(app, member, `/api/workspaces/${id}`)).statusCode).toBe(200);
    await kick(id, member);
    expect((await get(app, member, `/api/workspaces/${id}`)).statusCode).toBe(403);
  });

  it('キックは、そのワークスペースだけに効く(他のワークスペースは使える)', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const member = await createUser(app);
    const a = await newWorkspace(app, owner, 'A');
    const b = await newWorkspace(app, owner, 'B');
    await addMember(a, member);
    await addMember(b, member);
    await kick(a, member);
    expect((await get(app, member, `/api/workspaces/${a}`)).statusCode).toBe(403);
    expect((await get(app, member, `/api/workspaces/${b}`)).statusCode).toBe(200);
  });
});

describe('ガード requireOwner', () => {
  function appWithOwnerRoute() {
    const app = makeApp();
    app.get('/api/test/:ws/owner-only', { preHandler: requireOwner(testDb.db) }, async () => ({
      ok: true,
    }));
    return app;
  }

  it('オーナーは通る。メンバーは 403、kicked は 403、所属なしは 404、未ログインは 401', async () => {
    const app = appWithOwnerRoute();
    const owner = await createUser(app);
    const member = await createUser(app);
    const kicked = await createUser(app);
    const outsider = await createUser(app);
    const id = await newWorkspace(app, owner);
    await addMember(id, member);
    await addMember(id, kicked, 'kicked');

    const url = `/api/test/${id}/owner-only`;
    expect((await get(app, owner, url)).statusCode).toBe(200);
    expect((await get(app, member, url)).statusCode).toBe(403);
    expect((await get(app, kicked, url)).statusCode).toBe(403);
    expect((await get(app, outsider, url)).statusCode).toBe(404);
    expect((await get(app, undefined, url)).statusCode).toBe(401);
  });
});

describe('GET /api/workspaces/:ws/members', () => {
  it('active なメンバーだけを、参加順に返す(kicked・他のワークスペースの人は含めない)', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const member = await createUser(app);
    const kicked = await createUser(app);
    const outsider = await createUser(app);
    const id = await newWorkspace(app, owner);
    await addMember(id, member);
    await addMember(id, kicked, 'kicked');
    await newWorkspace(app, outsider);

    const res = await get(app, member, `/api/workspaces/${id}/members`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      {
        id: owner.id,
        username: owner.username,
        displayName: owner.username,
        statusText: '',
        avatarUrl: null,
        role: 'owner',
      },
      {
        id: member.id,
        username: member.username,
        displayName: member.username,
        statusText: '',
        avatarUrl: null,
        role: 'member',
      },
    ]);
  });

  it('秘密の情報(ハッシュなど)を含めない', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const id = await newWorkspace(app, owner);
    const body = (await get(app, owner, `/api/workspaces/${id}/members`)).body;
    expect(body).not.toMatch(/hash|password|recovery/i);
  });

  it('アバターを設定していれば、版つきの avatarUrl が入る', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const id = await newWorkspace(app, owner);
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
      ...auth(owner),
      payload,
    });
    expect(put.statusCode).toBe(200);
    const [m] = (await get(app, owner, `/api/workspaces/${id}/members`)).json();
    expect(m.avatarUrl).toMatch(new RegExp(`^/api/users/${owner.id}/avatar\\?v=[0-9a-f-]{36}$`));
  });
});

describe('GET /api/users/:userId/avatar(他のユーザーは、共通の所属が条件。設計書 §5.1)', () => {
  async function setAvatar(app: FastifyInstance, user: TestUser) {
    const { payload, contentType } = multipart([
      {
        name: 'file',
        filename: 'a.png',
        contentType: 'image/png',
        data: fileOfSize(PNG_HEADER, 50),
      },
    ]);
    const res = await app.inject({
      method: 'PUT',
      url: '/api/me/avatar',
      headers: { 'content-type': contentType, origin: ORIGIN },
      ...auth(user),
      payload,
    });
    expect(res.statusCode).toBe(200);
  }

  it('同じワークスペースに共に active で所属していれば、取得できる', async () => {
    const app = makeApp();
    const a = await createUser(app);
    const b = await createUser(app);
    await setAvatar(app, a);
    const id = await newWorkspace(app, a);
    await addMember(id, b);
    expect((await get(app, b, `/api/users/${a.id}/avatar`)).statusCode).toBe(200);
  });

  it('共通のワークスペースがなければ 404(別々のワークスペースに所属していても)', async () => {
    const app = makeApp();
    const a = await createUser(app);
    const b = await createUser(app);
    await setAvatar(app, a);
    await newWorkspace(app, a, 'Aだけ');
    await newWorkspace(app, b, 'Bだけ');
    const res = await get(app, b, `/api/users/${a.id}/avatar`);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual(NOT_FOUND);
  });

  it('どちらかが kicked なら 404(共通のワークスペースが、他にあれば取得できる)', async () => {
    const app = makeApp();
    const a = await createUser(app);
    const b = await createUser(app);
    await setAvatar(app, a);
    const first = await newWorkspace(app, a, '1');
    await addMember(first, b);
    expect((await get(app, b, `/api/users/${a.id}/avatar`)).statusCode).toBe(200);

    await kick(first, b); // 見る側が kicked
    expect((await get(app, b, `/api/users/${a.id}/avatar`)).statusCode).toBe(404);

    // 見られる側が kicked
    const second = await newWorkspace(app, b, '2');
    await addMember(second, a);
    expect((await get(app, a, `/api/users/${b.id}/avatar`)).statusCode).toBe(404); // b は未設定
    expect((await get(app, b, `/api/users/${a.id}/avatar`)).statusCode).toBe(200);
    await kick(second, a);
    expect((await get(app, b, `/api/users/${a.id}/avatar`)).statusCode).toBe(404);
  });

  it('共通のワークスペースがあっても、アバター未設定・存在しない ID は、同じ 404', async () => {
    const app = makeApp();
    const a = await createUser(app);
    const b = await createUser(app);
    const id = await newWorkspace(app, a);
    await addMember(id, b);
    for (const target of [a.id, '00000000-0000-4000-8000-000000000000']) {
      const res = await get(app, b, `/api/users/${target}/avatar`);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(NOT_FOUND);
    }
  });

  it('他のユーザーの取得でも、版つきなら長くキャッシュ、版なしは no-cache', async () => {
    const app = makeApp();
    const a = await createUser(app);
    const b = await createUser(app);
    await setAvatar(app, a);
    const id = await newWorkspace(app, a);
    await addMember(id, b);
    const [m] = (await get(app, b, `/api/workspaces/${id}/members`)).json();
    const url = (await get(app, b, `/api/workspaces/${id}/members`))
      .json()
      .find((x: { id: string }) => x.id === a.id).avatarUrl as string;
    expect(m).toBeDefined();
    expect((await get(app, b, url)).headers['cache-control']).toBe(
      'private, max-age=31536000, immutable',
    );
    expect((await get(app, b, `/api/users/${a.id}/avatar`)).headers['cache-control']).toBe(
      'private, no-cache',
    );
  });
});
