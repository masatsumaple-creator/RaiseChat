CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"storage_key" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"original_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachments_kind_check" CHECK ("attachments"."kind" IN ('image', 'video')),
	CONSTRAINT "attachments_size_check" CHECK ("attachments"."size_bytes" > 0)
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_message_id_idx" ON "attachments" USING btree ("message_id");--> statement-breakpoint
-- 添付の行が消えたら(メッセージの削除・チャンネル削除の連鎖を含む)、実体の削除を、削除キューに積む(設計書 §2)
CREATE FUNCTION "enqueue_storage_deletion"() RETURNS trigger AS $$
BEGIN
  INSERT INTO "storage_deletions" ("storage_key") VALUES (OLD."storage_key");
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "attachments_enqueue_deletion"
  AFTER DELETE ON "attachments"
  FOR EACH ROW EXECUTE FUNCTION "enqueue_storage_deletion"();
