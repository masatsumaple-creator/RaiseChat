import { z } from 'zod';
import { codePointLength } from './text';

/** ユーザー名: 半角英数字とアンダースコア、3〜32 文字(設計書 §1.1。DB の CHECK と同じ) */
export const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,32}$/;

export const PASSWORD_MIN_LENGTH = 8;
/** 上限は、ハッシュ計算の負荷を抑えるため(FR-001 には、上限の定めがない) */
export const PASSWORD_MAX_LENGTH = 128;

export const usernameSchema = z
  .string()
  .regex(USERNAME_PATTERN, 'ユーザー名は、半角英数字とアンダースコアの 3〜32 文字にしてください');

/** パスワード: 8〜128 文字。文字数は、コードポイント数で数える(設計書 §1.1) */
export const passwordSchema = z
  .string()
  .refine((value) => codePointLength(value) >= PASSWORD_MIN_LENGTH, {
    message: `パスワードは ${PASSWORD_MIN_LENGTH} 文字以上にしてください`,
  })
  .refine((value) => codePointLength(value) <= PASSWORD_MAX_LENGTH, {
    message: `パスワードは ${PASSWORD_MAX_LENGTH} 文字以下にしてください`,
  });

/** POST /auth/register の本文(FR-001) */
export const registerRequestSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

/** 自分のプロフィール(GET /me、登録の応答)。パスワードやリカバリーコードのハッシュは含めない */
export interface MeResponse {
  id: string;
  username: string;
  displayName: string;
  statusText: string;
  /** アバターを取得する API のパス。未設定なら null */
  avatarUrl: string | null;
}

/** POST /auth/register の応答。リカバリーコードは、この応答でだけ返す(FR-001) */
export interface RegisterResponse {
  user: MeResponse;
  recoveryCode: string;
}

/**
 * POST /auth/login の本文(FR-002)。
 * ユーザー名とパスワードの形式は、ここでは検証しない(形式の違反と、認証の失敗を、見分けられないようにするため)。
 * 長さの上限だけは設ける(ハッシュ計算の負荷と、レート制限のキーの大きさを抑えるため)。
 */
export const loginRequestSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** 表示名・ステータスの上限(設計書 §2。DB の CHECK と同じ。コードポイント数) */
export const DISPLAY_NAME_MAX_LENGTH = 50;
export const STATUS_TEXT_MAX_LENGTH = 100;

/** 改行やタブなどの制御文字を含まない(1 行の表示のため) */
const NO_CONTROL_CHARS = /^[^\p{Cc}]*$/u;

/** PATCH /me の本文(FR-004)。指定した項目だけを更新する。余分な項目は、拒否する */
export const profileUpdateSchema = z
  .strictObject({
    displayName: z
      .string()
      .trim()
      .refine((v) => codePointLength(v) >= 1, { message: '表示名を入力してください' })
      .refine((v) => codePointLength(v) <= DISPLAY_NAME_MAX_LENGTH, {
        message: `表示名は ${DISPLAY_NAME_MAX_LENGTH} 文字以下にしてください`,
      })
      .refine((v) => NO_CONTROL_CHARS.test(v), { message: '表示名に、制御文字は使えません' })
      .optional(),
    statusText: z
      .string()
      .trim()
      .refine((v) => codePointLength(v) <= STATUS_TEXT_MAX_LENGTH, {
        message: `ステータスは ${STATUS_TEXT_MAX_LENGTH} 文字以下にしてください`,
      })
      .refine((v) => NO_CONTROL_CHARS.test(v), { message: 'ステータスに、制御文字は使えません' })
      .optional(),
  })
  .refine((v) => v.displayName !== undefined || v.statusText !== undefined, {
    message: '更新する項目を指定してください',
  });
export type ProfileUpdate = z.infer<typeof profileUpdateSchema>;
