import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import { createDb, DEFAULT_DATABASE_URL } from './client';

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** マイグレーションを適用する。適用済みのものは飛ばす。 */
export async function runMigrations(url: string): Promise<void> {
  const { db, client } = createDb(url);
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await client.end();
  }
}

// `pnpm db:migrate` から直接実行されたとき
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  await runMigrations(url);
  console.log('migrations applied');
}
