import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ハッシュの検証が、ユーザーの有無によらず、1 回だけ行われることを確かめるため、呼び出しを数える
vi.mock('../auth/password', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth/password')>();
  return {
    ...actual,
    verifySecret: vi.fn(actual.verifySecret),
    verifyAgainstDummy: vi.fn(actual.verifyAgainstDummy),
  };
});

import { buildApp } from '../app';
import { verifyAgainstDummy, verifySecret } from '../auth/password';
import { loadConfig } from '../config';
import { sessions } from '../db/schema';
import { SESSION_COOKIE_NAME } from '../session-cookie';
import { createTestDatabase } from '../test/db';

const ORIGIN = 'http://localhost:5173';
const PASSWORD = 'correct-horse-battery';
const INVALID_BODY = {
  code: 'invalid_credentials',
  message: 'ユーザー名またはパスワードが正しくありません。',
};

let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
const apps: FastifyInstance[] = [];
let counter = 0;

beforeAll(async () => {
  testDb = await createTestDatabase();
});

afterAll(async () => {
  await testDb.close();
});

beforeEach(() => {
  vi.mocked(verifySecret).mockClear();
  vi.mocked(verifyAgainstDummy).mockClear();
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/** テストごとに、新しいアプリを作る(レート制限の記憶も、新しくなる) */
function makeApp() {
  const config = loadConfig({ ALLOWED_ORIGIN: ORIGIN });
  const app = buildApp({ config, db: testDb.db, logger: false });
  apps.push(app);
  return app;
}

function uniqueName(prefix = 'login') {
  counter += 1;
  return `${prefix}_${counter}`;
}

function post(
  app: FastifyInstance,
  url: string,
  body: unknown,
  options: { origin?: string | null; remoteAddress?: string; token?: string } = {},
) {
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  return app.inject({
    method: 'POST',
    url,
    headers: origin === null ? {} : { origin },
    payload: body as object,
    remoteAddress: options.remoteAddress,
    cookies: options.token ? { [SESSION_COOKIE_NAME]: options.token } : {},
  });
}

const login = (
  app: FastifyInstance,
  username: string,
  password: string,
  options?: Parameters<typeof post>[3],
) => post(app, '/api/auth/login', { username, password }, options);

/** ユーザーを登録する(別の IP から、登録のレート制限を避けて) */
async function createUser(app: FastifyInstance, username = uniqueName()) {
  const res = await post(
    app,
    '/api/auth/register',
    { username, password: PASSWORD },
    { remoteAddress: `10.200.${Math.floor(counter / 250)}.${counter % 250}` },
  );
  expect(res.statusCode).toBe(201);
  return { username, token: tokenOf(res) };
}

function tokenOf(res: { cookies: { name: string; value: string }[] }) {
  return res.cookies.find((c) => c.name === SESSION_COOKIE_NAME)!.value;
}

function me(app: FastifyInstance, token: string) {
  return app.inject({ method: 'GET', url: '/api/me', cookies: { [SESSION_COOKIE_NAME]: token } });
}

describe('POST /api/auth/login(FR-002)', () => {
  it('正しいユーザー名とパスワードで、ログインでき、Cookie で GET /me が通る', async () => {
    const app = makeApp();
    const { username } = await createUser(app);

    const res = await login(app, username, PASSWORD);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ username, displayName: username });
    expect(res.headers['cache-control']).toBe('no-store');

    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect((await me(app, tokenOf(res))).json().username).toBe(username);
  });

  it('ユーザー名の大文字小文字は、区別しない', async () => {
    const app = makeApp();
    const { username } = await createUser(app, uniqueName('Mixed'));
    for (const variant of [username.toLowerCase(), username.toUpperCase()]) {
      expect((await login(app, variant, PASSWORD)).statusCode, variant).toBe(200);
    }
  });

  it('ログインのたびに、新しいセッションができ、以前のセッションも有効なまま(複数の端末)', async () => {
    const app = makeApp();
    const { username, token: first } = await createUser(app);
    const second = tokenOf(await login(app, username, PASSWORD));
    const third = tokenOf(await login(app, username, PASSWORD));

    expect(new Set([first, second, third]).size).toBe(3);
    for (const token of [first, second, third]) {
      expect((await me(app, token)).statusCode).toBe(200);
    }
  });

  it('パスワードが違う場合と、ユーザーが存在しない場合は、まったく同じ応答(401)', async () => {
    const app = makeApp();
    const { username } = await createUser(app);

    const wrongPassword = await login(app, username, 'wrong-password-123');
    const unknownUser = await login(app, uniqueName('nobody'), PASSWORD);

    for (const res of [wrongPassword, unknownUser]) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual(INVALID_BODY);
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    expect(wrongPassword.body).toBe(unknownUser.body);
  });

  it('形式に合わないユーザー名・パスワードでも、検証エラーではなく、同じ 401', async () => {
    const app = makeApp();
    for (const [username, password] of [
      ['ab', 'x'],
      ['ひらがな', 'パスワード'],
      ['with space', ' '],
      ["' OR 1=1 --", "' OR 1=1 --"],
    ] as const) {
      const res = await login(app, username, password);
      expect(res.statusCode, username).toBe(401);
      expect(res.json()).toEqual(INVALID_BODY);
    }
  });

  it('本文がない・空・長すぎる場合は 400(ハッシュ計算とキーの大きさを抑える)', async () => {
    const app = makeApp();
    expect((await post(app, '/api/auth/login', {})).statusCode).toBe(400);
    expect((await login(app, '', PASSWORD)).statusCode).toBe(400);
    expect((await login(app, 'someone', '')).statusCode).toBe(400);
    expect((await login(app, 'a'.repeat(65), PASSWORD)).statusCode).toBe(400);
    expect((await login(app, 'someone', 'a'.repeat(257))).statusCode).toBe(400);
    expect(
      (await post(app, '/api/auth/login', { username: 'someone', password: 12345678 })).statusCode,
    ).toBe(400);
  });

  it('Origin がないと 403(CSRF 対策)', async () => {
    const app = makeApp();
    const { username } = await createUser(app);
    const res = await login(app, username, PASSWORD, { origin: null });
    expect(res.statusCode).toBe(403);
  });

  it('ハッシュの検証は、ユーザーの有無によらず、1 回だけ行われる(処理時間で、ユーザーの有無が分からない)', async () => {
    const app = makeApp();
    const { username } = await createUser(app);
    vi.mocked(verifySecret).mockClear();
    vi.mocked(verifyAgainstDummy).mockClear();

    // 存在するユーザー(パスワード違い): 本物のハッシュで 1 回
    await login(app, username, 'wrong-password-123');
    expect(verifySecret).toHaveBeenCalledTimes(1);
    expect(verifyAgainstDummy).not.toHaveBeenCalled();

    vi.mocked(verifySecret).mockClear();

    // 存在しないユーザー: ダミーのハッシュで 1 回(本物のハッシュは、検証しない)
    await login(app, uniqueName('ghost'), 'wrong-password-123');
    expect(verifyAgainstDummy).toHaveBeenCalledTimes(1);
    expect(verifySecret).not.toHaveBeenCalled();
  });

  it('存在しないユーザーへの試行は、実際に時間がかかる(ダミーの検証が、省かれていない)', async () => {
    const app = makeApp();
    const { username } = await createUser(app);
    await login(app, uniqueName('warm'), PASSWORD); // ダミーのハッシュを、先に作っておく

    const time = async (name: string) => {
      const start = performance.now();
      await login(app, name, 'wrong-password-123', { remoteAddress: `10.77.0.${++counter % 250}` });
      return performance.now() - start;
    };
    const known = await time(username);
    const unknown = await time(uniqueName('ghost'));
    // ハッシュ計算を省くと、数 ms で返る。計算していれば、同じ桁の時間になる(厳密な比較は、ゆらぎで不安定なので、緩く)
    expect(unknown).toBeGreaterThan(known / 5);
  });
});

describe('ログインのレート制限(設計書 §4.1)', () => {
  it('同じ接続元とユーザー名の組で、5 回失敗すると、6 回目は 429(正しいパスワードでも)', async () => {
    const app = makeApp();
    const { username } = await createUser(app);
    for (let i = 0; i < 5; i++) {
      expect((await login(app, username, 'wrong-password-123')).statusCode).toBe(401);
    }
    const blocked = await login(app, username, PASSWORD);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().code).toBe('rate_limited');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('制限は、組ごと: 別のユーザー名・別の接続元は、影響を受けない(第三者に、対象をロックされない)', async () => {
    const app = makeApp();
    const target = await createUser(app);
    const bystander = await createUser(app);
    for (let i = 0; i < 5; i++) await login(app, target.username, 'wrong-password-123');
    expect((await login(app, target.username, PASSWORD)).statusCode).toBe(429);

    // 同じ接続元の、別のユーザー
    expect((await login(app, bystander.username, PASSWORD)).statusCode).toBe(200);
    // 別の接続元から、同じユーザー(攻撃者の失敗が、本人のログインを妨げない)
    const fromElsewhere = await login(app, target.username, PASSWORD, {
      remoteAddress: '10.55.0.1',
    });
    expect(fromElsewhere.statusCode).toBe(200);
  });

  it('成功すると、その組の失敗の回数は、数え直しになる', async () => {
    const app = makeApp();
    const { username } = await createUser(app);
    for (let i = 0; i < 4; i++) await login(app, username, 'wrong-password-123');
    expect((await login(app, username, PASSWORD)).statusCode).toBe(200);
    // 成功の後は、また 5 回まで失敗できる
    for (let i = 0; i < 5; i++) {
      expect((await login(app, username, 'wrong-password-123')).statusCode).toBe(401);
    }
    expect((await login(app, username, 'wrong-password-123')).statusCode).toBe(429);
  });

  it('ユーザー名の大文字小文字を変えても、同じ組として数える', async () => {
    const app = makeApp();
    const { username } = await createUser(app, uniqueName('CaseKey'));
    for (let i = 0; i < 5; i++) {
      const variant = i % 2 === 0 ? username.toUpperCase() : username.toLowerCase();
      await login(app, variant, 'wrong-password-123');
    }
    expect((await login(app, username, PASSWORD)).statusCode).toBe(429);
  });

  it('同時に送られた推測も、上限を超えて評価されない(5 回だけ評価され、残りは 429)', async () => {
    const app = makeApp();
    const { username } = await createUser(app);
    vi.mocked(verifySecret).mockClear();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => login(app, username, 'wrong-password-123')),
    );
    const statuses = results.map((r) => r.statusCode);
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(7);
    expect(verifySecret).toHaveBeenCalledTimes(5);
  });

  it('同じ接続元からは、ユーザー名を変えても、15 分に 30 回まで(31 回目は 429)', async () => {
    const app = makeApp();
    const { username } = await createUser(app);
    for (let i = 0; i < 30; i++) {
      const res = await login(app, uniqueName('spray'), 'wrong-password-123');
      expect(res.statusCode).toBe(401);
    }
    const blocked = await login(app, username, PASSWORD);
    expect(blocked.statusCode).toBe(429);
    // 別の接続元は、影響を受けない
    expect((await login(app, username, PASSWORD, { remoteAddress: '10.56.0.1' })).statusCode).toBe(
      200,
    );
  });
});

describe('POST /api/auth/logout(FR-003)', () => {
  it('現在のセッションを削除し、Cookie を消す(204)。その後、同じ Cookie では 401', async () => {
    const app = makeApp();
    const { token } = await createUser(app);
    const hash = createHash('sha256').update(token).digest('hex');

    const res = await post(app, '/api/auth/logout', {}, { token });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');

    // Cookie を消す指示(空の値、または、過去の期限)
    const cleared = res.cookies.find((c) => c.name === SESSION_COOKIE_NAME);
    expect(cleared).toBeDefined();
    expect(cleared!.value).toBe('');

    const rows = await testDb.db.select().from(sessions).where(eq(sessions.tokenHash, hash));
    expect(rows).toHaveLength(0);
    expect((await me(app, token)).statusCode).toBe(401);
  });

  it('他のセッション(別の端末)は、そのまま有効', async () => {
    const app = makeApp();
    const { username, token: laptop } = await createUser(app);
    const phone = tokenOf(await login(app, username, PASSWORD));

    expect((await post(app, '/api/auth/logout', {}, { token: laptop })).statusCode).toBe(204);
    expect((await me(app, laptop)).statusCode).toBe(401);
    expect((await me(app, phone)).statusCode).toBe(200);
  });

  it('他のユーザーのセッションには、影響しない', async () => {
    const app = makeApp();
    const a = await createUser(app);
    const b = await createUser(app);
    await post(app, '/api/auth/logout', {}, { token: a.token });
    expect((await me(app, b.token)).statusCode).toBe(200);
  });

  it('ログインしていない(Cookie がない・無効)と 401', async () => {
    const app = makeApp();
    expect((await post(app, '/api/auth/logout', {})).statusCode).toBe(401);
    expect((await post(app, '/api/auth/logout', {}, { token: 'garbage' })).statusCode).toBe(401);
  });

  it('2 回続けてログアウトしても、2 回目は 401(セッションは、もうない)', async () => {
    const app = makeApp();
    const { token } = await createUser(app);
    expect((await post(app, '/api/auth/logout', {}, { token })).statusCode).toBe(204);
    expect((await post(app, '/api/auth/logout', {}, { token })).statusCode).toBe(401);
  });

  it('Origin がないと 403。セッションは、削除されない', async () => {
    const app = makeApp();
    const { token } = await createUser(app);
    const res = await post(app, '/api/auth/logout', {}, { token, origin: null });
    expect(res.statusCode).toBe(403);
    expect((await me(app, token)).statusCode).toBe(200);
  });

  it('ログアウト後に、再びログインできる', async () => {
    const app = makeApp();
    const { username, token } = await createUser(app);
    await post(app, '/api/auth/logout', {}, { token });
    const res = await login(app, username, PASSWORD);
    expect(res.statusCode).toBe(200);
    expect((await me(app, tokenOf(res))).statusCode).toBe(200);
  });
});
