import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError, type ZodType } from 'zod';

/**
 * API のエラー(設計書 §4.3)。HTTP ステータスと、code と message を持つ JSON で返す。
 * message には、内部情報や、存在の有無を含めない。
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export interface ErrorBody {
  code: string;
  message: string;
}

const STATUS_DEFAULTS: Record<number, ErrorBody> = {
  400: { code: 'bad_request', message: 'リクエストが正しくありません。' },
  401: { code: 'unauthorized', message: 'ログインが必要です。' },
  403: { code: 'forbidden', message: 'この操作は許可されていません。' },
  404: { code: 'not_found', message: '見つかりません。' },
  413: { code: 'payload_too_large', message: 'リクエストが大きすぎます。' },
  429: { code: 'rate_limited', message: 'しばらくしてから、もう一度お試しください。' },
};

/** zod で検証する。失敗したら、400(validation_error)。どの項目かは返すが、入力値は返さない。 */
export function parseWith<T>(schema: ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw validationError(result.error);
  }
  return result.data;
}

function validationError(error: ZodError): AppError {
  const fields = [...new Set(error.issues.map((i) => i.path.join('.')).filter((p) => p !== ''))];
  const message =
    fields.length > 0 ? `入力が正しくありません: ${fields.join(', ')}` : '入力が正しくありません。';
  return new AppError(400, 'validation_error', message);
}

/** Fastify に、エラー形式(§4.3)と、404 の応答を設定する */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((_request, reply) => {
    return reply.status(404).send(STATUS_DEFAULTS[404]);
  });

  app.setErrorHandler((error: FastifyError | AppError | ZodError, request, reply) => {
    if (error instanceof AppError) {
      for (const [name, value] of Object.entries(error.headers)) {
        void reply.header(name, value);
      }
      return reply.status(error.status).send({ code: error.code, message: error.message });
    }

    if (error instanceof ZodError) {
      const e = validationError(error);
      return reply.status(e.status).send({ code: e.code, message: e.message });
    }

    // Fastify 自身が出す 4xx(不正な JSON、大きすぎる本文など)。内部の文面は返さない
    const status = 'statusCode' in error ? error.statusCode : undefined;
    if (status !== undefined && status >= 400 && status < 500) {
      const body = STATUS_DEFAULTS[status] ?? STATUS_DEFAULTS[400]!;
      return reply.status(status).send(body);
    }

    // 想定外のエラー。詳細は、ログにだけ出し(秘密は redact される)、応答には出さない
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({
      code: 'internal_error',
      message: 'サーバーでエラーが起きました。',
    });
  });
}
