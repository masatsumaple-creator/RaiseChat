import type { FastifyRequest } from 'fastify';
import type { Db } from '../db/client';
import { AppError } from '../errors';
import { SESSION_COOKIE_NAME } from '../session-cookie';
import { findSessionUser, type SessionUser } from './sessions';

export interface AuthContext {
  user: SessionUser;
  /** 現在のセッションのトークンのハッシュ(ログアウトで、そのセッションだけを削除するため) */
  tokenHash: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** requireUser を通ったリクエストだけに、設定される */
    auth?: AuthContext;
  }
}

const unauthorized = () => new AppError(401, 'unauthorized', 'ログインが必要です。');

/**
 * ガード requireUser(設計書 §4.1): 有効なセッションがなければ 401。
 * リクエストのたびに、DB を引いて確認する(キャッシュしない)。
 */
export function requireUser(db: Db) {
  return async (request: FastifyRequest): Promise<void> => {
    const token = request.cookies[SESSION_COOKIE_NAME];
    if (!token) throw unauthorized();
    const found = await findSessionUser(db, token);
    if (!found) throw unauthorized();
    request.auth = { user: found.user, tokenHash: found.tokenHash };
  };
}

/** requireUser を通った後のハンドラで、認証済みのユーザーを取り出す */
export function authOf(request: FastifyRequest): AuthContext {
  if (!request.auth) throw unauthorized();
  return request.auth;
}
