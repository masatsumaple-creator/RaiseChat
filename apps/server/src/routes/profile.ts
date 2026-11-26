import type { MeResponse } from '@raisechat/shared';
import { profileUpdateSchema } from '@raisechat/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authOf, requireUser } from '../auth/guards';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { users } from '../db/schema';
import { AppError, parseWith } from '../errors';
import { replaceAvatar } from '../profile/avatar';
import { detectImageType, mimeFromExt } from '../storage/image-type';
import type { Storage } from '../storage/storage';
import { toMe } from './auth';

/** アバター画像の上限: 2MB(FR-004。ちょうど 2MB は許可し、1 バイトでも超えたら拒否) */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

export interface ProfileRouteDeps {
  db: Db;
  config: Config;
  storage: Storage;
  /** アバターの差し替え後に、旧ファイルの削除を促す(失敗しても、キューに残るので、再試行される) */
  onAvatarReplaced?: () => void;
}

const userIdSchema = z.uuid();

/**
 * multipart から、画像のファイルを 1 つだけ読み取る。フィールド名は file。
 * 上限を超えたら 413。ファイルが 0 個、または 2 個以上なら 400。
 */
async function readSingleFile(request: FastifyRequest): Promise<Buffer> {
  if (!request.isMultipart()) {
    throw new AppError(400, 'bad_request', 'multipart/form-data で、ファイルを送ってください。');
  }

  let data: Buffer | undefined;
  for await (const part of request.parts({
    // files は 2: 2 つ目を、ライブラリの上限(413)ではなく、こちらの検査(400)で、拒否するため
    limits: { fileSize: AVATAR_MAX_BYTES, files: 2, fields: 5, parts: 6 },
  })) {
    if (part.type !== 'file') continue; // 文字のフィールドは、使わない
    if (part.fieldname !== 'file' || data !== undefined) {
      part.file.resume();
      throw new AppError(
        400,
        'bad_request',
        'ファイルは、file という名前で、1 つだけ送ってください。',
      );
    }
    // 上限を超えると、ここで FST_REQ_FILE_TOO_LARGE(413)が投げられる
    data = await part.toBuffer();
  }
  if (!data) {
    throw new AppError(
      400,
      'bad_request',
      'ファイルは、file という名前で、1 つだけ送ってください。',
    );
  }
  return data;
}

export function registerProfileRoutes(app: FastifyInstance, deps: ProfileRouteDeps): void {
  const { db, storage } = deps;

  // FR-004: 表示名・ステータスの変更
  app.patch('/api/me', { preHandler: requireUser(db) }, async (request): Promise<MeResponse> => {
    const update = parseWith(profileUpdateSchema, request.body);
    const [updated] = await db
      .update(users)
      .set(update)
      .where(eq(users.id, authOf(request).user.id))
      .returning();
    return toMe(updated!);
  });

  // FR-004: アバター画像の差し替え
  app.put(
    '/api/me/avatar',
    { preHandler: requireUser(db) },
    async (request): Promise<MeResponse> => {
      const data = await readSingleFile(request);

      // 形式は、ファイルの内容で判定する(拡張子や、申告された Content-Type は、見ない)
      const type = detectImageType(data);
      if (!type) {
        throw new AppError(
          400,
          'unsupported_image',
          '画像は、JPEG・PNG・GIF・WebP のいずれかにしてください。',
        );
      }

      const user = authOf(request).user;
      const { avatarKey } = await replaceAvatar({ db, storage, userId: user.id, data, type });
      deps.onAvatarReplaced?.();
      return toMe({ ...user, avatarKey });
    },
  );

  // FR-004: アバター画像の取得。
  // フェーズ 1 は、本人のみ。他のユーザーには、フェーズ 2 で、同じワークスペースの条件を加える(設計書 §5.1)。
  // 条件を満たさない・存在しない・未設定は、いずれも同じ 404。
  app.get<{ Params: { userId: string } }>(
    '/api/users/:userId/avatar',
    { preHandler: requireUser(db) },
    async (request, reply) => {
      const notFound = () => new AppError(404, 'not_found', '見つかりません。');

      const parsed = userIdSchema.safeParse(request.params.userId);
      const me = authOf(request).user;
      if (!parsed.success || parsed.data !== me.id || !me.avatarKey) throw notFound();

      const data = await storage.get(me.avatarKey);
      const mime = mimeFromExt(me.avatarKey.slice(me.avatarKey.lastIndexOf('.') + 1));
      if (!data || !mime) throw notFound();

      return (
        reply
          .header('content-type', mime)
          // URL に版(?v=)が付くので、同じ URL の内容は変わらない。ブラウザだけに、キャッシュさせる
          .header('cache-control', 'private, max-age=31536000, immutable')
          // 画像として以外の解釈を、さらに防ぐ(nosniff は、全応答に付く)
          .header('content-security-policy', "default-src 'none'; sandbox")
          .send(data)
      );
    },
  );
}
