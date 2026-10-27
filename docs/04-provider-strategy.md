# 04 — Provider Strategy

## Recommended low-cost-first stack
- Cloudflare Workers: API and server-side logic.
- Cloudflare D1: structured operational data.
- Cloudflare R2: private uploads and deliverables.
- Cloudflare Queues: later, for background work and retries.
- Cloudflare Access or a maintained identity provider: protect internal console; decide customer auth after pilot.
- Genspark: AI-assisted production only through a verified supported connection or operator workflow.
- Cloudflare logs/analytics initially; optional Sentry or email provider only after privacy/cost review.

Cloudflare describes Workers, D1, R2 and Queues as building blocks for web applications: https://developers.cloudflare.com/use-cases/web-apps/

## Genspark validation
Genspark's help center describes connectors using API-call or MCP methods and notes that availability and actions depend on account/provider permissions: https://genspark.prod.sspark.ai/helpcenter/connectors-and-integrations
This does not prove a general public Genspark generation API exists, nor that public GitHub automatically runs jobs.

Validation:
1. Inspect the actual Genspark account's Skills → Connectors.
2. If GitHub is available, connect minimum required scope and test a harmless read.
3. If custom MCP is supported, expose allowlisted tools only; begin read-only, then add narrowly scoped writes after tests.
4. Otherwise use an operator workflow: prepare a sanitized brief, run it in Genspark, attach result and record mode=manual.
5. Record real test evidence before calling any connection live.

## Optional providers
GitHub for version control; Cloudflare for app/data; transactional email only if needed; payment provider only after price and demand validation; public web/permissioned research sources for evidence. No paid spend is approved by this blueprint.

## Avoid for MVP
Unverified APIs, browser automation that bypasses controls, auto-posting, customer credential storage, multiple paid AI providers without evidence, and MCP before core workflow works.