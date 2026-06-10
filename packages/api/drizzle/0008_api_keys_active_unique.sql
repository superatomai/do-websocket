-- Enforce AT MOST ONE ACTIVE api key per project, while keeping revoked rows
-- (is_active = false) for history so revoke→create rotation works.
--
-- NOTE: this project's prod DB is reconciled via `drizzle-kit push` (the
-- drizzle migration journal is empty), so this statement is applied directly
-- rather than through `db:migrate`. It is also declared in src/db/schema.ts
-- (uniqueIndex "idx_api_keys_active") so future `db:push` runs keep it.
CREATE UNIQUE INDEX "idx_api_keys_active" ON "api_keys" USING btree ("project_id") WHERE "is_active" = true;
