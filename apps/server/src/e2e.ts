import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { DEFAULT_DATABASE_URL } from './db/client';
import { runMigrations } from './db/migrate';

/**
 * E2E テスト(Playwright)用のサーバーの入口。
 * 専用の DB(raisechat_e2e)を、毎回、空の状態で作り直し、一時フォルダを保存先にして、通常のサーバーを起動する。
 * 開発用の DB・ファイルには、触れない。
 */
const E2E_DB_NAME = 'raisechat_e2e';

const baseUrl = new URL(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
const adminUrl = new URL(baseUrl);
adminUrl.pathname = '/postgres';
const e2eUrl = new URL(baseUrl);
e2eUrl.pathname = `/${E2E_DB_NAME}`;

const admin = postgres(adminUrl.toString(), { max: 1 });
try {
  await admin.unsafe(`DROP DATABASE IF EXISTS "${E2E_DB_NAME}" WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE "${E2E_DB_NAME}"`);
} finally {
  await admin.end();
}
await runMigrations(e2eUrl.toString());

process.env.DATABASE_URL = e2eUrl.toString();
process.env.PORT ??= '3100';
process.env.ALLOWED_ORIGIN ??= 'http://localhost:5273';
process.env.STORAGE_DIR = await mkdtemp(join(tmpdir(), 'raisechat-e2e-'));

await import('./index');
