-- workspaces.owner_id と、memberships のオーナーの行の一致を、DB で保証する(設計書 §2)。
-- (id, owner_id, owner_role) が、(workspace_id, user_id, role) の行を指す。owner_role は常に 'owner'。
-- これにより、次のことが DB で保証される。
--   - ワークスペースには、owner_id のユーザーの、role が owner の membership の行が必ずある
--   - その行を、削除したり、role を変えたり、別のユーザーに付け替えたりできない
--   - オーナーの行は、memberships_one_owner_key により、ワークスペースごとに 1 つだけ
-- ワークスペースと、オーナーの行は、相互に参照するため、同じトランザクションで作り、
-- 外部キーの検査は、コミットまで遅らせる(DEFERRABLE INITIALLY DEFERRED)。
ALTER TABLE "workspaces"
  ADD CONSTRAINT "workspaces_owner_membership_fk"
  FOREIGN KEY ("id", "owner_id", "owner_role")
  REFERENCES "memberships" ("workspace_id", "user_id", "role")
  DEFERRABLE INITIALLY DEFERRED;
