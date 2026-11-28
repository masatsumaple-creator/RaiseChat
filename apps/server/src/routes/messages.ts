import {
  MESSAGE_PAGE_SIZE,
  messageListQuerySchema,
  postMessageSchema,
  type MessagePageResponse,
  type MessageResponse,
} from '@raisechat/shared';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { channelOf, requireChannel } from '../auth/channel-guards';
import { authOf } from '../auth/guards';
import type { Db } from '../db/client';
import { messages, users } from '../db/schema';
import { parseWith } from '../errors';
import { avatarUrlFor } from '../profile/avatar';
import { chRoom, type Realtime } from '../realtime/realtime';

export interface MessageRouteDeps {
  db: Db;
  realtime: Realtime;
}

interface AuthorRow {
  id: string;
  username: string;
  displayName: string;
  avatarKey: string | null;
}

/** メッセージの応答の形。WebSocket のイベント(message:created)でも、同じ形を使う */
export function toMessageResponse(
  row: { id: number; channelId: string; body: string; createdAt: Date },
  author: AuthorRow,
): MessageResponse {
  return {
    id: row.id,
    channelId: row.channelId,
    author: {
      id: author.id,
      username: author.username,
      displayName: author.displayName,
      avatarUrl: avatarUrlFor(author.id, author.avatarKey),
    },
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}

/** チャンネルごとの advisory lock のキー(チャンネル ID から、64 ビットの整数を作る) */
export function channelLockKey(channelId: string) {
  return sql`hashtextextended(${channelId}, 0)`;
}

export function registerMessageRoutes(app: FastifyInstance, deps: MessageRouteDeps): void {
  const { db, realtime } = deps;

  // FR-101: 投稿(参加者のみ。参加者でなければ、存在を隠して 404)
  app.post<{ Params: { ch: string } }>(
    '/api/channels/:ch/messages',
    { preHandler: requireChannel(db) },
    async (request, reply): Promise<MessageResponse> => {
      const { body } = parseWith(postMessageSchema, request.body);
      const channelId = channelOf(request).id;
      const me = authOf(request).user;
      // チャンネル単位の advisory lock を取ってから挿入する。同じチャンネル内で、採番(ID)の順と、
      // コミットの順を一致させるため(設計書 §1.1。既読位置・ページングで、取りこぼしが起きないように)。
      // ロックは、トランザクションの終了(コミット)で、解放される
      const row = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${channelLockKey(channelId)})`);
        const [inserted] = await tx
          .insert(messages)
          .values({ channelId, userId: me.id, body })
          .returning();
        return inserted!;
      });
      const response = toMessageResponse(row, {
        id: me.id,
        username: me.username,
        displayName: me.displayName,
        avatarKey: me.avatarKey,
      });
      // コミットの後に、チャンネルの参加者へ通知する(設計書 §6.4)
      realtime.emit(chRoom(channelId), 'message:created', response);
      return reply.status(201).send(response);
    },
  );

  // FR-101: 新しい順に 50 件ずつ。cursor は、前のページの最後の ID(それより古いものを返す)
  app.get<{ Params: { ch: string } }>(
    '/api/channels/:ch/messages',
    { preHandler: requireChannel(db) },
    async (request): Promise<MessagePageResponse> => {
      const { cursor } = parseWith(messageListQuerySchema, request.query);
      const rows = await db
        .select({
          id: messages.id,
          channelId: messages.channelId,
          body: messages.body,
          createdAt: messages.createdAt,
          author: {
            id: users.id,
            username: users.username,
            displayName: users.displayName,
            avatarKey: users.avatarKey,
          },
        })
        .from(messages)
        .innerJoin(users, eq(users.id, messages.userId))
        .where(
          and(
            eq(messages.channelId, channelOf(request).id),
            cursor === undefined ? undefined : lt(messages.id, cursor),
          ),
        )
        .orderBy(desc(messages.id))
        // 次のページがあるかを知るため、1 件多く取る
        .limit(MESSAGE_PAGE_SIZE + 1);

      const page = rows.slice(0, MESSAGE_PAGE_SIZE);
      const hasMore = rows.length > MESSAGE_PAGE_SIZE;
      return {
        messages: page.map((r) => toMessageResponse(r, r.author)),
        nextCursor: hasMore ? page[page.length - 1]!.id : null,
      };
    },
  );
}
