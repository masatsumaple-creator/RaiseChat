import { z } from 'zod';
import { codePointLength } from './text';

/** メッセージ本文の上限(設計書 §2。DB の CHECK と同じ。コードポイント数) */
export const MESSAGE_BODY_MAX_LENGTH = 4000;

/** 一覧の 1 ページの件数(設計書 §5) */
export const MESSAGE_PAGE_SIZE = 50;

/**
 * 本文に使えない制御文字を含むか。改行・タブ(\n \r \t)は、複数行の本文のために許す。
 * NUL(U+0000)は、PostgreSQL の text に保存できないため、必ず拒否する。
 */
export function hasForbiddenControlChars(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * POST /channels/:ch/messages の本文(FR-101)。
 * 入力されたままのマークダウンの文字列として保存する(前後の空白も変えない。設計書 §5.6)。
 * 空白だけの本文は拒否する。余分な項目は拒否する。
 */
export const postMessageSchema = z.strictObject({
  body: z
    .string()
    .refine((v) => v.trim().length > 0, { message: '本文を入力してください' })
    .refine((v) => codePointLength(v) <= MESSAGE_BODY_MAX_LENGTH, {
      message: `本文は ${MESSAGE_BODY_MAX_LENGTH} 文字以下にしてください`,
    })
    .refine((v) => !hasForbiddenControlChars(v), { message: '本文に、使えない制御文字があります' }),
});
export type PostMessageRequest = z.infer<typeof postMessageSchema>;

/** GET /channels/:ch/messages の query。cursor は、前のページの最後の ID */
export const messageListQuerySchema = z.object({
  cursor: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});

/** メッセージの投稿者(表示用) */
export interface MessageAuthor {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface MessageResponse {
  id: number;
  channelId: string;
  author: MessageAuthor;
  body: string;
  createdAt: string;
}

export interface MessagePageResponse {
  /** 新しい順 */
  messages: MessageResponse[];
  /** 次のページを取るための cursor。次のページがなければ null */
  nextCursor: number | null;
}
