-- MANUAL ROLLBACK for migrations/0003_assistant.sql. Not applied automatically.
-- Deletes assistant conversations and pending/decided assistant actions. Back up first:
--   npx wrangler d1 export embrilo-os-production --remote --output=backup.sql
-- ai_usage keeps its widened CHECK (harmless for 0002 code); rows with operation='assistant' are removed.
DROP TABLE IF EXISTS assistant_actions;
DROP TABLE IF EXISTS assistant_messages;
DELETE FROM ai_usage WHERE operation = 'assistant';
DROP INDEX IF EXISTS idx_jobs_updated;
DROP INDEX IF EXISTS idx_jobs_created;
DROP INDEX IF EXISTS idx_prompt_versions_status;
DELETE FROM d1_migrations WHERE name = '0003_assistant.sql';
