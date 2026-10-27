# 03 — Data Model and API Contract

## Core entities
- customers: internal ID, public reference, display/contact reference, consent timestamp.
- orders: public reference, customer ID, service code, status, brief ID, timestamps.
- briefs: objective, audience, product facts, platform, language, tone, constraints, rights confirmation.
- jobs: order ID, workflow state, priority, attempts, idempotency key, assigned operator.
- production_runs: provider, mode, template version, status, timestamps, error code and cost estimate.
- assets: order ID, private storage key, type, visibility, checksum and expiry.
- reviews: reviewer, decision, checklist, notes and timestamp.
- revisions: order ID, revision number, request summary and status.
- audit_events: actor, action, resource, correlation ID, timestamp and safe metadata.

Use UUID/ULID identifiers, foreign keys, migrations and indexes. Do not log full briefs or secrets by default.

## State machine
SUBMITTED → TRIAGE → QUEUED → IN_PRODUCTION → QC_REVIEW → APPROVED → DELIVERED.
Branches: NEEDS_INFO, NEEDS_REVISION, BLOCKED_PROVIDER, FAILED, CANCELLED. Server validates each transition. Delivery requires approval.

## Proposed API v1
- POST /v1/public/requests — validate and create request; idempotent.
- GET /v1/public/requests/{ref} — customer-scoped status.
- GET /v1/public/requests/{ref}/deliverables — approved assets only.
- POST /v1/public/requests/{ref}/revisions — eligible revision request.
- POST /v1/internal/jobs/{id}/triage — internal-only.
- POST /v1/internal/jobs/{id}/start-production — internal-only.
- POST /v1/internal/jobs/{id}/production-result — internal/provider adapter.
- POST /v1/internal/jobs/{id}/review — internal-only.
- POST /v1/internal/jobs/{id}/deliver — approved state only.

## Connector security
Prefer service-to-service short-lived signed tokens/HMAC with timestamp, audience and replay protection, or Cloudflare service bindings when suitable. Keep credentials server-side. Rate limit intake, validate all fields, use correlation IDs, and return safe errors. Public reference alone must not authorize access.

These routes are proposals, not live endpoints. Publish OpenAPI and contract tests before launch.