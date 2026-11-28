import {
  MESSAGE_PAGE_SIZE,
  messageListQuerySchema,
  postMessageSchema,
  type DeletedMessageResponse,
  type MessageResponse,
  type ReplyPageResponse,
} from '@raisechat/shared';
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { authOf } from '../auth/guards';
import { requireMessageChannel, targetMessageOf } from '../auth/message-guards';
import type { Db } from '../db/client';
import { channelMembers, messages, threadMembers, users } from '../db/schema';
import { AppError, parseWith } from '../errors';
import { attachmentsOf } from '../messages/attachments';
import { loadMentions, notifyMentions, syncMentions } from '../messages/mentions';
import { loadReactions } from '../messages/reactions';
import { chRoom, type Realtime } from '../realtime/realtime';
import { channelLockKey, countReplies, toMessageResponse } from './messages';

export interface ThreadRouteDeps {
  db: Db;
  realtime: Realtime;
}

const notFound = () => new AppError(404, 'not_found', '見つかりません。');

/**
 * スレッドの返信(FR-105)。親は、トップレベルのメッセージだけ。
 * 認可は、メッセージのチャンネルの参加者であること(参加者でなければ、存在を隠して 404。設計書 §4.1)。
 */
export function registerThreadRoutes(app: FastifyInstance, deps: ThreadRouteDeps): void {
  const { db, realtime } = deps;

  // 返信の投稿。親が削除済みなら 404、親が返信なら 400(返信への返信は、できない)
  app.post<{ Params: { id: string } }>(
    '/api/messages/:id/replies',
    { preHandler: requireMessageChannel(db) },
    async (request, reply): Promise<MessageResponse> => {
      const target = targetMessageOf(request);
      // 削除済みのメッセージへの、新しい返信は、404(設計書 §4.1)。返信への返信の判定より先
      if (target.deletedAt !== null) throw notFound();
      if (target.parentId !== null) {
        throw new AppError(400, 'bad_request', '返信には、返信できません。');
      }
      const { body } = parseWith(postMessageSchema, request.body);
      const me = authOf(request).user;

      const { row, replyCount, synced } = await db.transaction(async (tx) => {
        // 同じチャンネルの採番を、コミットの順に一致させる(設計書 §1.1。トップレベルの投稿と同じロック)
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${channelLockKey(target.channelId)})`);
        // 親を共有ロックして、削除済みでないことを確かめる。同時に親が削除されても、
        // 「削除済みの親に、返信が加わる」ことが起きないよう、削除(行の更新)との順序を決める
        const [parent] = await tx
          .select({ userId: messages.userId, deletedAt: messages.deletedAt })
          .from(messages)
          .where(and(eq(messages.id, target.id), eq(messages.channelId, target.channelId)))
          .for('share');
        if (!parent || parent.deletedAt !== null) throw notFound();

        const [inserted] = await tx
          .insert(messages)
          .values({
            channelId: target.channelId,
            userId: me.id,
            parentId: target.id,
            body,
          })
          .returning();
        // 返信した人と、親の投稿者を、スレッドの参加者にする(すでにいれば、何もしない)。
        // チャンネルの参加者の行を共有ロックして、まだ参加している人だけにする(キックされた親の投稿者を、
        // スレッドの参加者に戻さない。同時のキックとも、順序が決まる。FR-302)
        const present = await tx
          .select({ userId: channelMembers.userId })
          .from(channelMembers)
          .where(
            and(
              eq(channelMembers.channelId, target.channelId),
              inArray(channelMembers.userId, [me.id, parent.userId]),
            ),
          )
          .for('share');
        if (!present.some((p) => p.userId === me.id)) throw notFound();
        const members = [...new Set(present.map((p) => p.userId))];
        await tx
          .insert(threadMembers)
          .values(members.map((userId) => ({ rootMessageId: target.id, userId })))
          .onConflictDoNothing();
        const [count] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(messages)
          .where(and(eq(messages.parentId, target.id), isNull(messages.deletedAt)));
        const synced = await syncMentions(tx, {
          id: inserted!.id,
          channelId: target.channelId,
          authorId: me.id,
          body,
        });
        return { row: inserted!, replyCount: count?.n ?? 0, synced };
      });

      const response = toMessageResponse({ ...row, body }, me, 0, [], synced.mentions);
      // コミットの後に、チャンネルの参加者へ通知する(トップレベルの message:created は、送らない)
      realtime.emit(chRoom(target.channelId), 'thread:reply-created', {
        reply: response,
        replyCount,
      });
      notifyMentions(realtime, synced, response);
      return reply.status(201).send(response);
    },
  );

  // 返信の一覧(古い順。cursor は、前のページの最後の ID で、それより新しいものを返す)。
  // 親が削除済みでも、返信は読める(「削除されました」の親の下に残る)。削除済みの返信は、含めない
  app.get<{ Params: { id: string } }>(
    '/api/messages/:id/replies',
    { preHandler: requireMessageChannel(db) },
    async (request): Promise<ReplyPageResponse> => {
      const target = targetMessageOf(request);
      if (target.parentId !== null) {
        throw new AppError(400, 'bad_request', '返信には、返信できません。');
      }
      const { cursor } = parseWith(messageListQuerySchema, request.query);

      const rows = await db
        .select({
          id: messages.id,
          channelId: messages.channelId,
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
        .innerJoin(users, eq(users.id, messages.userId))
        .where(
          and(
            eq(messages.parentId, target.id),
            isNull(messages.deletedAt),
            cursor === undefined ? undefined : gt(messages.id, cursor),
          ),
        )
        .orderBy(asc(messages.id))
        // 次のページがあるかを知るため、1 件多く取る
        .limit(MESSAGE_PAGE_SIZE + 1);
      const page = rows.slice(0, MESSAGE_PAGE_SIZE);
      const reactionsById = await loadReactions(db, [
        ...page.map((r) => r.id),
        ...(target.deletedAt === null ? [target.id] : []),
      ]);
      const mentionsById = await loadMentions(db, [
        ...page.map((r) => r.id),
        ...(target.deletedAt === null ? [target.id] : []),
      ]);
      const replies = page.map((r) =>
        toMessageResponse(
          { ...r, body: r.body ?? '' },
          r.author,
          0,
          reactionsById.get(r.id) ?? [],
          mentionsById.get(r.id) ?? [],
        ),
      );

      const replyCount = await countReplies(db, target.id);
      let parent: ReplyPageResponse['parent'];
      if (target.deletedAt !== null || target.body === null) {
        const placeholder: DeletedMessageResponse = {
          id: target.id,
          channelId: target.channelId,
          createdAt: target.createdAt.toISOString(),
          replyCount,
          deleted: true,
        };
        parent = placeholder;
      } else {
        const [author] = await db
          .select({
            id: users.id,
            username: users.username,
            displayName: users.displayName,
            avatarKey: users.avatarKey,
          })
          .from(users)
          .where(eq(users.id, target.userId));
        parent = toMessageResponse(
          { ...target, body: target.body },
          author!,
          replyCount,
          reactionsById.get(target.id) ?? [],
          mentionsById.get(target.id) ?? [],
          await attachmentsOf(db, target.id),
        );
      }

      return {
        parent,
        replies,
        nextCursor: rows.length > MESSAGE_PAGE_SIZE ? page[page.length - 1]!.id : null,
      };
    },
  );
}
