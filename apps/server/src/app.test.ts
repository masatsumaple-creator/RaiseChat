import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app';
import { loadConfig } from './config';
import { AppError, parseWith } from './errors';
import { RateLimiter, rateLimitGuard } from './rate-limit';
import { sessionCookieOptions } from './session-cookie';

const ORIGIN = 'http://localhost:5173';

const apps: FastifyInstance[] = [];

function makeApp(env: Record<string, string> = {}, logStream?: { write(m: string): void }) {
  const config = loadConfig({ ALLOWED_ORIGIN: ORIGIN, ...env });
  const app = buildApp({ config, logger: logStream ? undefined : false, logStream });
  apps.push(app);
  return { app, config };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('GET /health', () => {
  it('認証なしで、200 を返す', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('応答に、X-Content-Type-Options: nosniff が付く(404 にも)', async () => {
    const { app } = makeApp();
    const ok = await app.inject({ method: 'GET', url: '/health' });
    const notFound = await app.inject({ method: 'GET', url: '/nothing' });
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect(notFound.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('Origin の検証(CSRF 対策。設計書 §4.1)', () => {
  function appWithRoutes(env: Record<string, string> = {}) {
    const made = makeApp(env);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      made.app.route({ method, url: '/echo', handler: async () => ({ ok: true }) });
    }
    made.app.get('/echo', async () => ({ ok: true }));
    return made.app;
  }

  it('GET は、Origin がなくても通る', async () => {
    const app = appWithRoutes();
    const res = await app.inject({ method: 'GET', url: '/echo' });
    expect(res.statusCode).toBe(200);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)(
    '%s は、許可したオリジンなら通る',
    async (method) => {
      const app = appWithRoutes();
      const res = await app.inject({ method, url: '/echo', headers: { origin: ORIGIN } });
      expect(res.statusCode).toBe(200);
    },
  );

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)(
    '%s は、Origin ヘッダがないと 403(Referer などで代替しない)',
    async (method) => {
      const app = appWithRoutes();
      const res = await app.inject({
        method,
        url: '/echo',
        headers: { referer: `${ORIGIN}/page`, 'sec-fetch-site': 'same-origin' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({
        code: 'forbidden_origin',
        message: 'この操作は許可されていません。',
      });
    },
  );

  it.each([
    ['別のホスト', 'https://evil.example.com'],
    ['ポートが違う', 'http://localhost:3000'],
    ['スキームが違う', 'https://localhost:5173'],
    ['前方一致だけ', 'http://localhost:5173.evil.com'],
    ['null', 'null'],
    ['空', ''],
  ])('許可していないオリジン(%s)は 403', async (_name, origin) => {
    const app = appWithRoutes();
    const res = await app.inject({ method: 'POST', url: '/echo', headers: { origin } });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('forbidden_origin');
  });

  it('存在しないパスへの POST も、Origin がなければ 403(404 より先に判定する)', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'POST', url: '/nothing' });
    expect(res.statusCode).toBe(403);
  });

  it('複数のオリジンを許可できる', async () => {
    const app = appWithRoutes({ ALLOWED_ORIGIN: `${ORIGIN},https://chat.example.com` });
    const res = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { origin: 'https://chat.example.com' },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('エラー形式(設計書 §4.3)', () => {
  it('存在しないパスは、404 と、code・message だけの JSON', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'GET', url: '/nothing' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ code: 'not_found', message: '見つかりません。' });
  });

  it('AppError は、指定したステータスと code・message で返る', async () => {
    const { app } = makeApp();
    app.get('/teapot', async () => {
      throw new AppError(409, 'conflict', '競合しました。');
    });
    const res = await app.inject({ method: 'GET', url: '/teapot' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ code: 'conflict', message: '競合しました。' });
  });

  it('zod の検証に失敗すると 400。項目名は返すが、入力した値は返さない', async () => {
    const { app } = makeApp();
    const schema = z.object({ username: z.string().min(3), password: z.string().min(8) });
    app.post('/validate', async (request) => parseWith(schema, request.body));
    const res = await app.inject({
      method: 'POST',
      url: '/validate',
      headers: { origin: ORIGIN },
      payload: { username: 'ab', password: 'TopSecret1' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe('validation_error');
    expect(body.message).toContain('username');
    expect(JSON.stringify(body)).not.toContain('TopSecret1');
  });

  it('想定外のエラーは 500。詳細は、応答に出さない', async () => {
    const { app } = makeApp();
    app.get('/boom', async () => {
      throw new Error('connect ECONNREFUSED postgres://user:SuperSecret@db/raisechat');
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      code: 'internal_error',
      message: 'サーバーでエラーが起きました。',
    });
    expect(res.body).not.toContain('SuperSecret');
  });

  it('不正な JSON は 400。パーサーの内部の文面を返さない', async () => {
    const { app } = makeApp();
    app.post('/json', async (request) => request.body);
    const res = await app.inject({
      method: 'POST',
      url: '/json',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: '{"broken": ',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      code: 'bad_request',
      message: 'リクエストが正しくありません。',
    });
  });

  it('大きすぎる本文は 413', async () => {
    const { app } = makeApp();
    app.post('/json', async (request) => request.body);
    const res = await app.inject({
      method: 'POST',
      url: '/json',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ data: 'x'.repeat(2 * 1024 * 1024) }),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().code).toBe('payload_too_large');
  });
});

describe('レート制限', () => {
  function appWithLimit(limit: number, env: Record<string, string> = {}) {
    const made = makeApp(env);
    const limiter = new RateLimiter({ limit, windowMs: 60_000 });
    made.app.post(
      '/limited',
      { preHandler: rateLimitGuard(limiter, (request) => `ip:${request.ip}`) },
      async () => ({ ok: true }),
    );
    return made.app;
  }

  async function post(app: FastifyInstance, remoteAddress?: string) {
    return app.inject({
      method: 'POST',
      url: '/limited',
      headers: { origin: ORIGIN },
      remoteAddress,
    });
  }

  it('上限までは通り、超えると 429 と Retry-After', async () => {
    const app = appWithLimit(3);
    for (let i = 0; i < 3; i++) expect((await post(app)).statusCode).toBe(200);
    const res = await post(app);
    expect(res.statusCode).toBe(429);
    expect(res.json().code).toBe('rate_limited');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('接続元ごとに、別々に数える', async () => {
    const app = appWithLimit(1);
    expect((await post(app, '10.0.0.1')).statusCode).toBe(200);
    expect((await post(app, '10.0.0.1')).statusCode).toBe(429);
    expect((await post(app, '10.0.0.2')).statusCode).toBe(200);
  });
});

describe('trustProxy(設計書 §4.1)', () => {
  async function clientIp(app: FastifyInstance, remoteAddress: string, forwardedFor: string) {
    app.get('/ip', async (request) => ({ ip: request.ip }));
    const res = await app.inject({
      method: 'GET',
      url: '/ip',
      remoteAddress,
      headers: { 'x-forwarded-for': forwardedFor },
    });
    return res.json().ip as string;
  }

  it('信頼するプロキシが未設定なら、X-Forwarded-For を無視して、接続元を使う', async () => {
    const { app } = makeApp();
    expect(await clientIp(app, '203.0.113.5', '198.51.100.9')).toBe('203.0.113.5');
  });

  it('信頼するプロキシから届いたときだけ、X-Forwarded-For を使う', async () => {
    const { app } = makeApp({ TRUSTED_PROXIES: '10.0.0.1' });
    expect(await clientIp(app, '10.0.0.1', '198.51.100.9')).toBe('198.51.100.9');
  });

  it('信頼しない接続元からの X-Forwarded-For は、偽装として無視する', async () => {
    const { app } = makeApp({ TRUSTED_PROXIES: '10.0.0.1' });
    expect(await clientIp(app, '203.0.113.5', '198.51.100.9')).toBe('203.0.113.5');
  });
});

describe('Cookie(設計書 §4.1)', () => {
  it('リクエストの Cookie を読める', async () => {
    const { app } = makeApp();
    app.get('/whoami', async (request) => ({ value: request.cookies.sample }));
    const res = await app.inject({
      method: 'GET',
      url: '/whoami',
      headers: { cookie: 'sample=hello' },
    });
    expect(res.json()).toEqual({ value: 'hello' });
  });

  it('セッション Cookie は、HttpOnly と SameSite=Lax を持ち、開発では Secure を付けない', async () => {
    const { app, config } = makeApp();
    app.get('/set', async (_request, reply) => {
      void reply.setCookie('session', 'token', sessionCookieOptions(config));
      return { ok: true };
    });
    const res = await app.inject({ method: 'GET', url: '/set' });
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('Max-Age=2592000');
    expect(setCookie).not.toContain('Secure');
  });

  it('本番では、Secure も付く', async () => {
    const { app, config } = makeApp({ NODE_ENV: 'production' });
    app.get('/set', async (_request, reply) => {
      void reply.setCookie('session', 'token', sessionCookieOptions(config));
      return { ok: true };
    });
    const res = await app.inject({ method: 'GET', url: '/set' });
    expect(String(res.headers['set-cookie'])).toContain('Secure');
  });
});

describe('ログ', () => {
  it('Cookie と Authorization ヘッダの値は、ログに出ない', async () => {
    const lines: string[] = [];
    const { app } = makeApp({}, { write: (m) => void lines.push(m) });
    app.get('/log', async (request) => {
      request.log.info({ req: { headers: request.headers } }, 'headers');
      return { ok: true };
    });
    await app.inject({
      method: 'GET',
      url: '/log',
      headers: { cookie: 'session=SecretSessionToken', authorization: 'Bearer SecretBearer' },
    });
    const output = lines.join('');
    expect(output).toContain('headers');
    expect(output).not.toContain('SecretSessionToken');
    expect(output).not.toContain('SecretBearer');
  });
});
