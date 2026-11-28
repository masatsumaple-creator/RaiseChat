import type { SearchResult } from '@raisechat/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { errorMessage } from '../api/client';
import { searchKey, searchMessages } from '../api/search';
import { excerptParts, isSearchable, normalizeTerm } from '../search/excerpt';
import { useCurrentWorkspace } from './WorkspaceShell';

/** 結果のチャンネルの表示(DM は、相手の名前。プライベートは、鍵つき) */
function resultChannelLabel(r: SearchResult): string {
  if (r.channelType === 'dm') return `@ ${r.peerName ?? ''}`;
  return `${r.channelType === 'private' ? '🔒' : '#'} ${r.channelName ?? ''}`;
}

/** 結果を開く先: そのチャンネル。返信なら、スレッドのパネルを開いた状態(thread=親の ID) */
function resultPath(workspaceId: string, r: SearchResult): string {
  const base = `/w/${workspaceId}/c/${r.channelId}`;
  return r.parentId === null ? base : `${base}?thread=${r.parentId}`;
}

/**
 * メッセージ検索の結果(FR-110)。検索語は、URL の q。2 文字以上のときだけ検索し、1 文字以下は、案内を出す。
 * 新しい順に、50 件ずつ(「さらに読み込む」)。権限のないチャンネル・DM は、サーバーが、結果に入れない。
 */
export function SearchPage() {
  const workspace = useCurrentWorkspace();
  const [params] = useSearchParams();
  const q = normalizeTerm(params.get('q') ?? '');
  const searchable = isSearchable(q);

  const query = useInfiniteQuery({
    queryKey: searchKey(workspace.id, q),
    queryFn: ({ pageParam, signal }) => searchMessages(workspace.id, q, pageParam, signal),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: searchable,
    retry: false,
  });

  const results = query.data?.pages.flatMap((p) => p.results) ?? [];

  return (
    <main>
      <h2>検索結果</h2>
      {!searchable && <p role="status">検索語は、2 文字以上で入力してください。</p>}
      {searchable && query.isPending && <p role="status">検索中…</p>}
      {query.isError && (
        <div role="alert">
          <p>{errorMessage(query.error)}</p>
          <button type="button" onClick={() => void query.refetch()}>
            再試行
          </button>
        </div>
      )}
      {searchable && query.isSuccess && results.length === 0 && (
        <p role="status">「{q}」に一致するメッセージは、見つかりませんでした。</p>
      )}
      {results.length > 0 && (
        <ul aria-label="検索結果">
          {results.map((r) => (
            <li key={r.id}>
              <Link to={resultPath(workspace.id, r)}>
                <strong>{r.author.displayName}</strong>{' '}
                <time dateTime={r.createdAt}>{new Date(r.createdAt).toLocaleString('ja-JP')}</time>{' '}
                <span className="search-channel">{resultChannelLabel(r)}</span>
                {r.parentId !== null && <span className="search-reply">(スレッドの返信)</span>}
                <div className="search-excerpt">
                  {excerptParts(r.body, q).map((part, i) =>
                    typeof part === 'string' ? part : <mark key={i}>{part.match}</mark>,
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {query.hasNextPage && (
        <button
          type="button"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          さらに読み込む
        </button>
      )}
    </main>
  );
}
