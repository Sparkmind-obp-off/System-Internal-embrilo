import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Miniflare } from 'miniflare'
import { setupEnv, addOperator, login, call, internalPost, submit, driveTo, jobState, allChecks, PASSWORD, BASE, type Session } from './helpers'
import type { Bindings } from '../src/types'

let mf: Miniflare
let env: Bindings
let op: Session
beforeEach(async () => {
  ;({ mf, env } = await setupEnv())
  await addOperator(env, 'operator@example.test', 'OPERATOR')
  op = (await login(env, 'operator@example.test')) as Session & { ok: true }
})
afterEach(async () => mf.dispose())

describe('operator access', () => {
  it('console requires login', async () => {
    const res = await call(env, '/console')
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/login')
    const api = await call(env, '/v1/internal/jobs/x', { headers: { accept: 'application/json' } })
    expect(api.status).toBe(401)
  })

  it('valid login yields an HttpOnly SameSite=Strict session cookie', async () => {
    const r = await login(env, 'operator@example.test')
    expect(r.ok).toBe(true)
    const sc = r.res.headers.get('set-cookie') ?? ''
    expect(sc).toMatch(/HttpOnly/i)
    expect(sc).toMatch(/SameSite=Strict/i)
  })

  it('wrong password fails; account locks after repeated failures', async () => {
    for (let i = 0; i < 5; i++) expect((await login(env, 'operator@example.test', 'wrong-password-123')).ok).toBe(false)
    // Even the correct password is refused while locked.
    expect((await login(env, 'operator@example.test', PASSWORD)).ok).toBe(false)
    const row = await env.DB.prepare('SELECT locked_until FROM operators WHERE email = ?').bind('operator@example.test').first<{ locked_until: string }>()
    expect(Date.parse(row!.locked_until)).toBeGreaterThan(Date.now())
  })

  it('login form requires its CSRF token', async () => {
    const before = (await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first<{ n: number }>())!.n
    const res = await call(env, '/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE },
      body: new URLSearchParams({ email: 'operator@example.test', password: PASSWORD })
    })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/login?err=expired')
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first<{ n: number }>()
    expect(row!.n).toBe(before) // no new session was created
  })

  it('browser form login works when the browser sends Origin: null (regression)', async () => {
    const page = await call(env, '/login')
    const lcookie = (page.headers.get('set-cookie') ?? '').split(';')[0]
    const lcsrf = /name="_lcsrf" value="([^"]+)"/.exec(await page.text())?.[1] ?? ''
    const res = await call(env, '/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: lcookie, origin: 'null', 'sec-fetch-site': 'same-origin' },
      body: new URLSearchParams({ email: 'Operator@Example.test', password: PASSWORD, _lcsrf: lcsrf })
    })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/console')
  })

  it('login from a cross-site page is refused even with a token', async () => {
    const page = await call(env, '/login')
    const lcookie = (page.headers.get('set-cookie') ?? '').split(';')[0]
    const lcsrf = /name="_lcsrf" value="([^"]+)"/.exec(await page.text())?.[1] ?? ''
    const res = await call(env, '/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: lcookie, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
      body: new URLSearchParams({ email: 'operator@example.test', password: PASSWORD, _lcsrf: lcsrf })
    })
    expect(res.headers.get('location')).toBe('/login?err=expired')
  })

  it('state-changing calls require a valid CSRF token and same origin', async () => {
    const { jobId } = await submit(env, 'cust_csrf_00001')
    const noToken = await call(env, `/v1/internal/jobs/${jobId}/triage`, {
      method: 'POST',
      headers: { cookie: op.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'start' })
    })
    expect(noToken.status).toBe(403)
    const crossOrigin = await call(env, `/v1/internal/jobs/${jobId}/triage`, {
      method: 'POST',
      headers: { cookie: op.cookie, 'x-csrf-token': op.csrf, origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'start' })
    })
    expect(crossOrigin.status).toBe(403)
    expect(await jobState(env, jobId)).toBe('SUBMITTED')
  })

  it('logout invalidates the session server-side', async () => {
    await call(env, '/logout', {
      method: 'POST',
      headers: { cookie: op.cookie, 'content-type': 'application/x-www-form-urlencoded', origin: BASE },
      body: new URLSearchParams({ _csrf: op.csrf })
    })
    const res = await call(env, '/console', { headers: { cookie: op.cookie } })
    expect(res.status).toBe(303)
  })

  it('VIEWER can read but cannot change state', async () => {
    await addOperator(env, 'viewer@example.test', 'VIEWER')
    const v = (await login(env, 'viewer@example.test')) as Session & { ok: true }
    const { jobId } = await submit(env, 'cust_viewer_001')
    expect((await call(env, `/console/jobs/${jobId}`, { headers: { cookie: v.cookie } })).status).toBe(200)
    const res = await internalPost(env, v, `/jobs/${jobId}/triage`, { action: 'start' })
    expect(res.status).toBe(403)
    expect(await jobState(env, jobId)).toBe('SUBMITTED')
  })

  it('only ADMIN can cancel jobs or view the audit trail', async () => {
    const { jobId } = await submit(env, 'cust_cancel_001')
    expect((await internalPost(env, op, `/jobs/${jobId}/cancel`, { reason: 'test cancel' })).status).toBe(403)
    expect((await call(env, '/console/audit', { headers: { cookie: op.cookie } })).status).toBe(403)
    await addOperator(env, 'admin@example.test', 'ADMIN')
    const a = (await login(env, 'admin@example.test')) as Session & { ok: true }
    expect((await internalPost(env, a, `/jobs/${jobId}/cancel`, { reason: 'test cancel' })).status).toBe(200)
    expect(await jobState(env, jobId)).toBe('CANCELLED')
    expect((await call(env, '/console/audit', { headers: { cookie: a.cookie } })).status).toBe(200)
  })
})

describe('workflow & state transitions', () => {
  it('full happy path records actor, timestamp and correlation id for every change', async () => {
    const { jobId } = await submit(env, 'cust_happy_0001')
    await driveTo(env, op, jobId, 'DELIVERED')
    expect(await jobState(env, jobId)).toBe('DELIVERED')
    const hist = await env.DB.prepare('SELECT * FROM job_state_history WHERE job_id = ? ORDER BY created_at, rowid').bind(jobId).all<any>()
    expect(hist.results.map((h) => h.to_state)).toEqual(['SUBMITTED', 'TRIAGE', 'QUEUED', 'IN_PRODUCTION', 'QC_REVIEW', 'APPROVED', 'DELIVERED'])
    for (const h of hist.results) {
      expect(h.actor_id).toBeTruthy()
      expect(h.correlation_id).toBeTruthy()
      expect(h.created_at).toMatch(/Z$/)
    }
    const delivered = await env.DB.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE job_id = ?').bind(jobId).first<{ n: number }>()
    expect(delivered!.n).toBe(1)
  })

  it('rejects invalid transitions (skip steps)', async () => {
    const { jobId } = await submit(env, 'cust_skip_00001')
    let res = await internalPost(env, op, `/jobs/${jobId}/start-production`, { provider: 'genspark-manual' })
    expect(res.status).toBe(409)
    res = await internalPost(env, op, `/jobs/${jobId}/triage`, { action: 'queue' })
    expect(res.status).toBe(409)
    expect(await jobState(env, jobId)).toBe('SUBMITTED')
  })

  it('cannot queue a brief whose rights are not confirmed', async () => {
    const { jobId } = await submit(env, 'cust_rights_001')
    await env.DB.prepare('UPDATE briefs SET rights_confirmed = 0 WHERE order_id = (SELECT order_id FROM jobs WHERE id = ?)').bind(jobId).run()
    await internalPost(env, op, `/jobs/${jobId}/triage`, { action: 'start' })
    const res = await internalPost(env, op, `/jobs/${jobId}/triage`, { action: 'queue' })
    expect(res.status).toBe(422)
  })

  it('needs-info requires a customer-safe message and shows it to the customer only in that state', async () => {
    const { jobId } = await submit(env, 'cust_needinfo01')
    await internalPost(env, op, `/jobs/${jobId}/triage`, { action: 'start' })
    expect((await internalPost(env, op, `/jobs/${jobId}/triage`, { action: 'needs_info' })).status).toBe(422)
    expect((await internalPost(env, op, `/jobs/${jobId}/triage`, { action: 'needs_info', customer_message: 'Please send product size.' })).status).toBe(200)
    expect(await jobState(env, jobId)).toBe('NEEDS_INFO')
  })

  it('stale concurrent update is rejected (optimistic locking)', async () => {
    const { jobId } = await submit(env, 'cust_concurr_01')
    const results = await Promise.all([
      internalPost(env, op, `/jobs/${jobId}/triage`, { action: 'start' }),
      internalPost(env, op, `/jobs/${jobId}/triage`, { action: 'start' })
    ])
    const statuses = results.map((r) => r.status).sort()
    expect(statuses).toEqual([200, 409])
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM job_state_history WHERE job_id = ? AND to_state = 'TRIAGE'`).bind(jobId).first<{ n: number }>()
    expect(n!.n).toBe(1)
  })
})

describe('delivery gate', () => {
  it.each(['QUEUED', 'IN_PRODUCTION', 'QC_REVIEW'] as const)('cannot deliver from %s', async (stop) => {
    const { jobId } = await submit(env, `cust_gate_${stop.slice(0, 5).toLowerCase()}1`)
    await driveTo(env, op, jobId, stop)
    const res = await internalPost(env, op, `/jobs/${jobId}/deliver`)
    expect(res.status).toBe(409)
    expect(((await res.json()) as any).error.code).toBe('not_approved')
    expect(await jobState(env, jobId)).toBe(stop)
    const vis = await env.DB.prepare(`SELECT COUNT(*) AS n FROM assets WHERE job_id = ? AND visibility = 'CUSTOMER'`).bind(jobId).first<{ n: number }>()
    expect(vis!.n).toBe(0)
  })

  it('approval requires every QC checklist item; revision requires notes', async () => {
    const { jobId } = await submit(env, 'cust_qc_000001')
    await driveTo(env, op, jobId, 'QC_REVIEW')
    let res = await internalPost(env, op, `/jobs/${jobId}/review`, { decision: 'APPROVE', checklist: { ...allChecks(), rights_clear: false } })
    expect(res.status).toBe(422)
    res = await internalPost(env, op, `/jobs/${jobId}/review`, { decision: 'REQUEST_REVISION' })
    expect(res.status).toBe(422)
    res = await internalPost(env, op, `/jobs/${jobId}/review`, { decision: 'REQUEST_REVISION', notes: 'Hook is too long.' })
    expect(res.status).toBe(200)
    expect(await jobState(env, jobId)).toBe('NEEDS_REVISION')
    expect((await internalPost(env, op, `/jobs/${jobId}/deliver`)).status).toBe(409)
  })

  it('cannot deliver twice', async () => {
    const { jobId } = await submit(env, 'cust_twice_0001')
    await driveTo(env, op, jobId, 'DELIVERED')
    expect((await internalPost(env, op, `/jobs/${jobId}/deliver`)).status).toBe(409)
  })
})

describe('provider adapter & failure recovery', () => {
  it('manual-assisted run produces a sanitized prompt with provenance', async () => {
    const { jobId } = await submit(env, 'cust_prompt_001')
    await env.DB.prepare(`UPDATE briefs SET constraints = 'Contact owner at owner@example.com or +62 812 3456 7890' WHERE order_id = (SELECT order_id FROM jobs WHERE id = ?)`).bind(jobId).run()
    const { prompt, runId } = (await driveTo(env, op, jobId, 'IN_PRODUCTION')) as { prompt: string; runId: string }
    expect(prompt).toContain('[redacted-email]')
    expect(prompt).toContain('[redacted-phone]')
    expect(prompt).not.toContain('owner@example.com')
    expect(prompt).toContain('BRIEF DATA')
    const run = await env.DB.prepare('SELECT provider, mode, template_version, input_digest, status FROM production_runs WHERE id = ?').bind(runId).first<any>()
    expect(run).toMatchObject({ provider: 'genspark-manual', mode: 'manual', template_version: 'genspark-prod-v1', status: 'RUNNING' })
    expect(run.input_digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('unknown provider is rejected; a second concurrent run is refused', async () => {
    const { jobId } = await submit(env, 'cust_provider01')
    await driveTo(env, op, jobId, 'QUEUED')
    expect((await internalPost(env, op, `/jobs/${jobId}/start-production`, { provider: 'genspark-api' })).status).toBe(422)
    expect((await internalPost(env, op, `/jobs/${jobId}/start-production`, { provider: 'genspark-manual' })).status).toBe(200)
    expect((await internalPost(env, op, `/jobs/${jobId}/start-production`, { provider: 'genspark-manual' })).status).toBe(409)
  })

  it('provider failure parks the job recoverably, never delivers, and allows a retry', async () => {
    const { jobId } = await submit(env, 'cust_failure_01')
    const { runId } = (await driveTo(env, op, jobId, 'IN_PRODUCTION')) as { runId: string }
    let res = await internalPost(env, op, `/jobs/${jobId}/production-failure`, { run_id: runId, error_code: 'PROVIDER_UNAVAILABLE', outcome: 'BLOCKED_PROVIDER', note: 'timeout' })
    expect(res.status).toBe(200)
    expect(await jobState(env, jobId)).toBe('BLOCKED_PROVIDER')
    expect((await internalPost(env, op, `/jobs/${jobId}/deliver`)).status).toBe(409)
    const run = await env.DB.prepare('SELECT status, error_code FROM production_runs WHERE id = ?').bind(runId).first<any>()
    expect(run).toMatchObject({ status: 'BLOCKED', error_code: 'PROVIDER_UNAVAILABLE' })
    // Closed run cannot be completed afterwards.
    res = await internalPost(env, op, `/jobs/${jobId}/production-result`, { run_id: runId, output_text: 'late output' })
    expect(res.status).toBe(409)
    // Retry with a fresh run and finish.
    const retry = (await (await internalPost(env, op, `/jobs/${jobId}/start-production`, { provider: 'genspark-manual' })).json()) as any
    res = await internalPost(env, op, `/jobs/${jobId}/production-result`, { run_id: retry.run_id, output_text: 'DRAFT after retry' })
    expect(res.status).toBe(200)
    expect(await jobState(env, jobId)).toBe('QC_REVIEW')
    const job = await env.DB.prepare('SELECT attempts FROM jobs WHERE id = ?').bind(jobId).first<{ attempts: number }>()
    expect(job!.attempts).toBe(2)
  })

  it('FAILED job can be requeued', async () => {
    const { jobId } = await submit(env, 'cust_failed_001')
    const { runId } = (await driveTo(env, op, jobId, 'IN_PRODUCTION')) as { runId: string }
    await internalPost(env, op, `/jobs/${jobId}/production-failure`, { run_id: runId, error_code: 'OUTPUT_UNUSABLE', outcome: 'FAILED' })
    expect(await jobState(env, jobId)).toBe('FAILED')
    expect((await internalPost(env, op, `/jobs/${jobId}/requeue`, {})).status).toBe(200)
    expect(await jobState(env, jobId)).toBe('QUEUED')
  })
})

describe('file uploads (private R2)', () => {
  const form = (s: Session, file: File, field = 'reference_file') => {
    const fd = new FormData()
    fd.set('_csrf', s.csrf)
    fd.set(field, file)
    return fd
  }

  it('accepts an allowed file under a random key and serves it only to operators', async () => {
    const { jobId } = await submit(env, 'cust_upload_001')
    const res = await call(env, `/console/jobs/${jobId}/reference`, {
      method: 'POST',
      headers: { cookie: op.cookie, origin: BASE },
      body: form(op, new File(['synthetic reference notes'], '../../etc/notes.txt', { type: 'text/plain' }))
    })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toContain('ok=')
    const a = await env.DB.prepare('SELECT id, storage_key, filename FROM assets WHERE job_id = ?').bind(jobId).first<any>()
    expect(a.storage_key).toMatch(/^reference\/[0-9a-f-]{36}$/)
    expect(a.filename).toBe('notes.txt')
    expect((await call(env, `/console/assets/${a.id}`)).status).toBe(303) // anonymous → login
    const dl = await call(env, `/console/assets/${a.id}`, { headers: { cookie: op.cookie } })
    expect(dl.status).toBe(200)
    expect(dl.headers.get('content-disposition')).toContain('attachment')
  })

  it.each([
    ['executable extension', new File(['MZ'], 'run.exe', { type: 'application/octet-stream' })],
    ['html', new File(['<script>alert(1)</script>'], 'x.html', { type: 'text/html' })],
    ['svg', new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' })],
    ['renamed pdf with wrong magic bytes', new File(['not a pdf'], 'doc.pdf', { type: 'application/pdf' })]
  ])('rejects %s', async (_n, file) => {
    const { jobId } = await submit(env, 'cust_badfile_01')
    const res = await call(env, `/console/jobs/${jobId}/reference`, { method: 'POST', headers: { cookie: op.cookie, origin: BASE }, body: form(op, file) })
    expect(res.status).toBe(303)
    expect(decodeURIComponent(res.headers.get('location') ?? '')).toMatch(/err=/)
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM assets WHERE job_id = ?').bind(jobId).first<{ n: number }>()
    expect(n!.n).toBe(0)
  })

  it('rejects files over 10 MB', async () => {
    const { jobId } = await submit(env, 'cust_bigfile_01')
    const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'big.txt', { type: 'text/plain' })
    const res = await call(env, `/console/jobs/${jobId}/reference`, { method: 'POST', headers: { cookie: op.cookie, origin: BASE }, body: form(op, big) })
    expect(decodeURIComponent(res.headers.get('location') ?? '')).toMatch(/err=.*melebihi batas 10 MB/)
  })
})

describe('console pages & headers', () => {
  it('renders queue, job detail, metrics and providers with strict security headers', async () => {
    const { jobId } = await submit(env, 'cust_pages_0001')
    await driveTo(env, op, jobId, 'IN_PRODUCTION')
    for (const p of ['/console', `/console/jobs/${jobId}`, '/console/metrics', '/console/providers']) {
      const res = await call(env, p, { headers: { cookie: op.cookie } })
      expect(res.status, p).toBe(200)
      expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
      expect(res.headers.get('x-frame-options')).toBe('DENY')
      expect(res.headers.get('cache-control')).toBe('no-store')
    }
    const page = await (await call(env, `/console/jobs/${jobId}`, { headers: { cookie: op.cookie } })).text()
    expect(page).toContain('Sanitized prompt')
    expect(page).toContain('Salin prompt')
    expect(page).not.toContain('<script>alert')
  })

  it('escapes untrusted brief content in HTML (XSS)', async () => {
    const { jobId } = await submit(env, 'cust_xss_000001')
    await env.DB.prepare(`UPDATE briefs SET objective = '<img src=x onerror=alert(1)>' WHERE order_id = (SELECT order_id FROM jobs WHERE id = ?)`).bind(jobId).run()
    const html = await (await call(env, `/console/jobs/${jobId}`, { headers: { cookie: op.cookie } })).text()
    expect(html).not.toContain('<img src=x onerror=alert(1)>')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('queue supports grouped views, search and priority filter (no SQL wildcard injection)', async () => {
    const a = await submit(env, 'cust_queue_srch1')
    await submit(env, 'cust_queue_srch2')
    const html = async (q: string) => (await call(env, `/console${q}`, { headers: { cookie: op.cookie } })).text()
    expect(await html(`?q=${a.public_ref}`)).toContain(a.public_ref)
    expect(await html('?q=%25')).toContain('Tidak ada yang cocok') // literal %, not "match everything"
    expect(await html('?view=triage')).toContain(a.public_ref)
    expect(await html('?view=review')).toContain('Tidak ada pekerjaan di sini')
    expect(await html('?prio=URGENT')).not.toContain(a.public_ref)
    expect(await html('?view=bogus')).toContain(a.public_ref) // unknown view falls back to all open
  })

  it('validation errors re-render the form with field errors and preserved values', async () => {
    const { jobId } = await submit(env, 'cust_preserve01')
    await internalPost(env, op, `/jobs/${jobId}/triage`, { action: 'start' })
    const res = await call(env, `/console/jobs/${jobId}/brief`, {
      method: 'POST',
      headers: { cookie: op.cookie, origin: BASE, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: op.csrf, objective: 'short', audience: 'Audience kept intact', product_facts: 'Fakta produk yang cukup panjang', language: 'id' })
    })
    expect(res.status).toBe(422)
    const page = await res.text()
    expect(page).toContain('Audience kept intact') // value preserved
    expect(page).toContain('Minimal 10 karakter') // Indonesian field error
    expect(page).toContain('aria-invalid="true"')
    // nothing was saved
    const b = await env.DB.prepare('SELECT audience FROM briefs WHERE order_id = (SELECT order_id FROM jobs WHERE id = ?)').bind(jobId).first<{ audience: string }>()
    expect(b!.audience).not.toBe('Audience kept intact')
  })

  it('audit can be filtered by type and correlation id', async () => {
    await addOperator(env, 'admin2@example.test', 'ADMIN')
    const a = (await login(env, 'admin2@example.test')) as Session & { ok: true }
    const { jobId } = await submit(env, 'cust_auditflt1')
    await internalPost(env, a, `/jobs/${jobId}/triage`, { action: 'start' })
    const auth = await (await call(env, '/console/audit?type=auth', { headers: { cookie: a.cookie } })).text()
    expect(auth).toContain('auth.login')
    expect(auth).not.toContain('request.created')
    const cid = (await env.DB.prepare(`SELECT correlation_id FROM audit_events WHERE action = 'request.created'`).first<{ correlation_id: string }>())!.correlation_id
    const byCid = await (await call(env, `/console/audit?q=${cid.slice(0, 12)}`, { headers: { cookie: a.cookie } })).text()
    expect(byCid).toContain('request.created')
    expect(byCid).not.toContain('auth.login')
  })

  it('pages ship no inline scripts or inline styles (strict CSP compatible)', async () => {
    const { jobId } = await submit(env, 'cust_csp_000001')
    for (const p of ['/login', '/console', `/console/jobs/${jobId}`, '/console/metrics', '/console/providers']) {
      const html = await (await call(env, p, { headers: { cookie: op.cookie } })).text()
      expect(html, p).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/)
      expect(html, p).not.toMatch(/\sstyle="/)
      expect(html, p).not.toMatch(/\son[a-z]+="/)
    }
  })

  it('health endpoint reveals nothing sensitive', async () => {
    const res = await call(env, '/health')
    expect(await res.json()).toEqual({ ok: true })
  })
})
