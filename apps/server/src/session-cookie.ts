import type { CookieSerializeOptions } from '@fastify/cookie';
import type { Config } from './config';

/** セッション Cookie の名前(T5 で使う) */
export const SESSION_COOKIE_NAME = 'raisechat_session';

/** セッションの有効期限(30 日の固定期限。設計書 §6 の D1) */
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * セッション Cookie の属性(設計書 §4.1: HttpOnly、Secure、SameSite=Lax)。
 * Secure は、本番だけ付ける(開発は、http://localhost のため)。
 */
export function sessionCookieOptions(config: Pick<Config, 'isProduction'>): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}
