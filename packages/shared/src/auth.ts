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
