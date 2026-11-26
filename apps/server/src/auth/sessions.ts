import { and, eq, gt } from 'drizzle-orm';
import type { Db } from '../db/client';
import { sessions, users } from '../db/schema';
import { SESSION_MAX_AGE_SECONDS } from '../session-cookie';
import { generateSessionToken, hashToken } from './tokens';

/** セッションを作る。トークン(Cookie に入れる値)を返す。DB には、ハッシュだけを保存する */
export async function createSession(
  db: Db,
  userId: string,
  now: Date = new Date(),
): Promise<string> {
  const token = generateSessionToken();
  await db.insert(sessions).values({
    tokenHash: hashToken(token),
    userId,
    // 30 日の固定期限。アクセスのたびに延長しない(設計書 §6 の D1)
    expiresAt: new Date(now.getTime() + SESSION_MAX_AGE_SECONDS * 1000),
  });
  return token;
}

export type SessionUser = typeof users.$inferSelect;

/**
 * トークンから、有効なセッションのユーザーを探す。見つからない・期限切れなら null。
 * 期限切れの行は、見つけたときに削除する(溜まり続けないように)。
 */
export async function findSessionUser(
  db: Db,
  token: string,
  now: Date = new Date(),
): Promise<{ user: SessionUser; tokenHash: string } | null> {
  const tokenHash = hashToken(token);
  const [row] = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now)))
    .limit(1);
  if (row) return { user: row.user, tokenHash };

  await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
  return null;
}
