import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from './client';
import { fetchMe } from './me';

function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const spy = vi.fn(impl);
  vi.stubGlobal('fetch', spy);
  return spy;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function catchError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('例外が投げられませんでした');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiFetch: 成功', () => {
  it('JSON を解釈して返す。Cookie は同一オリジンのみ', async () => {
    const spy = mockFetch(async () => json(200, { id: 'u1' }));
    await expect(apiFetch('/api/me')).resolves.toEqual({ id: 'u1' });
    const init = spy.mock.calls[0]![1];
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('same-origin');
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({});
  });

  it('本文が空(204 など)なら undefined', async () => {
    mockFetch(async () => new Response(null, { status: 204 }));
    await expect(apiFetch('/api/auth/logout', { method: 'POST' })).resolves.toBeUndefined();
  });

  it('json を渡すと、JSON の本文と content-type を付けて送る', async () => {
    const spy = mockFetch(async () => json(200, {}));
    await apiFetch('/api/me', { method: 'PATCH', json: { displayName: '太郎' } });
    const init = spy.mock.calls[0]![1];
    expect(init.method).toBe('PATCH');
    expect(init.body).toBe('{"displayName":"太郎"}');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('formData は、そのまま送る(content-type は、ブラウザに任せる)', async () => {
    const spy = mockFetch(async () => json(200, {}));
    const form = new FormData();
    form.append('file', new Blob(['x']), 'a.png');
    await apiFetch('/api/me/avatar', { method: 'PUT', formData: form });
    const init = spy.mock.calls[0]![1];
    expect(init.body).toBe(form);
    expect(init.headers).toEqual({});
  });
});

describe('apiFetch: 失敗', () => {
  it('{ code, message } の形式なら、ステータス・code・message を持つ ApiError にする', async () => {
    mockFetch(async () =>
      json(400, { code: 'validation_error', message: '入力が正しくありません。' }),
    );
    const error = await catchError(apiFetch('/api/auth/register', { method: 'POST', json: {} }));
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 400,
      code: 'validation_error',
      message: '入力が正しくありません。',
    });
  });

  it('形式の違う本文(HTML など)は、code: unknown にし、本文を画面に出さない', async () => {
    mockFetch(
      async () => new Response('<html>502 Bad Gateway: secret-host</html>', { status: 502 }),
    );
    const error = await catchError(apiFetch('/api/me'));
    expect(error).toMatchObject({ status: 502, code: 'unknown' });
    expect((error as ApiError).message).not.toContain('secret-host');
  });

  it('code か message が文字列でない JSON も、unknown にする', async () => {
    mockFetch(async () => json(500, { code: 1, message: 'x' }));
    expect(await catchError(apiFetch('/api/me'))).toMatchObject({ status: 500, code: 'unknown' });
    mockFetch(async () => json(500, { code: 'x' }));
    expect(await catchError(apiFetch('/api/me'))).toMatchObject({ status: 500, code: 'unknown' });
    mockFetch(async () => json(500, null));
    expect(await catchError(apiFetch('/api/me'))).toMatchObject({ status: 500, code: 'unknown' });
  });

  it('本文が空のエラーも、unknown', async () => {
    mockFetch(async () => new Response(null, { status: 503 }));
    expect(await catchError(apiFetch('/api/me'))).toMatchObject({ status: 503, code: 'unknown' });
  });

  it('通信の失敗は、status 0・code: network_error', async () => {
    mockFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    const error = await catchError(apiFetch('/api/me'));
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 0, code: 'network_error' });
  });

  it('成功なのに JSON ではない応答は、unknown(プロキシの設定ミスなど)', async () => {
    mockFetch(async () => new Response('<html></html>', { status: 200 }));
    expect(await catchError(apiFetch('/api/me'))).toMatchObject({ status: 200, code: 'unknown' });
  });

  it('呼び出し側が中断したときは、通信の失敗にせず、そのまま伝える', async () => {
    const controller = new AbortController();
    mockFetch(async () => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    const error = await catchError(apiFetch('/api/me', { signal: controller.signal }));
    expect(error).not.toBeInstanceOf(ApiError);
    expect((error as DOMException).name).toBe('AbortError');
  });
});

describe('fetchMe', () => {
  const me = { id: 'u1', username: 'taro', displayName: '太郎', statusText: '', avatarUrl: null };

  it('ログイン中なら、ユーザーを返す', async () => {
    mockFetch(async () => json(200, me));
    await expect(fetchMe()).resolves.toEqual(me);
  });

  it('401 は、エラーではなく null(未ログイン)', async () => {
    mockFetch(async () => json(401, { code: 'unauthorized', message: 'ログインしてください。' }));
    await expect(fetchMe()).resolves.toBeNull();
  });

  it('401 以外の失敗は、エラーとして投げる(未ログインと取り違えない)', async () => {
    mockFetch(async () => json(500, { code: 'internal_error', message: 'x' }));
    expect(await catchError(fetchMe())).toMatchObject({ status: 500 });
    mockFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await catchError(fetchMe())).toMatchObject({ status: 0, code: 'network_error' });
  });
});
