# 09 — Public Connector Contract (v1)

Server-to-server only. Public Embrilo's **server** calls these endpoints; browsers must never hold the connector secret or call this API directly. No CORS headers are sent.

## Authentication (every endpoint except the signed download link)
| Header | Value |
|---|---|
| `X-Embrilo-Key-Id` | must equal `CONNECTOR_KEY_ID` (default `public-embrilo-v1`) |
| `X-Embrilo-Timestamp` | unix seconds, within ±300 s |
| `X-Embrilo-Nonce` | 16–64 chars `[A-Za-z0-9_-]`, single use |
| `X-Embrilo-Signature` | base64url(HMAC-SHA256(secret, canonical)) |
| `X-Embrilo-Customer` | opaque customer id owned by Public (customer-scoped routes) |
| `X-Embrilo-Customer-Token` | order token returned at creation (customer-scoped routes) |
| `Idempotency-Key` | 16–128 safe chars (POST routes) |

Canonical string (joined with `\n`):
```
EMBRILO-HMAC-V1
embrilo-os/v1
<METHOD>
<path + query>
<timestamp>
<nonce>
<X-Embrilo-Customer or empty>
<X-Embrilo-Customer-Token or empty>
<Idempotency-Key or empty>
<sha256 hex of raw body (empty string if none)>
```
For rotation, set the new secret as `CONNECTOR_HMAC_SECRET` and the old one as `CONNECTOR_HMAC_SECRET_PREVIOUS`, then remove the old one once Public has switched. A reference signer lives in `scripts/smoke.mjs` (Node) and in `src/lib/connector.ts` (`signRequest`).

## Endpoints
### `POST /v1/public/requests`
Body (unknown fields are rejected):
```json
{
  "customer": { "external_ref": "cust_abc12345", "display_name": "Toko Contoh" },
  "consent": { "accepted": true, "terms_version": "terms-2026-10", "accepted_at": "2026-10-27T08:00:00Z" },
  "service_code": "SCRIPT_PACK | HOOK_CAPTION_PACK | PRODUCT_STORY | CONTENT_CALENDAR | PRODUCTION_BRIEF",
  "brief": {
    "objective": "10-2000 chars", "audience": "3-1000", "product_facts": "10-5000",
    "platforms": ["tiktok","instagram_reels","youtube_shorts","facebook","other"],
    "language": "id | en | id-en", "tone": "", "cta": "", "constraints": "",
    "references": ["https://… (max 5, https only)"], "rights_confirmed": true
  }
}
```
`201` → `{ public_ref, status: "received", customer_token, idempotent_replay: false }`. A retry with the same key and body returns `200` with the same values. The same key with a different body returns `409 idempotency_conflict`. Invalid input returns `422 validation_failed` with `details[]`.
**Store `customer_token` server-side**, bound to the customer account. It is the customer's capability for this order; never send it to a browser.

### `GET /v1/public/requests/{public_ref}`
`200` → `{ public_ref, service_code, status: received|needs_info|in_progress|delivered|cancelled, message, revisions:{used,max,can_request}, submitted_at, updated_at, delivered_at }`. Internal states (QC, failed, blocked) are reported as `in_progress`.

### `GET /v1/public/requests/{public_ref}/deliverables`
Only released (approved and delivered) assets. Each item has a `download_url` valid for 5 minutes. Public should fetch it server-side and stream it to the logged-in customer.

### `POST /v1/public/requests/{public_ref}/revisions`
Body `{ "summary": "10-2000 chars" }`. Allowed only when the status is `delivered` and rounds remain (`MAX_REVISION_ROUNDS`, default 2). The call is idempotent.

## Errors
`{ "error": { "code", "message", "details?", "correlation_id" } }`. Customer authorization failures always return `404 not_found`, so references cannot be enumerated. Rate-limited responses return `429` with `Retry-After`.
