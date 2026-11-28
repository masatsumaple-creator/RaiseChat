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
import { avatarVersion, replaceAvatar } from '../profile/avatar';
import { notifyUserUpdated } from '../realtime/notify';
import type { Realtime } from '../realtime/realtime';
import { sharesActiveWorkspace } from '../workspaces/membership';
import { detectImageType, mimeFromExt } from '../storage/image-type';
import type { Storage } from '../storage/storage';
import { toMe } from './auth';

/** アバター画像の上限: 2MB(FR-004。ちょうど 2MB は許可し、1 バイトでも超えたら拒否) */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

export interface ProfileRouteDeps {
  db: Db;
  config: Config;
  storage: Storage;
  realtime: Realtime;
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
    await notifyUserUpdated(db, deps.realtime, updated!);
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
      await notifyUserUpdated(db, deps.realtime, { ...user, avatarKey });
      return toMe({ ...user, avatarKey });
    },
  );

  // FR-004: アバター画像の取得。本人、または、自分と対象が、同じワークスペースに共に active で所属している場合だけ(設計書 §5.1)。
  // 条件を満たさない・存在しない・未設定は、いずれも同じ 404。
  app.get<{ Params: { userId: string }; Querystring: { v?: string } }>(
    '/api/users/:userId/avatar',
    { preHandler: requireUser(db) },
    async (request, reply) => {
      const notFound = () => new AppError(404, 'not_found', '見つかりません。');

      const parsed = userIdSchema.safeParse(request.params.userId);
      if (!parsed.success) throw notFound();
      const me = authOf(request).user;

      let avatarKey: string | null;
      if (parsed.data === me.id) {
        avatarKey = me.avatarKey;
      } else {
        if (!(await sharesActiveWorkspace(db, me.id, parsed.data))) throw notFound();
        const [target] = await db
          .select({ avatarKey: users.avatarKey })
          .from(users)
          .where(eq(users.id, parsed.data));
        avatarKey = target?.avatarKey ?? null;
      }
      if (!avatarKey) throw notFound();

      const data = await storage.get(avatarKey);
      const mime = mimeFromExt(avatarKey.slice(avatarKey.lastIndexOf('.') + 1));
      if (!data || !mime) throw notFound();

      // 版(?v=)が、現在のものと一致するときだけ、長くキャッシュさせる(内容が変わらないため)。
      // 版がない・古い URL は、毎回、確認させる(差し替えや、共通の所属がなくなった後に、古い画像を返し続けないため)
      const current = request.query.v === avatarVersion(avatarKey);
      return (
        reply
          .header('content-type', mime)
          .header(
            'cache-control',
            current ? 'private, max-age=31536000, immutable' : 'private, no-cache',
          )
          // 画像として以外の解釈を、さらに防ぐ(nosniff は、全応答に付く)
          .header('content-security-policy', "default-src 'none'; sandbox")
          .send(data)
      );
    },
  );
}
