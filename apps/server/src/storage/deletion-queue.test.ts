import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { storageDeletions } from '../db/schema';
import { createTestDatabase } from '../test/db';
import { makeTempDir } from '../test/files';
import { processStorageDeletions, startDeletionWorker } from './deletion-queue';
import { LocalDiskStorage, type Storage } from './storage';

let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
let temp: Awaited<ReturnType<typeof makeTempDir>>;
let disk: LocalDiskStorage;

beforeAll(async () => {
  testDb = await createTestDatabase();
  temp = await makeTempDir();
  disk = new LocalDiskStorage(temp.dir);
});

afterAll(async () => {
  await testDb.close();
  await temp.close();
});

beforeEach(async () => {
  // 各テストを、空のキューから始める
  await testDb.db.delete(storageDeletions);
});

/** delete が、指定した回数だけ失敗し、その後は成功するストレージ */
function flakyStorage(failures: number, inner: Storage = disk) {
  let remaining = failures;
  const deleted: string[] = [];
  const storage: Storage = {
    put: (key, data) => inner.put(key, data),
    get: (key) => inner.get(key),
    async delete(key) {
      if (remaining > 0) {
        remaining -= 1;
        throw new Error('ストレージに接続できません');
      }
      deleted.push(key);
      await inner.delete(key);
    },
  };
  return { storage, deleted };
}

async function enqueue(...keys: string[]) {
  await testDb.db.insert(storageDeletions).values(keys.map((storageKey) => ({ storageKey })));
}

async function rows() {
  return testDb.db.select().from(storageDeletions).orderBy(storageDeletions.id);
}

describe('processStorageDeletions', () => {
  it('実体を削除し、deleted_at を設定する', async () => {
    await disk.put('avatars/q1/a.png', Buffer.from('x'));
    await enqueue('avatars/q1/a.png');

    const result = await processStorageDeletions(testDb.db, disk);

    expect(result).toEqual({ deleted: 1, failed: 0 });
    expect(await disk.get('avatars/q1/a.png')).toBeNull();
    const [row] = await rows();
    expect(row!.deletedAt).toBeInstanceOf(Date);
    expect(row!.retryCount).toBe(0);
  });

  it('実体がすでにない場合も、成功として扱う(冪等)', async () => {
    await enqueue('avatars/q2/missing.png');
    const result = await processStorageDeletions(testDb.db, disk);
    expect(result).toEqual({ deleted: 1, failed: 0 });
  });

  it('失敗した行は、deleted_at を設定せず、retry_count を増やして残す', async () => {
    await enqueue('avatars/q3/a.png');
    const { storage } = flakyStorage(Infinity);
    const errors: string[] = [];

    const result = await processStorageDeletions(testDb.db, storage, {
      onError: (_error, key) => errors.push(key),
    });

    expect(result).toEqual({ deleted: 0, failed: 1 });
    expect(errors).toEqual(['avatars/q3/a.png']);
    const [row] = await rows();
    expect(row!.deletedAt).toBeNull();
    expect(row!.retryCount).toBe(1);
  });

  it('失敗した行は、次の回に再試行され、成功したら完了する', async () => {
    await disk.put('avatars/q4/a.png', Buffer.from('x'));
    await enqueue('avatars/q4/a.png');
    const { storage, deleted } = flakyStorage(2);

    await processStorageDeletions(testDb.db, storage); // 失敗 1 回目
    await processStorageDeletions(testDb.db, storage); // 失敗 2 回目
    expect((await rows())[0]!.retryCount).toBe(2);
    expect(await disk.get('avatars/q4/a.png')).not.toBeNull(); // まだ、実体は残っている

    const result = await processStorageDeletions(testDb.db, storage); // 3 回目で成功
    expect(result).toEqual({ deleted: 1, failed: 0 });
    expect(deleted).toEqual(['avatars/q4/a.png']);
    expect(await disk.get('avatars/q4/a.png')).toBeNull();
    const [row] = await rows();
    expect(row!.deletedAt).toBeInstanceOf(Date);
    expect(row!.retryCount).toBe(2);
  });

  it('処理済みの行は、再び処理しない', async () => {
    await enqueue('avatars/q5/a.png');
    await processStorageDeletions(testDb.db, disk);
    const { storage, deleted } = flakyStorage(0);
    const result = await processStorageDeletions(testDb.db, storage);
    expect(result).toEqual({ deleted: 0, failed: 0 });
    expect(deleted).toEqual([]);
  });

  it('1 つの失敗が、他の行の処理を止めない', async () => {
    await enqueue('avatars/q6/a.png', 'avatars/q6/b.png', 'avatars/q6/c.png');
    const { storage, deleted } = flakyStorage(1); // 最初の 1 件だけ失敗

    const result = await processStorageDeletions(testDb.db, storage);

    expect(result).toEqual({ deleted: 2, failed: 1 });
    expect(deleted).toEqual(['avatars/q6/b.png', 'avatars/q6/c.png']);
    const all = await rows();
    expect(all.map((r) => r.deletedAt !== null)).toEqual([false, true, true]);
  });

  it('上限の回数、失敗した行は、あきらめる(行は、調査のために残す)', async () => {
    await enqueue('avatars/q7/a.png');
    const { storage } = flakyStorage(Infinity);
    for (let i = 0; i < 5; i++) {
      await processStorageDeletions(testDb.db, storage, { maxRetries: 3 });
    }
    const [row] = await rows();
    expect(row!.retryCount).toBe(3); // 3 回で止まる(4 回目以降は、試さない)
    expect(row!.deletedAt).toBeNull();
  });

  it('1 回に処理する件数は、batchSize まで。古い順', async () => {
    await enqueue('avatars/q8/1.png', 'avatars/q8/2.png', 'avatars/q8/3.png');
    const { storage, deleted } = flakyStorage(0);

    await processStorageDeletions(testDb.db, storage, { batchSize: 2 });
    expect(deleted).toEqual(['avatars/q8/1.png', 'avatars/q8/2.png']);
    await processStorageDeletions(testDb.db, storage, { batchSize: 2 });
    expect(deleted).toEqual(['avatars/q8/1.png', 'avatars/q8/2.png', 'avatars/q8/3.png']);
  });

  it('同時に 2 つが動いても、同じ行を重複して処理しない', async () => {
    const keys = Array.from({ length: 10 }, (_, i) => `avatars/q9/${i}.png`);
    await enqueue(...keys);
    const { storage, deleted } = flakyStorage(0);

    await Promise.all([
      processStorageDeletions(testDb.db, storage, { batchSize: 10 }),
      processStorageDeletions(testDb.db, storage, { batchSize: 10 }),
    ]);

    expect([...deleted].sort()).toEqual([...keys].sort()); // 10 件が、1 回ずつ
    expect((await rows()).every((r) => r.deletedAt !== null)).toBe(true);
  });
});

describe('startDeletionWorker', () => {
  it('一定の間隔で、キューを処理する。stop で止まる', async () => {
    await enqueue('avatars/w1/a.png');
    const worker = startDeletionWorker(testDb.db, disk, { intervalMs: 20 });
    try {
      await expect
        .poll(async () => (await rows())[0]?.deletedAt ?? null, { timeout: 3000 })
        .not.toBeNull();
    } finally {
      worker.stop();
    }

    // 止めた後に積んだ行は、処理されない
    await enqueue('avatars/w1/b.png');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const last = (await rows()).at(-1)!;
    expect(last.storageKey).toBe('avatars/w1/b.png');
    expect(last.deletedAt).toBeNull();
  });

  it('runNow で、すぐに処理でき、重ねて呼んでも同じ処理を共有する', async () => {
    await enqueue('avatars/w2/a.png');
    const worker = startDeletionWorker(testDb.db, disk, { intervalMs: 60_000 });
    try {
      const [a, b] = await Promise.all([worker.runNow(), worker.runNow()]);
      expect(a).toEqual({ deleted: 1, failed: 0 });
      expect(b).toBe(a);
      const [row] = await testDb.db
        .select()
        .from(storageDeletions)
        .where(eq(storageDeletions.storageKey, 'avatars/w2/a.png'));
      expect(row!.deletedAt).not.toBeNull();
    } finally {
      worker.stop();
    }
  });
});
