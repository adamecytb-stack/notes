-- Column additions to tables that already exist.
--
-- schema.sql is all CREATE TABLE IF NOT EXISTS, which does nothing to a table
-- that is already there — so new columns on `users` have to be added here
-- instead. SQLite has no ADD COLUMN IF NOT EXISTS, so scripts/migrate.mjs runs
-- each line on its own and treats "duplicate column" as success. That makes
-- the whole file safe to re-run on every deploy.
--
-- One statement per line. Blank lines and -- comments are ignored.

ALTER TABLE users ADD COLUMN public_key TEXT;
ALTER TABLE users ADD COLUMN wrapped_private TEXT;
ALTER TABLE users ADD COLUMN wrapped_iv TEXT;

ALTER TABLE push_subscriptions ADD COLUMN bedtime_time TEXT NOT NULL DEFAULT '';
ALTER TABLE push_subscriptions ADD COLUMN wbtb_time TEXT NOT NULL DEFAULT '';
