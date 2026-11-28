import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestDatabase } from '../test/db';
import {
  channelMembers,
  channels,
  memberships,
  messages,
  sessions,
  storageDeletions,
  threadMembers,
  users,
  workspaces,
} from './schema';

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

async function createUser(username: string) {
  const [user] = await testDb.db.insert(users).values(newUser(username)).returning();
  return user!;
}

/**
 * ワークスペースと、そのオーナーの行を、同じトランザクションで作る。
 * 両者は相互に参照するため、外部キーの検査は、コミットまで遅れる(0002 のマイグレーション)。
 */
async function createWorkspace(ownerId: string, name = 'ws') {
  return testDb.db.transaction(async (tx) => {
    const [ws] = await tx.insert(workspaces).values({ name, ownerId }).returning();
    await tx.insert(memberships).values({ workspaceId: ws!.id, userId: ownerId, role: 'owner' });
    return ws!;
  });
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
const FOREIGN_KEY_VIOLATION = '23503';

describe('マイグレーション', () => {
  it('空の DB に適用でき、テーブルができる', async () => {
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
        'channels',
        'channel_members',
      ]),
    );
  });

  it('workspaces.owner_id にインデックスがある', async () => {
    const rows = await testDb.db.execute<{ indexname: string }>(
      sql`SELECT indexname FROM pg_indexes WHERE tablename = 'workspaces'`,
    );
    expect(rows.map((r) => r.indexname)).toContain('workspaces_owner_id_idx');
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
  it('オーナーは、ワークスペースごとに 1 人', async () => {
    const owner = await createUser('one_owner_a');
    const other = await createUser('one_owner_b');
    const ws = await createWorkspace(owner.id);
    const state = await sqlState(
      testDb.db.insert(memberships).values({ workspaceId: ws.id, userId: other.id, role: 'owner' }),
    );
    expect(state).toBe(UNIQUE_VIOLATION);
  });

  it('role と status は、決められた値だけ', async () => {
    const owner = await createUser('enum_owner');
    const member = await createUser('enum_member');
    const ws = await createWorkspace(owner.id);
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
    const owner = await createUser('dup_owner');
    const member = await createUser('dup_member');
    const ws = await createWorkspace(owner.id);
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
    const owner = await createUser('status_owner');
    const member = await createUser('status_member');
    const ws = await createWorkspace(owner.id);
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

describe('オーナーの整合性(workspaces.owner_id と、オーナーの行の一致)', () => {
  it('ワークスペースと、オーナーの行を、同じトランザクションで作れる', async () => {
    const owner = await createUser('consistent_owner');
    const ws = await createWorkspace(owner.id);
    expect(ws.ownerRole).toBe('owner');
    const [row] = await testDb.db
      .select()
      .from(memberships)
      .where(eq(memberships.workspaceId, ws.id));
    expect(row).toMatchObject({ userId: owner.id, role: 'owner', status: 'active' });
  });

  it('オーナーの行がないワークスペースは、コミットできない', async () => {
    const owner = await createUser('no_membership_owner');
    const state = await sqlState(
      testDb.db.insert(workspaces).values({ name: 'orphan', ownerId: owner.id }),
    );
    expect(state).toBe(FOREIGN_KEY_VIOLATION);
    const rows = await testDb.db.select().from(workspaces).where(eq(workspaces.name, 'orphan'));
    expect(rows).toHaveLength(0);
  });

  it('owner_id と、role が owner の行のユーザーが食い違うと、コミットできない', async () => {
    const owner = await createUser('mismatch_owner');
    const other = await createUser('mismatch_other');
    const state = await sqlState(
      testDb.db.transaction(async (tx) => {
        const [ws] = await tx
          .insert(workspaces)
          .values({ name: 'mismatch', ownerId: owner.id })
          .returning();
        // owner_id は owner だが、オーナーの行は other
        await tx
          .insert(memberships)
          .values({ workspaceId: ws!.id, userId: other.id, role: 'owner' });
      }),
    );
    expect(state).toBe(FOREIGN_KEY_VIOLATION);
    const rows = await testDb.db.select().from(workspaces).where(eq(workspaces.name, 'mismatch'));
    expect(rows).toHaveLength(0);
  });

  it('オーナーの行の role を変えられない', async () => {
    const owner = await createUser('demote_owner');
    const ws = await createWorkspace(owner.id);
    const state = await sqlState(
      testDb.db
        .update(memberships)
        .set({ role: 'member' })
        .where(eq(memberships.workspaceId, ws.id)),
    );
    expect(state).toBe(FOREIGN_KEY_VIOLATION);
    const [row] = await testDb.db
      .select()
      .from(memberships)
      .where(eq(memberships.workspaceId, ws.id));
    expect(row?.role).toBe('owner');
  });

  it('オーナーの行だけを削除できない(キックできない)', async () => {
    const owner = await createUser('delete_owner');
    const ws = await createWorkspace(owner.id);
    const state = await sqlState(
      testDb.db.delete(memberships).where(eq(memberships.workspaceId, ws.id)),
    );
    expect(state).toBe(FOREIGN_KEY_VIOLATION);
    const rows = await testDb.db
      .select()
      .from(memberships)
      .where(eq(memberships.workspaceId, ws.id));
    expect(rows).toHaveLength(1);
  });

  it('owner_id を、オーナーの行がないユーザーに付け替えられない', async () => {
    const owner = await createUser('swap_owner');
    const other = await createUser('swap_other');
    const ws = await createWorkspace(owner.id);
    const state = await sqlState(
      testDb.db.update(workspaces).set({ ownerId: other.id }).where(eq(workspaces.id, ws.id)),
    );
    expect(state).toBe(FOREIGN_KEY_VIOLATION);
  });

  it('ワークスペースを削除すると、オーナーの行も含めて、membership が消える', async () => {
    const owner = await createUser('cascade_ws_owner');
    const member = await createUser('cascade_ws_member');
    const ws = await createWorkspace(owner.id);
    await testDb.db
      .insert(memberships)
      .values({ workspaceId: ws.id, userId: member.id, role: 'member' });

    await testDb.db.delete(workspaces).where(eq(workspaces.id, ws.id));

    const rows = await testDb.db
      .select()
      .from(memberships)
      .where(eq(memberships.workspaceId, ws.id));
    expect(rows).toHaveLength(0);
  });

  it('ワークスペースのオーナーであるユーザーは、削除できない', async () => {
    const owner = await createUser('undeletable_owner');
    await createWorkspace(owner.id);
    const state = await sqlState(testDb.db.delete(users).where(eq(users.id, owner.id)));
    expect(state).toBe(FOREIGN_KEY_VIOLATION);
  });
});

describe('sessions の連鎖削除', () => {
  it('ユーザーを削除すると、そのユーザーのセッションだけが消える', async () => {
    const target = await createUser('session_target');
    const bystander = await createUser('session_bystander');
    const expiresAt = new Date(Date.now() + 60_000);
    await testDb.db.insert(sessions).values([
      { tokenHash: 'target-1', userId: target.id, expiresAt },
      { tokenHash: 'target-2', userId: target.id, expiresAt },
      { tokenHash: 'bystander-1', userId: bystander.id, expiresAt },
    ]);

    await testDb.db.delete(users).where(eq(users.id, target.id));

    const rows = await testDb.db.select().from(sessions);
    const hashes = rows.map((r) => r.tokenHash);
    expect(hashes).not.toContain('target-1');
    expect(hashes).not.toContain('target-2');
    expect(hashes).toContain('bystander-1');
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

describe('channels / channel_members(FR-202, FR-203)', () => {
  async function newChannel(
    workspaceId: string,
    values: Partial<typeof channels.$inferInsert> = {},
  ) {
    return testDb.db
      .insert(channels)
      .values({ workspaceId, type: 'public', name: 'random', ...values })
      .returning();
  }

  it('名前は、同一ワークスペース内で、大文字小文字を区別せず一意。別のワークスペースなら同じ名前でよい', async () => {
    const owner = await createUser('ch_owner_1');
    const a = await createWorkspace(owner.id, 'a');
    const b = await createWorkspace(owner.id, 'b');
    await newChannel(a.id, { name: 'Dev' });
    expect(await sqlState(newChannel(a.id, { name: 'dev' }))).toBe(UNIQUE_VIOLATION);
    expect(await sqlState(newChannel(a.id, { name: 'DEV', type: 'private' }))).toBe(
      UNIQUE_VIOLATION,
    );
    await expect(newChannel(b.id, { name: 'Dev' })).resolves.toHaveLength(1);
  });

  it('既定チャンネルは、ワークスペースに 1 つ', async () => {
    const owner = await createUser('ch_owner_2');
    const ws = await createWorkspace(owner.id);
    await newChannel(ws.id, { name: 'general', isDefault: true });
    expect(await sqlState(newChannel(ws.id, { name: 'other', isDefault: true }))).toBe(
      UNIQUE_VIOLATION,
    );
  });

  it('種類は public / private / dm のみ。dm だけ名前が null で dm_key を持つ。名前は 1〜80 文字', async () => {
    const owner = await createUser('ch_owner_3');
    const ws = await createWorkspace(owner.id);
    expect(await sqlState(newChannel(ws.id, { type: 'secret' }))).toBe(CHECK_VIOLATION);
    expect(await sqlState(newChannel(ws.id, { name: null }))).toBe(CHECK_VIOLATION); // public なのに名前なし
    expect(await sqlState(newChannel(ws.id, { type: 'dm', name: 'x', dmKey: 'k' }))).toBe(
      CHECK_VIOLATION,
    ); // dm なのに名前あり
    expect(await sqlState(newChannel(ws.id, { type: 'dm', name: null }))).toBe(CHECK_VIOLATION); // dm_key なし
    expect(await sqlState(newChannel(ws.id, { name: '' }))).toBe(CHECK_VIOLATION);
    expect(await sqlState(newChannel(ws.id, { name: 'a'.repeat(81) }))).toBe(CHECK_VIOLATION);
    await expect(newChannel(ws.id, { name: 'あ'.repeat(80) })).resolves.toHaveLength(1);
    await expect(
      newChannel(ws.id, { type: 'dm', name: null, dmKey: 'u1:u2' }),
    ).resolves.toHaveLength(1);
    // 同じ 2 人の DM は、重複して作れない
    expect(await sqlState(newChannel(ws.id, { type: 'dm', name: null, dmKey: 'u1:u2' }))).toBe(
      UNIQUE_VIOLATION,
    );
  });

  it('参加者の行は、チャンネルの削除で消える。同じ人を、2 回は登録できない', async () => {
    const owner = await createUser('ch_owner_4');
    const ws = await createWorkspace(owner.id);
    const [ch] = await newChannel(ws.id, { name: 'tmp' });
    await testDb.db.insert(channelMembers).values({ channelId: ch!.id, userId: owner.id });
    expect(
      await sqlState(
        testDb.db.insert(channelMembers).values({ channelId: ch!.id, userId: owner.id }),
      ),
    ).toBe(UNIQUE_VIOLATION);
    await testDb.db.delete(channels).where(eq(channels.id, ch!.id));
    expect(
      await testDb.db.select().from(channelMembers).where(eq(channelMembers.channelId, ch!.id)),
    ).toEqual([]);
  });
});

describe('messages(FR-103、104、105)', () => {
  async function setupChannel(name: string) {
    const owner = await createUser(name + '_owner');
    const ws = await createWorkspace(owner.id);
    const [a] = await testDb.db
      .insert(channels)
      .values({ workspaceId: ws.id, type: 'public', name: 'a' })
      .returning();
    const [b] = await testDb.db
      .insert(channels)
      .values({ workspaceId: ws.id, type: 'public', name: 'b' })
      .returning();
    const insert = (values: Partial<typeof messages.$inferInsert> & { channelId: string }) =>
      testDb.db
        .insert(messages)
        .values({ userId: owner.id, body: 'x', ...values })
        .returning();
    return { owner, a: a!, b: b!, insert };
  }

  it('本文が null であることと、削除済み(deleted_at)であることは、一致する(どちらか一方だけは不可)', async () => {
    const { a, insert } = await setupChannel('msg_del');
    expect(await sqlState(insert({ channelId: a.id, body: null }))).toBe(CHECK_VIOLATION);
    expect(await sqlState(insert({ channelId: a.id, body: 'x', deletedAt: new Date() }))).toBe(
      CHECK_VIOLATION,
    );
    await expect(
      insert({ channelId: a.id, body: null, deletedAt: new Date() }),
    ).resolves.toHaveLength(1);
    await expect(insert({ channelId: a.id, body: 'x' })).resolves.toHaveLength(1);
  });

  it('本文は 1〜4000 文字(null は、削除済みの場合だけ)', async () => {
    const { a, insert } = await setupChannel('msg_len');
    expect(await sqlState(insert({ channelId: a.id, body: '' }))).toBe(CHECK_VIOLATION);
    expect(await sqlState(insert({ channelId: a.id, body: 'a'.repeat(4001) }))).toBe(
      CHECK_VIOLATION,
    );
    await expect(insert({ channelId: a.id, body: '😀'.repeat(4000) })).resolves.toHaveLength(1);
  });

  it('返信の親は、同じチャンネルのメッセージだけ(別のチャンネルの親は不可)', async () => {
    const { a, b, insert } = await setupChannel('msg_parent');
    const [parent] = await insert({ channelId: a.id });
    await expect(insert({ channelId: a.id, parentId: parent!.id })).resolves.toHaveLength(1);
    expect(await sqlState(insert({ channelId: b.id, parentId: parent!.id }))).toBe(
      FOREIGN_KEY_VIOLATION,
    );
    expect(await sqlState(insert({ channelId: a.id, parentId: 999_999_999 }))).toBe(
      FOREIGN_KEY_VIOLATION,
    );
  });

  it('親を物理削除すると(チャンネルの削除など)、返信も連鎖して消える。チャンネルの削除で、メッセージも消える', async () => {
    const { a, insert } = await setupChannel('msg_cascade');
    const [parent] = await insert({ channelId: a.id });
    const [reply] = await insert({ channelId: a.id, parentId: parent!.id });
    await testDb.db.delete(messages).where(eq(messages.id, parent!.id));
    expect(await testDb.db.select().from(messages).where(eq(messages.id, reply!.id))).toEqual([]);

    const [m] = await insert({ channelId: a.id });
    await testDb.db.delete(channels).where(eq(channels.id, a.id));
    expect(await testDb.db.select().from(messages).where(eq(messages.id, m!.id))).toEqual([]);
  });
});

describe('thread_members(FR-105)', () => {
  it('同じ人は、同じスレッドに、2 回は入れない。親を物理削除すると、スレッドの参加者も消える', async () => {
    const owner = await createUser('thr_owner');
    const ws = await createWorkspace(owner.id);
    const [ch] = await testDb.db
      .insert(channels)
      .values({ workspaceId: ws.id, type: 'public', name: 'thr' })
      .returning();
    const [root] = await testDb.db
      .insert(messages)
      .values({ channelId: ch!.id, userId: owner.id, body: '親' })
      .returning();
    await testDb.db.insert(threadMembers).values({ rootMessageId: root!.id, userId: owner.id });
    expect(
      await sqlState(
        testDb.db.insert(threadMembers).values({ rootMessageId: root!.id, userId: owner.id }),
      ),
    ).toBe(UNIQUE_VIOLATION);
    expect(
      await sqlState(
        testDb.db.insert(threadMembers).values({ rootMessageId: 999_999_999, userId: owner.id }),
      ),
    ).toBe(FOREIGN_KEY_VIOLATION);

    await testDb.db.delete(messages).where(eq(messages.id, root!.id));
    expect(
      await testDb.db.select().from(threadMembers).where(eq(threadMembers.rootMessageId, root!.id)),
    ).toEqual([]);
  });
});
