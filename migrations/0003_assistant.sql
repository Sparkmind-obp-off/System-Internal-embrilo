-- 0003: internal AI assistant (controlled tool use) + confirmation-gated actions.
-- Additive only. The ai_usage rebuild keeps every existing row and only widens the
-- `operation` CHECK to allow 'assistant'.

CREATE TABLE IF NOT EXISTS assistant_messages (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id),
  job_id TEXT,                          -- order context (NULL = global inbox context)
  role TEXT NOT NULL CHECK (role IN ('OPERATOR', 'ASSISTANT')),
  body TEXT NOT NULL,                   -- operator question or deterministic answer text
  data_json TEXT NOT NULL DEFAULT '{}', -- structured tool result: tool, args, sources, rows, ai suggestion
  provider TEXT,                        -- set only when an AI provider contributed
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assistant_messages_op ON assistant_messages(operator_id, created_at);
CREATE INDEX IF NOT EXISTS idx_assistant_messages_job ON assistant_messages(operator_id, job_id, created_at);

CREATE TABLE IF NOT EXISTS assistant_actions (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  kind TEXT NOT NULL CHECK (kind IN ('create_prompt_draft', 'mark_prompt_ready', 'assign_to_me')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED', 'CONFIRMED', 'FAILED', 'CANCELLED')),
  result_note TEXT,
  message_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_assistant_actions_op ON assistant_actions(operator_id, status);

CREATE TABLE IF NOT EXISTS ai_usage_v2 (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  operation TEXT NOT NULL CHECK (operation IN ('generate', 'refine', 'analyze', 'health', 'assistant')),
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
INSERT INTO ai_usage_v2 SELECT id, job_id, operation, provider, model, status, error_code, duration_ms, input_tokens, output_tokens, neurons_est, created_by, created_at FROM ai_usage;
DROP TABLE ai_usage;
ALTER TABLE ai_usage_v2 RENAME TO ai_usage;
CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage(created_at);

-- Search helpers
CREATE INDEX IF NOT EXISTS idx_jobs_updated ON jobs(updated_at);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_prompt_versions_status ON prompt_versions(job_id, status);
