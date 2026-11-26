import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { storageDeletions, users } from '../db/schema';
import { detectImageType } from '../storage/image-type';
import { LocalDiskStorage } from '../storage/storage';
import { createTestDatabase } from '../test/db';
import { makeTempDir, PNG_HEADER } from '../test/files';
import { avatarVersion, newAvatarKey, replaceAvatar } from './avatar';

let testDb: Awaited<ReturnType<typeof createTestDatabase>>;
let temp: Awaited<ReturnType<typeof makeTempDir>>;
let storage: LocalDiskStorage;
let counter = 0;

const png = detectImageType(PNG_HEADER)!;

beforeAll(async () => {
  testDb = await createTestDatabase();
  temp = await makeTempDir();
  storage = new LocalDiskStorage(temp.dir);
});

afterAll(async () => {
  await testDb.close();
  await temp.close();
});

async function createUser() {
  counter += 1;
  const [user] = await testDb.db
    .insert(users)
    .values({
      username: `avatar_${counter}`,
      passwordHash: 'x',
      recoveryCodeHash: 'x',
      displayName: 'x',
    })
    .returning();
  return user!;
}

async function queuedKeys() {
  const rows = await testDb.db.select().from(storageDeletions);
  return rows.map((r) => r.storageKey);
}

describe('newAvatarKey / avatarVersion', () => {
  it('キーは avatars/<ユーザー ID>/<uuid>.<拡張子>。毎回異なる', () => {
    const userId = randomUUID();
    const a = newAvatarKey(userId, png);
    const b = newAvatarKey(userId, png);
    expect(a).toMatch(new RegExp(`^avatars/${userId}/[0-9a-f-]{36}\\.png$`));
    expect(a).not.toBe(b);
  });

  it('版は、キーの uuid の部分', () => {
    const key = newAvatarKey(randomUUID(), png);
    expect(avatarVersion(key)).toMatch(/^[0-9a-f-]{36}$/);
    expect(key).toContain(avatarVersion(key));
  });
});

describe('replaceAvatar', () => {
  it('初めての設定: ファイルを保存し、avatar_key を更新する。削除キューには、何も積まない', async () => {
    const user = await createUser();
    const { avatarKey } = await replaceAvatar({
      db: testDb.db,
      storage,
      userId: user.id,
      data: PNG_HEADER,
      type: png,
    });

    expect(await storage.get(avatarKey)).toEqual(PNG_HEADER);
    const [row] = await testDb.db.select().from(users).where(eq(users.id, user.id));
    expect(row!.avatarKey).toBe(avatarKey);
    expect(await queuedKeys()).not.toContain(avatarKey);
  });

  it('差し替え: 旧ファイルのキーを、同じトランザクションで削除キューに積む(実体は、まだ残る)', async () => {
    const user = await createUser();
    const first = await replaceAvatar({
      db: testDb.db,
      storage,
      userId: user.id,
      data: Buffer.from([...PNG_HEADER, 1]),
      type: png,
    });
    const second = await replaceAvatar({
      db: testDb.db,
      storage,
      userId: user.id,
      data: Buffer.from([...PNG_HEADER, 2]),
      type: png,
    });

    expect(second.avatarKey).not.toBe(first.avatarKey);
    const [row] = await testDb.db.select().from(users).where(eq(users.id, user.id));
    expect(row!.avatarKey).toBe(second.avatarKey);

    const queued = await queuedKeys();
    expect(queued).toContain(first.avatarKey);
    expect(queued).not.toContain(second.avatarKey);
    // 実体の削除は、キューの処理が行う。ここでは、まだ、旧ファイルは残っている
    expect(await storage.get(first.avatarKey)).not.toBeNull();
  });

  it('同時に差し替えても、すべての旧ファイルが、1 回ずつキューに積まれる(取りこぼし・重複なし)', async () => {
    const user = await createUser();
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        replaceAvatar({
          db: testDb.db,
          storage,
          userId: user.id,
          data: Buffer.from([...PNG_HEADER, i]),
          type: png,
        }),
      ),
    );
    const allKeys = results.map((r) => r.avatarKey);
    const [row] = await testDb.db.select().from(users).where(eq(users.id, user.id));
    const finalKey = row!.avatarKey!;
    expect(allKeys).toContain(finalKey);

    // 最終的に使われているもの以外の 4 つが、キューに、1 回ずつ入っている
    const queued = (await queuedKeys()).filter((k) => allKeys.includes(k));
    expect([...queued].sort()).toEqual(allKeys.filter((k) => k !== finalKey).sort());
  });

  it('DB の更新に失敗したら、保存した新しいファイルを削除し、孤児を残さない', async () => {
    const puts: string[] = [];
    const spy = {
      put: async (key: string, data: Uint8Array) => {
        puts.push(key);
        await storage.put(key, data);
      },
      get: (key: string) => storage.get(key),
      delete: (key: string) => storage.delete(key),
    };

    // 存在しないユーザー: 更新の前に、トランザクションが失敗する
    await expect(
      replaceAvatar({
        db: testDb.db,
        storage: spy,
        userId: randomUUID(),
        data: PNG_HEADER,
        type: png,
      }),
    ).rejects.toThrow('ユーザーが存在しません');

    expect(puts).toHaveLength(1);
    expect(await storage.get(puts[0]!)).toBeNull(); // 孤児になっていない
    expect(await queuedKeys()).not.toContain(puts[0]);
  });

  it('保存(put)に失敗したら、DB は変わらない', async () => {
    const user = await createUser();
    const failing = {
      put: async () => {
        throw new Error('書き込めません');
      },
      get: async () => null,
      delete: async () => undefined,
    };
    await expect(
      replaceAvatar({
        db: testDb.db,
        storage: failing,
        userId: user.id,
        data: PNG_HEADER,
        type: png,
      }),
    ).rejects.toThrow('書き込めません');
    const [row] = await testDb.db.select().from(users).where(eq(users.id, user.id));
    expect(row!.avatarKey).toBeNull();
  });
});
