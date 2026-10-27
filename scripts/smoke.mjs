#!/usr/bin/env node
// End-to-end smoke test against a RUNNING instance (local wrangler or a deployed URL).
// Uses only synthetic data. Secrets are read from env vars or .dev.vars — never hard-coded.
//
//   BASE_URL=http://localhost:3000 OPERATOR_EMAIL=... OPERATOR_PASSWORD=... node scripts/smoke.mjs
//
// Required: CONNECTOR_HMAC_SECRET (env or .dev.vars), OPERATOR_EMAIL, OPERATOR_PASSWORD.
import { createHash, createHmac, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'

const devVars = existsSync('.dev.vars')
  ? Object.fromEntries(
      readFileSync('.dev.vars', 'utf8')
        .split('\n')
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()])
    )
  : {}
const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '')
const SECRET = process.env.CONNECTOR_HMAC_SECRET || devVars.CONNECTOR_HMAC_SECRET
const KEY_ID = process.env.CONNECTOR_KEY_ID || 'public-embrilo-v1'
const EMAIL = process.env.OPERATOR_EMAIL
const PASSWORD = process.env.OPERATOR_PASSWORD
if (!SECRET || !EMAIL || !PASSWORD) {
  console.error('Missing CONNECTOR_HMAC_SECRET / OPERATOR_EMAIL / OPERATOR_PASSWORD')
  process.exit(2)
}

const sha = (s) => createHash('sha256').update(s).digest('hex')
const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
let step = 0
const check = (cond, label, extra = '') => {
  step++
  console.log(`${cond ? 'PASS' : 'FAIL'} ${String(step).padStart(2)} ${label}${extra ? ` — ${extra}` : ''}`)
  if (!cond) process.exitCode = 1
  return cond
}

async function signed(method, path, { body, customerRef = '', customerToken = '', idem = '' } = {}) {
  const text = body ? JSON.stringify(body) : ''
  const ts = String(Math.floor(Date.now() / 1000))
  const nonce = randomUUID().replace(/-/g, '')
  const canonical = ['EMBRILO-HMAC-V1', 'embrilo-os/v1', method, path, ts, nonce, customerRef, customerToken, idem, sha(text)].join('\n')
  const headers = {
    'X-Embrilo-Key-Id': KEY_ID,
    'X-Embrilo-Timestamp': ts,
    'X-Embrilo-Nonce': nonce,
    'X-Embrilo-Signature': b64url(createHmac('sha256', SECRET).update(canonical).digest())
  }
  if (customerRef) headers['X-Embrilo-Customer'] = customerRef
  if (customerToken) headers['X-Embrilo-Customer-Token'] = customerToken
  if (idem) headers['Idempotency-Key'] = idem
  if (text) headers['Content-Type'] = 'application/json'
  return fetch(BASE + path, { method, headers, body: text || undefined, redirect: 'manual' })
}

const customerRef = `smoke_${randomUUID().slice(0, 12)}`
const body = {
  customer: { external_ref: customerRef, display_name: 'Smoke Test (synthetic)' },
  consent: { accepted: true, terms_version: 'terms-2026-10', accepted_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z') },
  service_code: 'SCRIPT_PACK',
  brief: {
    objective: 'Synthetic smoke test: promote a fictional product.',
    audience: 'Synthetic audience',
    product_facts: 'Fictional product facts for automated smoke testing only.',
    platforms: ['tiktok'],
    language: 'id',
    tone: 'santai',
    cta: 'Coba sekarang',
    constraints: 'No claims',
    references: [],
    rights_confirmed: true
  }
}

// 1. Unauthenticated access is refused
check((await fetch(`${BASE}/health`).then((r) => r.json())).ok === true, 'health')
const anon = await fetch(`${BASE}/console`, { redirect: 'manual' })
check(anon.status === 303 && anon.headers.get('location') === '/login', 'console requires login')
const unsigned = await fetch(`${BASE}/v1/public/requests`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
check(unsigned.status === 401, 'unsigned connector call rejected', String(unsigned.status))

// 2. Signed intake + idempotent retry
const idem = `smoke-${randomUUID()}`
const created = await signed('POST', '/v1/public/requests', { body, idem })
const cj = await created.json()
check(created.status === 201 && /^EMB-/.test(cj.public_ref), 'signed intake creates request', cj.public_ref)
const retry = await signed('POST', '/v1/public/requests', { body, idem })
const rj = await retry.json()
check(retry.status === 200 && rj.public_ref === cj.public_ref, 'idempotent retry returns same request (no duplicate)')
const auth = { customerRef, customerToken: cj.customer_token }
const refOnly = await signed('GET', `/v1/public/requests/${cj.public_ref}`, { customerRef })
check(refOnly.status === 404, 'reference without customer token is refused')

// 3. Operator login
const loginPage = await fetch(`${BASE}/login`)
const lcookie = (loginPage.headers.get('set-cookie') || '').split(';')[0]
const lcsrf = /name="_lcsrf" value="([^"]+)"/.exec(await loginPage.text())?.[1]
const login = await fetch(`${BASE}/login`, {
  method: 'POST',
  redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: lcookie, origin: BASE },
  body: new URLSearchParams({ email: EMAIL, password: PASSWORD, _lcsrf: lcsrf })
})
const cookie = (login.headers.get('set-cookie') || '').split(';')[0]
if (!check(login.status === 303 && login.headers.get('location') === '/console' && cookie.includes('_sid='), 'operator login')) process.exit(1)
const queueHtml = await fetch(`${BASE}/console`, { headers: { cookie } }).then((r) => r.text())
const csrf = /name="_csrf" value="([^"]+)"/.exec(queueHtml)?.[1]
const jobId = new RegExp(`href="/console/jobs/([0-9a-f-]{36})">${cj.public_ref}<`).exec(queueHtml)?.[1]
check(!!jobId, 'new request visible in queue')

const post = (p, b = {}) =>
  fetch(`${BASE}/v1/internal/jobs/${jobId}/${p}`, {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json', accept: 'application/json', origin: BASE },
    body: JSON.stringify(b)
  })

// 4. Workflow
const early = await post('deliver')
check(early.status === 409, 'delivery refused before approval', String(early.status))
check((await post('triage', { action: 'start' })).status === 200, 'triage started')
check((await post('triage', { action: 'queue' })).status === 200, 'qualified → queued')
const run = await (await post('start-production', { provider: 'genspark-manual' })).json()
check(run.ok && run.mode === 'manual' && run.prompt.includes('BRIEF DATA'), 'manual-assisted production run + sanitized prompt')
const fail = await post('production-failure', { run_id: run.run_id, error_code: 'PROVIDER_UNAVAILABLE', outcome: 'BLOCKED_PROVIDER', note: 'smoke' })
check(fail.status === 200, 'provider failure recorded (recoverable)')
const run2 = await (await post('start-production', { provider: 'genspark-manual' })).json()
check(run2.ok, 'retry production run after failure')
check((await post('production-result', { run_id: run2.run_id, output_text: 'SMOKE DRAFT: synthetic hooks and script', operator_minutes: 5 })).status === 200, 'draft attached → QC')
const checklist = { factual_accuracy: true, brand_fit: true, language_quality: true, platform_format: true, rights_clear: true, no_prohibited_claims: true }
check((await post('review', { decision: 'APPROVE', checklist })).status === 200, 'QC approved')
const pre = await signed('GET', `/v1/public/requests/${cj.public_ref}/deliverables`, auth).then((r) => r.json())
check(pre.deliverables?.length === 0, 'approved-but-unreleased draft not visible to customer')
check((await post('deliver')).status === 200, 'delivered')

// 5. Customer view
const status = await signed('GET', `/v1/public/requests/${cj.public_ref}`, auth).then((r) => r.json())
check(status.status === 'delivered', 'customer status = delivered')
const dels = await signed('GET', `/v1/public/requests/${cj.public_ref}/deliverables`, auth).then((r) => r.json())
const url = dels.deliverables?.[0]?.download_url
const file = url ? await fetch(url).then((r) => r.text()) : ''
check(file.includes('SMOKE DRAFT'), 'customer downloads approved deliverable via short-lived link')
const rev = await signed('POST', `/v1/public/requests/${cj.public_ref}/revisions`, { ...auth, body: { summary: 'Smoke revision: shorter hook please.' }, idem: `smoke-${randomUUID()}` })
check(rev.status === 201, 'customer revision request accepted after delivery')

console.log(process.exitCode ? '\nSMOKE TEST FAILED' : `\nSMOKE TEST PASSED (${step} checks) against ${BASE}`)
