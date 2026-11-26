CREATE TABLE "channel_members" (
	"channel_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"last_read_message_id" bigint DEFAULT 0 NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_members_channel_id_user_id_pk" PRIMARY KEY("channel_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" text NOT NULL,
	"name" text,
	"created_by" uuid,
	"is_default" boolean DEFAULT false NOT NULL,
	"dm_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channels_type_check" CHECK ("channels"."type" IN ('public', 'private', 'dm')),
	CONSTRAINT "channels_dm_name_check" CHECK (("channels"."type" = 'dm') = ("channels"."name" IS NULL)),
	CONSTRAINT "channels_dm_key_check" CHECK (("channels"."type" = 'dm') = ("channels"."dm_key" IS NOT NULL)),
	CONSTRAINT "channels_name_length" CHECK ("channels"."type" = 'dm' OR char_length("channels"."name") BETWEEN 1 AND 80)
);
--> statement-breakpoint
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_members_user_id_idx" ON "channel_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channels_name_key" ON "channels" USING btree ("workspace_id",lower("name")) WHERE "channels"."type" <> 'dm';--> statement-breakpoint
CREATE UNIQUE INDEX "channels_dm_key" ON "channels" USING btree ("workspace_id","dm_key") WHERE "channels"."type" = 'dm';--> statement-breakpoint
CREATE UNIQUE INDEX "channels_default_key" ON "channels" USING btree ("workspace_id") WHERE "channels"."is_default";