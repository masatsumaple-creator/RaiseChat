import { eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { AddressInfo } from 'node:net';
import { io as connectIo, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { memberships, messages, reactions } from '../db/schema';
import { SESSION_COOKIE_NAME } from '../session-cookie';
import { LocalDiskStorage } from '../storage/storage';
import { createTestDatabase } from '../test/db';
import { makeTempDir } from '../test/files';

const ORIGIN = 'http://localhost:5173';
const PASSWORD = 'correct-horse-battery';
const NOT_FOUND = { code: 'not_found', message: '見つかりません。' };

/** 種類の上限(20)を確かめるための、別々の絵文字 30 個 */
const MANY = Array.from('😀😃😄😁😆😅😂🤣😊😇🙂🙃😉😌😍🥰😘😗😙😚😋😛😝😜🤪🤨🧐🤓😎🥳');

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
  const username = `rx_user_${counter}`;
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
const put = (
  app: FastifyInstance,
  user: TestUser | undefined,
  id: number | string,
  emoji: string,
) => send(app, 'PUT', user, `/api/messages/${id}/reactions/${encodeURIComponent(emoji)}`);
const del = (
  app: FastifyInstance,
  user: TestUser | undefined,
  id: number | string,
  emoji: string,
) => send(app, 'DELETE', user, `/api/messages/${id}/reactions/${encodeURIComponent(emoji)}`);
const list = (app: FastifyInstance, user: TestUser, ch: string) =>
  send(app, 'GET', user, `/api/channels/${ch}/messages`);

async function reactionRows(messageId: number) {
  return testDb.db.select().from(reactions).where(eq(reactions.messageId, messageId));
}

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

describe('PUT /api/messages/:id/reactions/:emoji(付与。FR-108)', () => {
  it('付与できる(200)。その絵文字の件数と、付けた人が返り、DB に保存される', async () => {
    const { app, owner, ch } = await setup();
    const { id } = await post(app, owner, ch, 'x');
    const res = await put(app, owner, id, '👍');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ emoji: '👍', count: 1, userIds: [owner.id] });
    expect(await reactionRows(id)).toHaveLength(1);
  });

  it('すでに付けていれば、何もせず成功する(冪等)。同時に何度付与しても、1 件', async () => {
    const { app, owner, ch } = await setup();
    const { id } = await post(app, owner, ch, 'x');
    await put(app, owner, id, '👍');
    expect((await put(app, owner, id, '👍')).json().count).toBe(1);
    const results = await Promise.all(Array.from({ length: 6 }, () => put(app, owner, id, '🎉')));
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(await reactionRows(id)).toHaveLength(2);
  });

  it('複数の人が同じ絵文字を付けると、件数が増え、付けた順に並ぶ。付与者は、重複しない', async () => {
    const { app, owner, member, ch } = await setup();
    const { id } = await post(app, owner, ch, 'x');
    await put(app, member, id, '👍');
    const res = await put(app, owner, id, '👍');
    expect(res.json()).toEqual({ emoji: '👍', count: 2, userIds: [member.id, owner.id] });
  });

  it('パスにパーセントエンコードした、肌色・ZWJ・国旗・キーキャップも付けられる', async () => {
    const { app, owner, ch } = await setup();
    const { id } = await post(app, owner, ch, 'x');
    for (const emoji of ['👍🏽', '👨‍👩‍👧‍👦', '🇯🇵', '1️⃣', '❤️']) {
      const res = await put(app, owner, id, emoji);
      expect(res.statusCode, emoji).toBe(200);
      expect(res.json().emoji).toBe(emoji);
    }
  });

  it('絵文字でないもの(文字・複数・記号・HTML・長すぎる)は 400(invalid_emoji)。何も保存されない', async () => {
    const { app, owner, ch } = await setup();
    const { id } = await post(app, owner, ch, 'x');
    for (const bad of [
      'a',
      'ok',
      '1',
      '😀😀',
      '😀a',
      '©',
      ' ',
      '<script>',
      '😀/😀',
      Array.from({ length: 20 }, () => '👩').join('‍'),
    ]) {
      const res = await put(app, owner, id, bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
      expect(res.json().code).toBe('invalid_emoji');
    }
    expect(await reactionRows(id)).toEqual([]);
  });

  it('1 つのメッセージに付けられる絵文字は、20 種類まで。21 種類目は 400。すでにある種類は、上限でも付けられる', async () => {
    const { app, owner, member, ch } = await setup();
    const { id } = await post(app, owner, ch, 'x');
    for (const emoji of MANY.slice(0, 20)) {
      expect((await put(app, owner, id, emoji)).statusCode).toBe(200);
    }
    const over = await put(app, owner, id, MANY[20]!);
    expect(over.statusCode).toBe(400);
    expect(over.json().code).toBe('too_many_reactions');
    // 既存の種類を、別の人が付けるのは、できる
    expect((await put(app, member, id, MANY[0]!)).json().count).toBe(2);
    // 1 種類を、全員が外すと、新しい種類を付けられる
    await del(app, owner, id, MANY[1]!);
    expect((await put(app, owner, id, MANY[20]!)).statusCode).toBe(200);
    // 別のメッセージには、影響しない
    const other = await post(app, owner, ch, 'y');
    expect((await put(app, owner, other.id, MANY[21]!)).statusCode).toBe(200);
  });

  it('同時に別々の絵文字を付けても、種類は 20 を超えない(30 個を同時に付与)', async () => {
    const { app, owner, member, ch } = await setup();
    const { id } = await post(app, owner, ch, 'x');
    const results = await Promise.all(
      MANY.map((emoji, i) => put(app, i % 2 ? member : owner, id, emoji)),
    );
    const ok = results.filter((r) => r.statusCode === 200);
    const ng = results.filter((r) => r.statusCode === 400);
    expect(ok).toHaveLength(20);
    expect(ng).toHaveLength(10);
    const kinds = new Set((await reactionRows(id)).map((r) => r.emoji));
    expect(kinds.size).toBe(20);
  });

  it('返信にも付けられ、返信の一覧に含まれる', async () => {
    const { app, owner, member, ch } = await setup();
    const parent = await post(app, owner, ch, '親');
    const reply = await send(app, 'POST', member, `/api/messages/${parent.id}/replies`, {
      body: '返信',
    });
    await put(app, owner, reply.json().id, '👍');
    const page = (await send(app, 'GET', owner, `/api/messages/${parent.id}/replies`)).json();
    expect(page.replies[0].reactions).toEqual([{ emoji: '👍', count: 1, userIds: [owner.id] }]);
  });

  it('削除済みのメッセージには付けられない(404。絵文字の検証より先)', async () => {
    const { app, owner, ch } = await setup();
    const { id } = await post(app, owner, ch, 'x');
    await send(app, 'DELETE', owner, `/api/messages/${id}`);
    const res = await put(app, owner, id, '👍');
    expect(res.statusCode).toBe(404);
    expect((await put(app, owner, id, 'bad')).statusCode).toBe(404);
    expect(await reactionRows(id)).toEqual([]);
  });

  it('参加者でなければ(未参加・プライベート・他のワークスペース・存在しない・形式違い)、同じ 404。ログインしていないと 401', async () => {
    const { app, owner, member, bystander, outsider, ws, ch } = await setup();
    const { id } = await post(app, owner, ch, 'x');
    const secret = await createChannel(app, owner, ws, 'secret', 'private');
    const secretMsg = await post(app, owner, secret, 'ひみつ');
    const results = await Promise.all([
      put(app, bystander, id, '👍'),
      put(app, outsider, id, '👍'),
      put(app, member, secretMsg.id, '👍'),
      put(app, owner, 999999999, '👍'),
      put(app, owner, 'abc', '👍'),
    ]);
    for (const res of results) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(NOT_FOUND);
    }
    expect((await put(app, undefined, id, '👍')).statusCode).toBe(401);
    expect(await reactionRows(id)).toEqual([]);
    const noOrigin = await app.inject({
      method: 'PUT',
      url: `/api/messages/${id}/reactions/${encodeURIComponent('👍')}`,
      cookies: { [SESSION_COOKIE_NAME]: owner.token },
    });
    expect(noOrigin.statusCode).toBe(403);
  });
});

describe('DELETE /api/messages/:id/reactions/:emoji(解除)', () => {
  it('自分のリアクションだけを外す。他の人のものは、残る', async () => {
    const { app, owner, member, ch } = await setup();
    const { id } = await post(app, owner, ch, 'x');
    await put(app, owner, id, '👍');
    await put(app, member, id, '👍');
    expect((await del(app, owner, id, '👍')).statusCode).toBe(204);
    const rows = await reactionRows(id);
    expect(rows.map((r) => r.userId)).toEqual([member.id]);
  });

  it('付けていなくても、成功する(冪等)。削除済みのメッセージでも成功する', async () => {
    const { app, owner, member, ch } = await setup();
    const { id } = await post(app, owner, ch, 'x');
    expect((await del(app, member, id, '👍')).statusCode).toBe(204);
    expect((await del(app, member, id, '👍')).statusCode).toBe(204);
    await put(app, owner, id, '👍');
    await send(app, 'DELETE', owner, `/api/messages/${id}`);
    expect((await del(app, owner, id, '👍')).statusCode).toBe(204);
    expect((await del(app, member, id, '🎉')).statusCode).toBe(204);
  });

  it('絵文字でなければ 400。参加者でなければ 404。ログインしていないと 401', async () => {
    const { app, owner, bystander, outsider, ch } = await setup();
    const { id } = await post(app, owner, ch, 'x');
    expect((await del(app, owner, id, 'a')).statusCode).toBe(400);
    expect((await del(app, bystander, id, '👍')).statusCode).toBe(404);
    expect((await del(app, outsider, id, '👍')).statusCode).toBe(404);
    expect((await del(app, undefined, id, '👍')).statusCode).toBe(401);
  });
});

describe('メッセージの応答に含まれるリアクション', () => {
  it('一覧・編集の応答に、絵文字ごとの件数と付けた人が、付けた順に含まれる', async () => {
    const { app, owner, member, ch } = await setup();
    const a = await post(app, owner, ch, 'a');
    const b = await post(app, owner, ch, 'b');
    await put(app, member, a.id, '🎉');
    await put(app, owner, a.id, '👍');
    await put(app, owner, a.id, '🎉');
    const items = (await list(app, owner, ch)).json().messages as {
      id: number;
      reactions: unknown[];
    }[];
    expect(items.find((m) => m.id === b.id)!.reactions).toEqual([]);
    expect(items.find((m) => m.id === a.id)!.reactions).toEqual([
      { emoji: '🎉', count: 2, userIds: [member.id, owner.id] },
      { emoji: '👍', count: 1, userIds: [owner.id] },
    ]);
    const edited = await send(app, 'PATCH', owner, `/api/messages/${a.id}`, { body: '直した' });
    expect(edited.json().reactions).toHaveLength(2);
  });

  it('メッセージを削除すると、リアクションも無効になる(DB から消え、応答にも出ない)', async () => {
    const { app, owner, member, ch } = await setup();
    const parent = await post(app, owner, ch, '親');
    await send(app, 'POST', member, `/api/messages/${parent.id}/replies`, { body: '返信' });
    await put(app, owner, parent.id, '👍');
    await put(app, member, parent.id, '🎉');
    expect(await reactionRows(parent.id)).toHaveLength(2);

    await send(app, 'DELETE', owner, `/api/messages/${parent.id}`);
    expect(await reactionRows(parent.id)).toEqual([]);
    const res = await list(app, owner, ch); // 返信が残るので、削除済みの親が出る
    expect(res.json().messages[0]).toMatchObject({ id: parent.id, deleted: true });
    expect(res.body).not.toContain('👍');
    expect(res.body).not.toContain('🎉');
  });

  it('メッセージの物理削除(チャンネルの削除など)で、連鎖して消える', async () => {
    const { app, owner, ch } = await setup();
    const { id } = await post(app, owner, ch, 'x');
    await put(app, owner, id, '👍');
    await testDb.db.delete(messages).where(eq(messages.id, id));
    expect(await reactionRows(id)).toEqual([]);
  });
});

describe('WebSocket のイベント: reaction:added / reaction:removed', () => {
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
  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

  it('付与: 参加者に、その絵文字のいまの状態(件数と付けた人)が届く。未参加者には届かない', async () => {
    const { app, owner, member, ch, ownerRec, memberRec, bystanderRec } = await setupWs();
    const { id } = await post(app, owner, ch, 'x');
    await put(app, member, id, '👍');
    await put(app, owner, id, '👍');
    await vi.waitFor(() => expect(ownerRec.of('reaction:added')).toHaveLength(2));
    expect(ownerRec.of('reaction:added')).toEqual([
      { messageId: id, channelId: ch, emoji: '👍', count: 1, userIds: [member.id] },
      { messageId: id, channelId: ch, emoji: '👍', count: 2, userIds: [member.id, owner.id] },
    ]);
    expect(memberRec.of('reaction:added')).toHaveLength(2);
    await settle();
    expect(bystanderRec.of('reaction:added')).toEqual([]);
  });

  it('解除: 件数が減った状態が届く。全員が外すと、件数 0。付けていないものの解除、付与済みの再付与では、何も届かない', async () => {
    const { app, owner, member, ch, ownerRec } = await setupWs();
    const { id } = await post(app, owner, ch, 'x');
    await put(app, owner, id, '👍');
    await put(app, member, id, '👍');
    await put(app, member, id, '👍'); // 再付与: 通知しない
    await del(app, owner, id, '🎉'); // 付けていない: 通知しない
    await del(app, owner, id, '👍');
    await del(app, member, id, '👍');
    await vi.waitFor(() => expect(ownerRec.of('reaction:removed')).toHaveLength(2));
    expect(ownerRec.of('reaction:removed')).toEqual([
      { messageId: id, channelId: ch, emoji: '👍', count: 1, userIds: [member.id] },
      { messageId: id, channelId: ch, emoji: '👍', count: 0, userIds: [] },
    ]);
    await settle();
    expect(ownerRec.of('reaction:added')).toHaveLength(2);
  });
});
