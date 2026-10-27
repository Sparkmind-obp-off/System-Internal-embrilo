# 00 — Source of Truth

## Product
Embrilo is a human-reviewed, AI-assisted content production service. Initial outputs: short-video concepts, hooks, scripts, captions, CTAs, product storytelling, content calendars, and production briefs. Full video rendering and social auto-publishing are not MVP promises.

## Roles
- Owner/Admin: settings, access, provider setup, final approvals.
- Operator/Editor: triage, production, review, revisions, delivery.
- Customer: sees only their own request and approved deliverables through Public Embrilo.
- Service identities: API and provider adapters with minimum permissions.

## System boundaries
- Public layer: marketing, catalog, intake, customer status and approved delivery.
- Internal layer: queue, briefs, production runs, prompt templates, QC, revisions, operations.
- Connector: versioned API, authentication, validation, audit.
- Data: structured records in D1; private files in R2.
- Genspark: production assistant subject to verified account capabilities.

## Data classification
Public: service descriptions and approved examples. Internal: generic SOPs and sanitized templates. Confidential: briefs, drafts, customer contact details and deliverables. Secrets: API keys, OAuth tokens, signing keys. Since this repo is public, commit only public-safe content and sanitized internal guidance.

## Definition of done
A test customer submits a brief, an operator processes it, a draft is attached, a reviewer approves it, the customer retrieves only their own approved result, and audit events record key transitions.