import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { storageDeletions, users } from '../db/schema';
import { LocalDiskStorage } from '../storage/storage';
import { SESSION_COOKIE_NAME } from '../session-cookie';
import { createTestDatabase } from '../test/db';
import {
  fileOfSize,
  GIF_HEADER,
  JPEG_HEADER,
  makeTempDir,
  multipart,
  PNG_HEADER,
  WEBP_HEADER,
} from '../test/files';
import { AVATAR_MAX_BYTES } from './profile';

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

/** ユーザーを登録し、ログイン済みのトークンを返す(登録のレート制限を避けるため、IP を変える) */
async function createUser(app: FastifyInstance) {
  counter += 1;
  const username = `profile_${counter}`;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { origin: ORIGIN },
    payload: { username, password: PASSWORD },
    remoteAddress: `10.100.${Math.floor(counter / 250)}.${counter % 250}`,
  });
  expect(res.statusCode).toBe(201);
  const token = res.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;
  return { username, token, id: res.json().user.id as string };
}

function patchMe(app: FastifyInstance, token: string | undefined, body: unknown, origin = ORIGIN) {
  return app.inject({
    method: 'PATCH',
    url: '/api/me',
    headers: origin ? { origin } : {},
    cookies: token ? { [SESSION_COOKIE_NAME]: token } : {},
    payload: body as object,
  });
}

function putAvatar(
  app: FastifyInstance,
  token: string | undefined,
  parts: Parameters<typeof multipart>[0],
  origin: string | null = ORIGIN,
) {
  const { payload, contentType } = multipart(parts);
  return app.inject({
    method: 'PUT',
    url: '/api/me/avatar',
    headers: { 'content-type': contentType, ...(origin ? { origin } : {}) },
    cookies: token ? { [SESSION_COOKIE_NAME]: token } : {},
    payload,
  });
}

const upload = (
  app: FastifyInstance,
  token: string,
  data: Buffer,
  options: { filename?: string; contentType?: string } = {},
) =>
  putAvatar(app, token, [
    {
      name: 'file',
      filename: options.filename ?? 'avatar.png',
      contentType: options.contentType ?? 'image/png',
      data,
    },
  ]);

function getAvatar(app: FastifyInstance, token: string | undefined, userId: string, query = '') {
  return app.inject({
    method: 'GET',
    url: `/api/users/${userId}/avatar${query}`,
    cookies: token ? { [SESSION_COOKIE_NAME]: token } : {},
  });
}

async function userRow(id: string) {
  const [row] = await testDb.db.select().from(users).where(eq(users.id, id));
  return row!;
}

describe('PATCH /api/me(FR-004)', () => {
  it('表示名とステータスを変更でき、保存される', async () => {
    const app = makeApp();
    const { token, id } = await createUser(app);

    const res = await patchMe(app, token, { displayName: '山田 太郎', statusText: '会議中 😀' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id, displayName: '山田 太郎', statusText: '会議中 😀' });

    const row = await userRow(id);
    expect(row.displayName).toBe('山田 太郎');
    expect(row.statusText).toBe('会議中 😀');
    // GET /me にも反映される
    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(me.json().displayName).toBe('山田 太郎');
  });

  it('指定した項目だけを更新し、他は変えない', async () => {
    const app = makeApp();
    const { token, id, username } = await createUser(app);
    await patchMe(app, token, { statusText: '外出中' });
    let row = await userRow(id);
    expect(row.displayName).toBe(username);
    expect(row.statusText).toBe('外出中');

    await patchMe(app, token, { displayName: '新しい名前' });
    row = await userRow(id);
    expect(row.displayName).toBe('新しい名前');
    expect(row.statusText).toBe('外出中');
  });

  it('ステータスは、空にできる(消せる)。前後の空白は、取り除かれる', async () => {
    const app = makeApp();
    const { token, id } = await createUser(app);
    await patchMe(app, token, { statusText: '外出中' });
    const cleared = await patchMe(app, token, { statusText: '   ' });
    expect(cleared.statusCode).toBe(200);
    expect((await userRow(id)).statusText).toBe('');

    const trimmed = await patchMe(app, token, { displayName: '  Taro  ' });
    expect(trimmed.json().displayName).toBe('Taro');
  });

  it('表示名は 1〜50 文字、ステータスは 100 文字まで(コードポイント数。境界を確かめる)', async () => {
    const app = makeApp();
    const { token } = await createUser(app);
    const cases: [object, number][] = [
      [{ displayName: 'a' }, 200],
      [{ displayName: '' }, 400],
      [{ displayName: '   ' }, 400],
      [{ displayName: 'あ'.repeat(50) }, 200],
      [{ displayName: 'あ'.repeat(51) }, 400],
      [{ displayName: '😀'.repeat(50) }, 200], // UTF-16 では 100 だが、コードポイントでは 50
      [{ displayName: '😀'.repeat(51) }, 400],
      [{ statusText: 'x'.repeat(100) }, 200],
      [{ statusText: 'x'.repeat(101) }, 400],
      [{ statusText: '😀'.repeat(100) }, 200],
      [{ statusText: '😀'.repeat(101) }, 400],
    ];
    for (const [body, status] of cases) {
      const res = await patchMe(app, token, body);
      expect(res.statusCode, JSON.stringify(body).slice(0, 40)).toBe(status);
    }
  });

  it('制御文字(改行・タブ)は、拒否する', async () => {
    const app = makeApp();
    const { token } = await createUser(app);
    for (const body of [
      { displayName: 'a\nb' },
      { displayName: 'a\tb' },
      { statusText: 'x\r\ny' },
      { statusText: 'a\u0000b' },
    ]) {
      expect((await patchMe(app, token, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it('空の本文・余分な項目(username など)・型の違いは 400。ユーザー名は変えられない', async () => {
    const app = makeApp();
    const { token, id, username } = await createUser(app);
    for (const body of [
      {},
      { username: 'hacked_name' },
      { displayName: 'ok', passwordHash: 'x' },
      { displayName: 'ok', avatarKey: 'avatars/x/y.png' },
      { displayName: 123 },
    ]) {
      expect((await patchMe(app, token, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    const row = await userRow(id);
    expect(row.username).toBe(username);
    expect(row.avatarKey).toBeNull();
  });

  it('ログインしていないと 401。Origin がないと 403。他のユーザーは、変更できない', async () => {
    const app = makeApp();
    const a = await createUser(app);
    const b = await createUser(app);
    expect((await patchMe(app, undefined, { displayName: 'x' })).statusCode).toBe(401);
    expect((await patchMe(app, a.token, { displayName: 'x' }, '')).statusCode).toBe(403);

    await patchMe(app, a.token, { displayName: 'Aさん' });
    expect((await userRow(b.id)).displayName).toBe(b.username); // b は、変わらない
  });
});

describe('PUT /api/me/avatar(FR-004)', () => {
  it.each([
    ['PNG', PNG_HEADER, 'image/png', 'png'],
    ['JPEG', JPEG_HEADER, 'image/jpeg', 'jpg'],
    ['GIF', GIF_HEADER, 'image/gif', 'gif'],
    ['WebP', WEBP_HEADER, 'image/webp', 'webp'],
  ])('%s をアップロードでき、取得できる', async (_name, header, mime, ext) => {
    const app = makeApp();
    const { token, id } = await createUser(app);
    const data = fileOfSize(header, 1000);

    const res = await upload(app, token, data);
    expect(res.statusCode).toBe(200);
    const url = res.json().avatarUrl as string;
    expect(url).toMatch(new RegExp(`^/api/users/${id}/avatar\\?v=[0-9a-f-]{36}$`));
    expect((await userRow(id)).avatarKey).toMatch(
      new RegExp(`^avatars/${id}/[0-9a-f-]{36}\\.${ext}$`),
    );

    const got = await getAvatar(app, token, id);
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe(mime);
    expect(got.rawPayload.equals(data)).toBe(true);
  });

  it('取得の応答に、nosniff・CSP・キャッシュの指定が付く', async () => {
    const app = makeApp();
    const { token, id } = await createUser(app);
    await upload(app, token, fileOfSize(PNG_HEADER, 100));
    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    // 現在の版(?v=)つきの URL だけ、長くキャッシュさせる
    const got = await getAvatar(
      app,
      token,
      id,
      `?v=${new URL(me.json().avatarUrl, 'http://x').searchParams.get('v')}`,
    );
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    expect(got.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(got.headers['cache-control']).toBe('private, max-age=31536000, immutable');
  });

  it('版がない・古い版の URL は、長くキャッシュさせない(差し替え後に、古い画像を返し続けないため)', async () => {
    const app = makeApp();
    const { token, id } = await createUser(app);
    await upload(app, token, fileOfSize(PNG_HEADER, 100));
    for (const query of ['', '?v=old-version']) {
      const got = await getAvatar(app, token, id, query);
      expect(got.statusCode).toBe(200);
      expect(got.headers['cache-control']).toBe('private, no-cache');
    }
  });

  it('GET /me の avatarUrl も、アップロード後に更新される', async () => {
    const app = makeApp();
    const { token } = await createUser(app);
    const before = await app.inject({
      method: 'GET',
      url: '/api/me',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(before.json().avatarUrl).toBeNull();

    const uploaded = await upload(app, token, fileOfSize(PNG_HEADER, 100));
    const after = await app.inject({
      method: 'GET',
      url: '/api/me',
      cookies: { [SESSION_COOKIE_NAME]: token },
    });
    expect(after.json().avatarUrl).toBe(uploaded.json().avatarUrl);
  });

  it('ちょうど 2MB は許可し、1 バイトでも超えたら 413(ファイルは保存されない)', async () => {
    const app = makeApp();
    const { token, id } = await createUser(app);

    const exact = await upload(app, token, fileOfSize(PNG_HEADER, AVATAR_MAX_BYTES));
    expect(exact.statusCode).toBe(200);
    const keyAfterExact = (await userRow(id)).avatarKey;
    expect(keyAfterExact).not.toBeNull();

    const over = await upload(app, token, fileOfSize(PNG_HEADER, AVATAR_MAX_BYTES + 1));
    expect(over.statusCode).toBe(413);
    expect(over.json().code).toBe('payload_too_large');
    // DB も、保存先も、変わらない
    expect((await userRow(id)).avatarKey).toBe(keyAfterExact);
    expect(await storage.get(keyAfterExact!)).not.toBeNull();
  });

  it('拡張子や Content-Type を偽っても、内容で判定する: HTML を .png と偽っても拒否', async () => {
    const app = makeApp();
    const { token, id } = await createUser(app);
    const res = await upload(app, token, Buffer.from('<html><script>alert(1)</script></html>'), {
      filename: 'evil.png',
      contentType: 'image/png',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('unsupported_image');
    expect((await userRow(id)).avatarKey).toBeNull();
  });

  it('SVG は、拡張子・Content-Type が何であっても、拒否する', async () => {
    const app = makeApp();
    const { token, id } = await createUser(app);
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    for (const [filename, contentType] of [
      ['a.svg', 'image/svg+xml'],
      ['a.png', 'image/png'],
      ['a.jpg', 'image/jpeg'],
      ['a', 'application/octet-stream'],
    ]) {
      const res = await upload(app, token, svg, { filename, contentType });
      expect(res.statusCode, filename).toBe(400);
    }
    expect((await userRow(id)).avatarKey).toBeNull();
  });

  it('実際は PNG の内容なら、拡張子・Content-Type が違っても、PNG として扱う(内容だけを見る)', async () => {
    const app = makeApp();
    const { token, id } = await createUser(app);
    const res = await upload(app, token, fileOfSize(PNG_HEADER, 100), {
      filename: 'weird.svg',
      contentType: 'text/html',
    });
    expect(res.statusCode).toBe(200);
    expect((await userRow(id)).avatarKey).toMatch(/\.png$/);
    expect((await getAvatar(app, token, id)).headers['content-type']).toBe('image/png');
  });

  it('PDF・テキスト・空のファイル・BMP は拒否する', async () => {
    const app = makeApp();
    const { token } = await createUser(app);
    for (const data of [
      Buffer.from('%PDF-1.7\n'),
      Buffer.from('just text'),
      Buffer.alloc(0),
      Buffer.from([0x42, 0x4d, 0, 0, 0, 0]),
    ]) {
      expect((await upload(app, token, data)).statusCode).toBe(400);
    }
  });

  it('ファイルがない・名前が違う・2 つ以上・multipart でない場合は 400', async () => {
    const app = makeApp();
    const { token, id } = await createUser(app);
    const file = { filename: 'a.png', contentType: 'image/png', data: fileOfSize(PNG_HEADER, 50) };

    expect((await putAvatar(app, token, [{ name: 'comment', value: 'hello' }])).statusCode).toBe(
      400,
    );
    expect((await putAvatar(app, token, [{ name: 'avatar', ...file }])).statusCode).toBe(400);
    expect(
      (
        await putAvatar(app, token, [
          { name: 'file', ...file },
          { name: 'file', ...file },
        ])
      ).statusCode,
    ).toBe(400);
    const json = await app.inject({
      method: 'PUT',
      url: '/api/me/avatar',
      headers: { origin: ORIGIN },
      cookies: { [SESSION_COOKIE_NAME]: token },
      payload: { file: 'x' },
    });
    expect(json.statusCode).toBe(400);
    expect((await userRow(id)).avatarKey).toBeNull();
  });

  it('ログインしていないと 401。Origin がないと 403(どちらも、保存されない)', async () => {
    const app = makeApp();
    const { token, id } = await createUser(app);
    const part = [{ name: 'file', filename: 'a.png', contentType: 'image/png', data: PNG_HEADER }];
    expect((await putAvatar(app, undefined, part)).statusCode).toBe(401);
    expect((await putAvatar(app, token, part, null)).statusCode).toBe(403);
    expect((await userRow(id)).avatarKey).toBeNull();
  });
});

describe('アバターの差し替えと、旧ファイルの削除(FR-004)', () => {
  it('差し替えると、旧ファイルが削除キューに積まれ、非同期に実体が削除される', async () => {
    const app = makeApp();
    const { token, id } = await createUser(app);

    await upload(app, token, fileOfSize(PNG_HEADER, 100));
    const oldKey = (await userRow(id)).avatarKey!;
    await upload(app, token, fileOfSize(JPEG_HEADER, 200));
    const newKey = (await userRow(id)).avatarKey!;
    expect(newKey).not.toBe(oldKey);

    // キューに旧キーが積まれ、(非同期の処理で)実体が消え、deleted_at が設定される
    await expect
      .poll(
        async () => {
          const [row] = await testDb.db
            .select()
            .from(storageDeletions)
            .where(eq(storageDeletions.storageKey, oldKey));
          return row?.deletedAt ?? null;
        },
        { timeout: 5000 },
      )
      .not.toBeNull();
    expect(await storage.get(oldKey)).toBeNull();

    // 新しいファイルは残り、キューには積まれない
    expect(await storage.get(newKey)).not.toBeNull();
    const queuedNew = await testDb.db
      .select()
      .from(storageDeletions)
      .where(eq(storageDeletions.storageKey, newKey));
    expect(queuedNew).toHaveLength(0);
  });

  it('初めてのアップロードでは、削除キューに何も積まれない', async () => {
    const app = makeApp();
    const { token, id } = await createUser(app);
    await upload(app, token, fileOfSize(PNG_HEADER, 100));
    const key = (await userRow(id)).avatarKey!;
    const queued = await testDb.db
      .select()
      .from(storageDeletions)
      .where(eq(storageDeletions.storageKey, key));
    expect(queued).toHaveLength(0);
  });

  it('旧ファイルの削除に失敗しても、アップロード自体は成功し、キューに残る(再試行できる)', async () => {
    const config = loadConfig({ ALLOWED_ORIGIN: ORIGIN });
    const failingDelete = {
      put: (key: string, data: Uint8Array) => storage.put(key, data),
      get: (key: string) => storage.get(key),
      delete: async () => {
        throw new Error('ストレージに接続できません');
      },
    };
    const app = buildApp({ config, db: testDb.db, storage: failingDelete, logger: false });
    apps.push(app);
    const { token, id } = await createUser(app);

    await upload(app, token, fileOfSize(PNG_HEADER, 100));
    const oldKey = (await userRow(id)).avatarKey!;
    const second = await upload(app, token, fileOfSize(PNG_HEADER, 300));
    expect(second.statusCode).toBe(200);

    // 失敗が記録される(retry_count が増え、deleted_at は設定されない)
    await expect
      .poll(
        async () => {
          const [row] = await testDb.db
            .select()
            .from(storageDeletions)
            .where(eq(storageDeletions.storageKey, oldKey));
          return row?.retryCount ?? 0;
        },
        { timeout: 5000 },
      )
      .toBeGreaterThanOrEqual(1);
    const [row] = await testDb.db
      .select()
      .from(storageDeletions)
      .where(eq(storageDeletions.storageKey, oldKey));
    expect(row!.deletedAt).toBeNull();
    expect(await storage.get(oldKey)).not.toBeNull(); // 実体は、まだある
  });
});

describe('GET /api/users/:userId/avatar(本人のみ。他のユーザーは、workspaces.test.ts で確認)', () => {
  it('共通のワークスペースのない他のユーザーのアバターは、存在しても 404', async () => {
    const app = makeApp();
    const a = await createUser(app);
    const b = await createUser(app);
    await upload(app, a.token, fileOfSize(PNG_HEADER, 100));
    expect((await getAvatar(app, a.token, a.id)).statusCode).toBe(200);
    expect((await getAvatar(app, b.token, a.id)).statusCode).toBe(404);
  });

  it('未設定・存在しない ID・形式の違う ID は、いずれも同じ 404', async () => {
    const app = makeApp();
    const { token, id } = await createUser(app);
    const responses = [
      await getAvatar(app, token, id), // 自分だが、未設定
      await getAvatar(app, token, randomUUID()),
      await getAvatar(app, token, 'not-a-uuid'),
      await getAvatar(app, token, '1 OR 1=1'),
    ];
    for (const res of responses) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ code: 'not_found', message: '見つかりません。' });
    }
  });

  it('ログインしていないと 401', async () => {
    const app = makeApp();
    const { id } = await createUser(app);
    expect((await getAvatar(app, undefined, id)).statusCode).toBe(401);
  });
});
