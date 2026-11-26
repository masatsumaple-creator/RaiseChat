import type { MeResponse } from '@raisechat/shared';
import { useQuery } from '@tanstack/react-query';
import { ApiError, apiFetch } from './client';

export const ME_QUERY_KEY = ['me'] as const;

/**
 * ログイン中のユーザーを取得する。未ログイン(401)は、エラーではなく null として扱う。
 * それ以外の失敗(サーバーの停止など)は、エラーとして投げる。
 * 画面の振り分けは、この結果(null かどうか)だけで行う。
 */
export async function fetchMe(signal?: AbortSignal): Promise<MeResponse | null> {
  try {
    return await apiFetch<MeResponse>('/api/me', { signal });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export function useMe() {
  return useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: ({ signal }) => fetchMe(signal),
    // 認証の状態は、画面を開いたままでも変わり得る(別のタブでのログアウトなど)ため、
    // 画面に戻ってきたときに取り直す(TanStack Query の既定)。失敗の再試行は、画面の応答を遅くするので行わない
    retry: false,
  });
}
