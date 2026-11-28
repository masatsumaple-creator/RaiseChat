import {
  ATTACHMENT_MAX_FILES,
  IMAGE_MAX_BYTES,
  VIDEO_MAX_BYTES,
  type AttachmentResponse,
} from '@raisechat/shared';
import { asc, inArray } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client';
import { attachments, storageDeletions } from '../db/schema';
import { AppError } from '../errors';
import { detectMediaType, type MediaType } from '../storage/media-type';
import type { Storage } from '../storage/storage';

type Executor = Pick<Db, 'select'>;

/** 検証を通った、保存前の添付 */
export interface ValidatedFile {
  data: Buffer;
  type: MediaType;
  name: string;
}

const UNSUPPORTED = () =>
  new AppError(
    400,
    'unsupported_file',
    '添付は、画像(JPEG・PNG・GIF・WebP)か、動画(MP4・WebM)にしてください。',
  );

/** 元のファイル名を、表示用に整える(パス・制御文字を取り除き、255 文字までにする) */
export function cleanFileName(raw: string | undefined): string {
  const last = (raw ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = [...last]
    .filter((ch) => {
      const code = ch.codePointAt(0)!;
      return code >= 0x20 && code !== 0x7f;
    })
    .join('')
    .trim();
  const limited = [...cleaned].slice(0, 255).join('');
  return limited.length > 0 ? limited : 'file';
}

/** 1 つのファイルを、内容で検証する(形式・サイズ)。形式は、拡張子や Content-Type ではなく、内容で判定する */
export function validateFile(data: Buffer, filename: string | undefined): ValidatedFile {
  const type = detectMediaType(data);
  if (!type) throw UNSUPPORTED();
  if (data.length === 0) throw UNSUPPORTED();
  const max = type.kind === 'image' ? IMAGE_MAX_BYTES : VIDEO_MAX_BYTES;
  if (data.length > max) {
    throw new AppError(
      413,
      'payload_too_large',
      type.kind === 'image'
        ? '画像は、10MB 以下にしてください。'
        : '動画は、50MB 以下にしてください。',
    );
  }
  return { data, type, name: cleanFileName(filename) };
}

export interface MessageUpload {
  /** 本文(フィールド body。なければ undefined) */
  body: string | undefined;
  files: ValidatedFile[];
}

/**
 * 添付つきの投稿(multipart)を読み取り、すべて検証する(FR-107)。
 * フィールドは body(本文)と、files(ファイル。5 つまで)。ほかの名前は 400。
 * どれかが不正なら、投稿全体を拒否する(この時点では、何も保存していない)。
 */
export async function readMessageUpload(request: FastifyRequest): Promise<MessageUpload> {
  let body: string | undefined;
  const files: ValidatedFile[] = [];
  for await (const part of request.parts({
    // ファイルの上限は、動画の 50MB(超えると、413)。種類ごとの上限は、内容の判定の後に見る
    limits: {
      fileSize: VIDEO_MAX_BYTES,
      files: ATTACHMENT_MAX_FILES + 1,
      fields: 3,
      fieldSize: 20_000,
      parts: ATTACHMENT_MAX_FILES + 4,
    },
  })) {
    if (part.type === 'file') {
      if (part.fieldname !== 'files') {
        part.file.resume();
        throw new AppError(400, 'bad_request', 'ファイルは、files という名前で送ってください。');
      }
      if (files.length >= ATTACHMENT_MAX_FILES) {
        part.file.resume();
        throw new AppError(
          400,
          'too_many_files',
          `添付は、${ATTACHMENT_MAX_FILES} ファイルまでです。`,
        );
      }
      // 上限を超えると、ここで FST_REQ_FILE_TOO_LARGE(413)が投げられる
      const data = await part.toBuffer();
      files.push(validateFile(data, part.filename));
    } else {
      if (part.fieldname !== 'body' || body !== undefined || part.valueTruncated) {
        throw new AppError(400, 'bad_request', 'リクエストが正しくありません。');
      }
      body = String(part.value);
    }
  }
  return { body, files };
}

/** ストレージのキー: attachments/<ワークスペース ID>/<日付(UTC)>/<uuid>.<拡張子>(設計書 D2) */
export function newAttachmentKey(workspaceId: string, id: string, ext: string, now = new Date()) {
  return `attachments/${workspaceId}/${now.toISOString().slice(0, 10)}/${id}.${ext}`;
}

export interface StoredAttachment {
  id: string;
  key: string;
  file: ValidatedFile;
}

/**
 * 実体を、ストレージに保存する。途中で失敗したら、保存済みの分(と、失敗した分)を、削除キューに積んで、エラーを投げる。
 */
export async function storeFiles(
  db: Db,
  storage: Storage,
  workspaceId: string,
  files: ValidatedFile[],
): Promise<StoredAttachment[]> {
  const stored: StoredAttachment[] = [];
  try {
    for (const file of files) {
      const id = randomUUID();
      const key = newAttachmentKey(workspaceId, id, file.type.ext);
      stored.push({ id, key, file });
      await storage.put(key, file.data);
    }
  } catch (error) {
    await discardStored(db, stored);
    throw error;
  }
  return stored;
}

/** DB に残らなかった実体を、削除キューに積む(再試行できるように、キューを経由する) */
export async function discardStored(db: Db, stored: StoredAttachment[]): Promise<void> {
  if (stored.length === 0) return;
  await db.insert(storageDeletions).values(stored.map((s) => ({ storageKey: s.key })));
}

/** 複数のメッセージの、添付を、まとめて取る(1 回の問い合わせ。付けた順) */
export async function loadAttachments(
  db: Executor,
  messageIds: number[],
): Promise<Map<number, AttachmentResponse[]>> {
  const result = new Map<number, AttachmentResponse[]>();
  if (messageIds.length === 0) return result;
  const rows = await db
    .select()
    .from(attachments)
    .where(inArray(attachments.messageId, messageIds))
    .orderBy(asc(attachments.createdAt), asc(attachments.id));
  for (const r of rows) {
    const entry: AttachmentResponse = {
      id: r.id,
      kind: r.kind as AttachmentResponse['kind'],
      mime: r.mime,
      sizeBytes: r.sizeBytes,
      name: r.originalName,
    };
    const list = result.get(r.messageId);
    if (list) list.push(entry);
    else result.set(r.messageId, [entry]);
  }
  return result;
}

/** 1 つのメッセージの、添付 */
export async function attachmentsOf(
  db: Executor,
  messageId: number,
): Promise<AttachmentResponse[]> {
  return (await loadAttachments(db, [messageId])).get(messageId) ?? [];
}
