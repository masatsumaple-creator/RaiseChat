import { sql } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { memberships, messages } from '../db/schema';
import { SESSION_COOKIE_NAME } from '../session-cookie';
import { LocalDiskStorage } from '../storage/storage';
import { createTestDatabase } from '../test/db';
import { makeTempDir } from '../test/files';
import { escapeLike } from './search';

const ORIGIN = 'http://localhost:5173';
const PASSWORD = 'correct-horse-battery';

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
  const username = `srch_user_${counter}`;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { origin: ORIGIN },
    payload: { username, password: PASSWORD },
    remoteAddress: `10.210.${Math.floor(counter / 250)}.${counter % 250}`,
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

const post = async (app: FastifyInstance, user: TestUser, ch: string, body: string) => {
  const res = await send(app, 'POST', user, `/api/channels/${ch}/messages`, { body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: number };
};

const search = (
  app: FastifyInstance,
  user: TestUser | undefined,
  ws: string,
  q: string,
  cursor?: number,
) =>
  send(
    app,
    'GET',
    user,
    `/api/workspaces/${ws}/search?q=${encodeURIComponent(q)}${cursor === undefined ? '' : `&cursor=${cursor}`}`,
  );

const bodies = (res: LightMyRequestResponse) =>
  (res.json().results as Array<{ body: string }>).map((r) => r.body);

async function setup() {
  const app = makeApp();
  const owner = await createUser(app);
  const alice = await createUser(app);
  const bob = await createUser(app);
  const ws = await newWorkspace(app, owner);
  await addMember(ws, alice);
  await addMember(ws, bob);
  const open = await channel(app, owner, ws, 'open');
  await send(app, 'POST', alice, `/api/channels/${open}/join`);
  return { app, owner, alice, bob, ws, open };
}

describe('escapeLike(エスケープの順序)', () => {
  it('バックスラッシュ → パーセント → アンダースコアの順に、エスケープする', () => {
    expect(escapeLike('a\\b')).toBe('a\\\\b');
    expect(escapeLike('50%')).toBe('50\\%');
    expect(escapeLike('a_b')).toBe('a\\_b');
    // 逆の順だと、%・_ に付けた \ が、二重になる。\% は、\\\% になる
    expect(escapeLike('\\%')).toBe('\\\\\\%');
    expect(escapeLike('\\_%')).toBe('\\\\\\_\\%');
    expect(escapeLike('普通の語')).toBe('普通の語');
  });
});

describe('GET /api/workspaces/:ws/search(FR-110)', () => {
  it('参加チャンネルのメッセージがヒットし、チャンネル・投稿者・日時が付く。新しい順', async () => {
    const { app, owner, alice, ws, open } = await setup();
    await post(app, owner, open, '最初の りんご です');
    await post(app, alice, open, 'みかん だけ');
    await post(app, alice, open, 'りんご の 2 つ目');
    const res = await search(app, owner, ws, 'りんご');
    expect(res.statusCode, res.body).toBe(200);
    expect(bodies(res)).toEqual(['りんご の 2 つ目', '最初の りんご です']);
    expect(res.json().nextCursor).toBeNull();
    expect(res.json().results[0]).toMatchObject({
      channelId: open,
      channelType: 'public',
      channelName: 'open',
      peerName: null,
      parentId: null,
      author: { id: alice.id, username: alice.username },
      editedAt: null,
    });
  });

  it('日本語の 2 文字の語・大文字小文字を区別しない・前後の空白は無視', async () => {
    const { app, owner, ws, open } = await setup();
    await post(app, owner, open, '東京タワーに行った');
    await post(app, owner, open, 'Hello World');
    expect(bodies(await search(app, owner, ws, '東京'))).toEqual(['東京タワーに行った']);
    expect(bodies(await search(app, owner, ws, 'タワ'))).toEqual(['東京タワーに行った']);
    expect(bodies(await search(app, owner, ws, 'hello wor'))).toEqual(['Hello World']);
    expect(bodies(await search(app, owner, ws, '  WORLD  '))).toEqual(['Hello World']);
  });

  it('検索語が 1 文字以下・空・空白だけ・指定なしは 400(案内の文言)。長すぎる語も 400', async () => {
    const { app, owner, ws, open } = await setup();
    await post(app, owner, open, 'あ い う');
    for (const q of ['', 'あ', ' あ ', '   ']) {
      const res = await search(app, owner, ws, q);
      expect(res.statusCode, JSON.stringify(q)).toBe(400);
      expect(res.json()).toEqual({
        code: 'query_too_short',
        message: '検索語は、2 文字以上で入力してください。',
      });
    }
    const none = await send(app, 'GET', owner, `/api/workspaces/${ws}/search`);
    expect(none.statusCode).toBe(400);
    expect((await search(app, owner, ws, 'x'.repeat(101))).statusCode).toBe(400);
    expect((await search(app, owner, ws, 'x'.repeat(100))).statusCode).toBe(200);
    // 絵文字は、1 文字(コードポイント)と数える
    expect((await search(app, owner, ws, '😀')).statusCode).toBe(400);
    expect((await search(app, owner, ws, '😀😀')).statusCode).toBe(200);
  });

  it('権限外は入らない: 非参加のプライベート・非参加のパブリック・他人の DM・他のワークスペース', async () => {
    const { app, owner, alice, bob, ws, open } = await setup();
    const secret = await channel(app, owner, ws, 'secret', 'private');
    const unjoined = await channel(app, bob, ws, 'unjoined'); // owner・alice は未参加のパブリック
    const dm = (
      await send(app, 'POST', owner, `/api/workspaces/${ws}/dms`, { userId: bob.id })
    ).json();
    await post(app, owner, open, 'キーワード 公開');
    await post(app, owner, secret, 'キーワード 秘密');
    await post(app, bob, unjoined, 'キーワード 未参加');
    await post(app, owner, dm.id, 'キーワード DM');
    // 別のワークスペースにも、同じ語
    const other = await newWorkspace(app, owner, 'B');
    const otherCh = await channel(app, owner, other, 'general2');
    await post(app, owner, otherCh, 'キーワード 別ワークスペース');

    // alice: 参加している open だけ
    expect(bodies(await search(app, alice, ws, 'キーワード'))).toEqual(['キーワード 公開']);
    // bob: open・secret は未参加。自分の DM と、自分が作った unjoined だけ
    const bobResult = await search(app, bob, ws, 'キーワード');
    expect(bodies(bobResult)).toEqual(['キーワード DM', 'キーワード 未参加']);
    expect(bobResult.json().results[0]).toMatchObject({
      channelType: 'dm',
      channelName: null,
      peerName: owner.username,
    });
    // owner: 参加している 3 つ(open・secret・DM)。参加していない unjoined と、別のワークスペースは入らない
    expect(bodies(await search(app, owner, ws, 'キーワード'))).toEqual([
      'キーワード DM',
      'キーワード 秘密',
      'キーワード 公開',
    ]);
    // 別のワークスペースを指定すると、そちらだけ
    expect(bodies(await search(app, owner, other, 'キーワード'))).toEqual([
      'キーワード 別ワークスペース',
    ]);
  });

  it('ワークスペースに所属していない人は 404、未ログインは 401', async () => {
    const { app, ws } = await setup();
    const outsider = await createUser(app);
    expect((await search(app, outsider, ws, 'あいう')).statusCode).toBe(404);
    expect((await search(app, undefined, ws, 'あいう')).statusCode).toBe(401);
  });

  it('削除済みはヒットしない。編集後は、新しい本文でヒットし、古い本文ではヒットしない', async () => {
    const { app, owner, ws, open } = await setup();
    const gone = await post(app, owner, open, '消える とうふ');
    const edited = await post(app, owner, open, '直す みそ');
    expect(bodies(await search(app, owner, ws, 'とうふ'))).toEqual(['消える とうふ']);
    await send(app, 'DELETE', owner, `/api/messages/${gone.id}`);
    expect(bodies(await search(app, owner, ws, 'とうふ'))).toEqual([]);

    await send(app, 'PATCH', owner, `/api/messages/${edited.id}`, { body: '直した しょうゆ' });
    expect(bodies(await search(app, owner, ws, 'みそ'))).toEqual([]);
    const res = await search(app, owner, ws, 'しょうゆ');
    expect(bodies(res)).toEqual(['直した しょうゆ']);
    expect(res.json().results[0].editedAt).not.toBeNull();
  });

  it('スレッドの返信もヒットし、親の ID が付く。削除済みの親の下の返信も、ヒットする', async () => {
    const { app, owner, ws, open } = await setup();
    const root = await post(app, owner, open, '親の投稿');
    await send(app, 'POST', owner, `/api/messages/${root.id}/replies`, { body: '返信にだけ ねぎ' });
    const res = await search(app, owner, ws, 'ねぎ');
    expect(res.json().results[0]).toMatchObject({ body: '返信にだけ ねぎ', parentId: root.id });
    await send(app, 'DELETE', owner, `/api/messages/${root.id}`);
    expect(bodies(await search(app, owner, ws, 'ねぎ'))).toEqual(['返信にだけ ねぎ']);
  });

  it('バックスラッシュ・パーセント・アンダースコアを含む語は、文字どおりに検索される(ワイルドカードにならない)', async () => {
    const { app, owner, ws, open } = await setup();
    for (const body of [
      '割引は 50% です',
      '割引は 50ab です',
      'file_name.txt を見て',
      'fileXname.txt を見て',
      'C:\\temp\\new を開く',
      'C:temp が別',
      '100%_ok',
      '100aXok',
      '\\% の連続',
      '\\a の連続',
    ]) {
      await post(app, owner, open, body);
    }
    // % は、任意の文字列ではない
    expect(bodies(await search(app, owner, ws, '50%'))).toEqual(['割引は 50% です']);
    // _ は、任意の 1 文字ではない
    expect(bodies(await search(app, owner, ws, 'file_name'))).toEqual(['file_name.txt を見て']);
    // \ は、エスケープ文字として働かない
    expect(bodies(await search(app, owner, ws, 'C:\\temp'))).toEqual(['C:\\temp\\new を開く']);
    expect(bodies(await search(app, owner, ws, 'temp\\n'))).toEqual(['C:\\temp\\new を開く']);
    expect(bodies(await search(app, owner, ws, '100%_'))).toEqual(['100%_ok']);
    // \ と % の組み合わせも、文字どおり
    expect(bodies(await search(app, owner, ws, '\\%'))).toEqual(['\\% の連続']);
    expect(bodies(await search(app, owner, ws, '\\a'))).toEqual(['\\a の連続']);
    // % だけ・_ だけの 2 文字でも、全件にはならない
    expect(bodies(await search(app, owner, ws, '%%'))).toEqual([]);
    expect(bodies(await search(app, owner, ws, '__'))).toEqual([]);
  });

  it('50 件ずつ、cursor でページングできる(取りこぼし・重複がない)', async () => {
    const { app, owner, ws, open } = await setup();
    const ids: number[] = [];
    for (let i = 0; i < 120; i += 1) {
      ids.push((await post(app, owner, open, `ページ確認 ${i}`)).id);
    }
    await post(app, owner, open, '無関係');
    const seen: number[] = [];
    let cursor: number | undefined;
    const sizes: number[] = [];
    for (let page = 0; page < 5; page += 1) {
      const res = await search(app, owner, ws, 'ページ確認', cursor);
      expect(res.statusCode).toBe(200);
      const body = res.json() as { results: Array<{ id: number }>; nextCursor: number | null };
      sizes.push(body.results.length);
      seen.push(...body.results.map((r) => r.id));
      if (body.nextCursor === null) break;
      cursor = body.nextCursor;
    }
    expect(sizes).toEqual([50, 50, 20]);
    expect(seen).toEqual([...ids].reverse());
    expect(new Set(seen).size).toBe(120);
  });

  it('ちょうど 50 件なら、次のページはない(nextCursor が null)', async () => {
    const { app, owner, ws, open } = await setup();
    for (let i = 0; i < 50; i += 1) await post(app, owner, open, `ちょうど ${i}`);
    const res = await search(app, owner, ws, 'ちょうど');
    expect(res.json().results).toHaveLength(50);
    expect(res.json().nextCursor).toBeNull();
  });

  it('チャンネルを退出すると、そのチャンネルのメッセージは、結果に入らなくなる', async () => {
    const { app, owner, alice, ws, open } = await setup();
    await post(app, owner, open, '退出の確認 だし');
    expect(bodies(await search(app, alice, ws, 'だし'))).toHaveLength(1);
    expect((await send(app, 'POST', alice, `/api/channels/${open}/leave`)).statusCode).toBe(204);
    expect(bodies(await search(app, alice, ws, 'だし'))).toEqual([]);
  });

  it('索引が使われる設定になっている(pg_trgm の GIN 索引が、削除済みを除いて、作られている)', async () => {
    const rows = (await testDb.db.execute(
      sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'messages_body_trgm_idx'`,
    )) as unknown as Array<{ indexdef: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toContain('gin_trgm_ops');
    expect(rows[0]!.indexdef).toContain('deleted_at IS NULL');
  });

  it('DB に直接作った、削除済みの行は、ヒットしない', async () => {
    const { app, owner, ws, open } = await setup();
    const m = await post(app, owner, open, 'まだある こんぶ');
    await testDb.db.execute(
      sql`UPDATE ${messages} SET body = NULL, deleted_at = now() WHERE id = ${m.id}`,
    );
    expect(bodies(await search(app, owner, ws, 'こんぶ'))).toEqual([]);
  });
});
