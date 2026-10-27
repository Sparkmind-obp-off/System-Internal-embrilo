-- Embrilo OS — initial schema (D1 / SQLite)
-- Public repository: schema only. No real data here.
-- Identifiers are random UUIDs generated server-side. Timestamps are ISO-8601 UTC strings.

-- ---------------------------------------------------------------------------
-- Operators (internal console users) and sessions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operators (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ADMIN', 'OPERATOR', 'VIEWER')),
  password_hash TEXT NOT NULL,          -- format: pbkdf2-sha256$<iterations>$<salt_b64url>$<hash_b64url>
  active INTEGER NOT NULL DEFAULT 1,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,             -- SHA-256 of the session token; the raw token only lives in the cookie
  operator_id TEXT NOT NULL REFERENCES operators(id),
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_operator ON sessions(operator_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ---------------------------------------------------------------------------
-- Customers, orders, briefs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  external_ref TEXT NOT NULL UNIQUE,    -- opaque customer identifier owned by Public Embrilo (no email/phone)
  display_name TEXT NOT NULL,
  consent_at TEXT NOT NULL,
  consent_terms_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  public_ref TEXT NOT NULL UNIQUE,      -- shown to the customer; NEVER sufficient for authorization on its own
  customer_id TEXT NOT NULL REFERENCES customers(id),
  service_code TEXT NOT NULL,
  token_version INTEGER NOT NULL DEFAULT 1, -- bump to revoke the customer access token
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);

CREATE TABLE IF NOT EXISTS briefs (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  objective TEXT NOT NULL,
  audience TEXT NOT NULL,
  product_facts TEXT NOT NULL,
  platforms TEXT NOT NULL,              -- JSON array of platform codes
  language TEXT NOT NULL,
  tone TEXT NOT NULL DEFAULT '',
  cta TEXT NOT NULL DEFAULT '',
  constraints TEXT NOT NULL DEFAULT '',
  references_json TEXT NOT NULL DEFAULT '[]', -- untrusted; never fetched server-side
  rights_confirmed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Jobs and workflow state
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  state TEXT NOT NULL CHECK (state IN (
    'SUBMITTED','TRIAGE','QUEUED','IN_PRODUCTION','QC_REVIEW','APPROVED','DELIVERED',
    'NEEDS_INFO','NEEDS_REVISION','BLOCKED_PROVIDER','FAILED','CANCELLED')),
  priority TEXT NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
  attempts INTEGER NOT NULL DEFAULT 0,
  revision_round INTEGER NOT NULL DEFAULT 0,
  assigned_operator_id TEXT REFERENCES operators(id),
  customer_message TEXT NOT NULL DEFAULT '', -- customer-safe note (e.g. what info is missing)
  version INTEGER NOT NULL DEFAULT 1,        -- optimistic concurrency for state changes
  last_transition_id TEXT,                   -- guards atomic history insert inside a D1 batch
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state);
CREATE INDEX IF NOT EXISTS idx_jobs_assigned ON jobs(assigned_operator_id);

CREATE TABLE IF NOT EXISTS job_state_history (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  from_state TEXT,
  to_state TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('OPERATOR','CONNECTOR','SYSTEM')),
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  correlation_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_job ON job_state_history(job_id, created_at);

-- ---------------------------------------------------------------------------
-- Production runs, assets, reviews, revisions, deliveries
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS production_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  provider TEXT NOT NULL,               -- e.g. genspark-manual, manual-writer
  mode TEXT NOT NULL CHECK (mode IN ('manual','api','mcp')),
  template_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED','BLOCKED')),
  input_digest TEXT NOT NULL,           -- SHA-256 of the sanitized prompt (provenance without storing it twice)
  operator_id TEXT NOT NULL REFERENCES operators(id),
  output_asset_id TEXT,
  error_code TEXT,
  error_note TEXT,                      -- operator-written, must not contain secrets
  cost_estimate_cents INTEGER,
  operator_minutes INTEGER,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_job ON production_runs(job_id, started_at);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  run_id TEXT REFERENCES production_runs(id),
  kind TEXT NOT NULL CHECK (kind IN ('REFERENCE','DRAFT')),
  storage TEXT NOT NULL CHECK (storage IN ('R2','INLINE')),
  storage_key TEXT,                     -- random R2 key (no customer data in key)
  inline_text TEXT,                     -- small text drafts stored privately in D1
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'INTERNAL' CHECK (visibility IN ('INTERNAL','CUSTOMER')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assets_order ON assets(order_id);
CREATE INDEX IF NOT EXISTS idx_assets_job ON assets(job_id);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  run_id TEXT NOT NULL REFERENCES production_runs(id),
  reviewer_id TEXT NOT NULL REFERENCES operators(id),
  decision TEXT NOT NULL CHECK (decision IN ('APPROVE','REQUEST_REVISION')),
  checklist_json TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reviews_job ON reviews(job_id, created_at);

CREATE TABLE IF NOT EXISTS revisions (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  round INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('CUSTOMER','INTERNAL')),
  summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revisions_job ON revisions(job_id);

CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  review_id TEXT NOT NULL REFERENCES reviews(id),
  delivered_by TEXT NOT NULL REFERENCES operators(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deliveries_job ON deliveries(job_id);

-- ---------------------------------------------------------------------------
-- Audit, idempotency, replay protection, rate limiting
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}', -- safe metadata only; never full briefs or secrets
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_events(resource_type, resource_id);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, idem_key)
);

CREATE TABLE IF NOT EXISTS connector_nonces (
  nonce TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nonces_created ON connector_nonces(created_at_epoch);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
