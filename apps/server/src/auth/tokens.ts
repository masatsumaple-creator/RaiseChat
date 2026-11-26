import { createHash, randomBytes } from 'node:crypto';

/** セッションのトークン: 256 ビットのランダム値(URL に安全な文字列) */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * トークンのハッシュ(SHA-256)。DB には、これだけを保存する(設計書 §2 の sessions)。
 * トークンは、十分に長いランダム値なので、パスワード用の遅いハッシュは要らない。
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// 読み間違えやすい文字(I, L, O, U)を除いた 32 文字(Crockford の base32)
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** リカバリーコードの長さ: 28 文字 × 5 ビット = 140 ビット(FR-005 の基準は 128 ビット以上) */
const RECOVERY_CODE_LENGTH = 28;

/**
 * リカバリーコードを作る(FR-001)。28 文字を、4 文字ずつ、ハイフンで区切る(例: ABCD-EFGH-...)。
 * 暗号論的な乱数だけを使う。32 は 256 の約数なので、1 バイトの下位 5 ビットを使っても、偏らない。
 */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(RECOVERY_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < RECOVERY_CODE_LENGTH; i++) {
    code += ALPHABET[bytes[i]! & 31];
  }
  return code.match(/.{4}/g)!.join('-');
}

/**
 * 入力されたリカバリーコードを、ハッシュする前の形にそろえる(FR-005 の再設定で使う)。
 * ハイフンと空白を除き、大文字にする。読み間違えやすい文字は、Crockford の規則で読み替える。
 */
export function normalizeRecoveryCode(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1');
}
