CREATE TABLE "thread_members" (
	"root_message_id" bigint NOT NULL,
	"user_id" uuid NOT NULL,
	"last_read_message_id" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "thread_members_root_message_id_user_id_pk" PRIMARY KEY("root_message_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "thread_members" ADD CONSTRAINT "thread_members_root_message_id_messages_id_fk" FOREIGN KEY ("root_message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_members" ADD CONSTRAINT "thread_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;