import { Hono, type Context } from 'hono'
import { requireConnector, verifyCustomerToken, signDownload, DOWNLOAD_TTL_SEC } from '../lib/connector'
import { AppError } from '../lib/errors'
import { getJob, type JobRow } from '../lib/db'
import { rateLimit } from '../lib/ratelimit'
import { customerStatus } from '../lib/state'
import { timingSafeEqual } from '../lib/crypto'
import { clientIp } from '../lib/http'
import { V, validateCustomerExternalRef, validateIdempotencyKey, validatePublicRequest } from '../lib/validate'
import { createPublicRequest, customerRevisionRequest, maxRevisions } from '../services/jobs'
import { assetResponse } from '../services/files'
import type { Actor, AppEnv } from '../types'

/**
 * Versioned server-to-server API for Public Embrilo. Every route except the
 * short-lived download link requires a valid HMAC signature (see lib/connector.ts).
 * No CORS headers are emitted: browsers must never call this API directly.
 */
export const connector = new Hono<AppEnv>()

const connectorActor = (c: Context<AppEnv>): Actor => ({ type: 'CONNECTOR', id: c.get('connectorKeyId') ?? 'unknown' })

function parseBody(c: Context<AppEnv>): unknown {
  const text = c.get('bodyText') ?? ''
  if (text.length > 64 * 1024) throw new AppError(413, 'payload_too_large', 'Request body too large')
  if (!(c.req.header('content-type') ?? '').includes('application/json'))
    throw new AppError(415, 'unsupported_media_type', 'Use application/json')
  try {
    return JSON.parse(text)
  } catch {
    throw new AppError(400, 'invalid_json', 'Body must be valid JSON')
  }
}

/**
 * Customer authorization: the order is resolved by public_ref AND must belong to the
 * customer named in X-Embrilo-Customer AND the order-scoped customer token must match.
 * Every failure returns the same 404 so references cannot be enumerated.
 */
async function authorizeCustomerOrder(c: Context<AppEnv>) {
  const ref = c.req.param('ref') ?? ''
  const externalRef = validateCustomerExternalRef(c.req.header('x-embrilo-customer'))
  const token = c.req.header('x-embrilo-customer-token') ?? ''
  const secret = c.env.CUSTOMER_TOKEN_SECRET
  if (!secret || secret.length < 32) throw new AppError(503, 'connector_not_configured', 'Connector is not configured')
  const notFound = new AppError(404, 'not_found', 'Request not found')
  if (!/^EMB-[0-9A-Z]{5}-[0-9A-Z]{5}$/.test(ref) || !token) throw notFound
  const row = await c.env.DB.prepare(
    `SELECT o.id AS order_id, o.public_ref, o.service_code, o.token_version, o.created_at, c.id AS customer_id, c.external_ref, j.id AS job_id
     FROM orders o JOIN customers c ON c.id = o.customer_id JOIN jobs j ON j.order_id = o.id WHERE o.public_ref = ?`
  )
    .bind(ref)
    .first<{ order_id: string; public_ref: string; service_code: string; token_version: number; created_at: string; customer_id: string; external_ref: string; job_id: string }>()
  if (!row) throw notFound
  const ownerOk = timingSafeEqual(row.external_ref, externalRef)
  const tokenOk = await verifyCustomerToken(secret, row.order_id, row.token_version, token)
  if (!ownerOk || !tokenOk) throw notFound
  const job = await getJob(c.env.DB, row.job_id)
  return { order: row, job }
}

function statusBody(order: { public_ref: string; service_code: string; created_at: string }, job: JobRow, maxRounds: number) {
  const status = customerStatus(job.state)
  return {
    public_ref: order.public_ref,
    service_code: order.service_code,
    status,
    // Customer-safe message only (e.g. what information is missing). Never internal notes.
    message: status === 'needs_info' ? job.customer_message : null,
    revisions: { used: job.revision_round, max: maxRounds, can_request: job.state === 'DELIVERED' && job.revision_round < maxRounds },
    submitted_at: order.created_at,
    updated_at: job.updated_at,
    delivered_at: job.delivered_at
  }
}

connector.use('/public/*', async (c, next) => {
  if (c.req.path.startsWith('/v1/public/downloads/')) return next()
  return requireConnector(c, next)
})

// POST /v1/public/requests — validate, create idempotently.
connector.post('/public/requests', async (c) => {
  await rateLimit(c.env.DB, `intake:${c.get('connectorKeyId')}`, 60, 60)
  const idemKey = validateIdempotencyKey(c.req.header('idempotency-key'))
  const input = validatePublicRequest(parseBody(c))
  await rateLimit(c.env.DB, `intake-customer:${input.customer.external_ref}`, 10, 3600)
  const r = await createPublicRequest(c.env, input, idemKey, c.get('cid'), connectorActor(c))
  return c.json(
    {
      public_ref: r.public_ref,
      status: 'received',
      // Store server-side in Public Embrilo, bound to this customer. Never send to the browser.
      customer_token: r.customer_token,
      idempotent_replay: r.replay
    },
    r.replay ? 200 : 201
  )
})

// GET /v1/public/requests/:ref — customer-scoped status.
connector.get('/public/requests/:ref', async (c) => {
  await rateLimit(c.env.DB, `status:${c.get('connectorKeyId')}`, 600, 60)
  const { order, job } = await authorizeCustomerOrder(c)
  return c.json(statusBody(order, job, maxRevisions(c.env)))
})

// GET /v1/public/requests/:ref/deliverables — approved assets only, short-lived links.
connector.get('/public/requests/:ref/deliverables', async (c) => {
  await rateLimit(c.env.DB, `status:${c.get('connectorKeyId')}`, 600, 60)
  const { order, job } = await authorizeCustomerOrder(c)
  const secret = c.env.DOWNLOAD_SIGNING_SECRET
  if (!secret || secret.length < 32) throw new AppError(503, 'connector_not_configured', 'Connector is not configured')
  const rows = await c.env.DB.prepare(
    `SELECT a.id, a.filename, a.content_type, a.size_bytes, a.checksum_sha256, d.created_at AS delivered_at
     FROM deliveries d JOIN assets a ON a.id = d.asset_id
     WHERE d.job_id = ? AND a.visibility = 'CUSTOMER' AND a.order_id = ? ORDER BY d.created_at DESC`
  )
    .bind(job.id, order.order_id)
    .all<{ id: string; filename: string; content_type: string; size_bytes: number; checksum_sha256: string; delivered_at: string }>()
  const exp = Math.floor(Date.now() / 1000) + DOWNLOAD_TTL_SEC
  const origin = new URL(c.req.url).origin
  const items = await Promise.all(
    rows.results.map(async (a) => ({
      id: a.id,
      filename: a.filename,
      content_type: a.content_type,
      size_bytes: a.size_bytes,
      checksum_sha256: a.checksum_sha256,
      delivered_at: a.delivered_at,
      download_url: `${origin}/v1/public/downloads/${a.id}?exp=${exp}&sig=${await signDownload(secret, a.id, order.customer_id, exp)}`,
      expires_at: new Date(exp * 1000).toISOString()
    }))
  )
  return c.json({ public_ref: order.public_ref, status: customerStatus(job.state), deliverables: items })
})

// POST /v1/public/requests/:ref/revisions — eligible revision request (idempotent).
connector.post('/public/requests/:ref/revisions', async (c) => {
  await rateLimit(c.env.DB, `revision:${c.get('connectorKeyId')}`, 60, 60)
  const idemKey = validateIdempotencyKey(c.req.header('idempotency-key'))
  const body = parseBody(c)
  const v = new V()
  const root = v.obj(body, '', ['summary'])
  const summary = v.str(root.summary, 'summary', 10, 2000)
  v.throwIfAny()
  const { job } = await authorizeCustomerOrder(c)
  const r = await customerRevisionRequest(c.env, job, summary, idemKey, c.get('cid'), connectorActor(c))
  return c.json({ revision_id: r.revision_id, status: 'in_progress', idempotent_replay: r.replay }, r.replay ? 200 : 201)
})

// GET /v1/public/downloads/:assetId?exp&sig — short-lived signed link (Public should proxy it).
connector.get('/public/downloads/:assetId', async (c) => {
  await rateLimit(c.env.DB, `download:${clientIp(c)}`, 120, 60)
  const secret = c.env.DOWNLOAD_SIGNING_SECRET
  const denied = new AppError(404, 'not_found', 'Link invalid or expired')
  if (!secret || secret.length < 32) throw new AppError(503, 'connector_not_configured', 'Connector is not configured')
  const assetId = c.req.param('assetId')
  const exp = Number(c.req.query('exp'))
  const sig = c.req.query('sig') ?? ''
  const now = Math.floor(Date.now() / 1000)
  if (!Number.isInteger(exp) || exp < now || exp > now + DOWNLOAD_TTL_SEC + 5 || !sig) throw denied
  const a = await c.env.DB.prepare(
    `SELECT a.*, o.customer_id FROM assets a JOIN orders o ON o.id = a.order_id
     WHERE a.id = ? AND a.visibility = 'CUSTOMER' AND EXISTS (SELECT 1 FROM deliveries d WHERE d.asset_id = a.id)`
  )
    .bind(assetId)
    .first<{ storage: 'R2' | 'INLINE'; storage_key: string | null; inline_text: string | null; filename: string; content_type: string; customer_id: string }>()
  if (!a || !timingSafeEqual(await signDownload(secret, assetId, a.customer_id, exp), sig)) throw denied
  return assetResponse(c.env, a)
})
