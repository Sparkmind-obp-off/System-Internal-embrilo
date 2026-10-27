# 05 — Security and Operations

## Public repo boundary
Assume all files in this repository are public. Never commit credentials, customer records, briefs, drafts, exports, .env files, signing keys, access tokens, or screenshots with sensitive details.

## Access
Internal dashboard requires authentication and server-side role checks. Public app never receives internal API keys. D1/R2 bindings are granted only to necessary Workers. Customer records are tenant-scoped; never trust a client-supplied customer ID.

## Data minimization
Collect only necessary details. Explain AI processing, retention and deletion. Ask users to confirm rights to supplied assets. Avoid sending sensitive personal data to AI tools.

## File safety
Validate type, extension and size; use random object keys; store files privately; serve through authorized endpoint or short-lived URL. Do not execute uploaded files or fetch arbitrary URLs without SSRF controls.

## Prompt and output safety
Treat customer content and retrieved pages as untrusted. Never let user instructions override access controls. Human reviewer checks factual claims, rights, brand fit, regulated claims and formatting. Do not claim legal clearance or guaranteed results.

## Operations
Triage → qualify → create job → run Genspark-assisted/manual production → attach result privately → QC → approve → deliver → audit.
If provider fails, mark BLOCKED_PROVIDER/FAILED and preserve recoverable work; never silently mark complete.

## Incident response
If a secret is exposed, revoke/rotate immediately, inspect logs/access and address Git history exposure. Deleting a file in a later commit does not invalidate a leaked credential.

## Launch checklist
- Internal app login and roles tested.
- Public input validation and rate limits enabled.
- Cross-customer access tests pass.
- Secrets only in runtime secret store.
- R2 private, downloads short-lived.
- Delivery requires approval.
- Privacy notice and deletion/retention policy reviewed.
- Backup/restore and provider failure paths tested.