import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { createDb, DEFAULT_DATABASE_URL } from '../db/client';
import { runMigrations } from '../db/migrate';

/**
 * テスト用の DB を、テストごとに新しく作る(空の DB にマイグレーションを適用する)。
 * ファイルが並列に動いても、互いに干渉しない。終わったら、close() で削除する。
 * 接続先のサーバーは DATABASE_URL(未設定ならローカルの docker compose)。
 * CREATE DATABASE の権限が必要(docker compose と CI のユーザーは持っている)。
 */
export async function createTestDatabase() {
  const baseUrl = new URL(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  const name = `raisechat_test_${randomBytes(6).toString('hex')}`;

  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = '/postgres';
  const admin = postgres(adminUrl.toString(), { max: 1 });
  await admin.unsafe(`CREATE DATABASE "${name}"`);

  const testUrl = new URL(baseUrl);
  testUrl.pathname = `/${name}`;
  await runMigrations(testUrl.toString());

  const { db, client } = createDb(testUrl.toString());

  return {
    db,
    client,
    url: testUrl.toString(),
    async close() {
      await client.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.end();
    },
  };
}
