import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { memberships } from '../db/schema';

/**
 * 2 人のユーザーが、同じワークスペースに、共に active で所属しているか(設計書 §5.1 のアバターの認可)。
 * どちらかが kicked の場合は、その分は数えない。
 */
export async function sharesActiveWorkspace(db: Db, a: string, b: string): Promise<boolean> {
  const mine = db
    .select({ workspaceId: memberships.workspaceId })
    .from(memberships)
    .where(and(eq(memberships.userId, a), eq(memberships.status, 'active')));
  const rows = await db
    .select({ one: sql<number>`1` })
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, b),
        eq(memberships.status, 'active'),
        sql`${memberships.workspaceId} IN (${mine})`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}
