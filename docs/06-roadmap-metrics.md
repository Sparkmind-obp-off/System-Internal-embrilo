# 06 — MVP Roadmap and Metrics

## North Star
Accepted deliverables per active customer per month, guarded by quality and contribution margin.

## Track
First-draft acceptance, on-time delivery, operator minutes per accepted pack, revision rounds, repeat-order rate, contribution margin, provider-blocked time, job failure rate, support issues, and privacy incidents. Establish baseline from first 10–20 jobs before setting numeric targets.

## Phase 0 — Validate
Manually fulfil 3–5 pilot jobs; measure actual time, quality, payment, revision and repeat demand.

## Phase 1 — Intake
Public brief form, consent, schema validation, idempotency and request reference. Test duplicate retry and invalid inputs.

## Phase 2 — Internal console
Login, queue, brief details, triage, status transitions, production notes, attachments and QC.

## Phase 3 — Connector
Versioned API, service-to-service auth, rate limits, correlation IDs and contract tests. Verify cross-customer access denial.

## Phase 4 — Genspark bridge
Prove supported connector/API/MCP or manual workflow. Track template version and result provenance. Never mark complete on provider failure.

## Phase 5 — Delivery
Approved assets, short-lived access, revisions and optional notifications. Test ownership and expiry.

## Phase 6 — Scale
Add queues, payments, more providers, analytics and automation only when measured volume or customer behavior justifies them.

Out of scope: social auto-posting, fully automated video production, unreviewed delivery, public MCP tools, and complex multi-agent orchestration.

Go-live requires a complete test from public request through reviewed delivery. Documentation alone is not implementation.