import type { MiddlewareHandler } from 'hono'
import { hmacSha256, sha256Hex, timingSafeEqual } from './crypto'
import { AppError } from './errors'
import type { AppEnv } from '../types'

/**
 * Service-to-service authentication for Public Embrilo → Embrilo OS.
 *
 * Every request carries:
 *   X-Embrilo-Key-Id     key identifier (supports rotation)
 *   X-Embrilo-Timestamp  unix seconds; must be within ±MAX_SKEW_SEC
 *   X-Embrilo-Nonce      16-64 random chars; single use (replay protection)
 *   X-Embrilo-Signature  base64url HMAC-SHA256 over the canonical string below
 *
 * Canonical string (newline separated):
 *   EMBRILO-HMAC-V1, audience, METHOD, path+query, timestamp, nonce,
 *   X-Embrilo-Customer header (or empty), X-Embrilo-Customer-Token header (or empty),
 *   Idempotency-Key header (or empty), sha256_hex(body)
 *
 * The audience binds the signature to this service so it cannot be replayed elsewhere.
 * CORS is not used and is not authentication: this API is server-to-server only.
 */
export const AUDIENCE = 'embrilo-os/v1'
export const MAX_SKEW_SEC = 300
export const MIN_SECRET_LEN = 32

export function canonicalString(p: {
  method: string
  pathWithQuery: string
  timestamp: string
  nonce: string
  customerRef: string
  customerToken: string
  idempotencyKey: string
  bodySha256: string
}) {
  return [
    'EMBRILO-HMAC-V1',
    AUDIENCE,
    p.method.toUpperCase(),
    p.pathWithQuery,
    p.timestamp,
    p.nonce,
    p.customerRef,
    p.customerToken,
    p.idempotencyKey,
    p.bodySha256
  ].join('\n')
}

/** Helper used by tests and by the Public Embrilo reference client (docs/connector-client.md). */
export async function signRequest(
  secret: string,
  p: {
    method: string
    pathWithQuery: string
    body?: string
    customerRef?: string
    customerToken?: string
    idempotencyKey?: string
    keyId: string
    timestamp?: number
    nonce?: string
  }
): Promise<Record<string, string>> {
  const timestamp = String(p.timestamp ?? Math.floor(Date.now() / 1000))
  const nonce = p.nonce ?? crypto.randomUUID().replace(/-/g, '')
  const sig = await hmacSha256(
    secret,
    canonicalString({
      method: p.method,
      pathWithQuery: p.pathWithQuery,
      timestamp,
      nonce,
      customerRef: p.customerRef ?? '',
      customerToken: p.customerToken ?? '',
      idempotencyKey: p.idempotencyKey ?? '',
      bodySha256: await sha256Hex(p.body ?? '')
    })
  )
  const h: Record<string, string> = {
    'X-Embrilo-Key-Id': p.keyId,
    'X-Embrilo-Timestamp': timestamp,
    'X-Embrilo-Nonce': nonce,
    'X-Embrilo-Signature': sig
  }
  if (p.customerRef) h['X-Embrilo-Customer'] = p.customerRef
  if (p.customerToken) h['X-Embrilo-Customer-Token'] = p.customerToken
  if (p.idempotencyKey) h['Idempotency-Key'] = p.idempotencyKey
  return h
}

const unauthorized = () => new AppError(401, 'invalid_signature', 'Service authentication failed')

export const requireConnector: MiddlewareHandler<AppEnv> = async (c, next) => {
  const secrets = [c.env.CONNECTOR_HMAC_SECRET, c.env.CONNECTOR_HMAC_SECRET_PREVIOUS].filter(
    (s): s is string => typeof s === 'string' && s.length >= MIN_SECRET_LEN
  )
  const expectedKeyId = c.env.CONNECTOR_KEY_ID || 'public-embrilo-v1'
  if (!c.env.CONNECTOR_HMAC_SECRET || secrets.length === 0)
    throw new AppError(503, 'connector_not_configured', 'Connector is not configured')

  const keyId = c.req.header('x-embrilo-key-id') ?? ''
  const ts = c.req.header('x-embrilo-timestamp') ?? ''
  const nonce = c.req.header('x-embrilo-nonce') ?? ''
  const sig = c.req.header('x-embrilo-signature') ?? ''
  if (!timingSafeEqual(keyId, expectedKeyId) || !/^\d{9,11}$/.test(ts) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce) || !sig)
    throw unauthorized()
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - Number(ts)) > MAX_SKEW_SEC) throw new AppError(401, 'stale_request', 'Request timestamp outside allowed window')

  const body = await c.req.text()
  const url = new URL(c.req.url)
  const canonical = canonicalString({
    method: c.req.method,
    pathWithQuery: url.pathname + url.search,
    timestamp: ts,
    nonce,
    customerRef: c.req.header('x-embrilo-customer') ?? '',
    customerToken: c.req.header('x-embrilo-customer-token') ?? '',
    idempotencyKey: c.req.header('idempotency-key') ?? '',
    bodySha256: await sha256Hex(body)
  })
  let ok = false
  for (const s of secrets) if (timingSafeEqual(await hmacSha256(s, canonical), sig)) ok = true
  if (!ok) throw unauthorized()

  // Replay protection: a nonce can be used once. Insert fails on duplicate primary key.
  const ins = await c.env.DB.prepare('INSERT OR IGNORE INTO connector_nonces (nonce, key_id, created_at_epoch) VALUES (?, ?, ?)')
    .bind(nonce, keyId, now)
    .run()
  if ((ins.meta.changes ?? 0) !== 1) throw new AppError(401, 'replayed_request', 'Request nonce already used')
  // Opportunistic cleanup (no cron needed): nonces older than 2× the window can't be replayed anyway.
  if (Math.random() < 0.05)
    await c.env.DB.prepare('DELETE FROM connector_nonces WHERE created_at_epoch < ?').bind(now - MAX_SKEW_SEC * 2).run()

  c.set('connectorKeyId', keyId)
  c.set('bodyText', body)
  await next()
}

// ---------------------------------------------------------------------------
// Customer access token: order-scoped capability returned once to Public Embrilo
// at submission. Public stores it server-side with the customer's account and must
// present it (plus the matching customer ref) for status/deliverables/revisions.
// A public reference alone is never enough.
// ---------------------------------------------------------------------------
export async function customerToken(secret: string, orderId: string, tokenVersion: number) {
  return 'ct1.' + (await hmacSha256(secret, `ct1:${orderId}:${tokenVersion}`))
}

export async function verifyCustomerToken(secret: string, orderId: string, tokenVersion: number, provided: string) {
  return timingSafeEqual(await customerToken(secret, orderId, tokenVersion), provided)
}

// Short-lived signed download links for approved deliverables.
export const DOWNLOAD_TTL_SEC = 300

export async function signDownload(secret: string, assetId: string, customerId: string, exp: number) {
  return hmacSha256(secret, `dl1:${assetId}:${customerId}:${exp}`)
}
