import { z } from 'zod';
import { DEFAULT_DATABASE_URL } from './db/client';

/** カンマ区切りの文字列を、空要素を除いた配列にする */
function splitList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1).default(DEFAULT_DATABASE_URL),
  /** 許可するオリジン(Origin ヘッダの検証に使う。カンマ区切りで複数可。設計書 §4.1) */
  ALLOWED_ORIGIN: z.string().default('http://localhost:5173'),
  /**
   * 信頼するプロキシのアドレス(カンマ区切り。CIDR 可)。設計書 §4.1。
   * 未設定なら、X-Forwarded-For を無視して、接続元のアドレスを使う(ヘッダの偽装で、レート制限を回避されないため)。
   */
  TRUSTED_PROXIES: z.string().default(''),
  /** アップロードされたファイルの保存先(ローカルディスク。設計書 §1)。相対パスは、起動した場所から */
  STORAGE_DIR: z.string().min(1).default('./storage'),
});

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  /** 正規化したオリジン(例: http://localhost:5173)の一覧 */
  allowedOrigins: string[];
  trustedProxies: string[];
  storageDir: string;
  isProduction: boolean;
}

/**
 * 環境変数から、設定を読み込む。不正な値は、起動時に、エラーにする。
 * エラーの文面に、値は含めない(接続文字列などの、秘密を、ログに出さないため)。
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`環境変数が不正です: ${problems}`);
  }
  const e = parsed.data;

  const allowedOrigins = splitList(e.ALLOWED_ORIGIN).map((origin) => {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error('環境変数が不正です: ALLOWED_ORIGIN に、URL でない値があります');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(
        '環境変数が不正です: ALLOWED_ORIGIN は、http か https のオリジンにしてください',
      );
    }
    return url.origin;
  });
  if (allowedOrigins.length === 0) {
    throw new Error('環境変数が不正です: ALLOWED_ORIGIN が空です');
  }

  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    allowedOrigins,
    trustedProxies: splitList(e.TRUSTED_PROXIES),
    storageDir: e.STORAGE_DIR,
    isProduction: e.NODE_ENV === 'production',
  };
}
