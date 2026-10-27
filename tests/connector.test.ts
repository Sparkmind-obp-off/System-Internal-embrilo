import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setupEnv, signedCall, requestBody, idem, call, SECRETS, submit, addOperator, login, driveTo, jobState, type Session } from './helpers'
import type { Bindings } from '../src/types'
import type { Miniflare } from 'miniflare'

let mf: Miniflare
let env: Bindings
beforeEach(async () => ({ mf, env } = await setupEnv()))
afterEach(async () => mf.dispose())

describe('connector authentication', () => {
  it('rejects unsigned requests', async () => {
    const res = await call(env, '/v1/public/requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idem() },
      body: JSON.stringify(requestBody('cust_unsigned_01'))
    })
    expect(res.status).toBe(401)
  })

  it('rejects a wrong secret', async () => {
    const res = await signedCall(env, 'POST', '/v1/public/requests', { body: requestBody('cust_wrongkey_1'), idempotencyKey: idem(), secret: 'x'.repeat(40) })
    expect(res.status).toBe(401)
  })

  it('rejects a stale timestamp', async () => {
    const res = await signedCall(env, 'POST', '/v1/public/requests', {
      body: requestBody('cust_stale_0001'),
      idempotencyKey: idem(),
      timestamp: Math.floor(Date.now() / 1000) - 3600
    })
    expect(res.status).toBe(401)
    expect(((await res.json()) as any).error.code).toBe('stale_request')
  })

  it('rejects a replayed nonce', async () => {
    const nonce = 'replaynonce' + crypto.randomUUID().replace(/-/g, '')
    const key = idem()
    const first = await signedCall(env, 'POST', '/v1/public/requests', { body: requestBody('cust_replay_001'), idempotencyKey: key, nonce })
    expect(first.status).toBe(201)
    const second = await signedCall(env, 'POST', '/v1/public/requests', { body: requestBody('cust_replay_001'), idempotencyKey: key, nonce })
    expect(second.status).toBe(401)
    expect(((await second.json()) as any).error.code).toBe('replayed_request')
  })

  it('rejects a tampered body (signature covers body hash)', async () => {
    const { signRequest } = await import('../src/lib/connector')
    const body = JSON.stringify(requestBody('cust_tamper_001'))
    const key = idem()
    const headers = await signRequest(SECRETS.CONNECTOR_HMAC_SECRET, { method: 'POST', pathWithQuery: '/v1/public/requests', body, idempotencyKey: key, keyId: 'public-embrilo-v1' })
    const tampered = body.replace('SCRIPT_PACK', 'PRODUCT_STORY')
    const res = await call(env, '/v1/public/requests', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: tampered })
    expect(res.status).toBe(401)
  })

  it('returns 503 when connector secrets are missing (fails closed)', async () => {
    const res = await signedCall({ ...env, CONNECTOR_HMAC_SECRET: undefined }, 'POST', '/v1/public/requests', { body: requestBody('cust_noconf_001'), idempotencyKey: idem() })
    expect(res.status).toBe(503)
  })

  it('emits no CORS headers', async () => {
    const res = await call(env, '/v1/public/requests', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } })
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('intake validation & idempotency', () => {
  it('creates a request and returns a reference + customer token', async () => {
    const res = await signedCall(env, 'POST', '/v1/public/requests', { body: requestBody('cust_create_001'), idempotencyKey: idem() })
    expect(res.status).toBe(201)
    const j = (await res.json()) as any
    expect(j.public_ref).toMatch(/^EMB-[0-9A-Z]{5}-[0-9A-Z]{5}$/)
    expect(j.customer_token).toMatch(/^ct1\./)
    expect(j.status).toBe('received')
    const audit = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE action = 'request.created'`).first<{ n: number }>()
    expect(audit!.n).toBe(1)
  })

  it('same Idempotency-Key + same body → same result, no duplicate job', async () => {
    const key = idem()
    const body = requestBody('cust_idem_00001')
    const a = await signedCall(env, 'POST', '/v1/public/requests', { body, idempotencyKey: key })
    const b = await signedCall(env, 'POST', '/v1/public/requests', { body, idempotencyKey: key })
    expect(a.status).toBe(201)
    expect(b.status).toBe(200)
    const ja = (await a.json()) as any
    const jb = (await b.json()) as any
    expect(jb.public_ref).toBe(ja.public_ref)
    expect(jb.customer_token).toBe(ja.customer_token)
    expect(jb.idempotent_replay).toBe(true)
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM jobs').first<{ n: number }>()
    expect(n!.n).toBe(1)
  })

  it('concurrent identical retries create exactly one job', async () => {
    const key = idem()
    const body = requestBody('cust_concurrent1')
    const results = await Promise.all([1, 2, 3].map(() => signedCall(env, 'POST', '/v1/public/requests', { body, idempotencyKey: key })))
    const refs = new Set(await Promise.all(results.map(async (r) => ((await r.json()) as any).public_ref)))
    expect(refs.size).toBe(1)
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM jobs').first<{ n: number }>()
    expect(n!.n).toBe(1)
  })

  it('same Idempotency-Key with a different body → 409', async () => {
    const key = idem()
    await signedCall(env, 'POST', '/v1/public/requests', { body: requestBody('cust_idem_00002'), idempotencyKey: key })
    const res = await signedCall(env, 'POST', '/v1/public/requests', { body: requestBody('cust_idem_00002', { service_code: 'PRODUCT_STORY' }), idempotencyKey: key })
    expect(res.status).toBe(409)
  })

  it('requires an Idempotency-Key', async () => {
    const res = await signedCall(env, 'POST', '/v1/public/requests', { body: requestBody('cust_noidem_001') })
    expect(res.status).toBe(400)
  })

  it.each([
    ['missing consent', (b: any) => ({ ...b, consent: { ...b.consent, accepted: false } })],
    ['rights not confirmed', (b: any) => ({ ...b, brief: { ...b.brief, rights_confirmed: false } })],
    ['unknown service', (b: any) => ({ ...b, service_code: 'FULL_VIDEO' })],
    ['unknown field', (b: any) => ({ ...b, is_admin: true })],
    ['empty platforms', (b: any) => ({ ...b, brief: { ...b.brief, platforms: [] } })],
    ['http (non-https) reference', (b: any) => ({ ...b, brief: { ...b.brief, references: ['http://example.com/x'] } })],
    ['credentials in reference URL', (b: any) => ({ ...b, brief: { ...b.brief, references: ['https://u:p@example.com/x'] } })],
    ['objective too long', (b: any) => ({ ...b, brief: { ...b.brief, objective: 'x'.repeat(2001) } })],
    ['bad external_ref', (b: any) => ({ ...b, customer: { ...b.customer, external_ref: "x' OR 1=1 --" } })]
  ])('rejects invalid input: %s', async (_name, mutate) => {
    const res = await signedCall(env, 'POST', '/v1/public/requests', { body: mutate(requestBody('cust_invalid_01')), idempotencyKey: idem() })
    expect(res.status).toBe(422)
    const j = (await res.json()) as any
    expect(j.error.code).toBe('validation_failed')
    expect(Array.isArray(j.error.details)).toBe(true)
  })

  it('rate-limits intake per customer', async () => {
    let last = 0
    for (let i = 0; i < 11; i++) {
      const r = await signedCall(env, 'POST', '/v1/public/requests', { body: requestBody('cust_ratelimit1'), idempotencyKey: idem() })
      last = r.status
    }
    expect(last).toBe(429)
  })
})

describe('customer scoping', () => {
  it('status requires matching customer ref AND token; reference alone is not enough', async () => {
    const a = await submit(env, 'cust_scope_aaaa1')
    const b = await submit(env, 'cust_scope_bbbb1')
    const path = `/v1/public/requests/${a.public_ref}`

    const own = await signedCall(env, 'GET', path, { customerRef: 'cust_scope_aaaa1', customerToken: a.customer_token })
    expect(own.status).toBe(200)
    expect(((await own.json()) as any).status).toBe('received')

    // Reference only, no token.
    expect((await signedCall(env, 'GET', path, { customerRef: 'cust_scope_aaaa1' })).status).toBe(404)
    // Customer B using their own token on A's reference.
    expect((await signedCall(env, 'GET', path, { customerRef: 'cust_scope_bbbb1', customerToken: b.customer_token })).status).toBe(404)
    // Customer B presenting A's token (stolen token, wrong customer).
    expect((await signedCall(env, 'GET', path, { customerRef: 'cust_scope_bbbb1', customerToken: a.customer_token })).status).toBe(404)
    // Missing customer header.
    expect((await signedCall(env, 'GET', path, { customerToken: a.customer_token })).status).toBe(401)
  })

  it('deliverables: unapproved drafts are never returned; other customers cannot see delivered files', async () => {
    await addOperator(env, 'op@example.test', 'OPERATOR')
    const s = (await login(env, 'op@example.test')) as Session & { ok: true }
    const a = await submit(env, 'cust_deliv_aaaa1')
    const b = await submit(env, 'cust_deliv_bbbb1')
    const pathA = `/v1/public/requests/${a.public_ref}/deliverables`

    await driveTo(env, s, a.jobId, 'APPROVED')
    let res = await signedCall(env, 'GET', pathA, { customerRef: 'cust_deliv_aaaa1', customerToken: a.customer_token })
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).deliverables).toEqual([]) // approved but not yet released

    const dl = await signedCall(env, 'GET', `/v1/public/requests/${a.public_ref}`, { customerRef: 'cust_deliv_aaaa1', customerToken: a.customer_token })
    expect(((await dl.json()) as any).status).toBe('in_progress')

    const r = await call(env, `/v1/internal/jobs/${a.jobId}/deliver`, {
      method: 'POST',
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/json', accept: 'application/json' },
      body: '{}'
    })
    expect(r.status).toBe(200)

    res = await signedCall(env, 'GET', pathA, { customerRef: 'cust_deliv_aaaa1', customerToken: a.customer_token })
    const items = ((await res.json()) as any).deliverables
    expect(items).toHaveLength(1)
    const file = await call(env, new URL(items[0].download_url).pathname + new URL(items[0].download_url).search)
    expect(file.status).toBe(200)
    expect(await file.text()).toContain('DRAFT: synthetic script pack v1')
    expect(file.headers.get('content-disposition')).toContain('attachment')

    // Customer B cannot list A's deliverables.
    const other = await signedCall(env, 'GET', pathA, { customerRef: 'cust_deliv_bbbb1', customerToken: b.customer_token })
    expect(other.status).toBe(404)

    // Tampered / expired download links are rejected.
    const u = new URL(items[0].download_url)
    const badSig = await call(env, `${u.pathname}?exp=${u.searchParams.get('exp')}&sig=AAAA${u.searchParams.get('sig')!.slice(4)}`)
    expect(badSig.status).toBe(404)
    const expired = await call(env, `${u.pathname}?exp=${Math.floor(Date.now() / 1000) - 10}&sig=${u.searchParams.get('sig')}`)
    expect(expired.status).toBe(404)
  })

  it('internal draft assets cannot be fetched through the public download route', async () => {
    await addOperator(env, 'op2@example.test', 'OPERATOR')
    const s = (await login(env, 'op2@example.test')) as Session & { ok: true }
    const a = await submit(env, 'cust_draftleak1')
    await driveTo(env, s, a.jobId, 'QC_REVIEW')
    const asset = await env.DB.prepare(`SELECT a.id, o.customer_id FROM assets a JOIN orders o ON o.id = a.order_id WHERE a.job_id = ?`).bind(a.jobId).first<{ id: string; customer_id: string }>()
    const { signDownload } = await import('../src/lib/connector')
    const exp = Math.floor(Date.now() / 1000) + 60
    // Even a correctly signed link is refused while the asset is INTERNAL and undelivered.
    const sig = await signDownload(SECRETS.DOWNLOAD_SIGNING_SECRET, asset!.id, asset!.customer_id, exp)
    const res = await call(env, `/v1/public/downloads/${asset!.id}?exp=${exp}&sig=${sig}`)
    expect(res.status).toBe(404)
  })
})

describe('customer revision requests', () => {
  it('only after delivery, idempotent, capped by MAX_REVISION_ROUNDS', async () => {
    await addOperator(env, 'op3@example.test', 'OPERATOR')
    const s = (await login(env, 'op3@example.test')) as Session & { ok: true }
    const a = await submit(env, 'cust_revision01')
    const path = `/v1/public/requests/${a.public_ref}/revisions`
    const auth = { customerRef: 'cust_revision01', customerToken: a.customer_token }

    // Not eligible before delivery.
    let res = await signedCall(env, 'POST', path, { ...auth, body: { summary: 'Please make the hook shorter.' }, idempotencyKey: idem() })
    expect(res.status).toBe(409)

    await driveTo(env, s, a.jobId, 'DELIVERED')
    const key = idem()
    res = await signedCall(env, 'POST', path, { ...auth, body: { summary: 'Please make the hook shorter.' }, idempotencyKey: key })
    expect(res.status).toBe(201)
    const retry = await signedCall(env, 'POST', path, { ...auth, body: { summary: 'Please make the hook shorter.' }, idempotencyKey: key })
    expect(retry.status).toBe(200)
    expect(await jobState(env, a.jobId)).toBe('NEEDS_REVISION')
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM revisions WHERE job_id = ? AND source = 'CUSTOMER'`).bind(a.jobId).first<{ n: number }>()
    expect(n!.n).toBe(1)

    // Round 2: redo production → deliver → request again (allowed), then round 3 is refused.
    const again = async () => {
      const run = (await (
        await call(env, `/v1/internal/jobs/${a.jobId}/start-production`, {
          method: 'POST',
          headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/json' },
          body: JSON.stringify({ provider: 'genspark-manual' })
        })
      ).json()) as any
      for (const [p, b] of [
        ['production-result', { run_id: run.run_id, output_text: 'DRAFT v-next' }],
        ['review', { decision: 'APPROVE', checklist: { factual_accuracy: true, brand_fit: true, language_quality: true, platform_format: true, rights_clear: true, no_prohibited_claims: true } }],
        ['deliver', {}]
      ] as const) {
        const r = await call(env, `/v1/internal/jobs/${a.jobId}/${p}`, {
          method: 'POST',
          headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/json' },
          body: JSON.stringify(b)
        })
        expect(r.status).toBe(200)
      }
    }
    await again()
    res = await signedCall(env, 'POST', path, { ...auth, body: { summary: 'Second round: change the CTA wording.' }, idempotencyKey: idem() })
    expect(res.status).toBe(201)
    await again()
    res = await signedCall(env, 'POST', path, { ...auth, body: { summary: 'Third round should be refused.' }, idempotencyKey: idem() })
    expect(res.status).toBe(409)
    expect(((await res.json()) as any).error.code).toBe('revision_limit_reached')
  })
})
