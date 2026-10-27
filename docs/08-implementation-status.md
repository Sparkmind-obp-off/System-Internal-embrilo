# 08 — Implementation Status (evidence log)

This file records what is implemented, what is tested, and what is still blocked. Update it with evidence; never mark something live without proof.

## Implemented (code in this repo)
| Cluster | Where | Notes |
|---|---|---|
| Operator access | `src/lib/auth.ts`, `src/routes/console.tsx` | PBKDF2-SHA256 passwords (100k iterations, the Workers max), server-side sessions (only a SHA-256 of the token is stored), 8h absolute / 2h idle expiry, HttpOnly + SameSite=Strict (`__Host-` prefix on HTTPS), CSRF token + Origin check, lockout after 5 failures, roles ADMIN/OPERATOR/VIEWER checked on the server |
| Job queue & triage | `src/services/jobs.ts` (`triage`, `assign`) | Filter by state/assignee, priority, needs-info with a customer-safe message, rights check before queueing |
| Brief workspace | `updateBrief` | Edit only in pre-production/revision states; strict validation; reference URLs are stored but never fetched by the server (no SSRF) |
| Production runs | `startProduction`, `recordProductionResult`, `recordProductionFailure` | provider, mode, template version, prompt digest, operator, minutes, estimated cost, error code, timestamps; one running run per job |
| Provider adapter | `src/lib/providers.ts`, `src/lib/prompt.ts` | `genspark-manual` and `manual-writer` (both **manual**). Prompt is sanitized (email/phone/secret-like strings are redacted, brief marked as untrusted data) |
| Quality review | `review` | 6-item checklist; every item must pass to approve; a revision needs notes |
| Revision & delivery | `deliver`, `customerRevisionRequest` | Delivery requires state APPROVED **and** an APPROVE review for the latest successful run; asset visibility flips to CUSTOMER only on delivery; capped revision rounds |
| Audit & metrics | `job_state_history`, `audit_events`, `/console/metrics`, `/console/audit` | Every transition records actor, timestamp and correlation ID inside the same D1 batch (atomic). Metadata is limited to ids, codes and counts |
| Public connector | `src/routes/connector.ts`, `src/lib/connector.ts` | HMAC-SHA256 signed requests (audience, timestamp ±300s, single-use nonce, body hash, key rotation), idempotency keys, D1 rate limits, customer-scoped access (customer ref + order-scoped token), 5-minute signed download links, no CORS |
| Files | `src/services/files.ts` | Private R2, random keys, 10 MB limit, extension + MIME allowlist + magic-byte check, always served as an attachment with `nosniff` and a sandbox CSP |
| Hardening | `src/lib/http.ts`, `src/index.tsx` | Strict CSP (no inline scripts), HSTS on HTTPS, `X-Frame-Options: DENY`, `no-store`, safe JSON errors that include a correlation ID, logs without request bodies |

## State machine
```
SUBMITTED → TRIAGE → QUEUED → IN_PRODUCTION → QC_REVIEW → APPROVED → DELIVERED
TRIAGE → NEEDS_INFO → TRIAGE
IN_PRODUCTION → BLOCKED_PROVIDER → IN_PRODUCTION | QUEUED | FAILED
IN_PRODUCTION → FAILED → QUEUED
QC_REVIEW | APPROVED → NEEDS_REVISION → IN_PRODUCTION | QUEUED
DELIVERED → NEEDS_REVISION (customer, limited by MAX_REVISION_ROUNDS)
any non-terminal state → CANCELLED (admin only)
```
Transitions are applied with optimistic locking (`version`), so a stale or concurrent change returns 409. History, audit and side-effect rows are written in the same D1 batch and are guarded by a per-transition id: they land only if the transition itself applied.

## Tested (automated) — `npm test`
62 tests run with Vitest against a real local D1 + R2 (Miniflare): state machine, login/lockout/CSRF/logout, role denial (VIEWER, non-admin cancel/audit), happy path with history, rejected skips, optimistic locking, delivery gate from every unapproved state, QC rules, double delivery, sanitized prompt + provenance, provider failure → recoverable → retry, requeue, HMAC (unsigned/wrong key/stale/replay/tampered/unconfigured), no CORS, idempotency (replay, concurrent, conflict, missing), 9 invalid-input cases, rate limit, cross-customer denial (status, deliverables, stolen token), signed-link tampering/expiry, internal drafts unreachable from the public route, revision eligibility/idempotency/cap, upload allowlist/size/path traversal, XSS escaping, security headers.

End-to-end smoke test `scripts/smoke.mjs` (21 checks) passed against local `wrangler pages dev` with local D1.

## Genspark integration — mode proven: **manual-assisted only**
- No Genspark generation API, connector or MCP endpoint that this Worker can call was found or verified from this environment. The Genspark help center describes connectors that depend on account permissions; that does not prove a callable generation API exists.
- What is implemented and tested: the operator receives a sanitized, copy-ready prompt (template `genspark-prod-v1`), runs it in their own Genspark workspace, then attaches the output; the run records `mode=manual`, the operator, the template version and the prompt digest.
- To upgrade: verify a documented integration, store its credential as a Worker secret, implement `execute()` in an `api`/`mcp` adapter, add contract tests, and record the evidence here.

## Not implemented / out of scope (by design for MVP)
- Cloudflare Access in front of the console (recommended extra layer; it needs a Zero Trust setup in the account).
- Operator management UI (operators are created with `scripts/create-operator.mjs`).
- Queues/background jobs, email notifications, payments, auto-publishing.
- OpenAPI document (the contract is described in `docs/09-connector-contract.md`).
- Data retention/deletion jobs (needs a policy decision; no cron is used).

## Deployment record
| Date (UTC) | Step | Result |
|---|---|---|
| 2026-10-27 | Cloudflare auth via user API token (BYOK) | ✅ `wrangler whoami` OK |
| 2026-10-27 | `wrangler r2 bucket create embrilo-os-private` | ✅ created (private, empty, no public access) |
| 2026-10-27 | `wrangler d1 create embrilo-os-production` | ⛔ **blocked**: `System limit reached: databases per account (10) [code: 7406]` |
| — | Pages project, secrets, remote migrations, deploy, smoke test | ⏳ not started (needs D1) |

**Status: NOT deployed. No production URL exists.**
Next action (owner): free one D1 slot (delete a D1 database you no longer need) or raise the account's D1 limit. Then continue from step 1 of the README deployment checklist. The app is never pointed at another project's database.
