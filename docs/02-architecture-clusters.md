# 02 — Architecture and Clusters

## Flow
Customer → Public UI → public intake endpoint → authenticated connector → Internal job queue → D1 records/private R2 files → Genspark-assisted production → QC/revision → approved delivery → customer view.

## Cluster A — Public Edge
Marketing pages, service catalog, brief intake, customer status and delivery UI. Suggested TypeScript + Vite/React and Cloudflare Pages/Workers. No internal prompts, admin functions or provider secrets.

## Cluster B — API Connector
Versioned endpoints, validation, authentication, rate limits, idempotency, correlation IDs and audit events. Use a dedicated Worker or a carefully separated API within Workers. CORS is not authentication.

## Cluster C — Internal Console
Authenticated owner/operator dashboard, queue, brief qualification, production runs, QC checklist, revisions, delivery approvals and basic metrics. Separate deployment and access policy.

## Cluster D — Workflow Orchestration
State transitions, retries, timeouts, duplicate prevention and provider handoff. Start with D1-backed status transitions and operator actions. Add Cloudflare Queues when asynchronous jobs/retries justify it.

## Cluster E — Data and Assets
D1 for customers, orders, briefs metadata, jobs, status history, revisions and audit events. R2 private bucket for references and deliverables. KV is optional cache/config, not order source of truth.

## Cluster F — AI Provider Adapter
Normalize job input/output, record provider, execution mode, template version, result, failure and cost estimate. Support documented API, supported MCP/connector, or explicit human-operated handoff. Never invent an endpoint.

## Cluster G — Quality and Delivery
Checklist-based factual, brand, tone, format and rights review. Delivery requires an approval record. Customers see only their own approved files.

## Cluster H — Observability and Governance
Audit events, aggregate usage, error tracking, retention/deletion, backups and incident response.

Cloudflare reference architecture: https://developers.cloudflare.com/use-cases/web-apps/ . Storage guidance: https://developers.cloudflare.com/workers/platform/storage-options/ .