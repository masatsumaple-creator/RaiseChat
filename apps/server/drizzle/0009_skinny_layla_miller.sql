CREATE TABLE "mentions" (
	"message_id" bigint NOT NULL,
	"user_id" uuid NOT NULL,
	"read_at" timestamp with time zone,
	CONSTRAINT "mentions_message_id_user_id_pk" PRIMARY KEY("message_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentions" ADD CONSTRAINT "mentions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mentions_unread_idx" ON "mentions" USING btree ("user_id") WHERE "mentions"."read_at" IS NULL;