import type { MeResponse, RegisterResponse } from '@raisechat/shared';
import { registerRequestSchema } from '@raisechat/shared';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { users } from '../db/schema';
import { authOf, requireUser } from '../auth/guards';
import { hashSecret } from '../auth/password';
import { createSession, type SessionUser } from '../auth/sessions';
import { generateRecoveryCode, normalizeRecoveryCode } from '../auth/tokens';
import { AppError, parseWith } from '../errors';
import { rateLimitGuard, type RateLimiter } from '../rate-limit';
import { SESSION_COOKIE_NAME, sessionCookieOptions } from '../session-cookie';

export interface AuthRouteDeps {
  db: Db;
  config: Config;
  /** 登録の試行を、接続元ごとに制限する(設計書 §4.1) */
  registerLimiter: RateLimiter;
}

/** 自分のプロフィールの、応答の形。パスワードやリカバリーコードのハッシュは、含めない */
export function toMe(user: SessionUser): MeResponse {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    statusText: user.statusText,
    avatarUrl: user.avatarKey ? `/api/users/${user.id}/avatar` : null,
  };
}

/** PostgreSQL の一意制約違反(23505)か。Drizzle はドライバのエラーを cause に包む */
function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } };
  return (e.cause?.code ?? e.code) === '23505';
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

  // 自分のプロフィール(FR-004 の取得側)
  app.get('/api/me', { preHandler: requireUser(db) }, async (request): Promise<MeResponse> => {
    return toMe(authOf(request).user);
  });
}
