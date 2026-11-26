import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config';
import { AppError, registerErrorHandling } from './errors';

/** 状態を変えない(CSRF の対象にならない)メソッド */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface BuildAppOptions {
  config: Config;
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
export function buildApp({ config, logger, logStream }: BuildAppOptions): FastifyInstance {
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

  return app;
}
