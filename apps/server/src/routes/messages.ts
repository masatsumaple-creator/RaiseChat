import {
  MESSAGE_PAGE_SIZE,
  messageListQuerySchema,
  postMessageSchema,
  type DeletedMessageResponse,
  type MessageListItem,
  type MessagePageResponse,
  type MessageResponse,
  type MentionResponse,
  type ReactionSummary,
} from '@raisechat/shared';
import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { channelOf, requireChannel } from '../auth/channel-guards';
import { authOf } from '../auth/guards';
import { messageOf, requireAuthor } from '../auth/message-guards';
import type { Db } from '../db/client';
import { messages, mentions, reactions, users } from '../db/schema';
import { AppError, parseWith } from '../errors';
import { loadMentions, mentionsOf, notifyMentions, syncMentions } from '../messages/mentions';
import { loadReactions, reactionsOf } from '../messages/reactions';
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

interface MessageRow {
  id: number;
  channelId: string;
  parentId: number | null;
  body: string;
  createdAt: Date;
  editedAt: Date | null;
}

/** メッセージの応答の形。WebSocket のイベントでも、同じ形を使う */
export function toMessageResponse(
  row: MessageRow,
  author: AuthorRow,
  replyCount: number,
  reactions: ReactionSummary[],
  mentions: MentionResponse[],
): MessageResponse {
  return {
    id: row.id,
    channelId: row.channelId,
    parentId: row.parentId,
    author: {
      id: author.id,
      username: author.username,
      displayName: author.displayName,
      avatarUrl: avatarUrlFor(author.id, author.avatarKey),
    },
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
    replyCount,
    reactions,
    mentions,
    deleted: false,
  };
}

/** チャンネルごとの advisory lock のキー(チャンネル ID から、64 ビットの整数を作る) */
export function channelLockKey(channelId: string) {
  return sql`hashtextextended(${channelId}, 0)`;
}

/** あるメッセージの返信数(削除済みの返信は数えない)。外側の messages の行から参照する */
const replyCountOf = (parentId: typeof messages.id) =>
  sql<number>`(SELECT count(*)::int FROM messages r WHERE r.parent_id = ${parentId} AND r.deleted_at IS NULL)`;

/** 削除済みでない返信の数を数える */
export async function countReplies(db: Db, parentId: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(messages)
    .where(and(eq(messages.parentId, parentId), isNull(messages.deletedAt)));
  return row?.n ?? 0;
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
        const synced = await syncMentions(tx, {
          id: inserted!.id,
          channelId,
          authorId: me.id,
          body,
        });
        return { inserted: inserted!, synced };
      });
      const response = toMessageResponse({ ...row.inserted, body }, me, 0, [], row.synced.mentions);
      // コミットの後に、チャンネルの参加者へ通知する(設計書 §6.4)
      realtime.emit(chRoom(channelId), 'message:created', response);
      notifyMentions(realtime, row.synced, response);
      return reply.status(201).send(response);
    },
  );

  // FR-101: トップレベルを、新しい順に 50 件ずつ。cursor は、前のページの最後の ID(それより古いものを返す)。
  // 削除済みのトップレベルは、返信(削除済みでないもの)が 1 つ以上あるときだけ含める(FR-104、105)
  app.get<{ Params: { ch: string } }>(
    '/api/channels/:ch/messages',
    { preHandler: requireChannel(db) },
    async (request): Promise<MessagePageResponse> => {
      const { cursor } = parseWith(messageListQuerySchema, request.query);
      const replyCount = replyCountOf(messages.id);
      const rows = await db
        .select({
          id: messages.id,
          channelId: messages.channelId,
          parentId: messages.parentId,
          body: messages.body,
          createdAt: messages.createdAt,
          editedAt: messages.editedAt,
          deletedAt: messages.deletedAt,
          replyCount,
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
            isNull(messages.parentId),
            sql`(${messages.deletedAt} IS NULL OR ${replyCount} > 0)`,
            cursor === undefined ? undefined : lt(messages.id, cursor),
          ),
        )
        .orderBy(desc(messages.id))
        // 次のページがあるかを知るため、1 件多く取る
        .limit(MESSAGE_PAGE_SIZE + 1);

      const page = rows.slice(0, MESSAGE_PAGE_SIZE);
      const hasMore = rows.length > MESSAGE_PAGE_SIZE;
      const reactionsById = await loadReactions(
        db,
        page.filter((r) => r.deletedAt === null).map((r) => r.id),
      );
      const mentionsById = await loadMentions(
        db,
        page.filter((r) => r.deletedAt === null).map((r) => r.id),
      );
      const items: MessageListItem[] = page.map((r) => {
        if (r.deletedAt !== null || r.body === null) {
          const deleted: DeletedMessageResponse = {
            id: r.id,
            channelId: r.channelId,
            createdAt: r.createdAt.toISOString(),
            replyCount: r.replyCount,
            deleted: true,
          };
          return deleted;
        }
        return toMessageResponse(
          { ...r, body: r.body },
          r.author,
          r.replyCount,
          reactionsById.get(r.id) ?? [],
          mentionsById.get(r.id) ?? [],
        );
      });
      return { messages: items, nextCursor: hasMore ? page[page.length - 1]!.id : null };
    },
  );

  // FR-103: 編集(投稿者だけ)。本文が変わらなければ、何もせず成功(「編集済み」を付けない)
  app.patch<{ Params: { id: string } }>(
    '/api/messages/:id',
    { preHandler: requireAuthor(db) },
    async (request): Promise<MessageResponse> => {
      const { body } = parseWith(postMessageSchema, request.body);
      const current = messageOf(request);
      const me = authOf(request).user;
      const author = {
        id: me.id,
        username: me.username,
        displayName: me.displayName,
        avatarKey: me.avatarKey,
      };

      if (body === current.body) {
        return toMessageResponse(
          current,
          author,
          await countReplies(db, current.id),
          await reactionsOf(db, current.id),
          await mentionsOf(db, current.id),
        );
      }

      // 削除済みでないときだけ更新する(判定の後に、削除された場合も、矛盾を残さない)
      // 同じトランザクションで、メンションを差分更新する(新しく加わった人だけが、通知の対象)
      const result = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(messages)
          .set({ body, editedAt: sql`now()` })
          .where(and(eq(messages.id, current.id), isNull(messages.deletedAt)))
          .returning();
        if (!row) return null;
        const synced = await syncMentions(tx, {
          id: row.id,
          channelId: row.channelId,
          authorId: me.id,
          body,
        });
        return { updated: row, synced };
      });
      if (!result) throw new AppError(404, 'not_found', '見つかりません。');
      const { updated, synced } = result;

      const response = toMessageResponse(
        { ...updated, body },
        author,
        await countReplies(db, updated.id),
        await reactionsOf(db, updated.id),
        synced.mentions,
      );
      // トップレベルは message:updated、返信は thread:reply-updated(どちらか一方だけ送る。設計書 §10 の T17)
      if (response.parentId === null) {
        realtime.emit(chRoom(response.channelId), 'message:updated', response);
      } else {
        realtime.emit(chRoom(response.channelId), 'thread:reply-updated', response);
      }
      notifyMentions(realtime, synced, response);
      return response;
    },
  );

  // FR-104: 削除(投稿者だけ)。論理削除: 本文を破棄し、deleted_at を設定する
  app.delete<{ Params: { id: string } }>(
    '/api/messages/:id',
    { preHandler: requireAuthor(db) },
    async (request, reply) => {
      const current = messageOf(request);
      // すでに削除されていれば(判定の後の、同時の削除)、404
      // 同じトランザクションで、リアクション・メンションも無効にする(FR-104。設計書 §2.1)
      const deleted = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(messages)
          .set({ body: null, deletedAt: sql`now()` })
          .where(and(eq(messages.id, current.id), isNull(messages.deletedAt)))
          .returning({ id: messages.id });
        if (!row) return false;
        await tx.delete(reactions).where(eq(reactions.messageId, current.id));
        await tx.delete(mentions).where(eq(mentions.messageId, current.id));
        return true;
      });
      if (!deleted) throw new AppError(404, 'not_found', '見つかりません。');

      // 通知には、本文を含めない。トップレベルは message:deleted(自分の返信数)、
      // 返信は thread:reply-deleted(親の返信数)。どちらか一方だけ送る
      if (current.parentId === null) {
        realtime.emit(chRoom(current.channelId), 'message:deleted', {
          id: current.id,
          channelId: current.channelId,
          replyCount: await countReplies(db, current.id),
        });
      } else {
        realtime.emit(chRoom(current.channelId), 'thread:reply-deleted', {
          id: current.id,
          channelId: current.channelId,
          parentId: current.parentId,
          replyCount: await countReplies(db, current.parentId),
        });
      }
      return reply.status(204).send();
    },
  );
}
