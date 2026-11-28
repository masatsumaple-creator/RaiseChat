import type { UserUpdatedPayload } from '@raisechat/shared';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { memberships } from '../db/schema';
import { avatarUrlFor } from '../profile/avatar';
import { wsRoom, type Realtime } from './realtime';

/**
 * 表示名・アバター・ステータスの変更を、その人が active で所属する、全ワークスペースの ws ルームへ知らせる
 * (user:updated。設計書 §6.4)。所属するワークスペースがなければ、送り先がないので、何もしない。
 */
export async function notifyUserUpdated(
  db: Db,
  realtime: Realtime,
  user: {
    id: string;
    username: string;
    displayName: string;
    statusText: string;
    avatarKey: string | null;
  },
): Promise<void> {
  const rows = await db
    .select({ workspaceId: memberships.workspaceId })
    .from(memberships)
    .where(and(eq(memberships.userId, user.id), eq(memberships.status, 'active')));
  if (rows.length === 0) return;
  const payload: UserUpdatedPayload = {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    statusText: user.statusText,
    avatarUrl: avatarUrlFor(user.id, user.avatarKey),
  };
  realtime.emit(
    rows.map((r) => wsRoom(r.workspaceId)),
    'user:updated',
    payload,
  );
}
