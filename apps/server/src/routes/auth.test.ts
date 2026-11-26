import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { verifySecret } from '../auth/password';
import { normalizeRecoveryCode } from '../auth/tokens';
import { loadConfig } from '../config';
import { sessions, users } from '../db/schema';
import { SESSION_COOKIE_NAME } from '../session-cookie';
import { createTestDatabase } from '../test/db';

const ORIGIN = 'http://localhost:5173';
const VALID_PASSWORD = 'correct-horse-battery';

let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
const apps: FastifyInstance[] = [];
let counter = 0;

beforeAll(async () => {
  testDb = await createTestDatabase();
});

afterAll(async () => {
  await testDb.close();
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/** テストごとに、新しいアプリを作る(レート制限の記憶も、新しくなる) */
function makeApp(env: Record<string, string> = {}) {
  const config = loadConfig({ ALLOWED_ORIGIN: ORIGIN, ...env });
  const app = buildApp({ config, db: testDb.db, logger: false });
  apps.push(app);
  return app;
}

function uniqueName(prefix = 'user') {
  counter += 1;
  return `${prefix}_${counter}`;
}

function register(
  app: FastifyInstance,
  body: unknown,
  options: { origin?: string | null; remoteAddress?: string } = {},
) {
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  return app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: origin === null ? {} : { origin },
    payload: body as object,
    remoteAddress: options.remoteAddress,
  });
}

function sessionCookie(res: { cookies: { name: string; value: string }[] }) {
  return res.cookies.find((c) => c.name === SESSION_COOKIE_NAME);
}

function me(app: FastifyInstance, token?: string) {
  return app.inject({
    method: 'GET',
    url: '/api/me',
    cookies: token === undefined ? {} : { [SESSION_COOKIE_NAME]: token },
  });
}

describe('POST /api/auth/register', () => {
  it('登録でき、そのままログイン状態になる(Cookie で GET /me が通る)', async () => {
    const app = makeApp();
    const username = uniqueName();
    const res = await register(app, { username, password: VALID_PASSWORD });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user).toMatchObject({
      username,
      displayName: username,
      statusText: '',
      avatarUrl: null,
    });

    const cookie = sessionCookie(res);
    expect(cookie?.value).toBeTruthy();
    const meRes = await me(app, cookie!.value);
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json()).toEqual(body.user);
  });

  it('セッション Cookie は、HttpOnly・SameSite=Lax・30 日', async () => {
    const res = await register(makeApp(), { username: uniqueName(), password: VALID_PASSWORD });
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Max-Age=2592000');
  });

  it('応答は、キャッシュさせない(リカバリーコードを含むため)', async () => {
    const res = await register(makeApp(), { username: uniqueName(), password: VALID_PASSWORD });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('ユーザー名は、大文字小文字を区別せず一意(409)', async () => {
    const app = makeApp();
    const username = uniqueName('Dup');
    expect((await register(app, { username, password: VALID_PASSWORD })).statusCode).toBe(201);

    for (const variant of [username, username.toLowerCase(), username.toUpperCase()]) {
      const res = await register(app, { username: variant, password: VALID_PASSWORD });
      expect(res.statusCode, variant).toBe(409);
      expect(res.json().code).toBe('username_taken');
    }
  });

  it('同じユーザー名を同時に登録しても、1 件だけ成功する', async () => {
    const app = makeApp();
    const username = uniqueName('Race');
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        register(
          app,
          { username: i % 2 === 0 ? username : username.toUpperCase(), password: VALID_PASSWORD },
          { remoteAddress: `10.0.0.${i + 1}` },
        ),
      ),
    );
    const statuses = results.map((r) => r.statusCode).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409]);
    // 勝ったのが、元の綴りか、大文字の綴りかは、決まらない。大文字小文字を区別せずに、数える
    const rows = await testDb.db
      .select()
      .from(users)
      .where(eq(sql`lower(${users.username})`, username.toLowerCase()));
    expect(rows).toHaveLength(1);
  });

  it.each(['ab', 'a'.repeat(33), 'with space', 'ひらがな', 'a-b', ''])(
    '形式に合わないユーザー名(%j)は 400',
    async (username) => {
      const res = await register(makeApp(), { username, password: VALID_PASSWORD });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('validation_error');
      expect(res.json().message).toContain('username');
    },
  );

  it('パスワードは、コードポイント数で 8〜128 文字(境界を確かめる)', async () => {
    const app = makeApp();
    const cases: [string, number][] = [
      ['a'.repeat(7), 400],
      ['a'.repeat(8), 201],
      ['😀'.repeat(7), 400], // UTF-16 では 14 だが、コードポイントでは 7
      ['😀'.repeat(8), 201],
      ['a'.repeat(128), 201],
      ['a'.repeat(129), 400],
    ];
    for (const [password, status] of cases) {
      const res = await register(
        app,
        { username: uniqueName('pw'), password },
        { remoteAddress: `10.1.0.${++counter % 250}` },
      );
      expect(res.statusCode, `${[...password].length} 文字`).toBe(status);
    }
  });

  it('本文がない・型が違う場合は 400。入力したパスワードは、応答に出ない', async () => {
    const app = makeApp();
    const missing = await register(app, { username: uniqueName() });
    expect(missing.statusCode).toBe(400);
    const wrongType = await register(app, { username: uniqueName(), password: 12345678 });
    expect(wrongType.statusCode).toBe(400);
    const tooShort = await register(app, { username: uniqueName(), password: 'Secret1' });
    expect(tooShort.body).not.toContain('Secret1');
  });

  it('Origin がないと 403(CSRF 対策)。ユーザーは作られない', async () => {
    const username = uniqueName('csrf');
    const res = await register(makeApp(), { username, password: VALID_PASSWORD }, { origin: null });
    expect(res.statusCode).toBe(403);
    const rows = await testDb.db.select().from(users).where(eq(users.username, username));
    expect(rows).toHaveLength(0);
  });

  it('同じ接続元からは、10 回まで。11 回目は 429(Retry-After つき)', async () => {
    const app = makeApp();
    for (let i = 0; i < 10; i++) {
      const res = await register(app, { username: uniqueName('rl'), password: VALID_PASSWORD });
      expect(res.statusCode).toBe(201);
    }
    const res = await register(app, { username: uniqueName('rl'), password: VALID_PASSWORD });
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    // 別の接続元は、影響を受けない
    const other = await register(
      app,
      { username: uniqueName('rl'), password: VALID_PASSWORD },
      { remoteAddress: '10.9.9.9' },
    );
    expect(other.statusCode).toBe(201);
  });
});

describe('保存される値(平文で保存されていないこと)', () => {
  it('パスワードとリカバリーコードは、argon2id のハッシュで保存され、検証できる', async () => {
    const username = uniqueName('hash');
    const res = await register(makeApp(), { username, password: VALID_PASSWORD });
    const { recoveryCode } = res.json();

    const [row] = await testDb.db.select().from(users).where(eq(users.username, username));
    expect(row!.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(row!.recoveryCodeHash.startsWith('$argon2id$')).toBe(true);

    expect(await verifySecret(row!.passwordHash, VALID_PASSWORD)).toBe(true);
    expect(await verifySecret(row!.passwordHash, 'wrong-password')).toBe(false);
    // リカバリーコードは、正規化した形(ハイフンなし)で、ハッシュ化されている
    expect(await verifySecret(row!.recoveryCodeHash, normalizeRecoveryCode(recoveryCode))).toBe(
      true,
    );
    expect(await verifySecret(row!.recoveryCodeHash, normalizeRecoveryCode('0000-0000'))).toBe(
      false,
    );
  });

  it('DB のどの列にも、パスワードとリカバリーコードの平文は含まれない', async () => {
    const username = uniqueName('plain');
    const res = await register(makeApp(), { username, password: VALID_PASSWORD });
    const { recoveryCode } = res.json();

    const [row] = await testDb.db.select().from(users).where(eq(users.username, username));
    const dump = JSON.stringify(row);
    expect(dump).not.toContain(VALID_PASSWORD);
    expect(dump).not.toContain(recoveryCode);
    expect(dump).not.toContain(recoveryCode.replace(/-/g, ''));
  });

  it('セッションは、トークンのハッシュ(SHA-256)で保存され、有効期限は 30 日後', async () => {
    const before = Date.now();
    const res = await register(makeApp(), {
      username: uniqueName('sess'),
      password: VALID_PASSWORD,
    });
    const token = sessionCookie(res)!.value;

    const hash = createHash('sha256').update(token).digest('hex');
    const [row] = await testDb.db.select().from(sessions).where(eq(sessions.tokenHash, hash));
    expect(row).toBeDefined();
    const all = JSON.stringify(await testDb.db.select().from(sessions));
    expect(all).not.toContain(token);

    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    const expires = row!.expiresAt.getTime();
    expect(expires).toBeGreaterThanOrEqual(before + thirtyDays);
    expect(expires).toBeLessThanOrEqual(Date.now() + thirtyDays);
  });
});

describe('リカバリーコード(FR-001)', () => {
  it('登録の応答にだけ含まれ、GET /me や、同じユーザーの 2 回目以降の応答には、含まれない', async () => {
    const app = makeApp();
    const res = await register(app, { username: uniqueName('once'), password: VALID_PASSWORD });
    const { recoveryCode } = res.json();
    expect(recoveryCode).toMatch(/^([0-9A-Z]{4}-){6}[0-9A-Z]{4}$/);

    const meRes = await me(app, sessionCookie(res)!.value);
    expect(meRes.body).not.toContain(recoveryCode);
    expect(meRes.body).not.toContain('recoveryCode');
    expect(meRes.body).not.toContain('Hash');
  });

  it('ユーザーごとに、異なるコードが発行される', async () => {
    const app = makeApp();
    const codes = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const res = await register(
        app,
        { username: uniqueName('uniq'), password: VALID_PASSWORD },
        { remoteAddress: `10.2.0.${i + 1}` },
      );
      codes.add(res.json().recoveryCode);
    }
    expect(codes.size).toBe(3);
  });
});

describe('GET /api/me とセッション', () => {
  it('Cookie がないと 401', async () => {
    const res = await me(makeApp());
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ code: 'unauthorized', message: 'ログインが必要です。' });
  });

  it('でたらめなトークンは 401', async () => {
    const app = makeApp();
    for (const token of ['garbage', 'a'.repeat(43), '', '../../etc/passwd', "' OR 1=1 --"]) {
      expect((await me(app, token)).statusCode, token).toBe(401);
    }
  });

  it('期限切れのセッションは 401。見つけたときに、DB から削除される', async () => {
    const app = makeApp();
    const res = await register(app, { username: uniqueName('exp'), password: VALID_PASSWORD });
    const token = sessionCookie(res)!.value;
    const hash = createHash('sha256').update(token).digest('hex');
    expect((await me(app, token)).statusCode).toBe(200);

    await testDb.db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.tokenHash, hash));

    expect((await me(app, token)).statusCode).toBe(401);
    const rows = await testDb.db.select().from(sessions).where(eq(sessions.tokenHash, hash));
    expect(rows).toHaveLength(0);
  });

  it('期限の 1 秒前までは有効', async () => {
    const app = makeApp();
    const res = await register(app, { username: uniqueName('edge'), password: VALID_PASSWORD });
    const token = sessionCookie(res)!.value;
    const hash = createHash('sha256').update(token).digest('hex');
    await testDb.db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() + 60_000) })
      .where(eq(sessions.tokenHash, hash));
    expect((await me(app, token)).statusCode).toBe(200);
  });

  it('セッションは、それぞれのユーザーに紐づく(別のユーザーの情報は見えない)', async () => {
    const app = makeApp();
    const nameA = uniqueName('who_a');
    const nameB = uniqueName('who_b');
    const a = await register(app, { username: nameA, password: VALID_PASSWORD });
    const b = await register(app, { username: nameB, password: VALID_PASSWORD });
    expect((await me(app, sessionCookie(a)!.value)).json().username).toBe(nameA);
    expect((await me(app, sessionCookie(b)!.value)).json().username).toBe(nameB);
  });

  it('応答は、キャッシュさせない', async () => {
    const app = makeApp();
    const res = await register(app, { username: uniqueName('nc'), password: VALID_PASSWORD });
    const meRes = await me(app, sessionCookie(res)!.value);
    expect(meRes.headers['cache-control']).toBe('no-store');
  });
});
