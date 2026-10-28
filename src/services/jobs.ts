import { AppError, forbidden, notFound } from '../lib/errors'
import { getJob, guardedInsert, guardedUpdate, nowIso, transition, type JobRow } from '../lib/db'
import { auditStmt } from '../lib/audit'
import { customerToken } from '../lib/connector'
import { publicRef, sha256Hex, uuid } from '../lib/crypto'
import { getProvider, PROVIDER_ERROR_CODES } from '../lib/providers'
import type { PromptBrief } from '../lib/prompt'
import { stableStringify, PRIORITIES, V, validateBrief, type BriefInput, type PublicRequestInput } from '../lib/validate'
import type { JobState } from '../lib/state'
import type { Actor, Bindings, OperatorCtx } from '../types'
import { storeFile, type StoredFile } from './files'

const opActor = (op: OperatorCtx): Actor => ({ type: 'OPERATOR', id: op.id })
export const maxRevisions = (env: Bindings) => {
  const n = Number(env.MAX_REVISION_ROUNDS ?? '2')
  return Number.isInteger(n) && n >= 0 && n <= 10 ? n : 2
}

// ---------------------------------------------------------------------------
// Intake (public connector)
// ---------------------------------------------------------------------------
export type CreatedRequest = {
  replay: boolean
  order_id: string
  job_id: string
  public_ref: string
  customer_token: string
}

export async function createPublicRequest(
  env: Bindings,
  input: PublicRequestInput,
  idemKey: string,
  cid: string,
  actor: Actor
): Promise<CreatedRequest> {
  const db = env.DB
  if (!env.CUSTOMER_TOKEN_SECRET || env.CUSTOMER_TOKEN_SECRET.length < 32)
    throw new AppError(503, 'connector_not_configured', 'Connector is not configured')
  const requestHash = await sha256Hex(stableStringify(input))
  const scope = 'public_request'

  const existing = async () => {
    const row = await db
      .prepare('SELECT request_hash, resource_id FROM idempotency_keys WHERE scope = ? AND idem_key = ?')
      .bind(scope, idemKey)
      .first<{ request_hash: string; resource_id: string }>()
    if (!row) return null
    if (row.request_hash !== requestHash)
      throw new AppError(409, 'idempotency_conflict', 'Idempotency-Key was already used with a different request body')
    const o = await db
      .prepare('SELECT o.id, o.public_ref, o.token_version, j.id AS job_id FROM orders o JOIN jobs j ON j.order_id = o.id WHERE o.id = ?')
      .bind(row.resource_id)
      .first<{ id: string; public_ref: string; token_version: number; job_id: string }>()
    if (!o) throw new AppError(409, 'idempotency_conflict', 'Idempotency record is inconsistent')
    return {
      replay: true,
      order_id: o.id,
      job_id: o.job_id,
      public_ref: o.public_ref,
      customer_token: await customerToken(env.CUSTOMER_TOKEN_SECRET!, o.id, o.token_version)
    }
  }

  const prior = await existing()
  if (prior) return prior

  const ts = nowIso()
  // Customer upsert (idempotent on the opaque external_ref owned by Public Embrilo).
  await db
    .prepare(
      `INSERT INTO customers (id, external_ref, display_name, consent_at, consent_terms_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(external_ref) DO NOTHING`
    )
    .bind(uuid(), input.customer.external_ref, input.customer.display_name, input.consent.accepted_at, input.consent.terms_version, ts)
    .run()
  const customer = await db
    .prepare('SELECT id FROM customers WHERE external_ref = ?')
    .bind(input.customer.external_ref)
    .first<{ id: string }>()
  if (!customer) throw new Error('customer upsert failed')

  const orderId = uuid()
  const jobId = uuid()
  const ref = publicRef()
  const b = input.brief
  try {
    await db.batch([
      // The idempotency row goes first: a concurrent duplicate fails the whole batch.
      db
        .prepare('INSERT INTO idempotency_keys (scope, idem_key, request_hash, resource_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(scope, idemKey, requestHash, orderId, ts),
      db
        .prepare('INSERT INTO orders (id, public_ref, customer_id, service_code, token_version, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
        .bind(orderId, ref, customer.id, input.service_code, ts, ts),
      db
        .prepare(
          `INSERT INTO briefs (id, order_id, objective, audience, product_facts, platforms, language, tone, cta, constraints, references_json, rights_confirmed, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(uuid(), orderId, b.objective, b.audience, b.product_facts, JSON.stringify(b.platforms), b.language, b.tone, b.cta, b.constraints, JSON.stringify(b.references), b.rights_confirmed ? 1 : 0, ts, ts),
      db
        .prepare(`INSERT INTO jobs (id, order_id, state, priority, created_at, updated_at) VALUES (?, ?, 'SUBMITTED', 'NORMAL', ?, ?)`)
        .bind(jobId, orderId, ts, ts),
      db
        .prepare(
          `INSERT INTO job_state_history (id, job_id, from_state, to_state, actor_type, actor_id, reason, correlation_id, created_at)
           VALUES (?, ?, NULL, 'SUBMITTED', ?, ?, 'public intake', ?, ?)`
        )
        .bind(uuid(), jobId, actor.type, actor.id, cid, ts),
      auditStmt(db, actor, 'request.created', 'order', orderId, cid, { service_code: input.service_code, job_id: jobId })
    ])
  } catch (e) {
    // Lost a race with an identical retry: return the winner's result (or a conflict).
    const raced = await existing()
    if (raced) return raced
    throw e
  }
  return {
    replay: false,
    order_id: orderId,
    job_id: jobId,
    public_ref: ref,
    customer_token: await customerToken(env.CUSTOMER_TOKEN_SECRET, orderId, 1)
  }
}

// ---------------------------------------------------------------------------
// Triage / assignment / brief workspace
// ---------------------------------------------------------------------------
export async function triage(
  db: D1Database,
  op: OperatorCtx,
  jobId: string,
  input: Record<string, unknown>,
  cid: string
) {
  const v = new V()
  const action = v.enumOf(input.action, 'action', ['start', 'queue', 'needs_info'] as const)
  const reason = v.str(input.reason, 'reason', 0, 500, { optional: true })
  const priority = v.enumOf(input.priority, 'priority', PRIORITIES, true)
  const customerMessage = v.str(input.customer_message, 'customer_message', 0, 1000, { optional: true })
  if (action === 'needs_info' && !customerMessage) v.fail('customer_message', 'is required: tell the customer what is missing')
  v.throwIfAny()
  const job = await getJob(db, jobId)

  if (action === 'start') {
    return transition(db, { job, to: 'TRIAGE', actor: opActor(op), cid, reason: reason || 'triage started' })
  }
  if (action === 'queue') {
    const brief = await db.prepare('SELECT rights_confirmed FROM briefs b JOIN jobs j ON j.order_id = b.order_id WHERE j.id = ?').bind(jobId).first<{ rights_confirmed: number }>()
    if (!brief?.rights_confirmed) throw new AppError(422, 'rights_not_confirmed', 'Customer has not confirmed rights to supplied material')
    return transition(db, {
      job,
      to: 'QUEUED',
      actor: opActor(op),
      cid,
      reason: reason || 'qualified',
      set: { priority: priority || job.priority, customer_message: '' }
    })
  }
  return transition(db, {
    job,
    to: 'NEEDS_INFO',
    actor: opActor(op),
    cid,
    reason: reason || 'missing information',
    set: { customer_message: customerMessage }
  })
}

export async function assign(db: D1Database, op: OperatorCtx, jobId: string, input: Record<string, unknown>, cid: string) {
  const v = new V()
  const assignee = v.str(input.assignee_id, 'assignee_id', 0, 64, { optional: true })
  const priority = v.enumOf(input.priority, 'priority', PRIORITIES, true)
  v.throwIfAny()
  const job = await getJob(db, jobId)
  if (job.state === 'CANCELLED' || job.state === 'DELIVERED') throw new AppError(409, 'job_closed', 'Job is closed')
  if (assignee) {
    const target = await db.prepare(`SELECT id FROM operators WHERE id = ? AND active = 1 AND role IN ('ADMIN','OPERATOR')`).bind(assignee).first()
    if (!target) throw new AppError(422, 'validation_failed', 'Assignee must be an active operator', [{ field: 'assignee_id', issue: 'unknown operator' }])
  }
  await db.batch([
    db
      .prepare('UPDATE jobs SET assigned_operator_id = ?, priority = ?, updated_at = ? WHERE id = ?')
      .bind(assignee || null, priority || job.priority, nowIso(), jobId),
    auditStmt(db, opActor(op), 'job.assigned', 'job', jobId, cid, { assignee_id: assignee || null, priority: priority || job.priority })
  ])
}

export const BRIEF_EDITABLE: JobState[] = ['SUBMITTED', 'TRIAGE', 'NEEDS_INFO', 'QUEUED', 'NEEDS_REVISION', 'BLOCKED_PROVIDER', 'FAILED']

export async function updateBrief(db: D1Database, op: OperatorCtx, jobId: string, input: Record<string, unknown>, cid: string) {
  const job = await getJob(db, jobId)
  if (!BRIEF_EDITABLE.includes(job.state))
    throw new AppError(409, 'brief_locked', `Brief cannot be edited while job is ${job.state}`)
  // Form posts send platforms as a list and references one-per-line.
  const normalized = {
    objective: input.objective,
    audience: input.audience,
    product_facts: input.product_facts,
    platforms: Array.isArray(input.platforms) ? input.platforms : input.platforms ? [input.platforms] : [],
    language: input.language,
    tone: input.tone ?? '',
    cta: input.cta ?? '',
    constraints: input.constraints ?? '',
    references: Array.isArray(input.references)
      ? input.references
      : String(input.references ?? '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
    rights_confirmed: input.rights_confirmed === true || input.rights_confirmed === 'on' || input.rights_confirmed === 'true'
  }
  const v = new V()
  const b: BriefInput = validateBrief(v, normalized, 'brief', false)
  v.throwIfAny()
  await db.batch([
    db
      .prepare(
        `UPDATE briefs SET objective=?, audience=?, product_facts=?, platforms=?, language=?, tone=?, cta=?, constraints=?, references_json=?, rights_confirmed=?, updated_at=?
         WHERE order_id = ?`
      )
      .bind(b.objective, b.audience, b.product_facts, JSON.stringify(b.platforms), b.language, b.tone, b.cta, b.constraints, JSON.stringify(b.references), b.rights_confirmed ? 1 : 0, nowIso(), job.order_id),
    auditStmt(db, opActor(op), 'brief.updated', 'job', jobId, cid, {})
  ])
}

// ---------------------------------------------------------------------------
// Production runs (provider adapter)
// ---------------------------------------------------------------------------
export async function loadPromptBrief(db: D1Database, jobId: string): Promise<PromptBrief> {
  const row = await db
    .prepare(
      `SELECT o.public_ref, o.service_code, b.* FROM jobs j JOIN orders o ON o.id = j.order_id JOIN briefs b ON b.order_id = o.id WHERE j.id = ?`
    )
    .bind(jobId)
    .first<Record<string, string>>()
  if (!row) throw notFound()
  const revs = await db
    .prepare(`SELECT summary FROM revisions WHERE job_id = ? AND status = 'OPEN' ORDER BY round, created_at`)
    .bind(jobId)
    .all<{ summary: string }>()
  return {
    public_ref: row.public_ref,
    service_code: row.service_code,
    objective: row.objective,
    audience: row.audience,
    product_facts: row.product_facts,
    platforms: JSON.parse(row.platforms),
    language: row.language,
    tone: row.tone,
    cta: row.cta,
    constraints: row.constraints,
    references: JSON.parse(row.references_json),
    revision_notes: revs.results.map((r) => r.summary)
  }
}

export async function startProduction(db: D1Database, op: OperatorCtx, jobId: string, input: Record<string, unknown>, cid: string) {
  const v = new V()
  const providerId = v.str(input.provider, 'provider', 1, 64)
  v.throwIfAny()
  const provider = getProvider(providerId)
  if (!provider) throw new AppError(422, 'validation_failed', 'Unknown provider', [{ field: 'provider', issue: 'unknown provider' }])
  const job = await getJob(db, jobId)
  const running = await db.prepare(`SELECT id FROM production_runs WHERE job_id = ? AND status = 'RUNNING'`).bind(jobId).first()
  if (running) throw new AppError(409, 'run_in_progress', 'A production run is already in progress for this job')
  const prepared = await provider.prepare(await loadPromptBrief(db, jobId))
  const runId = uuid()
  await transition(db, {
    job,
    to: 'IN_PRODUCTION',
    actor: opActor(op),
    cid,
    reason: `run ${provider.id}`,
    set: { attempts: job.attempts + 1, assigned_operator_id: job.assigned_operator_id ?? op.id },
    auditMeta: { run_id: runId, provider: provider.id, mode: provider.mode },
    extra: (g) => [
      guardedInsert(
        db,
        'production_runs',
        {
          id: runId,
          job_id: jobId,
          provider: provider.id,
          mode: provider.mode,
          template_version: prepared.templateVersion,
          status: 'RUNNING',
          input_digest: prepared.digest,
          operator_id: op.id,
          started_at: nowIso()
        },
        g
      )
    ]
  })
  return { run_id: runId, prompt: prepared.prompt, provider: provider.id, mode: provider.mode }
}

type RunRow = { id: string; job_id: string; status: string; provider: string; input_digest: string }

async function getRunningRun(db: D1Database, jobId: string, runId: string): Promise<RunRow> {
  const run = await db.prepare('SELECT id, job_id, status, provider, input_digest FROM production_runs WHERE id = ? AND job_id = ?').bind(runId, jobId).first<RunRow>()
  if (!run) throw notFound()
  if (run.status !== 'RUNNING') throw new AppError(409, 'run_not_running', 'This production run is already closed')
  return run
}

export async function recordProductionResult(
  env: Bindings,
  op: OperatorCtx,
  jobId: string,
  input: Record<string, unknown>,
  cid: string
) {
  const db = env.DB
  const v = new V()
  const runId = v.str(input.run_id, 'run_id', 1, 64)
  const text = v.str(input.output_text, 'output_text', 0, 200_000, { optional: true })
  const minutes = v.int(input.operator_minutes, 'operator_minutes', 0, 10_000, true)
  const cost = v.int(input.cost_estimate_cents, 'cost_estimate_cents', 0, 10_000_000, true)
  const file = input.output_file instanceof File && input.output_file.size > 0 ? input.output_file : null
  if (!text && !file) v.fail('output_text', 'provide the generated output as text or attach a file')
  if (text && file) v.fail('output_file', 'provide either text or a file, not both')
  v.throwIfAny()

  const job = await getJob(db, jobId)
  if (job.state !== 'IN_PRODUCTION') throw new AppError(409, 'invalid_transition', `Cannot record output while job is ${job.state}`)
  const run = await getRunningRun(db, jobId, runId)

  const stored: StoredFile = file
    ? await storeFile(env, file, 'DRAFT')
    : {
        storage: 'INLINE',
        storage_key: null,
        inline_text: text,
        filename: `${jobId.slice(0, 8)}-draft.md`,
        content_type: 'text/markdown; charset=utf-8',
        size_bytes: new TextEncoder().encode(text).length,
        checksum_sha256: await sha256Hex(text)
      }
  const assetId = uuid()
  try {
    await transition(db, {
      job,
      to: 'QC_REVIEW',
      actor: opActor(op),
      cid,
      reason: 'draft attached',
      auditAction: 'production.result_recorded',
      auditMeta: { run_id: run.id, asset_id: assetId, size_bytes: stored.size_bytes },
      extra: (g) => [
        guardedInsert(
          db,
          'assets',
          {
            id: assetId,
            order_id: job.order_id,
            job_id: jobId,
            run_id: run.id,
            kind: 'DRAFT',
            storage: stored.storage,
            storage_key: stored.storage_key,
            inline_text: stored.inline_text,
            filename: stored.filename,
            content_type: stored.content_type,
            size_bytes: stored.size_bytes,
            checksum_sha256: stored.checksum_sha256,
            visibility: 'INTERNAL',
            created_by: op.id,
            created_at: nowIso()
          },
          g
        ),
        guardedUpdate(
          db,
          `UPDATE production_runs SET status = 'SUCCEEDED', output_asset_id = ?, operator_minutes = ?, cost_estimate_cents = ?, finished_at = ? WHERE id = ? AND status = 'RUNNING'`,
          [assetId, minutes, cost, nowIso(), run.id],
          g
        )
      ]
    })
  } catch (e) {
    if (stored.storage === 'R2' && stored.storage_key && env.R2) await env.R2.delete(stored.storage_key)
    throw e
  }
  return { asset_id: assetId }
}

/** Provider failure: run is closed, job is parked in a recoverable state, nothing is delivered. */
export async function recordProductionFailure(db: D1Database, op: OperatorCtx, jobId: string, input: Record<string, unknown>, cid: string) {
  const v = new V()
  const runId = v.str(input.run_id, 'run_id', 1, 64)
  const code = v.enumOf(input.error_code, 'error_code', PROVIDER_ERROR_CODES)
  const outcome = v.enumOf(input.outcome, 'outcome', ['BLOCKED_PROVIDER', 'FAILED'] as const)
  const note = v.str(input.note, 'note', 0, 1000, { optional: true })
  const minutes = v.int(input.operator_minutes, 'operator_minutes', 0, 10_000, true)
  v.throwIfAny()
  const job = await getJob(db, jobId)
  const run = await getRunningRun(db, jobId, runId)
  await transition(db, {
    job,
    to: outcome,
    actor: opActor(op),
    cid,
    reason: `provider error ${code}`,
    auditAction: 'production.failed',
    auditMeta: { run_id: run.id, error_code: code },
    extra: (g) => [
      guardedUpdate(
        db,
        `UPDATE production_runs SET status = ?, error_code = ?, error_note = ?, operator_minutes = ?, finished_at = ? WHERE id = ? AND status = 'RUNNING'`,
        [outcome === 'BLOCKED_PROVIDER' ? 'BLOCKED' : 'FAILED', code, note, minutes, nowIso(), run.id],
        g
      )
    ]
  })
}

export async function requeue(db: D1Database, op: OperatorCtx, jobId: string, input: Record<string, unknown>, cid: string) {
  const v = new V()
  const reason = v.str(input.reason, 'reason', 0, 500, { optional: true })
  v.throwIfAny()
  const job = await getJob(db, jobId)
  if (!['FAILED', 'BLOCKED_PROVIDER', 'NEEDS_REVISION'].includes(job.state))
    throw new AppError(409, 'invalid_transition', `Cannot requeue a job in ${job.state}`)
  await transition(db, { job, to: 'QUEUED', actor: opActor(op), cid, reason: reason || 'requeued' })
}

// ---------------------------------------------------------------------------
// Quality review, delivery, cancellation
// ---------------------------------------------------------------------------
export const QC_CHECKLIST = [
  ['factual_accuracy', 'Facts match the brief; nothing invented (specs, prices, testimonials, results)'],
  ['brand_fit', 'Tone and voice fit the brand and audience'],
  ['language_quality', 'Natural, correct language (Bahasa Indonesia first)'],
  ['platform_format', 'Format, length and structure fit the target platforms'],
  ['rights_clear', 'No third-party material used without rights'],
  ['no_prohibited_claims', 'No prohibited, regulated, guaranteed-result or misleading claims']
] as const

export async function latestSucceededRun(db: D1Database, jobId: string) {
  return db
    .prepare(`SELECT id, output_asset_id FROM production_runs WHERE job_id = ? AND status = 'SUCCEEDED' ORDER BY started_at DESC, rowid DESC LIMIT 1`)
    .bind(jobId)
    .first<{ id: string; output_asset_id: string | null }>()
}

export async function review(env: Bindings, op: OperatorCtx, jobId: string, input: Record<string, unknown>, cid: string) {
  const db = env.DB
  const v = new V()
  const decision = v.enumOf(input.decision, 'decision', ['APPROVE', 'REQUEST_REVISION'] as const)
  const notes = v.str(input.notes, 'notes', 0, 2000, { optional: true })
  const raw = (input.checklist && typeof input.checklist === 'object' ? input.checklist : input) as Record<string, unknown>
  const checklist: Record<string, boolean> = {}
  for (const [key] of QC_CHECKLIST) checklist[key] = raw[key] === true || raw[key] === 'on' || raw[key] === 'true'
  if (decision === 'APPROVE') {
    for (const [key] of QC_CHECKLIST) if (!checklist[key]) v.fail(`checklist.${key}`, 'must pass before approval')
  } else if (!notes) v.fail('notes', 'explain what must change')
  v.throwIfAny()

  const job = await getJob(db, jobId)
  if (job.state !== 'QC_REVIEW') throw new AppError(409, 'invalid_transition', `Cannot review a job in ${job.state}`)
  const run = await latestSucceededRun(db, jobId)
  if (!run?.output_asset_id) throw new AppError(409, 'no_draft', 'No draft output to review')
  const reviewId = uuid()
  const ts = nowIso()
  await transition(db, {
    job,
    to: decision === 'APPROVE' ? 'APPROVED' : 'NEEDS_REVISION',
    actor: opActor(op),
    cid,
    reason: decision === 'APPROVE' ? 'QC passed' : 'QC requested revision',
    auditAction: 'review.recorded',
    auditMeta: { review_id: reviewId, decision, run_id: run.id },
    extra: (g) => [
      guardedInsert(db, 'reviews', { id: reviewId, job_id: jobId, run_id: run.id, reviewer_id: op.id, decision, checklist_json: JSON.stringify(checklist), notes, created_at: ts }, g),
      ...(decision === 'REQUEST_REVISION'
        ? [guardedInsert(db, 'revisions', { id: uuid(), order_id: job.order_id, job_id: jobId, round: job.revision_round, source: 'INTERNAL', summary: notes, status: 'OPEN', created_at: ts }, g)]
        : [])
    ]
  })
  return { review_id: reviewId }
}

export async function deliver(db: D1Database, op: OperatorCtx, jobId: string, cid: string) {
  const job = await getJob(db, jobId)
  // Gate 1: state machine — only APPROVED may become DELIVERED.
  if (job.state !== 'APPROVED') throw new AppError(409, 'not_approved', `Delivery requires an approved job (current: ${job.state})`)
  // Gate 2: there must be an APPROVE review for the latest successful run's output.
  const run = await latestSucceededRun(db, jobId)
  const approval = run
    ? await db
        .prepare(`SELECT id, decision, run_id FROM reviews WHERE job_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
        .bind(jobId)
        .first<{ id: string; decision: string; run_id: string }>()
    : null
  if (!run?.output_asset_id || !approval || approval.decision !== 'APPROVE' || approval.run_id !== run.id)
    throw new AppError(409, 'not_approved', 'The current draft has no approval record')
  const assetId = run.output_asset_id
  const ts = nowIso()
  await transition(db, {
    job,
    to: 'DELIVERED',
    actor: opActor(op),
    cid,
    reason: 'approved deliverable released',
    auditAction: 'delivery.released',
    auditMeta: { asset_id: assetId, review_id: approval.id },
    extra: (g) => [
      guardedUpdate(db, `UPDATE assets SET visibility = 'CUSTOMER' WHERE id = ? AND job_id = ?`, [assetId, jobId], g),
      guardedInsert(db, 'deliveries', { id: uuid(), job_id: jobId, asset_id: assetId, review_id: approval.id, delivered_by: op.id, created_at: ts }, g),
      guardedUpdate(db, `UPDATE revisions SET status = 'RESOLVED' WHERE job_id = ? AND status = 'OPEN'`, [jobId], g)
    ]
  })
  return { asset_id: assetId }
}

export async function cancel(db: D1Database, op: OperatorCtx, jobId: string, input: Record<string, unknown>, cid: string) {
  if (op.role !== 'ADMIN') throw forbidden('Only an admin can cancel a job')
  const v = new V()
  const reason = v.str(input.reason, 'reason', 3, 500)
  v.throwIfAny()
  const job = await getJob(db, jobId)
  await transition(db, { job, to: 'CANCELLED', actor: opActor(op), cid, reason })
}

export async function addReference(env: Bindings, op: OperatorCtx, jobId: string, input: Record<string, unknown>, cid: string) {
  const file = input.reference_file instanceof File && input.reference_file.size > 0 ? input.reference_file : null
  if (!file) throw new AppError(422, 'validation_failed', 'Attach a file', [{ field: 'reference_file', issue: 'is required' }])
  const job = await getJob(env.DB, jobId)
  if (job.state === 'CANCELLED' || job.state === 'DELIVERED') throw new AppError(409, 'job_closed', 'Job is closed')
  const stored = await storeFile(env, file, 'REFERENCE')
  const assetId = uuid()
  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO assets (id, order_id, job_id, run_id, kind, storage, storage_key, inline_text, filename, content_type, size_bytes, checksum_sha256, visibility, created_by, created_at)
         VALUES (?, ?, ?, NULL, 'REFERENCE', ?, ?, NULL, ?, ?, ?, ?, 'INTERNAL', ?, ?)`
      )
      .bind(assetId, job.order_id, jobId, stored.storage, stored.storage_key, stored.filename, stored.content_type, stored.size_bytes, stored.checksum_sha256, op.id, nowIso()),
    auditStmt(env.DB, opActor(op), 'asset.reference_added', 'job', jobId, cid, { asset_id: assetId, size_bytes: stored.size_bytes })
  ])
  return { asset_id: assetId }
}

// ---------------------------------------------------------------------------
// Customer-scoped operations (public connector)
// ---------------------------------------------------------------------------
export async function customerRevisionRequest(
  env: Bindings,
  job: JobRow,
  summary: string,
  idemKey: string,
  cid: string,
  actor: Actor
) {
  const db = env.DB
  const scope = `revision:${job.id}`
  const hash = await sha256Hex(summary)
  const prior = await db.prepare('SELECT request_hash, resource_id FROM idempotency_keys WHERE scope = ? AND idem_key = ?').bind(scope, idemKey).first<{ request_hash: string; resource_id: string }>()
  if (prior) {
    if (prior.request_hash !== hash) throw new AppError(409, 'idempotency_conflict', 'Idempotency-Key was already used with a different request body')
    return { replay: true, revision_id: prior.resource_id }
  }
  if (job.state !== 'DELIVERED') throw new AppError(409, 'revision_not_eligible', 'A revision can be requested only after delivery')
  const max = maxRevisions(env)
  if (job.revision_round >= max) throw new AppError(409, 'revision_limit_reached', 'No revision rounds remaining for this order')
  const revisionId = uuid()
  const round = job.revision_round + 1
  try {
    await transition(db, {
      job,
      to: 'NEEDS_REVISION',
      actor,
      cid,
      reason: `customer revision round ${round}`,
      set: { revision_round: round },
      auditAction: 'revision.requested',
      auditMeta: { revision_id: revisionId, round },
      extra: (g) => [
        guardedInsert(db, 'idempotency_keys', { scope, idem_key: idemKey, request_hash: hash, resource_id: revisionId, created_at: nowIso() }, g),
        guardedInsert(db, 'revisions', { id: revisionId, order_id: job.order_id, job_id: job.id, round, source: 'CUSTOMER', summary, status: 'OPEN', created_at: nowIso() }, g)
      ]
    })
  } catch (e) {
    const raced = await db.prepare('SELECT request_hash, resource_id FROM idempotency_keys WHERE scope = ? AND idem_key = ?').bind(scope, idemKey).first<{ request_hash: string; resource_id: string }>()
    if (raced && raced.request_hash === hash) return { replay: true, revision_id: raced.resource_id }
    throw e
  }
  return { replay: false, revision_id: revisionId, round }
}
