import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config';
import type { Db } from './db/client';
import { AppError, registerErrorHandling } from './errors';
import { RateLimiter } from './rate-limit';
import { registerAuthRoutes } from './routes/auth';
import { registerProfileRoutes } from './routes/profile';
import { processStorageDeletions } from './storage/deletion-queue';
import { LocalDiskStorage, type Storage } from './storage/storage';

/** 状態を変えない(CSRF の対象にならない)メソッド */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface BuildAppOptions {
  config: Config;
  db: Db;
  /** ファイルの保存先。未指定なら、config.storageDir のローカルディスク */
  storage?: Storage;
  /** false でログを止める(テスト用)。既定は、本番とそれ以外で、レベルを変える */
  logger?: boolean;
  /** ログの出力先(テストで、ログの内容を確かめるため)。未指定なら標準出力 */
  logStream?: { write(message: string): void };
}

/**
 * Fastify のアプリを組み立てる(起動はしない)。
 * - エラー形式(§4.3)、404
 * - Origin の検証(§4.1): GET 以外は、許可するオリジンと一致しなければ 403。ヘッダがない場合も拒否
 * - Cookie の読み書き、nosniff ヘッダ
 * - trustProxy(§4.1): 信頼するプロキシが設定されたときだけ、X-Forwarded-For を使う
 * - ログから、Cookie などの秘密を除く
 */
export function buildApp({
  config,
  db,
  storage = new LocalDiskStorage(config.storageDir),
  logger,
  logStream,
}: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger:
      logger === false
        ? false
        : {
            level: config.isProduction ? 'info' : 'debug',
            redact: {
              paths: [
                'req.headers.cookie',
                'req.headers.authorization',
                'res.headers["set-cookie"]',
              ],
              censor: '[redacted]',
            },
            ...(logStream ? { stream: logStream } : {}),
          },
    // 未設定なら false(ヘッダを無視して、接続元のアドレスを使う)
    trustProxy: config.trustedProxies.length > 0 ? config.trustedProxies : false,
  });

  registerErrorHandling(app);
  void app.register(cookie);
  // ファイルの上限は、ルートごとに指定する(アバターは 2MB。FR-004)
  void app.register(multipart);

  app.addHook('onRequest', async (request) => {
    if (SAFE_METHODS.has(request.method)) return;
    const origin = request.headers.origin;
    if (origin === undefined || !config.allowedOrigins.includes(origin)) {
      throw new AppError(403, 'forbidden_origin', 'この操作は許可されていません。');
    }
  });

  app.addHook('onSend', async (_request, reply) => {
    void reply.header('x-content-type-options', 'nosniff');
  });

  app.get('/health', async () => ({ status: 'ok' }));

  registerAuthRoutes(app, {
    db,
    config,
    // 登録は、同じ接続元から、15 分に 10 回まで(設計書 §4.1。回数は T5 で決めた)
    registerLimiter: new RateLimiter({ limit: 10, windowMs: 15 * 60 * 1000 }),
    // ログインは、同じ接続元とユーザー名の組で 15 分に 5 回、同じ接続元全体で 15 分に 30 回まで(FR-005 と同じ基準)
    loginPairLimiter: new RateLimiter({ limit: 5, windowMs: 15 * 60 * 1000 }),
    loginIpLimiter: new RateLimiter({ limit: 30, windowMs: 15 * 60 * 1000 }),
  });

  registerProfileRoutes(app, {
    db,
    config,
    storage,
    // 旧アバターの実体の削除を、すぐに試す。失敗しても、キューに残り、定期処理で再試行される
    onAvatarReplaced: () => {
      processStorageDeletions(db, storage, {
        onError: (error, key) => app.log.error({ err: error, storageKey: key }, '実体の削除に失敗'),
      }).catch((error) => app.log.error({ err: error }, '削除キューの処理に失敗'));
    },
  });

  return app;
}
