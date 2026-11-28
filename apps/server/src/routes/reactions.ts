import {
  isSingleEmoji,
  MAX_REACTION_KINDS_PER_MESSAGE,
  type ReactionSummary,
} from '@raisechat/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { authOf } from '../auth/guards';
import { requireMessageChannel, targetMessageOf } from '../auth/message-guards';
import type { Db } from '../db/client';
import { messages, reactions } from '../db/schema';
import { AppError } from '../errors';
import { emojiState } from '../messages/reactions';
import { chRoom, type Realtime } from '../realtime/realtime';

export interface ReactionRouteDeps {
  db: Db;
  realtime: Realtime;
}

const notFound = () => new AppError(404, 'not_found', '見つかりません。');

const invalidEmoji = () =>
  new AppError(400, 'invalid_emoji', 'リアクションは、絵文字 1 つだけ指定できます。');

/**
 * 絵文字リアクション(FR-108)。メッセージ(トップレベルも返信も)のチャンネルの参加者だけが、付けられる
 * (参加者でなければ、存在を隠して 404。設計書 §4.1)。絵文字は、パスにパーセントエンコードして指定する。
 */
export function registerReactionRoutes(app: FastifyInstance, deps: ReactionRouteDeps): void {
  const { db, realtime } = deps;

  // 付与。すでに付けていれば、何もせず成功(冪等)。削除済みのメッセージには、付けられない(404)
  app.put<{ Params: { id: string; emoji: string } }>(
    '/api/messages/:id/reactions/:emoji',
    { preHandler: requireMessageChannel(db) },
    async (request): Promise<ReactionSummary> => {
      const target = targetMessageOf(request);
      if (target.deletedAt !== null) throw notFound();
      const emoji = request.params.emoji;
      if (!isSingleEmoji(emoji)) throw invalidEmoji();
      const me = authOf(request).user.id;

      const added = await db.transaction(async (tx) => {
        // メッセージの行をロックする。同時の付与でも、種類の上限を超えないよう、順に処理する。
        // 同時の削除(リアクションの無効化)とも、順序が決まる
        const [message] = await tx
          .select({ deletedAt: messages.deletedAt })
          .from(messages)
          .where(eq(messages.id, target.id))
          .for('update');
        if (!message || message.deletedAt !== null) throw notFound();

        const kinds = await tx
          .selectDistinct({ emoji: reactions.emoji })
          .from(reactions)
          .where(eq(reactions.messageId, target.id));
        const mine = await tx
          .select({ emoji: reactions.emoji })
          .from(reactions)
          .where(
            and(
              eq(reactions.messageId, target.id),
              eq(reactions.userId, me),
              eq(reactions.emoji, emoji),
            ),
          );
        if (mine.length > 0) return false; // すでに付けている

        // 新しい種類の絵文字は、上限(20)まで
        const isNewKind = !kinds.some((k) => k.emoji === emoji);
        if (isNewKind && kinds.length >= MAX_REACTION_KINDS_PER_MESSAGE) {
          throw new AppError(
            400,
            'too_many_reactions',
            `1 つのメッセージに付けられる絵文字は、${MAX_REACTION_KINDS_PER_MESSAGE} 種類までです。`,
          );
        }
        await tx.insert(reactions).values({ messageId: target.id, userId: me, emoji });
        return true;
      });

      const state = await emojiState(db, target.id, emoji);
      // 新しく付けたときだけ、通知する(コミットの後)。差分ではなく、その絵文字の、いまの状態を送る
      if (added) {
        realtime.emit(chRoom(target.channelId), 'reaction:added', {
          messageId: target.id,
          channelId: target.channelId,
          ...state,
        });
      }
      return state;
    },
  );

  // 解除(自分のリアクションだけ)。冪等: 付けていなくても、削除済みのメッセージでも、成功する
  app.delete<{ Params: { id: string; emoji: string } }>(
    '/api/messages/:id/reactions/:emoji',
    { preHandler: requireMessageChannel(db) },
    async (request, reply) => {
      const target = targetMessageOf(request);
      const emoji = request.params.emoji;
      if (!isSingleEmoji(emoji)) throw invalidEmoji();

      const removed = await db
        .delete(reactions)
        .where(
          and(
            eq(reactions.messageId, target.id),
            eq(reactions.userId, authOf(request).user.id),
            eq(reactions.emoji, emoji),
          ),
        )
        .returning({ emoji: reactions.emoji });

      if (removed.length > 0) {
        realtime.emit(chRoom(target.channelId), 'reaction:removed', {
          messageId: target.id,
          channelId: target.channelId,
          ...(await emojiState(db, target.id, emoji)),
        });
      }
      return reply.status(204).send();
    },
  );
}
