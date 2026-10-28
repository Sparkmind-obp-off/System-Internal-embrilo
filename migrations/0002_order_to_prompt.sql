-- Embrilo OS — order-to-prompt workspace (Prompt Studio)
-- Additive only: new tables + nullable/defaulted columns. Existing rows are untouched.
-- Rollback: migrations-rollback/0002_order_to_prompt.down.sql (manual, reviewed).

-- Work type chosen by the operator (NULL = derive from the order's service code).
ALTER TABLE jobs ADD COLUMN work_type TEXT;
-- Private operator notes for the order (never sent to customers or AI providers).
ALTER TABLE jobs ADD COLUMN internal_notes TEXT NOT NULL DEFAULT '';
-- Which prompt version a production run was executed with (NULL = legacy template).
ALTER TABLE production_runs ADD COLUMN prompt_version_id TEXT;

-- Versioned production prompts, always tied to one job/order.
CREATE TABLE IF NOT EXISTS prompt_versions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  version INTEGER NOT NULL,
  work_type TEXT NOT NULL,
  template_id TEXT NOT NULL,           -- e.g. video_short@1
  source TEXT NOT NULL CHECK (source IN ('TEMPLATE', 'AI', 'MANUAL')),
  provider TEXT,                       -- workers_ai | groq | NULL
  model TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'READY', 'SUPERSEDED')),
  note TEXT NOT NULL DEFAULT '',
  base_version_id TEXT,
  created_by TEXT NOT NULL REFERENCES operators(id),
  created_at TEXT NOT NULL,
  UNIQUE (job_id, version)
);
CREATE INDEX IF NOT EXISTS idx_prompt_versions_job ON prompt_versions(job_id, version);

-- Internal Prompt Studio log (operator instructions, assistant notes, system events) per job.
CREATE TABLE IF NOT EXISTS studio_messages (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  role TEXT NOT NULL CHECK (role IN ('OPERATOR', 'ASSISTANT', 'SYSTEM')),
  body TEXT NOT NULL,
  prompt_version_id TEXT,
  provider TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_studio_messages_job ON studio_messages(job_id, created_at);

-- Model usage metadata only (no prompt or brief text is stored here).
CREATE TABLE IF NOT EXISTS ai_usage (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  operation TEXT NOT NULL CHECK (operation IN ('generate', 'refine', 'analyze', 'health')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'error')),
  error_code TEXT,
  duration_ms INTEGER NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  neurons_est REAL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage(created_at);

-- Small key/value store for workspace settings (JSON values, no secrets).
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
