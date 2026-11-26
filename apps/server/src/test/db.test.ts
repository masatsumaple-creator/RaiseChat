import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DATABASE_URL } from '../db/client';
import { createTestDatabase } from './db';

/** 名前の DB が、サーバーに存在するか */
async function databaseExists(name: string): Promise<boolean> {
  const url = new URL(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  url.pathname = '/postgres';
  const sql = postgres(url.toString(), { max: 1 });
  try {
    const rows = await sql`SELECT 1 FROM pg_database WHERE datname = ${name}`;
    return rows.length > 0;
  } finally {
    await sql.end();
  }
}

function uniqueName() {
  return `raisechat_test_${randomBytes(6).toString('hex')}`;
}

describe('createTestDatabase', () => {
  it('作った DB は、close() で削除される', async () => {
    const name = uniqueName();
    const testDb = await createTestDatabase({ name });
    expect(await databaseExists(name)).toBe(true);

    await testDb.close();
    expect(await databaseExists(name)).toBe(false);
  });

  it('マイグレーションが失敗したら、作った DB を削除して、元のエラーを投げる', async () => {
    const name = uniqueName();
    const failure = new Error('migration failed');

    await expect(
      createTestDatabase({
        name,
        migrate: async () => {
          // DB は、この時点で作られている
          expect(await databaseExists(name)).toBe(true);
          throw failure;
        },
      }),
    ).rejects.toBe(failure);

    expect(await databaseExists(name)).toBe(false);
  });

  it('DB の作成自体が失敗しても(同名の DB がある)、既存の DB を消さない', async () => {
    const name = uniqueName();
    const first = await createTestDatabase({ name });
    try {
      await expect(createTestDatabase({ name })).rejects.toThrow();
      // 2 つ目の失敗で、1 つ目の DB を、巻き込んで削除していない
      expect(await databaseExists(name)).toBe(true);
    } finally {
      await first.close();
    }
  });
});
