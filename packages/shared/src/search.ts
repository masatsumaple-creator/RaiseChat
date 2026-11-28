import { z } from 'zod';
import type { MessageAuthor } from './message';
import type { ChannelType } from './channel';

/** 検索語の最小の長さ(コードポイント数。FR-110)。1 文字以下は、検索しない */
export const SEARCH_MIN_LENGTH = 2;
/** 検索語の最大の長さ(コードポイント数) */
export const SEARCH_MAX_LENGTH = 100;
/** 検索結果の 1 ページの件数(設計書 §3.3) */
export const SEARCH_PAGE_SIZE = 50;

/** GET /workspaces/:ws/search の query。cursor は、前のページの最後のメッセージの ID */
export const searchQuerySchema = z.object({
  q: z.string().max(1000).default(''),
  cursor: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});

/** 検索結果の 1 件(削除済みでないメッセージ。トップレベルも返信も) */
export interface SearchResult {
  id: number;
  channelId: string;
  /** チャンネルの種類。DM は、name が null で、peer に相手 */
  channelType: ChannelType;
  channelName: string | null;
  /** DM なら、呼び出した人から見た相手の表示名 */
  peerName: string | null;
  /** 返信なら、親(トップレベル)の ID */
  parentId: number | null;
  author: MessageAuthor;
  body: string;
  createdAt: string;
  editedAt: string | null;
}

export interface SearchResponse {
  /** 新しい順 */
  results: SearchResult[];
  /** 次のページを取るための cursor。なければ null */
  nextCursor: number | null;
}
