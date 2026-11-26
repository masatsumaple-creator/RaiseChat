import { and, asc, eq, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { storageDeletions } from '../db/schema';
import type { Storage } from './storage';

export interface DeletionOptions {
  /** 1 回に処理する件数 */
  batchSize?: number;
  /** この回数、失敗した行は、あきらめる(行は残すので、調査できる) */
  maxRetries?: number;
  onError?: (error: unknown, storageKey: string) => void;
}

export interface DeletionResult {
  deleted: number;
  failed: number;
}

/**
 * 削除キュー(storage_deletions)の、未処理の行を処理する(要件定義書 §9 #8)。
 * 実体の削除に成功したら deleted_at を設定し、失敗したら retry_count を増やして残す(次の回に再試行)。
 * 同時に複数が動いても、同じ行を重複して処理しないよう、行をロックする(SKIP LOCKED)。
 */
export async function processStorageDeletions(
  db: Db,
  storage: Storage,
  options: DeletionOptions = {},
): Promise<DeletionResult> {
  const batchSize = options.batchSize ?? 50;
  const maxRetries = options.maxRetries ?? 10;
  const result: DeletionResult = { deleted: 0, failed: 0 };

  await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(storageDeletions)
      .where(and(isNull(storageDeletions.deletedAt), lt(storageDeletions.retryCount, maxRetries)))
      .orderBy(asc(storageDeletions.id))
      .limit(batchSize)
      .for('update', { skipLocked: true });

    for (const row of rows) {
      try {
        await storage.delete(row.storageKey);
        await tx
          .update(storageDeletions)
          .set({ deletedAt: new Date() })
          .where(eq(storageDeletions.id, row.id));
        result.deleted += 1;
      } catch (error) {
        await tx
          .update(storageDeletions)
          .set({ retryCount: sql`${storageDeletions.retryCount} + 1` })
          .where(eq(storageDeletions.id, row.id));
        result.failed += 1;
        options.onError?.(error, row.storageKey);
      }
    }
  });

  return result;
}

/**
 * 一定の間隔で、削除キューを処理する。止めるには、返り値の stop を呼ぶ。
 * 前回の処理が終わっていなければ、重ねて開始しない。
 */
export function startDeletionWorker(
  db: Db,
  storage: Storage,
  options: DeletionOptions & { intervalMs?: number } = {},
): { stop(): void; runNow(): Promise<DeletionResult> } {
  let running: Promise<DeletionResult> | undefined;

  const runNow = () => {
    running ??= processStorageDeletions(db, storage, options).finally(() => {
      running = undefined;
    });
    return running;
  };

  const timer = setInterval(() => {
    runNow().catch((error) => options.onError?.(error, '(キューの処理)'));
  }, options.intervalMs ?? 60_000);
  timer.unref();

  return { stop: () => clearInterval(timer), runNow };
}
