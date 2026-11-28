import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { attachments, channelMembers, memberships } from '../db/schema';
import { SESSION_COOKIE_NAME } from '../session-cookie';
import { LocalDiskStorage } from '../storage/storage';
import { createTestDatabase } from '../test/db';
import { fileOfSize, makeTempDir, MP4_HEADER, multipart, PNG_HEADER } from '../test/files';
import { contentDisposition, parseRange } from './attachment-files';

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
  const username = `atf_user_${counter}`;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { origin: ORIGIN },
    payload: { username, password: PASSWORD },
    remoteAddress: `10.200.${Math.floor(counter / 250)}.${counter % 250}`,
  });
  expect(res.statusCode).toBe(201);
  const token = res.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;
  return { username, token, id: res.json().user.id as string };
}

function send(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'DELETE',
  user: TestUser | undefined,
  url: string,
  options: { payload?: unknown; headers?: Record<string, string> } = {},
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    headers: { origin: ORIGIN, ...options.headers },
    cookies: user ? { [SESSION_COOKIE_NAME]: user.token } : {},
    ...(options.payload === undefined ? {} : { payload: options.payload as object }),
  });
}

/** 添付つきで投稿して、メッセージと、添付の ID を返す */
async function postWithFiles(
  app: FastifyInstance,
  user: TestUser,
  ch: string,
  files: Array<{ data: Buffer; filename: string }>,
) {
  const { payload, contentType } = multipart([
    { name: 'body', value: '添付' },
    ...files.map((f) => ({ name: 'files', filename: f.filename, data: f.data })),
  ]);
  const res = await app.inject({
    method: 'POST',
    url: `/api/channels/${ch}/messages`,
    headers: { origin: ORIGIN, 'content-type': contentType },
    cookies: { [SESSION_COOKIE_NAME]: user.token },
    payload,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: number; attachments: Array<{ id: string }> };
}

async function setup() {
  const app = makeApp();
  const owner = await createUser(app);
  const member = await createUser(app);
  const bystander = await createUser(app); // 同じワークスペースで、チャンネルに未参加
  const outsider = await createUser(app); // 別のワークスペース
  const ws = (await send(app, 'POST', owner, '/api/workspaces', { payload: { name: 'A' } })).json()
    .id as string;
  await send(app, 'POST', outsider, '/api/workspaces', { payload: { name: 'B' } });
  for (const u of [member, bystander]) {
    await testDb.db.insert(memberships).values({ workspaceId: ws, userId: u.id, role: 'member' });
  }
  const ch = (
    await send(app, 'POST', owner, `/api/workspaces/${ws}/channels`, {
      payload: { name: 'files', type: 'public' },
    })
  ).json().id as string;
  await send(app, 'POST', member, `/api/channels/${ch}/join`);
  return { app, owner, member, bystander, outsider, ws, ch };
}

const IMAGE = fileOfSize(PNG_HEADER, 1000);
const VIDEO = fileOfSize(MP4_HEADER, 2000);

describe('GET /api/attachments/:id(FR-107)', () => {
  it('参加者は取得できる。内容・Content-Type・Content-Length・nosniff・inline・キャッシュの指定', async () => {
    const { app, owner, member, ch } = await setup();
    const posted = await postWithFiles(app, owner, ch, [
      { data: IMAGE, filename: '写真 (1).png' },
      { data: VIDEO, filename: 'clip.mp4' },
    ]);
    const [imageId, videoId] = posted.attachments.map((a) => a.id) as [string, string];

    for (const user of [owner, member]) {
      const image = await send(app, 'GET', user, `/api/attachments/${imageId}`);
      expect(image.statusCode).toBe(200);
      expect(image.rawPayload.equals(IMAGE)).toBe(true);
      expect(image.headers['content-type']).toBe('image/png');
      expect(image.headers['content-length']).toBe(String(IMAGE.length));
      expect(image.headers['x-content-type-options']).toBe('nosniff');
      expect(image.headers['accept-ranges']).toBe('bytes');
      expect(image.headers['cache-control']).toBe('private, no-cache');
      expect(image.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
      // ファイル名は、ASCII の代替と、UTF-8 の指定の両方で付ける
      expect(image.headers['content-disposition']).toBe(
        `inline; filename="__ (1).png"; filename*=UTF-8''%E5%86%99%E7%9C%9F%20%281%29.png`,
      );

      const video = await send(app, 'GET', user, `/api/attachments/${videoId}`);
      expect(video.statusCode).toBe(200);
      expect(video.headers['content-type']).toBe('video/mp4');
      expect(video.rawPayload.equals(VIDEO)).toBe(true);
    }
  });

  it('参加者でない人(同じワークスペース・別のワークスペース)は 404。未ログインは 401。形式違いの ID は 404', async () => {
    const { app, owner, bystander, outsider, ch } = await setup();
    const posted = await postWithFiles(app, owner, ch, [{ data: IMAGE, filename: 'a.png' }]);
    const id = posted.attachments[0]!.id;
    for (const user of [bystander, outsider]) {
      const res = await send(app, 'GET', user, `/api/attachments/${id}`);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(NOT_FOUND);
    }
    expect((await send(app, 'GET', undefined, `/api/attachments/${id}`)).statusCode).toBe(401);
    expect((await send(app, 'GET', owner, '/api/attachments/not-a-uuid')).statusCode).toBe(404);
    expect(
      (await send(app, 'GET', owner, '/api/attachments/00000000-0000-4000-8000-000000000000'))
        .statusCode,
    ).toBe(404);
  });

  it('チャンネルを退出した人は、取得できなくなる(404)', async () => {
    const { app, owner, member, ch } = await setup();
    const id = (await postWithFiles(app, owner, ch, [{ data: IMAGE, filename: 'a.png' }]))
      .attachments[0]!.id;
    expect((await send(app, 'GET', member, `/api/attachments/${id}`)).statusCode).toBe(200);
    expect((await send(app, 'POST', member, `/api/channels/${ch}/leave`)).statusCode).toBe(204);
    expect((await send(app, 'GET', member, `/api/attachments/${id}`)).statusCode).toBe(404);
  });

  it('DM の添付は、参加者以外(ワークスペースのオーナーを含む)には 404', async () => {
    const { app, owner, member, bystander, ws } = await setup();
    const dm = (
      await send(app, 'POST', member, `/api/workspaces/${ws}/dms`, {
        payload: { userId: bystander.id },
      })
    ).json();
    const id = (await postWithFiles(app, member, dm.id, [{ data: IMAGE, filename: 'dm.png' }]))
      .attachments[0]!.id;
    expect((await send(app, 'GET', bystander, `/api/attachments/${id}`)).statusCode).toBe(200);
    expect((await send(app, 'GET', owner, `/api/attachments/${id}`)).statusCode).toBe(404);
  });

  it('メッセージを削除すると、添付は、すぐに 404 になる', async () => {
    const { app, owner, member, ch } = await setup();
    const posted = await postWithFiles(app, owner, ch, [{ data: IMAGE, filename: 'a.png' }]);
    const id = posted.attachments[0]!.id;
    expect((await send(app, 'GET', member, `/api/attachments/${id}`)).statusCode).toBe(200);
    expect((await send(app, 'DELETE', owner, `/api/messages/${posted.id}`)).statusCode).toBe(204);
    for (const user of [owner, member]) {
      expect((await send(app, 'GET', user, `/api/attachments/${id}`)).statusCode).toBe(404);
    }
  });

  it('許可形式でない MIME の行・ストレージに実体がない場合は、500 ではなく 404', async () => {
    const { app, owner, ch } = await setup();
    const posted = await postWithFiles(app, owner, ch, [
      { data: IMAGE, filename: 'a.png' },
      { data: IMAGE, filename: 'b.png' },
    ]);
    const [badMime, missing] = posted.attachments.map((a) => a.id) as [string, string];
    await testDb.db
      .update(attachments)
      .set({ mime: 'text/html' })
      .where(eq(attachments.id, badMime));
    const [row] = await testDb.db.select().from(attachments).where(eq(attachments.id, missing));
    await storage.delete(row!.storageKey);
    expect((await send(app, 'GET', owner, `/api/attachments/${badMime}`)).statusCode).toBe(404);
    expect((await send(app, 'GET', owner, `/api/attachments/${missing}`)).statusCode).toBe(404);
  });

  it('参加者の行を外すと、取得できない(参加の行だけで判定する)', async () => {
    const { app, owner, member, ch } = await setup();
    const id = (await postWithFiles(app, owner, ch, [{ data: IMAGE, filename: 'a.png' }]))
      .attachments[0]!.id;
    await testDb.db
      .delete(channelMembers)
      .where(and(eq(channelMembers.channelId, ch), eq(channelMembers.userId, member.id)));
    expect((await send(app, 'GET', member, `/api/attachments/${id}`)).statusCode).toBe(404);
  });
});

describe('Range(動画のシークのため)', () => {
  async function video() {
    const ctx = await setup();
    const data = fileOfSize(MP4_HEADER, 1000);
    for (let i = MP4_HEADER.length; i < data.length; i += 1) data[i] = i % 251;
    const id = (await postWithFiles(ctx.app, ctx.owner, ctx.ch, [{ data, filename: 'v.mp4' }]))
      .attachments[0]!.id;
    const get = (range?: string) =>
      send(ctx.app, 'GET', ctx.member, `/api/attachments/${id}`, {
        headers: range ? { range } : {},
      });
    return { data, get };
  }

  it('先頭・途中・末尾までの指定は 206(Content-Range・Content-Length・該当の部分)', async () => {
    const { data, get } = await video();
    const head = await get('bytes=0-99');
    expect(head.statusCode).toBe(206);
    expect(head.headers['content-range']).toBe('bytes 0-99/1000');
    expect(head.headers['content-length']).toBe('100');
    expect(head.rawPayload.equals(data.subarray(0, 100))).toBe(true);
    expect(head.headers['content-type']).toBe('video/mp4');

    const middle = await get('bytes=500-599');
    expect(middle.headers['content-range']).toBe('bytes 500-599/1000');
    expect(middle.rawPayload.equals(data.subarray(500, 600))).toBe(true);

    const open = await get('bytes=900-');
    expect(open.headers['content-range']).toBe('bytes 900-999/1000');
    expect(open.rawPayload.equals(data.subarray(900))).toBe(true);
  });

  it('末尾の n バイト・終端が大きすぎる指定・最後の 1 バイトも、正しく返す', async () => {
    const { data, get } = await video();
    const suffix = await get('bytes=-100');
    expect(suffix.headers['content-range']).toBe('bytes 900-999/1000');
    expect(suffix.rawPayload.equals(data.subarray(900))).toBe(true);
    const beyond = await get('bytes=990-5000');
    expect(beyond.headers['content-range']).toBe('bytes 990-999/1000');
    const last = await get('bytes=999-999');
    expect(last.statusCode).toBe(206);
    expect(last.rawPayload.equals(data.subarray(999))).toBe(true);
    const bigSuffix = await get('bytes=-5000');
    expect(bigSuffix.headers['content-range']).toBe('bytes 0-999/1000');
  });

  it('範囲が、ファイルの外なら 416(Content-Range: bytes */サイズ)', async () => {
    const { get } = await video();
    for (const range of ['bytes=1000-', 'bytes=1000-1100', 'bytes=5000-6000', 'bytes=-0']) {
      const res = await get(range);
      expect(res.statusCode, range).toBe(416);
      expect(res.headers['content-range'], range).toBe('bytes */1000');
    }
  });

  it('解釈できない・逆順・複数の範囲・単位が違う指定は、無視して、全体を返す(200)', async () => {
    const { data, get } = await video();
    for (const range of ['bytes=abc', 'bytes=-', 'bytes=50-10', 'bytes=0-9,20-29', 'items=0-9']) {
      const res = await get(range);
      expect(res.statusCode, range).toBe(200);
      expect(res.rawPayload.equals(data)).toBe(true);
    }
  });

  it('参加者でなければ、Range でも 404', async () => {
    const { app, owner, bystander, ch } = await setup();
    const id = (await postWithFiles(app, owner, ch, [{ data: VIDEO, filename: 'v.mp4' }]))
      .attachments[0]!.id;
    const res = await send(app, 'GET', bystander, `/api/attachments/${id}`, {
      headers: { range: 'bytes=0-9' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('parseRange / contentDisposition(単体)', () => {
  it('parseRange', () => {
    expect(parseRange(undefined, 10)).toBeNull();
    expect(parseRange('bytes=0-4', 10)).toEqual({ start: 0, end: 4 });
    expect(parseRange('bytes=5-', 10)).toEqual({ start: 5, end: 9 });
    expect(parseRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange('bytes=0-100', 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=10-', 10)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 10)).toBe('unsatisfiable');
    expect(parseRange('bytes=5-2', 10)).toBeNull();
    expect(parseRange('bytes=1-2,4-5', 10)).toBeNull();
  });

  it('contentDisposition: 改行・引用符・非 ASCII を、ヘッダに、そのまま出さない', () => {
    const header = contentDisposition('a"b\r\nSet-Cookie: x=1.png');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header.startsWith('inline; filename="')).toBe(true);
    expect(header.split('filename="')[1]!.split('"')[0]).not.toContain('"');
    expect(contentDisposition('日本語.png')).toBe(
      `inline; filename="___.png"; filename*=UTF-8''${encodeURIComponent('日本語.png')}`,
    );
  });
});
