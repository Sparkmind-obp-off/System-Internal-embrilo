import { readFileSync, readdirSync } from 'node:fs'
import { Miniflare } from 'miniflare'
import app from '../src/index'
import { hashPassword } from '../src/lib/crypto'
import { signRequest } from '../src/lib/connector'
import type { Bindings } from '../src/types'

export const SECRETS = {
  CONNECTOR_HMAC_SECRET: 'test-connector-secret-0123456789abcdef0123',
  CUSTOMER_TOKEN_SECRET: 'test-customer-secret-0123456789abcdef01234',
  DOWNLOAD_SIGNING_SECRET: 'test-download-secret-0123456789abcdef01234'
}
export const KEY_ID = 'public-embrilo-v1'
export const BASE = 'http://localhost'

export async function setupEnv(opts: { r2?: boolean } = {}) {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("") } }',
    d1Databases: ['DB'],
    r2Buckets: ['R2']
  })
  const DB = (await mf.getD1Database('DB')) as unknown as D1Database
  const R2 = (await mf.getR2Bucket('R2')) as unknown as R2Bucket
  const dir = new URL('../migrations/', import.meta.url)
  const sql = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(new URL(f, dir), 'utf8'))
    .join('\n;\n')
  const statements = sql
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
  for (const s of statements) await DB.prepare(s).run()
  const env: Bindings = {
    DB,
    R2: opts.r2 === false ? undefined : R2,
    APP_ENV: 'test',
    CONNECTOR_KEY_ID: KEY_ID,
    MAX_REVISION_ROUNDS: '2',
    ...SECRETS
  }
  return { mf, env }
}

export const PASSWORD = 'correct-horse-battery-staple'

export async function addOperator(env: Bindings, email: string, role: 'ADMIN' | 'OPERATOR' | 'VIEWER') {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO operators (id, email, display_name, role, password_hash, active, failed_logins, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)`
  )
    .bind(id, email, email.split('@')[0], role, await hashPassword(PASSWORD), now, now)
    .run()
  return id
}

export function call(env: Bindings, path: string, init: RequestInit = {}) {
  return app.fetch(new Request(BASE + path, init), env, {
    waitUntil() {},
    passThroughOnException() {}
  } as unknown as ExecutionContext)
}

/** Logs in through the real login form and returns cookie + CSRF token for the session. */
export async function login(env: Bindings, email: string, password = PASSWORD) {
  const page = await call(env, '/login')
  const lcookie = (page.headers.get('set-cookie') ?? '').split(';')[0]
  const html = await page.text()
  const lcsrf = /name="_lcsrf" value="([^"]+)"/.exec(html)?.[1] ?? ''
  const res = await call(env, '/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: lcookie, origin: BASE },
    body: new URLSearchParams({ email, password, _lcsrf: lcsrf })
  })
  const setCookie = res.headers.get('set-cookie') ?? ''
  const cookie = setCookie.split(';')[0]
  if (res.headers.get('location') !== '/console' || !cookie.startsWith('embrilo_sid=')) return { ok: false as const, res }
  const consolePage = await call(env, '/console', { headers: { cookie } })
  const csrf = /name="_csrf" value="([^"]+)"/.exec(await consolePage.text())?.[1] ?? ''
  return { ok: true as const, cookie, csrf, res }
}

export type Session = { cookie: string; csrf: string }

/** Calls the internal JSON API with session + CSRF header. */
export function internalPost(env: Bindings, s: Session, path: string, body: Record<string, unknown> = {}) {
  return call(env, `/v1/internal${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: s.cookie, 'x-csrf-token': s.csrf, accept: 'application/json' },
    body: JSON.stringify(body)
  })
}

export async function signedCall(
  env: Bindings,
  method: string,
  path: string,
  opts: { body?: unknown; customerRef?: string; customerToken?: string; idempotencyKey?: string; secret?: string; timestamp?: number; nonce?: string } = {}
) {
  const body = opts.body === undefined ? '' : JSON.stringify(opts.body)
  const headers = await signRequest(opts.secret ?? SECRETS.CONNECTOR_HMAC_SECRET, {
    method,
    pathWithQuery: path,
    body,
    customerRef: opts.customerRef,
    customerToken: opts.customerToken,
    idempotencyKey: opts.idempotencyKey,
    keyId: KEY_ID,
    timestamp: opts.timestamp,
    nonce: opts.nonce
  })
  return call(env, path, {
    method,
    headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body || undefined
  })
}

let seq = 0
export function requestBody(customerRef: string, overrides: Record<string, unknown> = {}) {
  seq++
  return {
    customer: { external_ref: customerRef, display_name: `Synthetic Customer ${seq}` },
    consent: { accepted: true, terms_version: 'terms-2026-10', accepted_at: '2026-10-27T08:00:00Z' },
    service_code: 'SCRIPT_PACK',
    brief: {
      objective: 'Launch a fictional cold brew product for office workers.',
      audience: 'Office workers 22-35 (synthetic test audience)',
      product_facts: 'Fictional 250 ml cold brew, no added sugar. Synthetic test data.',
      platforms: ['tiktok'],
      language: 'id',
      tone: 'santai',
      cta: 'Pesan sekarang',
      constraints: 'No health claims',
      references: [],
      rights_confirmed: true
    },
    ...overrides
  }
}

export const idem = () => `idem-${crypto.randomUUID()}`

/** Creates a request via the signed connector and returns its identifiers. */
export async function submit(env: Bindings, customerRef: string) {
  const res = await signedCall(env, 'POST', '/v1/public/requests', { body: requestBody(customerRef), idempotencyKey: idem() })
  if (res.status !== 201) throw new Error(`submit failed ${res.status} ${await res.text()}`)
  const j = (await res.json()) as { public_ref: string; customer_token: string }
  const job = await env.DB.prepare('SELECT j.id FROM jobs j JOIN orders o ON o.id = j.order_id WHERE o.public_ref = ?')
    .bind(j.public_ref)
    .first<{ id: string }>()
  return { ...j, jobId: job!.id }
}

/** Drives a job from SUBMITTED to APPROVED (or stops at a given state) through the internal API. */
export async function driveTo(env: Bindings, s: Session, jobId: string, stop: 'QUEUED' | 'IN_PRODUCTION' | 'QC_REVIEW' | 'APPROVED' | 'DELIVERED') {
  const ok = async (r: Response) => {
    if (r.status !== 200) throw new Error(`step failed ${r.status} ${await r.text()}`)
    return r.json() as Promise<any>
  }
  await ok(await internalPost(env, s, `/jobs/${jobId}/triage`, { action: 'start' }))
  await ok(await internalPost(env, s, `/jobs/${jobId}/triage`, { action: 'queue' }))
  if (stop === 'QUEUED') return {}
  const run = await ok(await internalPost(env, s, `/jobs/${jobId}/start-production`, { provider: 'genspark-manual' }))
  if (stop === 'IN_PRODUCTION') return { runId: run.run_id as string, prompt: run.prompt as string }
  await ok(await internalPost(env, s, `/jobs/${jobId}/production-result`, { run_id: run.run_id, output_text: 'DRAFT: synthetic script pack v1', operator_minutes: 15 }))
  if (stop === 'QC_REVIEW') return { runId: run.run_id as string }
  await ok(await internalPost(env, s, `/jobs/${jobId}/review`, { decision: 'APPROVE', checklist: allChecks() }))
  if (stop === 'APPROVED') return { runId: run.run_id as string }
  await ok(await internalPost(env, s, `/jobs/${jobId}/deliver`))
  return { runId: run.run_id as string }
}

export const allChecks = () => ({
  factual_accuracy: true,
  brand_fit: true,
  language_quality: true,
  platform_format: true,
  rights_clear: true,
  no_prohibited_claims: true
})

export async function jobState(env: Bindings, jobId: string) {
  return (await env.DB.prepare('SELECT state FROM jobs WHERE id = ?').bind(jobId).first<{ state: string }>())!.state
}
