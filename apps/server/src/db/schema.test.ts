import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestDatabase } from '../test/db';
import { memberships, storageDeletions, users, workspaces } from './schema';

let testDb: Awaited<ReturnType<typeof createTestDatabase>>;

beforeAll(async () => {
  testDb = await createTestDatabase();
});

afterAll(async () => {
  await testDb.close();
});

function newUser(username: string) {
  return {
    username,
    passwordHash: 'hash',
    recoveryCodeHash: 'hash',
    displayName: username,
  };
}

/** 制約違反は、ドライバのエラーに包まれて届くため、原因の SQLSTATE を取り出す */
async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (e) {
    const err = e as { code?: string; cause?: { code?: string } };
    return err.cause?.code ?? err.code;
  }
  return undefined;
}

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

describe('マイグレーション', () => {
  it('空の DB に適用でき、フェーズ 1 のテーブルができる', async () => {
    const rows = await testDb.db.execute<{ table_name: string }>(
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const names = rows.map((r) => r.table_name);
    expect(names).toEqual(
      expect.arrayContaining([
        'users',
        'sessions',
        'workspaces',
        'memberships',
        'storage_deletions',
      ]),
    );
  });
});

describe('users の制約', () => {
  it('ユーザー名は、大文字小文字を区別せず一意', async () => {
    await testDb.db.insert(users).values(newUser('Alice'));
    const state = await sqlState(testDb.db.insert(users).values(newUser('aLICE')));
    expect(state).toBe(UNIQUE_VIOLATION);
  });

  it('ユーザー名の形式(半角英数字とアンダースコア、3〜32 文字)を満たさないと拒否される', async () => {
    for (const bad of ['ab', 'a'.repeat(33), 'with space', 'ひらがな', 'a-b-c']) {
      const state = await sqlState(testDb.db.insert(users).values(newUser(bad)));
      expect(state, bad).toBe(CHECK_VIOLATION);
    }
    await testDb.db.insert(users).values(newUser('a_1'));
    await testDb.db.insert(users).values(newUser('b'.repeat(32)));
  });

  it('表示名とステータスの長さを、コードポイント数で検証する', async () => {
    // 絵文字 50 個は、UTF-16 では 100 だが、コードポイントでは 50 なので通る
    await testDb.db.insert(users).values({ ...newUser('emoji50'), displayName: '😀'.repeat(50) });
    const tooLong = await sqlState(
      testDb.db.insert(users).values({ ...newUser('emoji51'), displayName: '😀'.repeat(51) }),
    );
    expect(tooLong).toBe(CHECK_VIOLATION);
    const empty = await sqlState(
      testDb.db.insert(users).values({ ...newUser('emptyname'), displayName: '' }),
    );
    expect(empty).toBe(CHECK_VIOLATION);
  });
});

describe('memberships の制約', () => {
  async function setup(prefix: string) {
    const [owner] = await testDb.db
      .insert(users)
      .values(newUser(`${prefix}_owner`))
      .returning();
    const [member] = await testDb.db
      .insert(users)
      .values(newUser(`${prefix}_member`))
      .returning();
    const [ws] = await testDb.db
      .insert(workspaces)
      .values({ name: 'ws', ownerId: owner!.id })
      .returning();
    await testDb.db
      .insert(memberships)
      .values({ workspaceId: ws!.id, userId: owner!.id, role: 'owner' });
    return { owner: owner!, member: member!, ws: ws! };
  }

  it('オーナーは、ワークスペースごとに 1 人', async () => {
    const { member, ws } = await setup('one_owner');
    const state = await sqlState(
      testDb.db
        .insert(memberships)
        .values({ workspaceId: ws.id, userId: member.id, role: 'owner' }),
    );
    expect(state).toBe(UNIQUE_VIOLATION);
  });

  it('role と status は、決められた値だけ', async () => {
    const { member, ws } = await setup('enum_check');
    const badRole = await sqlState(
      testDb.db
        .insert(memberships)
        .values({ workspaceId: ws.id, userId: member.id, role: 'admin' }),
    );
    expect(badRole).toBe(CHECK_VIOLATION);
    const badStatus = await sqlState(
      testDb.db
        .insert(memberships)
        .values({ workspaceId: ws.id, userId: member.id, role: 'member', status: 'banned' }),
    );
    expect(badStatus).toBe(CHECK_VIOLATION);
  });

  it('同じユーザーは、同じワークスペースに 1 行だけ(kicked の行も 1 行)', async () => {
    const { member, ws } = await setup('dup');
    await testDb.db
      .insert(memberships)
      .values({ workspaceId: ws.id, userId: member.id, role: 'member', status: 'kicked' });
    const state = await sqlState(
      testDb.db
        .insert(memberships)
        .values({ workspaceId: ws.id, userId: member.id, role: 'member' }),
    );
    expect(state).toBe(UNIQUE_VIOLATION);
  });

  it('status の既定値は active', async () => {
    const { member, ws } = await setup('default_status');
    await testDb.db
      .insert(memberships)
      .values({ workspaceId: ws.id, userId: member.id, role: 'member' });
    const [row] = await testDb.db
      .select()
      .from(memberships)
      .where(eq(memberships.userId, member.id));
    expect(row?.status).toBe('active');
  });
});

describe('storage_deletions', () => {
  it('未削除の行を、登録でき、retry_count の既定値は 0', async () => {
    const [row] = await testDb.db
      .insert(storageDeletions)
      .values({ storageKey: 'avatars/old.png' })
      .returning();
    expect(row?.deletedAt).toBeNull();
    expect(row?.retryCount).toBe(0);
  });
});
