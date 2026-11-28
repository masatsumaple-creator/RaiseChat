import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// 設計書 §2 のスキーマのうち、フェーズ 1(T3)と、フェーズ 2 で作るもの(channels など)。
// 残りのテーブルは、使うフェーズで追加する。

/** ユーザー(アカウントはグローバル。要件定義書 §9 #3) */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(), // argon2id
    recoveryCodeHash: text('recovery_code_hash').notNull(), // argon2id(FR-005)
    displayName: text('display_name').notNull(),
    avatarKey: text('avatar_key'), // storage_key。未設定は null
    statusText: text('status_text').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('users_username_format', sql`${t.username} ~ '^[A-Za-z0-9_]{3,32}$'`),
    check('users_display_name_length', sql`char_length(${t.displayName}) BETWEEN 1 AND 50`),
    check('users_status_text_length', sql`char_length(${t.statusText}) <= 100`),
    // ユーザー名は、大文字小文字を区別せず一意
    uniqueIndex('users_username_lower_key').on(sql`lower(${t.username})`),
  ],
);

/** セッション(トークンはハッシュで保存。パスワード再設定時に user_id で一括削除する) */
export const sessions = pgTable(
  'sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('sessions_user_id_idx').on(t.userId)],
);

/** ワークスペース */
export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    // 常に 'owner'。(id, owner_id, owner_role) で、memberships の「オーナーの行」を参照するため(0001 の外部キー)
    ownerRole: text('owner_role')
      .notNull()
      .generatedAlwaysAs(sql`'owner'`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('workspaces_name_length', sql`char_length(${t.name}) BETWEEN 1 AND 50`),
    index('workspaces_owner_id_idx').on(t.ownerId),
  ],
);

/** 所属。kicked の行は、キックから解除までの間だけ存在する(FR-302, 304) */
export const memberships = pgTable(
  'memberships',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role').notNull(),
    status: text('status').notNull().default('active'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    check('memberships_role_check', sql`${t.role} IN ('owner', 'member')`),
    check('memberships_status_check', sql`${t.status} IN ('active', 'kicked')`),
    index('memberships_user_id_idx').on(t.userId),
    // オーナーは各ワークスペースに 1 人
    uniqueIndex('memberships_one_owner_key')
      .on(t.workspaceId)
      .where(sql`${t.role} = 'owner'`),
    // workspaces の外部キー(0001)が参照する。workspaces.owner_id と、オーナーの行の一致を DB で保証する
    uniqueIndex('memberships_workspace_user_role_key').on(t.workspaceId, t.userId, t.role),
  ],
);

/** 添付・アバターの実体の削除キュー(要件定義書 §9 #8) */
export const storageDeletions = pgTable(
  'storage_deletions',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    storageKey: text('storage_key').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    retryCount: integer('retry_count').notNull().default(0),
  },
  (t) => [
    index('storage_deletions_pending_idx')
      .on(t.id)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

/** チャンネル(パブリック・プライベート・DM)。DM は、フェーズ 3 で使う(列だけ先に持つ) */
export const channels = pgTable(
  'channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    name: text('name'), // dm は null
    createdBy: uuid('created_by').references(() => users.id), // dm は null
    isDefault: boolean('is_default').notNull().default(false), // general。退出・削除不可(FR-203)
    dmKey: text('dm_key'), // DM の重複防止。小さい方の user_id + ':' + 大きい方
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('channels_type_check', sql`${t.type} IN ('public', 'private', 'dm')`),
    check('channels_dm_name_check', sql`(${t.type} = 'dm') = (${t.name} IS NULL)`),
    check('channels_dm_key_check', sql`(${t.type} = 'dm') = (${t.dmKey} IS NOT NULL)`),
    check('channels_name_length', sql`${t.type} = 'dm' OR char_length(${t.name}) BETWEEN 1 AND 80`),
    // 名前は、同一ワークスペース内で、大文字小文字を区別せず一意(FR-202)
    uniqueIndex('channels_name_key')
      .on(t.workspaceId, sql`lower(${t.name})`)
      .where(sql`${t.type} <> 'dm'`),
    uniqueIndex('channels_dm_key')
      .on(t.workspaceId, t.dmKey)
      .where(sql`${t.type} = 'dm'`),
    // 既定チャンネル(general)は、ワークスペースに 1 つ
    uniqueIndex('channels_default_key')
      .on(t.workspaceId)
      .where(sql`${t.isDefault}`),
  ],
);

/** チャンネルの参加者と、チャンネル単位の既読位置・ミュート(FR-401, 403) */
export const channelMembers = pgTable(
  'channel_members',
  {
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    lastReadMessageId: bigint('last_read_message_id', { mode: 'number' }).notNull().default(0),
    muted: boolean('muted').notNull().default(false),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.channelId, t.userId] }),
    index('channel_members_user_id_idx').on(t.userId),
  ],
);

/** 招待リンク(FR-301)。トークンは平文で保存せず、ハッシュだけを保存する */
export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    maxUses: integer('max_uses'), // null は無制限
    usedCount: integer('used_count').notNull().default(0),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('invitations_max_uses_check', sql`${t.maxUses} IS NULL OR ${t.maxUses} > 0`),
    check('invitations_used_count_check', sql`${t.usedCount} >= 0`),
    index('invitations_workspace_id_idx').on(t.workspaceId),
  ],
);

/**
 * メッセージ(FR-101、103〜105)。parent_id が null ならトップレベル、そうでなければスレッドの返信(1 段のみ。
 * 返信の親が、トップレベルであることは、DB では表せないため、アプリで検証する。設計書 §2.1)。
 * 論理削除(FR-104)では、本文を null にして deleted_at を設定する(本文の有無と、削除の有無は、一致する)。
 */
export const messages = pgTable(
  'messages',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    parentId: bigint('parent_id', { mode: 'number' }),
    body: text('body'), // 削除時は null(FR-104)
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    check(
      'messages_body_length',
      sql`${t.body} IS NULL OR char_length(${t.body}) BETWEEN 1 AND 4000`,
    ),
    // 本文が null であることと、削除済みであることは、同じ
    check('messages_deleted_check', sql`(${t.deletedAt} IS NULL) = (${t.body} IS NOT NULL)`),
    // 親が、同じチャンネルのメッセージであることを、DB で保証する(複合外部キー)
    unique('messages_id_channel_key').on(t.id, t.channelId),
    foreignKey({
      columns: [t.parentId, t.channelId],
      foreignColumns: [t.id, t.channelId],
      name: 'messages_parent_fk',
    }).onDelete('cascade'),
    // チャンネルの履歴(トップレベル。新しい順)
    index('messages_channel_top_idx')
      .on(t.channelId, sql`${t.id} DESC`)
      .where(sql`${t.parentId} IS NULL`),
    // スレッドの返信
    index('messages_thread_idx')
      .on(t.parentId, t.id)
      .where(sql`${t.parentId} IS NOT NULL`),
  ],
);
