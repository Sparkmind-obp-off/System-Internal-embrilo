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
| 2026-10-27 | R2 bucket `embrilo-os-private` | ✅ created (private, no public access) |
| 2026-10-27 | First `d1 create` attempt | ⛔ account limit (10); owner freed a slot |
| 2026-10-27 | D1 `embrilo-os-production` + remote migration `0001` | ✅ 32 statements applied |
| 2026-10-27 | Pages project `embrilo-os` (production branch `main`) | ✅ created |
| 2026-10-27 | Secrets `CONNECTOR_HMAC_SECRET`, `CUSTOMER_TOKEN_SECRET`, `DOWNLOAD_SIGNING_SECRET` | ✅ set (encrypted in Cloudflare; values not in Git) |
| 2026-10-27 | `wrangler pages deploy dist --branch main` | ✅ deployed |
| 2026-10-27 | First ADMIN operator created via `scripts/create-operator.mjs` (hash only in D1) | ✅ |
| 2026-10-27 | `scripts/smoke.mjs` against https://embrilo-os.pages.dev | ✅ 21/21 checks passed |

**Status: deployed and verified** at https://embrilo-os.pages.dev (login: `/login`).
Note: the smoke test left one synthetic request (`EMB-AP2W7-GJ4FN`, customer "Smoke Test (synthetic)") in production; an admin can cancel it.
Not yet done: Cloudflare Access in front of `/console*` and `/login` (recommended).

## UI/UX upgrade (2026-10-28)
- Redesigned every console route (login, queue, job detail, Produksi AI, metrics, audit, error pages) with a shared design system and Indonesian-first copy. Routes, server contracts, auth, CSRF, roles, state transitions, audit and connector behaviour are unchanged.
- Queue: attention summary by real state groups, tabs (all open / mine / done), search by reference or customer (LIKE wildcards escaped), priority filter, next-action column, age with stale highlight.
- Job detail: header with owner/age/next action, SVG workflow stepper, a single "next safe action" panel, guided 3-step manual Genspark handoff with copy confirmation, QC checklist, delivery confirmation checkbox, admin cancel with explicit confirmation, readable activity timeline.
- Forms: on validation failure the page is re-rendered (HTTP 422) with Indonesian field-level errors and the submitted values preserved; focus moves to the first invalid field.
- Metrics: definitions and sample sizes shown; "Belum ada data" is distinguished from zero; no targets are claimed.
- Audit: filter by event type and correlation/resource id, paginated ("Muat kejadian lebih lama"), metadata collapsed.
- Motion (Anime.js 4.5.0, `animate`, `createTimeline`, `stagger`, `createDrawable`): short entrance for headers/cards, staggered summary cards and first visible rows, stepper line drawing, metric bars, toast and flash feedback. Disabled entirely under `prefers-reduced-motion`; a CSS fallback reveals content after 1.5s if JS fails. Bundle: 41.7 KB minified / ~17 KB gzip (Anime.js ≈ 38 KB of it).
- Verified: 68/68 tests; Playwright/Chromium QA at 1440, 375 and 320 px wide (no horizontal overflow, no console errors, reduced motion respected, first Tab reaches the skip link). Not verified: real-device testing on iOS/Android and screen-reader walkthroughs.
- Deployed 2026-10-28 to https://embrilo-os.pages.dev (Cloudflare Pages, BYOK) from merge commit `03ffa76`. Post-deploy checks: `/health` 200; `/static/boot.js`, `/static/console.js`, `/static/console.css` 200; CSP unchanged; Playwright QA against production at 1440/375/320 px with the real admin account: no overflow, no console errors, reduced motion respected (read-only page visits; no job state was changed).

## Order-to-prompt workspace (2026-10-28)
- **Flow:** order arrives via the existing signed connector (`POST /v1/public/requests`, idempotent) → Inbox → order detail → **Prompt Studio** (`/console/jobs/:id/studio`) → operator copies the prompt into Genspark.ai or another tool and runs it **manually** → records result/QC/delivery on the job page. Generating, copying or marking a prompt READY never changes job state and is never shown as executed or delivered.
- **Prompt Studio:** structured brief, rule-based missing-information detection with a copy-ready customer question list (not sent automatically), work type + private internal notes, versioned prompts (TEMPLATE / AI / MANUAL; DRAFT / READY / SUPERSEDED), direct editing, "Perbaiki prompt", line diff between versions, copy with honest confirmation, internal studio log. `start-production` uses the READY version and stores `prompt_version_id` on the run for provenance.
- **Templates:** `src/lib/templates.ts`, 8 work types (`video_short`, `social_content`, `image_creative`, `design_brand`, `document`, `research`, `website_code`, `general`), each versioned (`id@1`). Only video_short, social_content and general are enabled by default because the Public-embrilo docs list only short-video script packs and product storytelling packs as offerings; admins enable others in Pengaturan.
- **Providers (explicit, no automatic cross-provider fallback):** 1) Cloudflare Workers AI via the `AI` Pages binding (`wrangler.jsonc`), default model `@cf/meta/llama-3.3-70b-instruct-fp8-fast`; 2) Groq chat-completions (`https://api.groq.com/openai/v1/chat/completions`) only when an admin selects it and the `GROQ_API_KEY` secret exists; 3) template-only mode, always available. Settings page shows the active mode; a selected-but-unconfigured provider shows a warning and uses templates.
- **Limits & cost:** 30 s timeout; ≤ 14k input chars/message; max output tokens default 1,800 (≤ 4,000); per-operator rate limit 20 AI calls / 10 min; daily caps default 8,000 estimated Neurons (Workers AI free allocation is 10,000/day per the official pricing page, checked 2026-10-28) and 50 Groq calls. Neuron estimates use the published per-model rates and are estimates only.
- **Privacy:** only the sanitized prompt text is sent to a provider (emails, phone numbers, secret-like strings redacted; brief wrapped as untrusted data). Internal notes, audit data and other orders are never sent. `ai_usage` stores provider, model, status, error code, duration, tokens and estimated Neurons only — no prompt or brief text. Model output is stored as an untrusted draft and escaped when rendered.
- **Schema:** `migrations/0002_order_to_prompt.sql` (additive: `jobs.work_type`, `jobs.internal_notes`, `production_runs.prompt_version_id`, tables `prompt_versions`, `studio_messages`, `ai_usage`, `app_settings`). Manual rollback: `migrations-rollback/0002_order_to_prompt.down.sql` (back up first).
- **Tests:** 85/85 (17 new in `tests/studio.test.ts`: template structure and unknown markers, gap rules, draft→edit→refine→ready versioning with no state change, READY provenance in production runs, studio lock during production, AI-without-provider safe failure with preserved text, validation, roles/CSRF, Workers AI mocked success and rate-limit failure, daily cap, Groq mocked success/401, Groq-without-secret fallback, admin-only settings). Provider calls in tests are mocked; real-provider evidence is recorded below.
- **Not built (by design):** customer-facing chat, automatic messaging to customers, automatic execution in Genspark, AI Gateway, multi-provider orchestration.

### Live provider evidence (production, 2026-10-28)

- **Groq account check** (direct API, key stored only as Pages secret `GROQ_API_KEY`): `llama-3.3-70b-versatile` is **not** available on this account. Verified working models: `openai/gpt-oss-120b` (default), `openai/gpt-oss-20b`, `qwen/qwen3.8-27b`. Account rate limits reported: 1,000 requests/min, 8,000 tokens/min. The model setting is an enum restricted to these three IDs (an unknown model → 422). gpt-oss models are called with `reasoning_effort: low` and `include_reasoning: false`; any `<think>` block is stripped from output.
- **Deployment:** commit `316a02f`, https://45a567d5.embrilo-os.pages.dev (alias https://embrilo-os.pages.dev). Checks after deploy: `/health` 200; anonymous `/console/settings` → 303 `/login`; admin login OK; Inbox, job detail, Prompt Studio, Metrics, Audit all 200 with 0 JS errors (read-only visits on the synthetic smoke job; nothing was clicked that changes state).
- **Settings → Uji provider** (prompt "Balas hanya dengan satu kata: OK", no customer data, 64 max tokens):
  - Workers AI `@cf/meta/llama-3.3-70b-instruct-fp8-fast`: ✅ success in 0.3 s
  - Groq `openai/gpt-oss-120b`: ✅ success in 0.2 s
- **Active provider:** Workers AI stays primary (free allocation, healthy). Groq is configured and tested as an **explicit** alternative that an admin selects in Settings. There is no automatic switch between providers; if the selected provider fails, the operator gets a clear error, their text is kept, and template mode is always available.

## AI order-management workspace (2026-10-28)

- **Search & Inbox** (`src/services/search.ts`): one parameterised query shared by the Inbox and the assistant. Searches order ref, customer name, brief keywords and (ADMIN/OPERATOR only) customer external ref. Filters: view, status, scope (open/all), mine, needs-me, priority, service (multi), prompt (none/draft/ready), open revision, created from/to, updated from, sort. Pagination 10/25/50. Indicators: brief incomplete, waiting for clarification, prompt draft/ready, revision, delivered. Real rows only.
- **Assistant** (`src/services/assistant.ts`, `/console/assistant`, plus a panel on every order page). Seven read-only tools: `search_orders`, `get_order_details`, `summarize_order`, `identify_missing_brief_fields` (rule gaps + new rule-based conflict detection), `draft_production_prompt` (template preview from the real brief), `get_prompt_versions`, `get_order_activity`. Deterministic Indonesian intent rules come first. The configured LLM is used only when the operator ticks "Gunakan AI": as a router whose JSON output is schema-validated (unknown tools/filters/refs → clarification; no SQL) or to phrase a summary of already-loaded, sanitized facts — shown as "Saran AI — bukan fakta". Every answer lists its source orders and fields; empty results say so.
- **Mutations** (`create_prompt_draft`, `mark_prompt_ready`, `assign_to_me`) are stored as PROPOSED actions (15-minute TTL), owned by the proposing operator, and run only after explicit confirmation. At confirmation the server re-checks role, expiry, prompt version / current owner and studio lock, then reuses the existing services (`studio.createDraft`, `studio.editorAction`, `jobs.assign`). Atomic claim prevents double execution. Audit: `assistant.asked`, `assistant.action_proposed|confirmed|cancelled|failed`, `assistant.cleared`.
- **Prompt export**: `GET /console/jobs/:id/studio/export?v=N` downloads Markdown, audited as `studio.exported`; the header states that export is not execution.
- **Removed**: the duplicate `/console/providers` page (now a 301 to `/console/settings`) and unused re-exports.
- **Migration** `0003_assistant.sql`: `assistant_messages`, `assistant_actions`; rebuilds `ai_usage` to allow `operation='assistant'` (rows copied); search indexes. Rollback: `migrations-rollback/0003_assistant.down.sql`. Production backup taken first (`.local/backups/prod-before-0003-2026-10-28.sql`, local only). Applied remotely: ✅; `ai_usage` 3 → 3 rows, jobs 1 → 1.
- **Tests**: 112/112 (`npx vitest run`, 5 files; 27 new in `tests/assistant.test.ts`). Typecheck with `--noUnusedLocals` clean. Local Playwright QA: filters, `/` shortcut, Enter-to-send, summary, proposal → confirm → draft v2, export download, 375/320 px without overflow, 0 JS errors.
- **Deployment**: commit `2135a33`, https://65f070f8.embrilo-os.pages.dev (alias https://embrilo-os.pages.dev). Production checks: `/health` 200; anonymous `/console/assistant` → 303 `/login`; Inbox filters, assistant, settings, metrics and audit return 200; `/console/providers` → Settings; "Cari order video yang belum selesai" → 1 real order; "Ringkas progres order ini" on the synthetic smoke order → 8 recorded facts; with AI ticked, Workers AI `@cf/meta/llama-3.3-70b-instruct-fp8-fast` returned a labelled suggestion; 0 JS errors. No action was confirmed and no order was changed; the test conversation was cleared afterwards.
