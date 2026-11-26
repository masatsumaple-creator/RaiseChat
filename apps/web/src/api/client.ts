/** サーバーのエラー形式 { code, message }(設計書 §4)を表す例外 */
export class ApiError extends Error {
  constructor(
    /** HTTP ステータス。ネットワークの失敗など、応答が無いときは 0 */
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** 画面に出す、エラーの文言。ApiError 以外(想定外の例外)は、内容を出さず、定型文にする */
export function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : '予期しないエラーが発生しました。';
}

export interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** JSON で送る本文 */
  json?: unknown;
  /** multipart で送る本文(アバターなど)。Content-Type は、ブラウザが境界つきで設定する */
  formData?: FormData;
  signal?: AbortSignal;
}

const NETWORK_ERROR_MESSAGE = 'サーバーに接続できません。通信の状態を確認してください。';
const UNKNOWN_ERROR_MESSAGE = '予期しないエラーが発生しました。';

/** エラー応答の本文から { code, message } を取り出す。形式が違えば undefined */
function parseErrorBody(text: string): { code: string; message: string } | undefined {
  try {
    const body: unknown = JSON.parse(text);
    if (
      typeof body === 'object' &&
      body !== null &&
      'code' in body &&
      'message' in body &&
      typeof body.code === 'string' &&
      typeof body.message === 'string'
    ) {
      return { code: body.code, message: body.message };
    }
  } catch {
    // JSON ではない(プロキシの HTML のエラー画面など)
  }
  return undefined;
}

/**
 * API を呼ぶ。成功なら、JSON を解釈した値(本文が空なら undefined)を返す。
 * 失敗は、すべて ApiError にそろえて投げる:
 * - サーバーが { code, message } を返した → その内容
 * - 形式の違う応答(HTML など)→ code: 'unknown'(本文は画面に出さない)
 * - 通信そのものの失敗 → status 0、code: 'network_error'
 * Cookie は同一オリジンのものだけを送る(開発時は、Vite のプロキシ経由)。
 */
export async function apiFetch<T = unknown>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  const { method = 'GET', json, formData, signal } = options;
  const headers: Record<string, string> = {};
  let body: BodyInit | undefined;
  if (formData !== undefined) {
    body = formData;
  } else if (json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(json);
  }

  let response: Response;
  try {
    response = await fetch(path, { method, headers, body, signal, credentials: 'same-origin' });
  } catch (error) {
    // 呼び出し側の中断(画面の切り替えなど)は、通信の失敗として扱わず、そのまま伝える
    if (signal?.aborted) throw error;
    throw new ApiError(0, 'network_error', NETWORK_ERROR_MESSAGE);
  }

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError(0, 'network_error', NETWORK_ERROR_MESSAGE);
  }

  if (!response.ok) {
    const parsed = parseErrorBody(text);
    throw new ApiError(
      response.status,
      parsed?.code ?? 'unknown',
      parsed?.message ?? UNKNOWN_ERROR_MESSAGE,
    );
  }

  if (text === '') return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    // 成功のはずなのに JSON ではない(プロキシの設定ミスなど)
    throw new ApiError(response.status, 'unknown', UNKNOWN_ERROR_MESSAGE);
  }
}
