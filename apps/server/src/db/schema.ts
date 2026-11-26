import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// 設計書 §2 のスキーマのうち、フェーズ 1 で作るもの(T3)。
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('workspaces_name_length', sql`char_length(${t.name}) BETWEEN 1 AND 50`)],
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
    // オーナーは各ワークスペースに 1 人。workspaces.owner_id と一致させる
    uniqueIndex('memberships_one_owner_key')
      .on(t.workspaceId)
      .where(sql`${t.role} = 'owner'`),
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
