import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { storageDeletions, users } from '../db/schema';
import type { ImageType } from '../storage/image-type';
import type { Storage } from '../storage/storage';

/** アバターの保存キー: avatars/<ユーザー ID>/<uuid>.<拡張子> */
export function newAvatarKey(userId: string, type: ImageType): string {
  return `avatars/${userId}/${randomUUID()}.${type.ext}`;
}

/** キーから、アバターの版(uuid)を取り出す。URL に付けて、差し替え後にキャッシュされないようにする */
export function avatarVersion(avatarKey: string): string {
  const name = avatarKey.slice(avatarKey.lastIndexOf('/') + 1);
  return name.slice(0, name.lastIndexOf('.'));
}

/**
 * アバターを差し替える(FR-004)。
 * 1. 新しいファイルを保存する。
 * 2. 1 つのトランザクションで、avatar_key を更新し、旧ファイルのキーを削除キューに積む(要件定義書 §9 #8)。
 *    旧ファイルの実体は、キューの処理で、非同期に削除される(失敗しても、キューの行が残るので再試行できる)。
 * 3. 2 が失敗したら、保存した新しいファイルを削除して、孤児を残さない。
 */
export async function replaceAvatar(opts: {
  db: Db;
  storage: Storage;
  userId: string;
  data: Uint8Array;
  type: ImageType;
}): Promise<{ avatarKey: string }> {
  const { db, storage, userId, data, type } = opts;
  const avatarKey = newAvatarKey(userId, type);

  await storage.put(avatarKey, data);
  try {
    await db.transaction(async (tx) => {
      // 同時に差し替えられても、旧キーの読み取りと更新が、順番に行われるよう、行をロックする
      const [current] = await tx
        .select({ avatarKey: users.avatarKey })
        .from(users)
        .where(eq(users.id, userId))
        .for('update');
      if (!current) throw new Error('ユーザーが存在しません');

      await tx.update(users).set({ avatarKey }).where(eq(users.id, userId));
      if (current.avatarKey) {
        await tx.insert(storageDeletions).values({ storageKey: current.avatarKey });
      }
    });
  } catch (error) {
    await storage.delete(avatarKey).catch(() => undefined);
    throw error;
  }
  return { avatarKey };
}
