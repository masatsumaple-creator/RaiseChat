import {
  SEARCH_MIN_LENGTH,
  SEARCH_MAX_LENGTH,
  SEARCH_PAGE_SIZE,
  codePointLength,
  searchQuerySchema,
  type SearchResponse,
} from '@raisechat/shared';
import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { authOf } from '../auth/guards';
import { requireMember, workspaceOf } from '../auth/workspace-guards';
import type { Db } from '../db/client';
import { channelMembers, channels, messages, users } from '../db/schema';
import { AppError, parseWith } from '../errors';
import { avatarUrlFor } from '../profile/avatar';
import { loadPeers } from './channels';

export interface SearchRouteDeps {
  db: Db;
}

/**
 * LIKE の特殊文字を、文字そのものとして扱うために、エスケープする。
 * 順序が重要: 先に、エスケープ文字の \ を二重にし、そのあとで % と _ に \ を付ける(逆にすると、付けた \ が、二重になる)。
 * ESCAPE '\' の前提は、standard_conforming_strings がオン(PostgreSQL 16 の既定。設計書 §3.3)。
 */
export function escapeLike(term: string): string {
  return term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * メッセージ検索(FR-110。設計書 §3.3)。対象は、自分が参加しているチャンネル・DM の、削除済みでないメッセージ
 * (トップレベルも返信も)。ワークスペースを指定し、他のワークスペースの結果は、混ぜない。新しい順に 50 件ずつ。
 */
export function registerSearchRoutes(app: FastifyInstance, deps: SearchRouteDeps): void {
  const { db } = deps;

  app.get<{ Params: { ws: string } }>(
    '/api/workspaces/:ws/search',
    { preHandler: requireMember(db) },
    async (request): Promise<SearchResponse> => {
      const { q, cursor } = parseWith(searchQuerySchema, request.query);
      const term = q.trim();
      const length = codePointLength(term);
      if (length < SEARCH_MIN_LENGTH) {
        throw new AppError(
          400,
          'query_too_short',
          `検索語は、${SEARCH_MIN_LENGTH} 文字以上で入力してください。`,
        );
      }
      if (length > SEARCH_MAX_LENGTH) {
        throw new AppError(
          400,
          'query_too_long',
          `検索語は、${SEARCH_MAX_LENGTH} 文字以下にしてください。`,
        );
      }

      const me = authOf(request).user.id;
      const workspaceId = workspaceOf(request).workspaceId;
      const pattern = `%${escapeLike(term)}%`;

      const rows = await db
        .select({
          id: messages.id,
          channelId: messages.channelId,
          channelType: channels.type,
          channelName: channels.name,
          parentId: messages.parentId,
          body: messages.body,
          createdAt: messages.createdAt,
          editedAt: messages.editedAt,
          author: {
            id: users.id,
            username: users.username,
            displayName: users.displayName,
            avatarKey: users.avatarKey,
          },
        })
        .from(messages)
        .innerJoin(
          channels,
          and(eq(channels.id, messages.channelId), eq(channels.workspaceId, workspaceId)),
        )
        .innerJoin(
          channelMembers,
          and(eq(channelMembers.channelId, channels.id), eq(channelMembers.userId, me)),
        )
        .innerJoin(users, eq(users.id, messages.userId))
        .where(
          and(
            isNull(messages.deletedAt),
            sql`${messages.body} ILIKE ${pattern} ESCAPE '\\'`,
            cursor === undefined ? undefined : lt(messages.id, cursor),
          ),
        )
        .orderBy(desc(messages.id))
        // 次のページがあるかを知るため、1 件多く取る
        .limit(SEARCH_PAGE_SIZE + 1);

      const page = rows.slice(0, SEARCH_PAGE_SIZE);
      const peers = await loadPeers(db, me, [
        ...new Set(page.filter((r) => r.channelType === 'dm').map((r) => r.channelId)),
      ]);
      return {
        results: page.map((r) => ({
          id: r.id,
          channelId: r.channelId,
          channelType: r.channelType as SearchResponse['results'][number]['channelType'],
          channelName: r.channelName,
          peerName: peers.get(r.channelId)?.displayName ?? null,
          parentId: r.parentId,
          author: {
            id: r.author.id,
            username: r.author.username,
            displayName: r.author.displayName,
            avatarUrl: avatarUrlFor(r.author.id, r.author.avatarKey),
          },
          body: r.body ?? '',
          createdAt: r.createdAt.toISOString(),
          editedAt: r.editedAt?.toISOString() ?? null,
        })),
        nextCursor: rows.length > SEARCH_PAGE_SIZE ? page[page.length - 1]!.id : null,
      };
    },
  );
}
