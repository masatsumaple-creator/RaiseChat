import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export const DEFAULT_DATABASE_URL = 'postgres://raisechat:raisechat@localhost:5432/raisechat';

export function createDb(url: string) {
  const client = postgres(url, { max: 5 });
  const db = drizzle(client, { schema });
  return { db, client };
}

export type Db = ReturnType<typeof createDb>['db'];
