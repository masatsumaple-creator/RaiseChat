ALTER TABLE "workspaces" ADD COLUMN "owner_role" text GENERATED ALWAYS AS ('owner') STORED NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_workspace_user_role_key" ON "memberships" USING btree ("workspace_id","user_id","role");--> statement-breakpoint
CREATE INDEX "workspaces_owner_id_idx" ON "workspaces" USING btree ("owner_id");