import { vi } from 'vitest';

export type Handler = (request: { body: unknown }) => Response | Promise<Response>;

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export const apiError = (status: number, code: string, message = 'エラー') =>
  json(status, { code, message });

/**
 * fetch を、パスごとの応答に差し替える(キーは "メソッド パス")。
 * 登録のない呼び出しは、テストの失敗にする(想定外の API 呼び出しに、気づくため)。
 * 戻り値の calls で、呼ばれた順の "メソッド パス" を確かめられる。
 */
export function mockApi(routes: Record<string, Handler>) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const key = `${init.method ?? 'GET'} ${url}`;
      calls.push(key);
      const handler = routes[key];
      if (!handler) throw new Error(`想定外の API 呼び出し: ${key}`);
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
      return handler({ body });
    }),
  );
  return { calls };
}
