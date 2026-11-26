import { hash, verify } from '@node-rs/argon2';

/**
 * argon2id(設計書 §1)。パスワードとリカバリーコードの、ハッシュに使う。
 * パラメータは、OWASP の推奨(メモリ 19 MiB、反復 2、並列 1)。ライブラリの既定のアルゴリズムは argon2id。
 */
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashSecret(plain: string): Promise<string> {
  return hash(plain, OPTIONS);
}

/** 一致すれば true。ハッシュの形式が壊れている場合も、例外にせず false */
export async function verifySecret(hashed: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashed, plain);
  } catch {
    return false;
  }
}
