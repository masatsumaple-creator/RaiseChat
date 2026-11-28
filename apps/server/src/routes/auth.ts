import type { MeResponse, RegisterResponse } from '@raisechat/shared';
import { loginRequestSchema, registerRequestSchema } from '@raisechat/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { sessions, users } from '../db/schema';
import { authOf, requireUser } from '../auth/guards';
import { hashSecret, verifyAgainstDummy, verifySecret } from '../auth/password';
import { createSession, type SessionUser } from '../auth/sessions';
import { avatarUrlFor } from '../profile/avatar';
import { generateRecoveryCode, normalizeRecoveryCode } from '../auth/tokens';
import { isUniqueViolation } from '../db/errors';
import { AppError, parseWith } from '../errors';
import type { Realtime } from '../realtime/realtime';
import { rateLimitedError, rateLimitGuard, type RateLimiter } from '../rate-limit';
import { SESSION_COOKIE_NAME, sessionCookieOptions } from '../session-cookie';

export interface AuthRouteDeps {
  db: Db;
  config: Config;
  realtime: Realtime;
  /** 登録の試行を、接続元ごとに制限する(設計書 §4.1) */
  registerLimiter: RateLimiter;
  /** ログインの試行を、接続元とユーザー名の組ごとに制限する(設計書 §4.1)。成功すると、組の記憶を消す */
  loginPairLimiter: RateLimiter;
  /** ログインの試行を、接続元ごとに制限する(ユーザー名を変えながらの総当たりを防ぐ) */
  loginIpLimiter: RateLimiter;
}

/** ログインの失敗は、ユーザー名の有無・パスワードの違いを問わず、同じ応答にする(FR-002) */
const invalidCredentials = () =>
  new AppError(401, 'invalid_credentials', 'ユーザー名またはパスワードが正しくありません。');

/** 自分のプロフィールの、応答の形。パスワードやリカバリーコードのハッシュは、含めない */
export function toMe(user: SessionUser): MeResponse {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    statusText: user.statusText,
    avatarUrl: avatarUrlFor(user.id, user.avatarKey),
  };
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const { db, config } = deps;

  // 認証に関わる応答は、キャッシュさせない(リカバリーコードを含むため)
  app.addHook('onSend', async (request, reply) => {
    if (request.url.startsWith('/api/auth/') || request.url === '/api/me') {
      void reply.header('cache-control', 'no-store');
    }
  });

  // FR-001: 登録。そのままログイン状態になり、リカバリーコードを一度だけ返す
  app.post(
    '/api/auth/register',
    { preHandler: rateLimitGuard(deps.registerLimiter, (request) => `register:${request.ip}`) },
    async (request, reply) => {
      const { username, password } = parseWith(registerRequestSchema, request.body);

      const recoveryCode = generateRecoveryCode();
      const [passwordHash, recoveryCodeHash] = await Promise.all([
        hashSecret(password),
        hashSecret(normalizeRecoveryCode(recoveryCode)),
      ]);

      let user: SessionUser;
      try {
        const [created] = await db
          .insert(users)
          // 表示名の既定は、ユーザー名(プロフィールで変更できる。FR-004)
          .values({ username, passwordHash, recoveryCodeHash, displayName: username })
          .returning();
        user = created!;
      } catch (error) {
        // ユーザー名は、大文字小文字を区別せず一意(同時に登録されたときも、DB の制約で防ぐ)
        if (isUniqueViolation(error)) {
          throw new AppError(409, 'username_taken', 'このユーザー名は、すでに使われています。');
        }
        throw error;
      }

      const token = await createSession(db, user.id);
      void reply.setCookie(SESSION_COOKIE_NAME, token, sessionCookieOptions(config));

      const body: RegisterResponse = { user: toMe(user), recoveryCode };
      return reply.status(201).send(body);
    },
  );

  // FR-002: ログイン
  app.post('/api/auth/login', async (request, reply) => {
    const { username, password } = parseWith(loginRequestSchema, request.body);

    // 試行は、パスワードを確かめる前に数える(同時に送られた推測で、上限を超えられないように)。
    // 組のキーは、成功すると消す。接続元のキーは、成功しても消さない(成功を挟んで、数え直されないように)。
    const pairKey = `login:${request.ip}:${username.toLowerCase()}`;
    const ipKey = `login-ip:${request.ip}`;
    if (!deps.loginIpLimiter.consume(ipKey)) {
      throw rateLimitedError(deps.loginIpLimiter.retryAfterSeconds(ipKey));
    }
    if (!deps.loginPairLimiter.consume(pairKey)) {
      throw rateLimitedError(deps.loginPairLimiter.retryAfterSeconds(pairKey));
    }

    // ユーザー名は、大文字小文字を区別しない(登録時の一意性と同じ)
    const [user] = await db
      .select()
      .from(users)
      .where(eq(sql`lower(${users.username})`, username.toLowerCase()))
      .limit(1);

    // 存在しないユーザーでも、ハッシュの検証を 1 回行い、処理時間でユーザーの有無が分からないようにする
    const ok = user
      ? await verifySecret(user.passwordHash, password)
      : await verifyAgainstDummy(password);
    if (!user || !ok) throw invalidCredentials();

    deps.loginPairLimiter.reset(pairKey);
    const token = await createSession(db, user.id);
    void reply.setCookie(SESSION_COOKIE_NAME, token, sessionCookieOptions(config));
    return toMe(user);
  });

  // FR-003: ログアウト。現在のセッションだけを削除する(他の端末のセッションは、そのまま)
  app.post('/api/auth/logout', { preHandler: requireUser(db) }, async (request, reply) => {
    await db.delete(sessions).where(eq(sessions.tokenHash, authOf(request).tokenHash));
    // そのセッションのソケットだけを切断する(他の端末のセッションの接続は、そのまま)
    deps.realtime.disconnectSession(authOf(request).tokenHash);
    void reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    return reply.status(204).send();
  });

  // 自分のプロフィール(FR-004 の取得側)
  app.get('/api/me', { preHandler: requireUser(db) }, async (request): Promise<MeResponse> => {
    return toMe(authOf(request).user);
  });
}
