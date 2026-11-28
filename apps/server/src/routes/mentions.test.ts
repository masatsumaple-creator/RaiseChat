import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { AddressInfo } from 'node:net';
import { io as connectIo, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { channelMembers, memberships, mentions } from '../db/schema';
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
  const username = `mention_user_${counter}`;
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

interface Posted {
  id: number;
  mentions: { userId: string; username: string }[];
}

const post = async (app: FastifyInstance, user: TestUser, ch: string, body: string) => {
  const res = await send(app, 'POST', user, `/api/channels/${ch}/messages`, { body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as Posted;
};
const reply = async (app: FastifyInstance, user: TestUser, parent: number, body: string) => {
  const res = await send(app, 'POST', user, `/api/messages/${parent}/replies`, { body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as Posted;
};
const edit = async (app: FastifyInstance, user: TestUser, id: number, body: string) => {
  const res = await send(app, 'PATCH', user, `/api/messages/${id}`, { body });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Posted;
};

async function mentionedIds(messageId: number) {
  const rows = await testDb.db.select().from(mentions).where(eq(mentions.messageId, messageId));
  return rows.map((r) => r.userId).sort();
}
const sorted = (...ids: string[]) => [...ids].sort();

async function setup() {
  const app = makeApp();
  const owner = await createUser(app);
  const alice = await createUser(app);
  const bob = await createUser(app);
  const bystander = await createUser(app); // 同じワークスペースで、チャンネルに未参加
  const ws = await newWorkspace(app, owner);
  for (const u of [alice, bob, bystander]) await addMember(ws, u);
  const ch = await createChannel(app, owner, ws, 'talk');
  await join(app, alice, ch);
  await join(app, bob, ch);
  return { app, owner, alice, bob, bystander, ws, ch };
}

describe('メンションの登録(投稿。FR-109)', () => {
  it('参加者だけが登録される。応答にも、有効なメンション(ユーザー ID とユーザー名)が入る', async () => {
    const { app, owner, alice, bystander, ch } = await setup();
    const posted = await post(
      app,
      owner,
      ch,
      `@${alice.username} @${bystander.username} @nobody_here`,
    );
    expect(posted.mentions).toEqual([{ userId: alice.id, username: alice.username }]);
    expect(await mentionedIds(posted.id)).toEqual([alice.id]);
  });

  it('プライベートで、非参加者をメンションしても、登録・通知されず、チャンネルにも入れない', async () => {
    const app = makeApp();
    const owner = await createUser(app);
    const outside = await createUser(app);
    const ws = await newWorkspace(app, owner);
    await addMember(ws, outside);
    const ch = await createChannel(app, owner, ws, 'secret', 'private');
    const posted = await post(app, owner, ch, `@${outside.username} 見える?`);
    expect(posted.mentions).toEqual([]);
    expect(await mentionedIds(posted.id)).toEqual([]);
    const rows = await testDb.db
      .select()
      .from(channelMembers)
      .where(eq(channelMembers.channelId, ch));
    expect(rows.map((r) => r.userId)).toEqual([owner.id]);
    expect((await send(app, 'GET', outside, `/api/channels/${ch}/messages`)).statusCode).toBe(404);
  });

  it('自分自身は、登録しない', async () => {
    const { app, owner, alice, ch } = await setup();
    const posted = await post(app, owner, ch, `@${owner.username} @${alice.username}`);
    expect(await mentionedIds(posted.id)).toEqual([alice.id]);
  });

  it('大文字小文字を区別しない。同じ人を複数回メンションしても 1 件', async () => {
    const { app, owner, alice, ch } = await setup();
    const posted = await post(
      app,
      owner,
      ch,
      `@${alice.username.toUpperCase()} @${alice.username} @${alice.username}`,
    );
    expect(posted.mentions).toEqual([{ userId: alice.id, username: alice.username }]);
    expect(await mentionedIds(posted.id)).toEqual([alice.id]);
  });

  it('ユーザー名の途中までの一致は、対象外(より長い名前の一部には、反応しない)', async () => {
    const { app, owner, alice, ch } = await setup();
    const posted = await post(
      app,
      owner,
      ch,
      `@${alice.username}x @${alice.username.slice(0, -1)}`,
    );
    expect(posted.mentions).toEqual([]);
  });

  it('コードのブロック・インラインコードの中は、対象外', async () => {
    const { app, owner, alice, bob, ch } = await setup();
    const body = [
      `\`@${alice.username}\``,
      '```',
      `@${alice.username}`,
      '```',
      `@${bob.username}`,
    ].join('\n');
    const posted = await post(app, owner, ch, body);
    expect(await mentionedIds(posted.id)).toEqual([bob.id]);
  });

  it('ワークスペースに active で所属していない人は、登録しない', async () => {
    const { app, owner, alice, ch } = await setup();
    await testDb.db
      .update(memberships)
      .set({ status: 'kicked' })
      .where(eq(memberships.userId, alice.id));
    const posted = await post(app, owner, ch, `@${alice.username}`);
    expect(posted.mentions).toEqual([]);
  });

  it('一覧(GET /channels/:ch/messages)に、有効なメンションが含まれる', async () => {
    const { app, owner, alice, ch } = await setup();
    await post(app, owner, ch, `@${alice.username} ここ`);
    const res = await send(app, 'GET', owner, `/api/channels/${ch}/messages`);
    expect(res.json().messages[0].mentions).toEqual([
      { userId: alice.id, username: alice.username },
    ]);
  });
});

describe('メンションの登録(スレッドの返信)', () => {
  it('返信のメンションも登録され、返信の一覧にも含まれる。スレッドの非参加者にも付く', async () => {
    const { app, owner, bob, ch } = await setup();
    const root = await post(app, owner, ch, 'root');
    const r = await reply(app, owner, root.id, `@${bob.username} 見て`);
    expect(r.mentions).toEqual([{ userId: bob.id, username: bob.username }]);
    expect(await mentionedIds(r.id)).toEqual([bob.id]);
    const res = await send(app, 'GET', owner, `/api/messages/${root.id}/replies`);
    expect(res.json().replies[0].mentions).toEqual([{ userId: bob.id, username: bob.username }]);
  });

  it('返信の編集でも、差分更新される', async () => {
    const { app, owner, alice, bob, ch } = await setup();
    const root = await post(app, owner, ch, 'root');
    const r = await reply(app, owner, root.id, `@${alice.username}`);
    await edit(app, owner, r.id, `@${bob.username}`);
    expect(await mentionedIds(r.id)).toEqual([bob.id]);
  });
});

describe('メンションの編集(差分)', () => {
  it('追加・削除・変化なしを、差分で更新する。残る行の既読(read_at)は、そのまま', async () => {
    const { app, owner, alice, bob, ch } = await setup();
    const posted = await post(app, owner, ch, `@${alice.username} @${bob.username}`);
    const readAt = new Date('2026-01-01T00:00:00Z');
    await testDb.db.update(mentions).set({ readAt }).where(eq(mentions.messageId, posted.id));

    // 変化なし(alice)+ 削除(bob)
    const edited = await edit(app, owner, posted.id, `直した @${alice.username}`);
    expect(edited.mentions).toEqual([{ userId: alice.id, username: alice.username }]);
    const rows = await testDb.db.select().from(mentions).where(eq(mentions.messageId, posted.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(alice.id);
    expect(rows[0]!.readAt).toEqual(readAt);

    // 追加(bob を戻す)。alice の既読は、残る
    const again = await edit(app, owner, posted.id, `@${alice.username} @${bob.username} 再び`);
    expect(again.mentions.map((m) => m.userId).sort()).toEqual(sorted(alice.id, bob.id));
    const after = await testDb.db.select().from(mentions).where(eq(mentions.messageId, posted.id));
    expect(after.find((r) => r.userId === alice.id)!.readAt).toEqual(readAt);
    expect(after.find((r) => r.userId === bob.id)!.readAt).toBeNull();
  });

  it('本文が変わらない編集では、メンションも変わらず、応答にそのまま含まれる', async () => {
    const { app, owner, alice, ch } = await setup();
    const posted = await post(app, owner, ch, `@${alice.username}`);
    const same = await edit(app, owner, posted.id, `@${alice.username}`);
    expect(same.mentions).toEqual([{ userId: alice.id, username: alice.username }]);
  });

  it('編集でコードに入れると、メンションは外れる', async () => {
    const { app, owner, alice, ch } = await setup();
    const posted = await post(app, owner, ch, `@${alice.username}`);
    const edited = await edit(app, owner, posted.id, `\`@${alice.username}\``);
    expect(edited.mentions).toEqual([]);
    expect(await mentionedIds(posted.id)).toEqual([]);
  });
});

describe('メンションの削除', () => {
  it('メッセージの削除で、メンションが消え、一覧にも出ない', async () => {
    const { app, owner, alice, ch } = await setup();
    const posted = await post(app, owner, ch, `@${alice.username}`);
    await reply(app, owner, posted.id, 'keep'); // 返信が残れば、削除済みの親が一覧に出る
    expect((await send(app, 'DELETE', owner, `/api/messages/${posted.id}`)).statusCode).toBe(204);
    expect(await mentionedIds(posted.id)).toEqual([]);
    const res = await send(app, 'GET', owner, `/api/channels/${ch}/messages`);
    expect(res.json().messages[0]).not.toHaveProperty('mentions');
  });

  it('メッセージの行の削除(チャンネルの削除など)でも、連鎖して消える', async () => {
    const { app, owner, alice, ch } = await setup();
    const posted = await post(app, owner, ch, `@${alice.username}`);
    await testDb.db.execute(sql`DELETE FROM messages WHERE id = ${posted.id}`);
    expect(await mentionedIds(posted.id)).toEqual([]);
  });
});

describe('WebSocket のイベント: mention:created', () => {
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
    const ch = await createChannel(app, owner, ws, 'live');
    await join(app, alice, ch);
    await join(app, bob, ch);
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
      owner,
      alice,
      bob,
      ws,
      ch,
      ownerRec: await connect(owner),
      aliceRec: await connect(alice),
      bobRec: await connect(bob),
    };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

  it('メンションされた人にだけ届く(メッセージ ID・チャンネル ID・ワークスペース ID)。本人・他の人には届かない', async () => {
    const { app, owner, alice, ws, ch, ownerRec, aliceRec, bobRec } = await setupWs();
    const posted = await post(app, owner, ch, `@${alice.username} @${owner.username}`);
    await vi.waitFor(() => expect(aliceRec.of('mention:created')).toHaveLength(1));
    expect(aliceRec.of('mention:created')).toEqual([
      { messageId: posted.id, channelId: ch, workspaceId: ws },
    ]);
    await settle();
    expect(bobRec.of('mention:created')).toEqual([]);
    expect(ownerRec.of('mention:created')).toEqual([]);
  });

  it('編集では、新しく加わった人にだけ届く。残る人・外れた人・変化なしの編集では、届かない', async () => {
    const { app, owner, alice, bob, ws, ch, aliceRec, bobRec } = await setupWs();
    const posted = await post(app, owner, ch, `@${alice.username}`);
    await vi.waitFor(() => expect(aliceRec.of('mention:created')).toHaveLength(1));
    await edit(app, owner, posted.id, `@${alice.username} @${bob.username} 追加`);
    await vi.waitFor(() => expect(bobRec.of('mention:created')).toHaveLength(1));
    expect(bobRec.of('mention:created')).toEqual([
      { messageId: posted.id, channelId: ch, workspaceId: ws },
    ]);
    await edit(app, owner, posted.id, `@${bob.username} 外した`); // alice は外れる
    await edit(app, owner, posted.id, `@${bob.username} 外した`); // 変化なし
    await settle();
    expect(aliceRec.of('mention:created')).toHaveLength(1);
    expect(bobRec.of('mention:created')).toHaveLength(1);
  });

  it('返信のメンションも、本人にだけ届く', async () => {
    const { app, owner, bob, ws, ch, aliceRec, bobRec } = await setupWs();
    const root = await post(app, owner, ch, 'root');
    const r = await reply(app, owner, root.id, `@${bob.username}`);
    await vi.waitFor(() => expect(bobRec.of('mention:created')).toHaveLength(1));
    expect(bobRec.of('mention:created')).toEqual([
      { messageId: r.id, channelId: ch, workspaceId: ws },
    ]);
    await settle();
    expect(aliceRec.of('mention:created')).toEqual([]);
  });

  it('参加者でない人をメンションしても、誰にも届かない(プライベート)', async () => {
    const { app, owner, alice, aliceRec, ws } = await setupWs();
    const secret = await createChannel(app, owner, ws, 'secret', 'private');
    await post(app, owner, secret, `@${alice.username}`);
    await settle();
    expect(aliceRec.of('mention:created')).toEqual([]);
  });
});
