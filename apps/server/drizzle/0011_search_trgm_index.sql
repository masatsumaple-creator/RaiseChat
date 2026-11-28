-- メッセージ検索(FR-110。設計書 §2・§3.3)。部分一致(ILIKE)を、トライグラムの索引で速くする。
-- 削除済みのメッセージは、索引に含めない(検索の対象外)。
-- pg_trgm は、信頼された拡張(PostgreSQL 13 以降)なので、データベースの所有者が作れる。
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX "messages_body_trgm_idx" ON "messages" USING gin ("body" gin_trgm_ops) WHERE "deleted_at" IS NULL;
