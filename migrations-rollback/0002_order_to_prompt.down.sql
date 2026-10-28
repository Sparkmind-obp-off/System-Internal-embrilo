-- MANUAL ROLLBACK for migrations/0002_order_to_prompt.sql. Not applied automatically.
-- Review first: this permanently deletes prompt versions, studio logs, AI usage and settings.
-- Back up with `wrangler d1 export embrilo-os-production --remote --output=backup.sql` before running.
DROP TABLE IF EXISTS app_settings;
DROP TABLE IF EXISTS ai_usage;
DROP TABLE IF EXISTS studio_messages;
DROP TABLE IF EXISTS prompt_versions;
ALTER TABLE production_runs DROP COLUMN prompt_version_id;
ALTER TABLE jobs DROP COLUMN internal_notes;
ALTER TABLE jobs DROP COLUMN work_type;
-- Finally remove the migration record so it can be re-applied later:
DELETE FROM d1_migrations WHERE name = '0002_order_to_prompt.sql';
