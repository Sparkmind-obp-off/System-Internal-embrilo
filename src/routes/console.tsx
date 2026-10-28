import { Hono, type Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { createSession, destroySession, requireOperator, requireRole, verifyCsrf, isCrossSite } from '../lib/auth'
import { MAX_FAILED_LOGINS, LOCKOUT_MS } from '../lib/auth'
import { DUMMY_PASSWORD_HASH, randomToken, timingSafeEqual, verifyPassword } from '../lib/crypto'
import { AppError, notFound } from '../lib/errors'
import { nowIso } from '../lib/db'
import { readInput, clientIp } from '../lib/http'
import { rateLimit } from '../lib/ratelimit'
import { audit } from '../lib/audit'
import { isState, STATES } from '../lib/state'
import * as jobs from '../services/jobs'
import { assetResponse } from '../services/files'
import { buildPrompt } from '../lib/prompt'
import { LoginPage, QueuePage, MetricsPage, AuditPage, ProvidersPage, type QueueRow, type AuditRow, type QueueFilter, type Metric } from '../views/pages'
import { JobPage, type JobDetail, type FormState } from '../views/job'
import { QUEUE_VIEWS, AUDIT_TYPES, ERROR_MESSAGES, translateIssue, fieldKey, type QueueView } from '../views/labels'
import { STATE_LABEL_ID } from '../views/layout'
import type { AppEnv, OperatorCtx } from '../types'

export const consoleApp = new Hono<AppEnv>()

// ---------------------------------------------------------------------------
// Login / logout
// ---------------------------------------------------------------------------
const LOGIN_CSRF = 'embrilo_lcsrf'

consoleApp.get('/login', (c) => {
  if (c.get('operator')) return c.redirect('/console', 303)
  const token = randomToken(18)
  setCookie(c, LOGIN_CSRF, token, { httpOnly: true, sameSite: 'Strict', path: '/login', secure: new URL(c.req.url).protocol === 'https:', maxAge: 1800 })
  const e = c.req.query('err')
  const msg =
    e === 'expired'
      ? 'Formulir masuk kedaluwarsa atau browser memblokir cookie keamanannya. Coba lagi, dan pastikan cookie diizinkan untuk situs ini.'
      : e
        ? 'Email atau kata sandi salah, atau akun sedang dikunci sementara (5 kali salah = 15 menit).'
        : undefined
  return c.html(<LoginPage csrf={token} err={msg} />)
})

consoleApp.post('/login', async (c) => {
  const ip = clientIp(c)
  await rateLimit(c.env.DB, `login-ip:${ip}`, 20, 900)
  const input = await readInput(c)
  // Login CSRF: double-submit token + same-origin check.
  const cookieTok = getCookie(c, LOGIN_CSRF) ?? ''
  const formTok = typeof input._lcsrf === 'string' ? input._lcsrf : ''
  if (isCrossSite(c) || !cookieTok || !timingSafeEqual(cookieTok, formTok)) {
    // Friendly recovery instead of a dead-end error page: reissue a fresh form.
    return c.redirect('/login?err=expired', 303)
  }

  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase().slice(0, 254) : ''
  const password = typeof input.password === 'string' ? input.password.slice(0, 256) : ''
  const cid = c.get('cid')
  const op = email
    ? await c.env.DB.prepare('SELECT id, password_hash, active, failed_logins, locked_until FROM operators WHERE email = ?')
        .bind(email)
        .first<{ id: string; password_hash: string; active: number; failed_logins: number; locked_until: string | null }>()
    : null
  const locked = !!op?.locked_until && Date.parse(op.locked_until) > Date.now()
  // Always run the KDF so response time does not reveal whether the account exists.
  const ok = (await verifyPassword(password, op?.password_hash ?? DUMMY_PASSWORD_HASH)) && !!op && op.active === 1 && !locked

  if (!ok) {
    if (op) {
      const failed = op.failed_logins + 1
      const lockUntil = failed >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCKOUT_MS).toISOString() : null
      await c.env.DB.prepare('UPDATE operators SET failed_logins = ?, locked_until = COALESCE(?, locked_until), updated_at = ? WHERE id = ?')
        .bind(lockUntil ? 0 : failed, lockUntil, nowIso(), op.id)
        .run()
      await audit(c.env.DB, { type: 'OPERATOR', id: op.id }, lockUntil ? 'auth.locked' : 'auth.login_failed', 'operator', op.id, cid, {})
    }
    return c.redirect('/login?err=1', 303)
  }
  await c.env.DB.prepare('UPDATE operators SET failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?').bind(nowIso(), op!.id).run()
  await createSession(c, op!.id)
  await audit(c.env.DB, { type: 'OPERATOR', id: op!.id }, 'auth.login', 'operator', op!.id, cid, {})
  return c.redirect('/console', 303)
})

consoleApp.post('/logout', async (c) => {
  const op = c.get('operator')
  if (op) {
    const input = await readInput(c)
    verifyCsrf(c, typeof input._csrf === 'string' ? input._csrf : undefined)
    await audit(c.env.DB, { type: 'OPERATOR', id: op.id }, 'auth.logout', 'operator', op.id, c.get('cid'), {})
  }
  await destroySession(c)
  return c.redirect('/login', 303)
})

// ---------------------------------------------------------------------------
// Authenticated console
// ---------------------------------------------------------------------------
consoleApp.use('/console', requireOperator('html'))
consoleApp.use('/console/*', requireOperator('html'))

const base = (c: Context<AppEnv>) => ({
  op: c.get('operator') as OperatorCtx,
  csrf: c.get('csrf') as string,
  ok: c.req.query('ok')?.slice(0, 200),
  err: c.req.query('err')?.slice(0, 300)
})

consoleApp.get('/console', async (c) => {
  const b = base(c)
  const viewParam = c.req.query('view')
  const view = QUEUE_VIEWS.find((v) => v.id === viewParam)?.id as QueueView | undefined
  const stateParam = c.req.query('state')
  const state = !view && stateParam && isState(stateParam) ? stateParam : undefined
  const mine = c.req.query('mine') === '1'
  const q = (c.req.query('q') ?? '').trim().slice(0, 64)
  const prioParam = c.req.query('prio') ?? ''
  const prio = ['LOW', 'NORMAL', 'HIGH', 'URGENT'].includes(prioParam) ? prioParam : ''

  const where: string[] = []
  const params: unknown[] = []
  if (view) {
    const states = QUEUE_VIEWS.find((v) => v.id === view)!.states
    where.push(`j.state IN (${states.map(() => '?').join(',')})`)
    params.push(...states)
  } else if (state) {
    where.push('j.state = ?')
    params.push(state)
  } else {
    where.push(`j.state NOT IN ('DELIVERED','CANCELLED')`)
  }
  if (mine) {
    where.push('j.assigned_operator_id = ?')
    params.push(b.op.id)
  }
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`
    where.push(`(o.public_ref LIKE ? ESCAPE '\\' OR cu.display_name LIKE ? ESCAPE '\\')`)
    params.push(like, like)
  }
  if (prio) {
    where.push('j.priority = ?')
    params.push(prio)
  }
  const [rows, countRows, mineRow] = await Promise.all([
    c.env.DB.prepare(
      `SELECT j.id, o.public_ref, o.service_code, j.state, j.priority, cu.display_name AS customer_name, op.display_name AS assignee_name,
              j.assigned_operator_id, j.updated_at, j.created_at
       FROM jobs j JOIN orders o ON o.id = j.order_id JOIN customers cu ON cu.id = o.customer_id LEFT JOIN operators op ON op.id = j.assigned_operator_id
       WHERE ${where.join(' AND ')}
       ORDER BY CASE j.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END, j.created_at ASC LIMIT 200`
    )
      .bind(...params)
      .all<QueueRow>(),
    c.env.DB.prepare('SELECT state, COUNT(*) AS n FROM jobs GROUP BY state').all<{ state: string; n: number }>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE assigned_operator_id = ? AND state NOT IN ('DELIVERED','CANCELLED')`).bind(b.op.id).first<{ n: number }>()
  ])
  const byState: Record<string, number> = {}
  let open = 0
  for (const r of countRows.results) {
    byState[r.state] = r.n
    if (r.state !== 'DELIVERED' && r.state !== 'CANCELLED') open += r.n
  }
  const viewCounts: Record<string, number> = {}
  for (const v of QUEUE_VIEWS) viewCounts[v.id] = v.states.reduce((a, st) => a + (byState[st] ?? 0), 0)
  const filter: QueueFilter = { view, state, mine, q: q || undefined, prio: prio || undefined }
  return c.html(
    <QueuePage {...b} rows={rows.results} viewCounts={viewCounts} openCount={open} mineCount={mineRow?.n ?? 0} filter={filter} now={Date.now()} />
  )
})

async function loadJobDetail(c: Context<AppEnv>, jobId: string): Promise<JobDetail> {
  const db = c.env.DB
  const row = await db
    .prepare(
      `SELECT j.*, o.public_ref, o.service_code, cu.display_name AS customer_name, cu.external_ref AS customer_ref, b.objective, b.audience, b.product_facts, b.platforms,
              b.language, b.tone, b.cta, b.constraints, b.references_json, b.rights_confirmed
       FROM jobs j JOIN orders o ON o.id = j.order_id JOIN customers cu ON cu.id = o.customer_id JOIN briefs b ON b.order_id = o.id WHERE j.id = ?`
    )
    .bind(jobId)
    .first<Record<string, any>>()
  if (!row) throw notFound()
  const [history, runs, assets, reviews, revisions, operators] = await Promise.all([
    db.prepare(`SELECT h.*, op.display_name AS actor_name FROM job_state_history h LEFT JOIN operators op ON op.id = h.actor_id WHERE h.job_id = ? ORDER BY h.created_at DESC, h.rowid DESC`).bind(jobId).all<any>(),
    db.prepare(`SELECT r.*, op.display_name AS operator_name FROM production_runs r LEFT JOIN operators op ON op.id = r.operator_id WHERE r.job_id = ? ORDER BY r.started_at DESC, r.rowid DESC`).bind(jobId).all<any>(),
    db.prepare(`SELECT id, kind, filename, size_bytes, visibility, storage, created_at FROM assets WHERE job_id = ? ORDER BY created_at DESC`).bind(jobId).all<any>(),
    db.prepare(`SELECT rv.*, op.display_name AS reviewer_name FROM reviews rv LEFT JOIN operators op ON op.id = rv.reviewer_id WHERE rv.job_id = ? ORDER BY rv.created_at DESC`).bind(jobId).all<any>(),
    db.prepare(`SELECT * FROM revisions WHERE job_id = ? ORDER BY round DESC, created_at DESC`).bind(jobId).all<any>(),
    db.prepare(`SELECT id, display_name FROM operators WHERE active = 1 AND role IN ('ADMIN','OPERATOR') ORDER BY display_name`).all<any>()
  ])
  // Draft preview: latest successful run's inline text (internal only).
  const latest = await jobs.latestSucceededRun(db, jobId)
  let draftPreview: string | null = null
  if (latest?.output_asset_id) {
    const a = await db.prepare('SELECT storage, inline_text, filename FROM assets WHERE id = ?').bind(latest.output_asset_id).first<{ storage: string; inline_text: string | null; filename: string }>()
    draftPreview = a?.storage === 'INLINE' ? (a.inline_text ?? '').slice(0, 20000) : a ? `[file attachment: ${a.filename} — download from Private assets]` : null
  }
  // Re-render the sanitized prompt for a running run (deterministic from brief + template).
  let prompt: string | null = null
  if (row.state === 'IN_PRODUCTION') {
    prompt = buildPrompt(await jobs.loadPromptBrief(db, jobId))
  }
  return {
    job: row as JobDetail['job'],
    order: { public_ref: row.public_ref, service_code: row.service_code, customer_name: row.customer_name, customer_ref: row.customer_ref },
    brief: {
      objective: row.objective,
      audience: row.audience,
      product_facts: row.product_facts,
      platforms: JSON.parse(row.platforms),
      language: row.language,
      tone: row.tone,
      cta: row.cta,
      constraints: row.constraints,
      references: JSON.parse(row.references_json),
      rights_confirmed: row.rights_confirmed === 1
    },
    history: history.results,
    runs: runs.results,
    assets: assets.results,
    reviews: reviews.results,
    revisions: revisions.results,
    operators: operators.results,
    draftPreview,
    prompt,
    maxRevisions: jobs.maxRevisions(c.env),
    r2Configured: !!c.env.R2
  }
}

consoleApp.get('/console/jobs/:id', async (c) => {
  const b = base(c)
  return c.html(<JobPage {...b} d={await loadJobDetail(c, c.req.param('id'))} now={Date.now()} />)
})

/** Human-readable (Indonesian) message for a safe AppError. */
function errorText(e: AppError): string {
  return ERROR_MESSAGES[e.code] ?? e.message
}

/**
 * Form POST → service → redirect back (Post/Redirect/Get).
 * Validation failures on a known form re-render the page (422) with field errors and the
 * submitted values preserved, so operators never lose what they typed.
 */
type Action = (c: Context<AppEnv>, op: OperatorCtx, id: string, input: Record<string, unknown>, cid: string) => Promise<unknown>
function formAction(okMsg: string, fn: Action, roles: OperatorCtx['role'][] = ['ADMIN', 'OPERATOR'], formId?: (input: Record<string, unknown>) => string | undefined) {
  return async (c: Context<AppEnv>) => {
    const id = c.req.param('id') ?? ''
    const back = `/console/jobs/${encodeURIComponent(id)}`
    const input = await readInput(c)
    verifyCsrf(c, typeof input._csrf === 'string' ? input._csrf : undefined)
    delete input._csrf
    const op = requireRole(c.get('operator'), ...roles)
    try {
      await fn(c, op, id, input, c.get('cid'))
      return c.redirect(`${back}?ok=${encodeURIComponent(okMsg)}`, 303)
    } catch (e) {
      if (e instanceof AppError && e.status !== 401 && e.status !== 403 && e.status !== 404) {
        const fid = formId?.(input)
        if (e.code === 'validation_failed' && fid && e.details?.length) {
          const errors: Record<string, string> = {}
          for (const d of e.details) {
            const k = fieldKey(d.field)
            if (!errors[k]) errors[k] = translateIssue(d.issue)
          }
          const values: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(input)) if (!(v instanceof File)) values[k] = v
          const form: FormState = { id: fid, errors, values }
          return c.html(
            <JobPage op={op} csrf={c.get('csrf') as string} err={errorText(e)} d={await loadJobDetail(c, id)} form={form} now={Date.now()} />,
            422
          )
        }
        return c.redirect(`${back}?err=${encodeURIComponent(errorText(e))}`, 303)
      }
      throw e
    }
  }
}

consoleApp.post('/console/jobs/:id/triage', formAction('Triase diperbarui', (c, op, id, i, cid) => jobs.triage(c.env.DB, op, id, i, cid), undefined, (i) => (i.action === 'needs_info' ? 'needs_info' : undefined)))
consoleApp.post('/console/jobs/:id/assign', formAction('Penugasan disimpan', (c, op, id, i, cid) => jobs.assign(c.env.DB, op, id, i, cid)))
consoleApp.post('/console/jobs/:id/brief', formAction('Brief disimpan', (c, op, id, i, cid) => jobs.updateBrief(c.env.DB, op, id, i, cid), undefined, () => 'brief'))
consoleApp.post('/console/jobs/:id/start-production', formAction('Produksi dimulai — salin prompt di bawah', (c, op, id, i, cid) => jobs.startProduction(c.env.DB, op, id, i, cid)))
consoleApp.post('/console/jobs/:id/production-result', formAction('Draf dilampirkan — pekerjaan masuk tinjauan QC', (c, op, id, i, cid) => jobs.recordProductionResult(c.env, op, id, i, cid), undefined, () => 'result'))
consoleApp.post('/console/jobs/:id/production-failure', formAction('Kegagalan provider dicatat — pekerjaan tetap bisa dipulihkan', (c, op, id, i, cid) => jobs.recordProductionFailure(c.env.DB, op, id, i, cid), undefined, () => 'failure'))
consoleApp.post('/console/jobs/:id/requeue', formAction('Pekerjaan dikembalikan ke antrean', (c, op, id, i, cid) => jobs.requeue(c.env.DB, op, id, i, cid)))
consoleApp.post('/console/jobs/:id/review', formAction('Tinjauan QC dicatat', (c, op, id, i, cid) => jobs.review(c.env, op, id, i, cid), undefined, () => 'review'))
consoleApp.post('/console/jobs/:id/deliver', formAction('Terkirim ke pelanggan', (c, op, id, _i, cid) => jobs.deliver(c.env.DB, op, id, cid)))
consoleApp.post('/console/jobs/:id/reference', formAction('Referensi diunggah', (c, op, id, i, cid) => jobs.addReference(c.env, op, id, i, cid)))
consoleApp.post('/console/jobs/:id/cancel', formAction('Pekerjaan dibatalkan', (c, op, id, i, cid) => jobs.cancel(c.env.DB, op, id, i, cid), ['ADMIN'], () => 'cancel'))

// Private asset download for operators (every role may read; audited).
consoleApp.get('/console/assets/:id', async (c) => {
  const op = requireRole(c.get('operator'), 'ADMIN', 'OPERATOR', 'VIEWER')
  const a = await c.env.DB.prepare('SELECT * FROM assets WHERE id = ?').bind(c.req.param('id')).first<any>()
  if (!a) throw notFound()
  await audit(c.env.DB, { type: 'OPERATOR', id: op.id }, 'asset.downloaded', 'job', a.job_id, c.get('cid'), { asset_id: a.id })
  return assetResponse(c.env, a)
})

consoleApp.get('/console/metrics', async (c) => {
  const b = base(c)
  const db = c.env.DB
  const q = async <T,>(sql: string) => (await db.prepare(sql).first<T>())!
  const [delivered, ttd, acceptance, revisions, failures, minutes, byState] = await Promise.all([
    q<{ n: number }>(`SELECT COUNT(*) AS n FROM jobs WHERE state = 'DELIVERED'`),
    q<{ h: number | null }>(`SELECT ROUND(AVG((julianday(delivered_at) - julianday(created_at)) * 24), 1) AS h FROM jobs WHERE delivered_at IS NOT NULL`),
    q<{ first_pass: number; reviewed: number }>(
      `SELECT SUM(CASE WHEN first_decision = 'APPROVE' THEN 1 ELSE 0 END) AS first_pass, COUNT(*) AS reviewed FROM (
         SELECT (SELECT decision FROM reviews r WHERE r.job_id = j.id ORDER BY created_at ASC, rowid ASC LIMIT 1) AS first_decision
         FROM jobs j WHERE EXISTS (SELECT 1 FROM reviews r WHERE r.job_id = j.id))`
    ),
    q<{ avg: number | null }>(`SELECT ROUND(AVG(revision_round), 2) AS avg FROM jobs WHERE state = 'DELIVERED'`),
    q<{ failed: number; total: number }>(`SELECT SUM(CASE WHEN status IN ('FAILED','BLOCKED') THEN 1 ELSE 0 END) AS failed, COUNT(*) AS total FROM production_runs`),
    q<{ avg: number | null }>(`SELECT ROUND(AVG(m), 1) AS avg FROM (SELECT SUM(COALESCE(operator_minutes,0)) AS m FROM production_runs r JOIN jobs j ON j.id = r.job_id WHERE j.state = 'DELIVERED' GROUP BY r.job_id)`),
    db.prepare('SELECT state, COUNT(*) AS n FROM jobs GROUP BY state ORDER BY n DESC').all<{ state: string; n: number }>()
  ])
  const pct = (a: number, t: number) => (t ? `${Math.round((a / t) * 100)}%` : null)
  const num = (v: number | null | undefined, unit = '') => (v === null || v === undefined ? null : `${String(v).replace('.', ',')}${unit}`)
  const total = byState.results.reduce((a, r) => a + r.n, 0)
  const metrics: Metric[] = [
    { label: 'Pekerjaan terkirim', value: String(delivered.n), sample: `dari ${total} pekerjaan tercatat`, definition: 'Jumlah pekerjaan dengan status Terkirim saat ini.' },
    { label: 'Rata-rata waktu kirim', value: num(ttd.h, ' jam'), sample: `${delivered.n} pekerjaan terkirim`, definition: 'Rata-rata selisih waktu antara permintaan masuk dan pengiriman terakhir, untuk pekerjaan yang sudah terkirim.' },
    { label: 'Lolos QC pada draf pertama', value: pct(acceptance.first_pass ?? 0, acceptance.reviewed ?? 0), sample: `${acceptance.reviewed ?? 0} pekerjaan pernah ditinjau`, definition: 'Persentase pekerjaan yang tinjauan QC pertamanya langsung “Disetujui”.' },
    { label: 'Rata-rata putaran revisi pelanggan', value: num(revisions.avg), sample: `${delivered.n} pekerjaan terkirim`, definition: 'Rata-rata jumlah revisi yang diminta pelanggan pada pekerjaan berstatus Terkirim.' },
    { label: 'Tingkat kegagalan provider', value: pct(failures.failed ?? 0, failures.total ?? 0), sample: `${failures.total ?? 0} proses produksi`, definition: 'Persentase proses produksi yang berakhir Gagal atau Terhambat.' },
    { label: 'Menit operator per pekerjaan terkirim', value: num(minutes.avg, ' mnt'), sample: 'berdasarkan menit yang diisi operator', definition: 'Rata-rata total menit kerja yang dicatat operator di semua proses produksi untuk pekerjaan yang sudah terkirim. Hanya akurat jika operator mengisi menit kerja.' }
  ]
  return c.html(
    <MetricsPage
      {...b}
      metrics={metrics}
      total={total}
      byState={byState.results.filter((r) => isState(r.state)).map((r) => ({ state: r.state as any, n: r.n, label: STATE_LABEL_ID[r.state as keyof typeof STATE_LABEL_ID] }))}
    />
  )
})

consoleApp.get('/console/audit', async (c) => {
  const b = base(c)
  requireRole(b.op, 'ADMIN')
  const typeParam = c.req.query('type') ?? ''
  const type = AUDIT_TYPES.find((t) => t.id === typeParam)
  const q = (c.req.query('q') ?? '').trim().slice(0, 64)
  const beforeParam = c.req.query('before') ?? ''
  const before = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(beforeParam) ? beforeParam : ''
  const where: string[] = []
  const params: unknown[] = []
  if (type) {
    where.push('a.action LIKE ?')
    params.push(`${type.prefix}%`)
  }
  if (q && /^[A-Za-z0-9_-]+$/.test(q)) {
    where.push('(a.correlation_id LIKE ? OR a.resource_id LIKE ? OR a.actor_id LIKE ?)')
    params.push(`${q}%`, `${q}%`, `${q}%`)
  }
  if (before) {
    where.push('a.created_at < ?')
    params.push(before)
  }
  const PAGE = 100
  const rows = await c.env.DB.prepare(
    `SELECT a.*, op.display_name AS actor_name FROM audit_events a LEFT JOIN operators op ON op.id = a.actor_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.created_at DESC, a.rowid DESC LIMIT ${PAGE + 1}`
  )
    .bind(...params)
    .all<AuditRow>()
  const list = rows.results.slice(0, PAGE)
  const nextBefore = rows.results.length > PAGE ? list[list.length - 1].created_at : undefined
  return c.html(<AuditPage {...b} rows={list} filter={{ type: type?.id, q: q || undefined }} nextBefore={nextBefore} now={Date.now()} />)
})

consoleApp.get('/console/providers', (c) => c.html(<ProvidersPage {...base(c)} />))

export { STATES }
