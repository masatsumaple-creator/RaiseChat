import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authOf, requireUser } from '../auth/guards';
import type { Db } from '../db/client';
import { attachments, channelMembers, messages } from '../db/schema';
import { AppError } from '../errors';
import type { Storage } from '../storage/storage';

export interface AttachmentFileRouteDeps {
  db: Db;
  storage: Storage;
}

const attachmentIdSchema = z.uuid();

/** 配信してよい MIME(許可形式だけ。FR-107) */
const SERVABLE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/webm',
]);

const notFound = () => new AppError(404, 'not_found', '見つかりません。');

/** Content-Disposition: inline。ファイル名は、ASCII の代替と、UTF-8(RFC 5987)の両方で、エスケープして付ける */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\%]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export type ByteRange = { start: number; end: number } | 'unsatisfiable' | null;

/**
 * Range ヘッダを解釈する(1 つの範囲だけ。RFC 9110)。
 * - null: Range がない・解釈できない・複数の範囲 → 全体を返す(200)
 * - 'unsatisfiable': 範囲が、ファイルの外 → 416
 */
export function parseRange(header: string | undefined, size: number): ByteRange {
  if (header === undefined) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a, b] = m as unknown as [string, string, string];
  if (a === '' && b === '') return null;
  if (a === '') {
    // 末尾の n バイト
    const n = Number(b);
    if (n === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  if (start >= size) return 'unsatisfiable';
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  if (end < start) return null; // 逆順は、無効な指定として、無視する
  return { start, end };
}

/**
 * 添付の取得(FR-107。設計書 §5.4)。メッセージのチャンネルの参加者だけ(参加者でなければ、存在を隠して 404)。
 * 削除済みのメッセージの添付は、行が物理削除されているため、404。
 */
export function registerAttachmentFileRoutes(
  app: FastifyInstance,
  deps: AttachmentFileRouteDeps,
): void {
  const { db, storage } = deps;

  app.get<{ Params: { id: string } }>(
    '/api/attachments/:id',
    { preHandler: requireUser(db) },
    async (request, reply) => {
      const parsed = attachmentIdSchema.safeParse(request.params.id);
      if (!parsed.success) throw notFound();
      const me = authOf(request).user.id;

      const [row] = await db
        .select({
          storageKey: attachments.storageKey,
          mime: attachments.mime,
          name: attachments.originalName,
          size: attachments.sizeBytes,
        })
        .from(attachments)
        .innerJoin(messages, eq(messages.id, attachments.messageId))
        .innerJoin(
          channelMembers,
          and(eq(channelMembers.channelId, messages.channelId), eq(channelMembers.userId, me)),
        )
        .where(and(eq(attachments.id, parsed.data), isNull(messages.deletedAt)));
      if (!row || !SERVABLE_MIMES.has(row.mime)) throw notFound();

      const data = await storage.get(row.storageKey);
      if (!data) throw notFound();

      const range = parseRange(request.headers.range, data.length);
      void reply
        .header('content-type', row.mime)
        .header('content-disposition', contentDisposition(row.name))
        .header('accept-ranges', 'bytes')
        // 認可のある応答なので、共有のキャッシュには置かせない。削除・退出の後に、古い応答を返し続けないよう、毎回確認させる
        .header('cache-control', 'private, no-cache')
        // 動画・画像として以外の解釈と、埋め込みでのスクリプトの実行を防ぐ(nosniff は、全応答に付く)
        .header('content-security-policy', "default-src 'none'; sandbox");

      if (range === 'unsatisfiable') {
        return reply.status(416).header('content-range', `bytes */${data.length}`).send();
      }
      if (range) {
        return reply
          .status(206)
          .header('content-range', `bytes ${range.start}-${range.end}/${data.length}`)
          .header('content-length', range.end - range.start + 1)
          .send(data.subarray(range.start, range.end + 1));
      }
      return reply.header('content-length', data.length).send(data);
    },
  );
}
