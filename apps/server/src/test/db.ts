import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { createDb, DEFAULT_DATABASE_URL } from '../db/client';
import { runMigrations } from '../db/migrate';

export interface TestDatabaseOptions {
  /** 作る DB の名前。未指定なら、ランダムな名前(raisechat_test_ で始まる) */
  name?: string;
  /** マイグレーションの適用。既定は runMigrations。失敗時の後始末を、テストで確かめるために差し替えられる */
  migrate?: (url: string) => Promise<void>;
}

/**
 * テスト用の DB を、テストごとに新しく作る(空の DB にマイグレーションを適用する)。
 * ファイルが並列に動いても、互いに干渉しない。終わったら、close() で削除する。
 * 接続先のサーバーは DATABASE_URL(未設定ならローカルの docker compose)。
 * CREATE DATABASE の権限が必要(docker compose と CI のユーザーは持っている)。
 * DB を作った後に失敗した場合は、その DB を削除し、接続を閉じてから、エラーを投げ直す。
 */
export async function createTestDatabase(options: TestDatabaseOptions = {}) {
  const baseUrl = new URL(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  const name = options.name ?? `raisechat_test_${randomBytes(6).toString('hex')}`;
  const migrate = options.migrate ?? runMigrations;

  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = '/postgres';
  const admin = postgres(adminUrl.toString(), { max: 1 });

  const testUrl = new URL(baseUrl);
  testUrl.pathname = `/${name}`;

  let created = false;
  let client: ReturnType<typeof createDb>['client'] | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    created = true;
    await migrate(testUrl.toString());
    const connection = createDb(testUrl.toString());
    client = connection.client;

    return {
      db: connection.db,
      client: connection.client,
      url: testUrl.toString(),
      async close() {
        await connection.client.end();
        await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
        await admin.end();
      },
    };
  } catch (error) {
    // 後始末の失敗で、元のエラーを隠さない
    await client?.end().catch(() => undefined);
    if (created) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
    }
    await admin.end().catch(() => undefined);
    throw error;
  }
}
