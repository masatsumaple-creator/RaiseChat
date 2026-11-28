ALTER TABLE "messages" DROP CONSTRAINT "messages_body_length";
--> statement-breakpoint
DROP INDEX "messages_channel_idx";
--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "body" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "parent_id" bigint;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "edited_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "deleted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_id_channel_key" UNIQUE("id","channel_id");
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_parent_fk" FOREIGN KEY ("parent_id","channel_id") REFERENCES "public"."messages"("id","channel_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "messages_channel_top_idx" ON "messages" USING btree ("channel_id","id" DESC) WHERE "messages"."parent_id" IS NULL;
--> statement-breakpoint
CREATE INDEX "messages_thread_idx" ON "messages" USING btree ("parent_id","id") WHERE "messages"."parent_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_deleted_check" CHECK (("messages"."deleted_at" IS NULL) = ("messages"."body" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_body_length" CHECK ("messages"."body" IS NULL OR char_length("messages"."body") BETWEEN 1 AND 4000);