import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { hashToken } from '../auth/tokens';
import { loadConfig } from '../config';
import { channelMembers, channels, invitations, memberships } from '../db/schema';
import { SESSION_COOKIE_NAME } from '../session-cookie';
import { LocalDiskStorage } from '../storage/storage';
import { createTestDatabase } from '../test/db';
import { makeTempDir } from '../test/files';

const ORIGIN = 'http://localhost:5173';
const PASSWORD = 'correct-horse-battery';
const INVALID = { code: 'invalid_invitation', message: 'この招待リンクは、無効です。' };
const DAY_MS = 24 * 60 * 60 * 1000;

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
  /** このユーザーのリクエストの接続元(レート制限を、ユーザーごとに分けるため) */
  ip: string;
}

async function createUser(app: FastifyInstance): Promise<TestUser> {
  counter += 1;
  const username = `inv_user_${counter}`;
  const ip = `10.130.${Math.floor(counter / 250)}.${counter % 250}`;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { origin: ORIGIN },
    payload: { username, password: PASSWORD },
    remoteAddress: ip,
  });
  expect(res.statusCode).toBe(201);
  const token = res.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;
  return { username, token, id: res.json().user.id as string, ip };
}

function send(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'DELETE',
  user: TestUser | undefined,
  url: string,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    headers: { origin: ORIGIN },
    cookies: user ? { [SESSION_COOKIE_NAME]: user.token } : {},
    remoteAddress: user?.ip ?? '10.130.255.255',
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

async function newWorkspace(app: FastifyInstance, owner: TestUser, name = 'チーム') {
  const res = await send(app, 'POST', owner, '/api/workspaces', { name });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function issue(
  app: FastifyInstance,
  owner: TestUser,
  ws: string,
  body?: unknown,
): Promise<{ id: string; token: string }> {
  const res = await send(app, 'POST', owner, `/api/workspaces/${ws}/invitations`, body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

const preview = (app: FastifyInstance, user: TestUser | undefined, token: string) =>
  send(app, 'GET', user, `/api/invitations/${token}`);
const accept = (app: FastifyInstance, user: TestUser | undefined, token: string) =>
  send(app, 'POST', user, `/api/invitations/${token}/accept`);

async function membershipOf(ws: string, user: TestUser) {
  const [row] = await testDb.db
    .select()
    .from(memberships)
    .where(and(eq(memberships.workspaceId, ws), eq(memberships.userId, user.id)));
  return row;
}

async function inviteRow(id: string) {
  const [row] = await testDb.db.select().from(invitations).where(eq(invitations.id, id));
  return row!;
}

async function inGeneral(ws: string, user: TestUser) {
  const [general] = await testDb.db
    .select()
    .from(channels)
    .where(and(eq(channels.workspaceId, ws), eq(channels.isDefault, true)));
  const rows = await testDb.db
    .select()
    .from(channelMembers)
    .where(and(eq(channelMembers.channelId, general!.id), eq(channelMembers.userId, user.id)));
  return rows.length > 0;
}

async function setInvitation(id: string, values: Partial<typeof invitations.$inferInsert>) {
  await testDb.db.update(invitations).set(values).where(eq(invitations.id, id));
}

describe('POST /api/workspaces/:ws/invitations(発行。FR-301)', () => {
  it('既定は、7 日・10 回。トークンは、この応答でだけ返し、DB にはハッシュだけを保存する', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const before = Date.now();
    const res = await send(app, 'POST', owner, `/api/workspaces/${ws}/invitations`);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      createdBy: owner.id,
      maxUses: 10,
      usedCount: 0,
      revokedAt: null,
      status: 'active',
    });
    expect(typeof body.token).toBe('string');
    expect(body.token.length).toBeGreaterThanOrEqual(43); // 256 ビット
    const expires = new Date(body.expiresAt).getTime();
    expect(expires - before).toBeGreaterThan(7 * DAY_MS - 5000);
    expect(expires - before).toBeLessThan(7 * DAY_MS + 5000);

    const row = await inviteRow(body.id);
    expect(row.tokenHash).toBe(hashToken(body.token));
    expect(row.tokenHash).not.toContain(body.token);
  });

  it('有効期限(1・7・30 日)と使用回数(1・10・無制限)を選べる', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const ws = await newWorkspace(app, owner);
    for (const [days, maxUses, expectedMax] of [
      [1, 1, 1],
      [30, 'unlimited', null],
      [7, 10, 10],
    ] as const) {
      const before = Date.now();
      const res = await send(app, 'POST', owner, `/api/workspaces/${ws}/invitations`, {
        expiresInDays: days,
        maxUses,
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().maxUses).toBe(expectedMax);
      const diff = new Date(res.json().expiresAt).getTime() - before;
      expect(Math.abs(diff - days * DAY_MS)).toBeLessThan(5000);
    }
  });

  it('選択肢にない値・余分な項目は 400', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const ws = await newWorkspace(app, owner);
    for (const body of [
      { expiresInDays: 2 },
      { expiresInDays: '7' },
      { maxUses: 5 },
      { maxUses: 0 },
      { maxUses: null },
      { createdBy: owner.id },
    ]) {
      const res = await send(app, 'POST', owner, `/api/workspaces/${ws}/invitations`, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it('オーナーだけ。メンバーは 403、kicked は 403、所属なしは 404、未ログインは 401', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const member = await createUser(app);
    const kicked = await createUser(app);
    const outsider = await createUser(app);
    const ws = await newWorkspace(app, owner);
    await testDb.db.insert(memberships).values([
      { workspaceId: ws, userId: member.id, role: 'member' },
      { workspaceId: ws, userId: kicked.id, role: 'member', status: 'kicked' },
    ]);
    const url = `/api/workspaces/${ws}/invitations`;
    expect((await send(app, 'POST', member, url)).statusCode).toBe(403);
    expect((await send(app, 'POST', kicked, url)).statusCode).toBe(403);
    expect((await send(app, 'POST', outsider, url)).statusCode).toBe(404);
    expect((await send(app, 'POST', undefined, url)).statusCode).toBe(401);
  });

  it('Origin がないと 403', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const res = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws}/invitations`,
      cookies: { [SESSION_COOKIE_NAME]: owner.token },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /api/workspaces/:ws/invitations(一覧)・DELETE(取り消し)', () => {
  it('一覧は、新しい順。トークンもハッシュも含めず、状態(有効・期限切れ・取り消し・回数超過)を示す', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const other = await newWorkspace(app, owner, '別');
    const active = await issue(app, owner, ws);
    const expired = await issue(app, owner, ws);
    const revoked = await issue(app, owner, ws);
    const exhausted = await issue(app, owner, ws, { maxUses: 1 });
    await issue(app, owner, other); // 別のワークスペースのリンクは、含めない
    await setInvitation(expired.id, { expiresAt: new Date(Date.now() - 1000) });
    await setInvitation(revoked.id, { revokedAt: new Date() });
    await setInvitation(exhausted.id, { usedCount: 1 });

    const res = await send(app, 'GET', owner, `/api/workspaces/${ws}/invitations`);
    expect(res.statusCode).toBe(200);
    const list = res.json() as { id: string; status: string }[];
    expect(list.map((i) => [i.id, i.status])).toEqual([
      [exhausted.id, 'exhausted'],
      [revoked.id, 'revoked'],
      [expired.id, 'expired'],
      [active.id, 'active'],
    ]);
    expect(res.body).not.toMatch(/token|hash/i);
  });

  it('一覧・取り消しは、オーナーだけ(メンバーは 403)', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const member = await createUser(app);
    const ws = await newWorkspace(app, owner);
    await testDb.db
      .insert(memberships)
      .values({ workspaceId: ws, userId: member.id, role: 'member' });
    const inv = await issue(app, owner, ws);
    expect((await send(app, 'GET', member, `/api/workspaces/${ws}/invitations`)).statusCode).toBe(
      403,
    );
    expect(
      (await send(app, 'DELETE', member, `/api/workspaces/${ws}/invitations/${inv.id}`)).statusCode,
    ).toBe(403);
    expect((await inviteRow(inv.id)).revokedAt).toBeNull();
  });

  it('取り消すと(204)、受諾できない。何度取り消しても成功し、最初の時刻を保つ', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const guest = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const inv = await issue(app, owner, ws);
    const url = `/api/workspaces/${ws}/invitations/${inv.id}`;

    expect((await send(app, 'DELETE', owner, url)).statusCode).toBe(204);
    const first = (await inviteRow(inv.id)).revokedAt;
    expect(first).not.toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect((await send(app, 'DELETE', owner, url)).statusCode).toBe(204);
    expect((await inviteRow(inv.id)).revokedAt).toEqual(first);

    const res = await accept(app, guest, inv.token);
    expect(res.statusCode).toBe(404);
    expect(await membershipOf(ws, guest)).toBeUndefined();
  });

  it('別のワークスペースのリンク・存在しない ID・形式違いは、取り消せず 404', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const other = await newWorkspace(app, owner, '別');
    const inOther = await issue(app, owner, other);
    for (const id of [inOther.id, '00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
      const res = await send(app, 'DELETE', owner, `/api/workspaces/${ws}/invitations/${id}`);
      expect(res.statusCode, id).toBe(404);
    }
    expect((await inviteRow(inOther.id)).revokedAt).toBeNull();
  });
});

describe('GET /api/invitations/:token(受諾前の確認)', () => {
  it('有効なら、ワークスペース名だけを返す', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const guest = await createUser(app);
    const ws = await newWorkspace(app, owner, 'みんなの部屋');
    const inv = await issue(app, owner, ws);
    const res = await preview(app, guest, inv.token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ workspaceName: 'みんなの部屋' });
    // 確認だけでは、参加しない・回数を使わない
    expect(await membershipOf(ws, guest)).toBeUndefined();
    expect((await inviteRow(inv.id)).usedCount).toBe(0);
  });

  it('存在しない・形式違い・期限切れ・取り消し・回数超過・kicked は、すべて同じ 404 と同じ文言', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const guest = await createUser(app);
    const kicked = await createUser(app);
    const ws = await newWorkspace(app, owner);
    await testDb.db
      .insert(memberships)
      .values({ workspaceId: ws, userId: kicked.id, role: 'member', status: 'kicked' });
    const expired = await issue(app, owner, ws);
    const revoked = await issue(app, owner, ws);
    const exhausted = await issue(app, owner, ws, { maxUses: 1 });
    const valid = await issue(app, owner, ws);
    await setInvitation(expired.id, { expiresAt: new Date(Date.now() - 1000) });
    await setInvitation(revoked.id, { revokedAt: new Date() });
    await setInvitation(exhausted.id, { usedCount: 1 });

    const responses = [
      await preview(app, guest, 'A'.repeat(43)),
      await preview(app, guest, 'short'),
      await preview(app, guest, expired.token),
      await preview(app, guest, revoked.token),
      await preview(app, guest, exhausted.token),
      await preview(app, kicked, valid.token), // 有効なリンクでも、kicked には無効
    ];
    for (const res of responses) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(INVALID);
    }
  });

  it('回数を使い切ったリンクも、すでに参加している人には有効', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const inv = await issue(app, owner, ws, { maxUses: 1 });
    await setInvitation(inv.id, { usedCount: 1 });
    expect((await preview(app, owner, inv.token)).statusCode).toBe(200);
  });

  it('ログインしていないと 401', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const inv = await issue(app, owner, ws);
    expect((await preview(app, undefined, inv.token)).statusCode).toBe(401);
    expect((await accept(app, undefined, inv.token)).statusCode).toBe(401);
  });
});

describe('POST /api/invitations/:token/accept(受諾。設計書 §3.1)', () => {
  it('参加できる: メンバーになり、general に参加し、使用回数が 1 増える', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const guest = await createUser(app);
    const ws = await newWorkspace(app, owner, 'ようこそ');
    const inv = await issue(app, owner, ws);

    const res = await accept(app, guest, inv.token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: ws, name: 'ようこそ', role: 'member' });
    expect(await membershipOf(ws, guest)).toMatchObject({ role: 'member', status: 'active' });
    expect(await inGeneral(ws, guest)).toBe(true);
    expect((await inviteRow(inv.id)).usedCount).toBe(1);

    // 一覧・メンバー一覧に現れ、ワークスペースを使える
    const list = await send(app, 'GET', guest, '/api/workspaces');
    expect((list.json() as { id: string }[]).map((w) => w.id)).toEqual([ws]);
    expect((await send(app, 'GET', guest, `/api/workspaces/${ws}`)).statusCode).toBe(200);
  });

  it('参加済みの再受諾は成功し、使用回数を増やさない(オーナー自身でも)', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const guest = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const inv = await issue(app, owner, ws);
    await accept(app, guest, inv.token);

    const again = await accept(app, guest, inv.token);
    expect(again.statusCode).toBe(200);
    expect(again.json().role).toBe('member');
    const byOwner = await accept(app, owner, inv.token);
    expect(byOwner.statusCode).toBe(200);
    expect(byOwner.json().role).toBe('owner'); // 役割は、変わらない
    expect(await membershipOf(ws, owner)).toMatchObject({ role: 'owner' });
    expect((await inviteRow(inv.id)).usedCount).toBe(1);
  });

  it('kicked は、再参加できない。無効なリンクと同じ 404 で、行も回数も変わらない', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const guest = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const inv = await issue(app, owner, ws);
    await accept(app, guest, inv.token);
    await testDb.db
      .update(memberships)
      .set({ status: 'kicked' })
      .where(and(eq(memberships.workspaceId, ws), eq(memberships.userId, guest.id)));
    await testDb.db.delete(channelMembers).where(eq(channelMembers.userId, guest.id));

    const fresh = await issue(app, owner, ws); // 新しいリンクでも、同じ
    for (const token of [inv.token, fresh.token]) {
      const res = await accept(app, guest, token);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(INVALID);
    }
    expect((await membershipOf(ws, guest))?.status).toBe('kicked');
    expect(await inGeneral(ws, guest)).toBe(false);
    expect((await inviteRow(inv.id)).usedCount).toBe(1);
    expect((await inviteRow(fresh.id)).usedCount).toBe(0);
    expect((await send(app, 'GET', guest, `/api/workspaces/${ws}`)).statusCode).toBe(403);
  });

  it('存在しない・形式違い・期限切れ・取り消し・回数超過は、同じ 404。参加しない', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const guest = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const expired = await issue(app, owner, ws);
    const revoked = await issue(app, owner, ws);
    const exhausted = await issue(app, owner, ws, { maxUses: 1 });
    await setInvitation(expired.id, { expiresAt: new Date(Date.now() - 1000) });
    await setInvitation(revoked.id, { revokedAt: new Date() });
    await setInvitation(exhausted.id, { usedCount: 1 });

    for (const token of [
      'B'.repeat(43),
      'x',
      'a%2Fb',
      expired.token,
      revoked.token,
      exhausted.token,
    ]) {
      const res = await accept(app, guest, token);
      expect(res.statusCode, token).toBe(404);
      expect(res.json()).toEqual(INVALID);
    }
    // 回数超過では、メンバーの行の挿入も、ロールバックされている
    expect(await membershipOf(ws, guest)).toBeUndefined();
    expect(await inGeneral(ws, guest)).toBe(false);
    expect((await inviteRow(exhausted.id)).usedCount).toBe(1);
  });

  it('最後の 1 回を使うと、次の人は参加できない(1 回限りのリンク)', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const a = await createUser(app);
    const b = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const inv = await issue(app, owner, ws, { maxUses: 1 });
    expect((await accept(app, a, inv.token)).statusCode).toBe(200);
    expect((await accept(app, b, inv.token)).statusCode).toBe(404);
    expect(await membershipOf(ws, b)).toBeUndefined();
  });

  it('無制限のリンクは、何人でも参加できる', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const inv = await issue(app, owner, ws, { maxUses: 'unlimited' });
    for (let i = 0; i < 12; i++) {
      const guest = await createUser(app);
      expect((await accept(app, guest, inv.token)).statusCode).toBe(200);
    }
    expect((await inviteRow(inv.id)).usedCount).toBe(12);
  });

  it('同時に受諾されても、上限を超えない(上限 3 に 12 人)', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const inv = await issue(app, owner, ws, { maxUses: 1 });
    await setInvitation(inv.id, { maxUses: 3 });
    const guests = await Promise.all(Array.from({ length: 12 }, () => createUser(app)));

    const results = await Promise.all(guests.map((g) => accept(app, g, inv.token)));
    const ok = guests.filter((_, i) => results[i]!.statusCode === 200);
    const ng = guests.filter((_, i) => results[i]!.statusCode === 404);
    expect(ok).toHaveLength(3);
    expect(ng).toHaveLength(9);
    expect((await inviteRow(inv.id)).usedCount).toBe(3);

    // 成功した人だけが、メンバーと general の参加者になっている(失敗した人の行は、残らない)
    const members = await testDb.db
      .select()
      .from(memberships)
      .where(eq(memberships.workspaceId, ws));
    expect(members.map((m) => m.userId).sort()).toEqual([owner.id, ...ok.map((g) => g.id)].sort());
    for (const g of ng) expect(await inGeneral(ws, g)).toBe(false);
    for (const g of ok) expect(await inGeneral(ws, g)).toBe(true);
  });

  it('同じ人が同時に何度受諾しても、回数は 1 回だけ消費する', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const guest = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const inv = await issue(app, owner, ws);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => accept(app, guest, inv.token)),
    );
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200, 200]);
    expect((await inviteRow(inv.id)).usedCount).toBe(1);
    const rows = await testDb.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.workspaceId, ws), eq(memberships.userId, guest.id)));
    expect(rows).toHaveLength(1);
  });

  it('有効期限は、受諾の時点の DB の時刻で判定する(期限ちょうどを過ぎれば拒否)', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const guest = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const inv = await issue(app, owner, ws);
    await setInvitation(inv.id, { expiresAt: new Date(Date.now() + 60_000) });
    expect((await preview(app, guest, inv.token)).statusCode).toBe(200);
    await setInvitation(inv.id, { expiresAt: new Date(Date.now() - 1) });
    expect((await accept(app, guest, inv.token)).statusCode).toBe(404);
  });
});

describe('レート制限(無効なトークンの試行だけを数える。設計書 §4.1)', () => {
  it('ユーザー単位: 無効な試行が 10 回に達すると、次は 429(Retry-After つき)。有効なリンクでも', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const guest = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const valid = await issue(app, owner, ws);

    for (let i = 0; i < 10; i++) {
      expect((await preview(app, guest, 'C'.repeat(43))).statusCode).toBe(404);
    }
    const limited = await preview(app, guest, 'C'.repeat(43));
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    // 確認と受諾は、同じ上限を共有する
    expect((await accept(app, guest, valid.token)).statusCode).toBe(429);
    expect(await membershipOf(ws, guest)).toBeUndefined();
    // 他のユーザー(別の接続元)には、影響しない
    const other = await createUser(app);
    expect((await accept(app, other, valid.token)).statusCode).toBe(200);
  });

  it('有効なリンクの利用は、数えない(何度確認しても 429 にならない)', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const guest = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const inv = await issue(app, owner, ws, { maxUses: 'unlimited' });
    for (let i = 0; i < 15; i++) {
      expect((await preview(app, guest, inv.token)).statusCode).toBe(200);
    }
    for (let i = 0; i < 15; i++) {
      expect((await accept(app, guest, inv.token)).statusCode).toBe(200);
    }
  });

  it('kicked・期限切れ・取り消し・回数超過の失敗も、数える(区別しない)', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const guest = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const revoked = await issue(app, owner, ws);
    await setInvitation(revoked.id, { revokedAt: new Date() });
    for (let i = 0; i < 10; i++) {
      expect((await accept(app, guest, revoked.token)).statusCode).toBe(404);
    }
    expect((await accept(app, guest, revoked.token)).statusCode).toBe(429);
  });

  it('接続元の全体: 別々のユーザーでも、同じ接続元からの無効な試行が 30 回に達すると、429', async () => {
    const app = makeApp();
    const users = await Promise.all(Array.from({ length: 4 }, () => createUser(app)));
    const sameIp = (user: TestUser) =>
      app.inject({
        method: 'GET',
        url: `/api/invitations/${'D'.repeat(43)}`,
        cookies: { [SESSION_COOKIE_NAME]: user.token },
        remoteAddress: '10.131.0.1',
      });
    // ユーザーごとに 8 回(ユーザー単位の上限 10 回には達しない)で、合計 32 回
    for (let round = 0; round < 8; round++) {
      for (const user of users) {
        const res = await sameIp(user);
        const total = round * users.length + users.indexOf(user);
        expect(res.statusCode, `${total}`).toBe(total < 30 ? 404 : 429);
      }
    }
  });
});

describe('invitations テーブルの制約', () => {
  it('トークンのハッシュは一意。使用回数の上限は 1 以上、使用回数は 0 以上', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const ws = await newWorkspace(app, owner);
    const base = {
      workspaceId: ws,
      createdBy: owner.id,
      expiresAt: new Date(Date.now() + DAY_MS),
    };
    await testDb.db.insert(invitations).values({ ...base, tokenHash: 'h1' });
    const state = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        const err = e as { code?: string; cause?: { code?: string } };
        return err.cause?.code ?? err.code;
      }
      return undefined;
    };
    expect(await state(testDb.db.insert(invitations).values({ ...base, tokenHash: 'h1' }))).toBe(
      '23505',
    );
    expect(
      await state(testDb.db.insert(invitations).values({ ...base, tokenHash: 'h2', maxUses: 0 })),
    ).toBe('23514');
    expect(
      await state(
        testDb.db.insert(invitations).values({ ...base, tokenHash: 'h3', usedCount: -1 }),
      ),
    ).toBe('23514');
  });
});
