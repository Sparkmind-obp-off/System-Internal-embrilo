# Embrilo OS — Internal Operations Console

Internal console for Embrilo's AI-assisted, human-reviewed content service. It receives qualified requests from Public Embrilo, triages them, organizes production (Genspark **manual-assisted**), runs QC, handles revisions and authorizes delivery.

> **This repository is public.** It contains code, schema, sanitized templates and synthetic demo data only. Never commit secrets, `.dev.vars`, `.local/`, real briefs, customer data or generated deliverables.

## Status at a glance
| Area | Status |
|---|---|
| Operator login, sessions, roles, CSRF, lockout | ✅ implemented · ✅ tested |
| Queue, triage, needs-info, assignment, brief workspace | ✅ implemented · ✅ tested |
| Production runs + provider adapter | ✅ implemented · ✅ tested — **manual-assisted only** |
| QC checklist, approval gate, delivery, revisions | ✅ implemented · ✅ tested |
| Audit trail + metrics | ✅ implemented · ✅ tested |
| Public connector API v1 (HMAC, replay protection, idempotency, customer scope) | ✅ implemented · ✅ tested |
| Private R2 uploads + short-lived download links | ✅ implemented · ✅ tested (local R2) |
| Genspark automated API/connector/MCP | ⛔ **not verified** — no automated adapter exists |
| Cloudflare Access in front of the console | ⏳ not configured (recommended) |
| Production deployment | ✅ https://embrilo-os.pages.dev — deployed and smoke-tested 2026-10-27 |

Details and evidence: [`docs/08-implementation-status.md`](docs/08-implementation-status.md). Connector contract: [`docs/09-connector-contract.md`](docs/09-connector-contract.md).

## Architecture
- **Runtime:** Hono on Cloudflare Pages Functions (Workers runtime), TypeScript, server-rendered `hono/jsx` UI (no client framework, strict CSP, no inline JS or inline styles).
- **UI:** Indonesian-first design system in `public/static/console.css` (tokens, components, responsive down to 320px, reduced-motion). Copy/labels in `src/views/labels.ts`, icons (Lucide paths, ISC) in `src/views/icons.tsx`.
- **Motion:** Anime.js **v4.5.0** bundled by esbuild from `src/client/console.ts` → `public/static/console.js` (generated, gitignored). Pages work fully without JavaScript.
- **Data:** D1 (`DB`) for all records; private R2 (`R2`) for uploaded references and file drafts. Small text drafts are stored privately in D1.
- **Layers:** `src/routes/console.tsx` (HTML console) and `src/routes/internal.ts` (JSON) both call `src/services/jobs.ts`; `src/lib/state.ts` is the single state-transition table; `src/routes/connector.ts` is the public server-to-server API.

```
SUBMITTED → TRIAGE → QUEUED → IN_PRODUCTION → QC_REVIEW → APPROVED → DELIVERED
branches: NEEDS_INFO · NEEDS_REVISION · BLOCKED_PROVIDER · FAILED · CANCELLED
```
Only `APPROVED` can become `DELIVERED`, and only when an APPROVE review exists for the latest successful run. Every change writes history plus an audit event (actor, timestamp, correlation ID) atomically.

## Routes
| Path | Auth | Purpose |
|---|---|---|
| `GET /health` | none | `{ok:true}` only |
| `GET/POST /login`, `POST /logout` | form CSRF | operator session |
| `GET /console` (`?state=`, `?mine=1`) | operator | queue |
| `GET /console/jobs/:id` + `POST …/{triage,assign,brief,start-production,production-result,production-failure,requeue,review,deliver,reference,cancel}` | operator + CSRF (cancel: admin) | job workspace |
| `GET /console/assets/:id` | operator | private file download (audited) |
| `GET /console/metrics`, `/console/providers`, `/console/audit` (admin) | operator | ops views |
| `POST /v1/internal/jobs/:id/*` | operator session + `X-CSRF-Token` | JSON versions of the job actions |
| `POST /v1/public/requests` | HMAC + Idempotency-Key | create a request |
| `GET /v1/public/requests/:ref` | HMAC + customer ref + customer token | customer-safe status |
| `GET /v1/public/requests/:ref/deliverables` | same | released assets + 5-minute links |
| `POST /v1/public/requests/:ref/revisions` | same + Idempotency-Key | revision request |
| `GET /v1/public/downloads/:id?exp&sig` | signed link | approved file download |

## Data model
`operators`, `sessions`, `customers`, `orders`, `briefs`, `jobs`, `job_state_history`, `production_runs`, `assets`, `reviews`, `revisions`, `deliveries`, `audit_events`, `idempotency_keys`, `connector_nonces`, `rate_limits` — see `migrations/0001_initial_schema.sql`.

## Configuration
Bindings (`wrangler.jsonc`): `DB` (D1 `embrilo-os-production`), `R2` (bucket `embrilo-os-private`; optional — without it, file uploads are disabled and text drafts still work).

Vars: `APP_ENV`, `CONNECTOR_KEY_ID` (default `public-embrilo-v1`), `MAX_REVISION_ROUNDS` (default `2`).

Secrets (names only; each must be ≥32 random chars):
- `CONNECTOR_HMAC_SECRET` (shared only with Public Embrilo's server)
- `CONNECTOR_HMAC_SECRET_PREVIOUS` (optional, for rotation)
- `CUSTOMER_TOKEN_SECRET`
- `DOWNLOAD_SIGNING_SECRET`

If a secret is missing, the connector fails closed with `503`.

## Local development
```bash
npm install
cp .dev.vars.example .dev.vars          # then replace the values with random strings
npm run db:migrate:local
npm run db:seed:local                    # synthetic demo jobs
OPERATOR_PASSWORD='choose-a-long-password' npm run operator:sql -- --email you@example.test --name "You" --role ADMIN
npx wrangler d1 execute embrilo-os-production --local --file=.local/operator.sql
npm run build
pm2 start ecosystem.config.cjs           # or: npm run dev:sandbox
# open http://localhost:3000/login
```

### Checks
```bash
npm run typecheck     # tsc --noEmit
npm test              # 68 Vitest tests against local D1 + R2 (Miniflare)
npm run build         # esbuild client bundle + vite → dist/_worker.js
OPERATOR_EMAIL=… OPERATOR_PASSWORD=… BASE_URL=http://localhost:3000 node scripts/smoke.mjs   # 21-step E2E
```

## Operator guide
1. **Queue** → open a job → *Start triage*.
2. Check the brief (edit facts if needed) → *Qualify → queue*, or *Request more info* with a message the customer will see.
3. *Start production run* (Genspark manual-assisted) → copy the sanitized prompt → run it in your Genspark workspace → paste/attach the output. If the provider fails, record the failure; the job stays recoverable.
4. **QC**: tick all six checks to approve, or request a revision with notes.
5. *Release approved deliverable* → the customer can download it through Public Embrilo.

## Deployment
Target: Cloudflare Pages via the owner's own Cloudflare account (BYOK). Checklist:
1. `wrangler d1 create embrilo-os-production` → put the id in `wrangler.jsonc`.
2. `wrangler r2 bucket create embrilo-os-private` (keep it private; no public access or r2.dev URL).
3. `wrangler d1 migrations apply embrilo-os-production --remote`.
4. `wrangler pages project create <name> --production-branch main`.
5. Set the four secrets with `wrangler pages secret put <NAME> --project-name <name>`.
6. `npm run build && wrangler pages deploy dist --project-name <name> --branch main`.
7. Create the first ADMIN with `scripts/create-operator.mjs` and `wrangler d1 execute … --remote --file=.local/operator.sql`.
8. Run `scripts/smoke.mjs` against the production URL.
9. Recommended: put `/console*` and `/login` behind Cloudflare Access.

Deployment record: see the "Deployment" section of `docs/08-implementation-status.md`.

## Documentation
`docs/00`–`07` (source of truth, research, architecture, data model, providers, security, roadmap, runbook), `docs/08-implementation-status.md`, `docs/09-connector-contract.md`, `prompts/`.
