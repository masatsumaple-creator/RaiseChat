import type { SearchResponse } from '@raisechat/shared';
import { apiFetch } from './client';

export const searchKey = (workspaceId: string, q: string) => ['search', workspaceId, q] as const;

/** メッセージの検索(FR-110)。新しい順に 50 件ずつ。cursor は、前のページの最後の ID */
export const searchMessages = (
  workspaceId: string,
  q: string,
  cursor: number | undefined,
  signal?: AbortSignal,
) =>
  apiFetch<SearchResponse>(
    `/api/workspaces/${workspaceId}/search?q=${encodeURIComponent(q)}${
      cursor === undefined ? '' : `&cursor=${cursor}`
    }`,
    { signal },
  );
