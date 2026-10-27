import { AppError, notFound } from './errors'
import { uuid } from './crypto'
import { canTransition, type JobState } from './state'
import type { Actor } from '../types'

export const nowIso = () => new Date().toISOString()

export type JobRow = {
  id: string
  order_id: string
  state: JobState
  priority: string
  attempts: number
  revision_round: number
  assigned_operator_id: string | null
  customer_message: string
  version: number
  last_transition_id: string | null
  created_at: string
  updated_at: string
  delivered_at: string | null
}

export async function getJob(db: D1Database, id: string): Promise<JobRow> {
  const row = await db.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first<JobRow>()
  if (!row) throw notFound()
  return row
}

/**
 * A guard makes extra statements inside a D1 batch apply ONLY if the job's
 * state transition (identified by a unique transition id) actually applied.
 * D1 batches are transactional, so either everything lands or nothing changes.
 */
export type Guard = { jobId: string; transitionId: string }
const GUARD_SQL = 'EXISTS (SELECT 1 FROM jobs WHERE id = ? AND last_transition_id = ?)'

export function guardedInsert(db: D1Database, table: string, row: Record<string, unknown>, g: Guard) {
  const cols = Object.keys(row)
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) SELECT ${cols.map(() => '?').join(', ')} WHERE ${GUARD_SQL}`
  return db.prepare(sql).bind(...cols.map((c) => row[c] ?? null), g.jobId, g.transitionId)
}

export function guardedUpdate(db: D1Database, sql: string, params: unknown[], g: Guard) {
  // `sql` must be an UPDATE with a WHERE clause; the guard is AND-ed onto it.
  return db.prepare(`${sql} AND ${GUARD_SQL}`).bind(...params, g.jobId, g.transitionId)
}

export type TransitionOpts = {
  job: JobRow
  to: JobState
  actor: Actor
  cid: string
  reason?: string
  /** Extra column updates applied to jobs together with the transition. */
  set?: Record<string, unknown>
  /** Additional statements built with the guard (inserted after the jobs update). */
  extra?: (g: Guard) => D1PreparedStatement[]
  auditAction?: string
  auditMeta?: Record<string, unknown>
}

/** Validates and atomically applies a state transition with history + audit. */
export async function transition(db: D1Database, o: TransitionOpts): Promise<{ transitionId: string }> {
  const { job, to } = o
  if (!canTransition(job.state, to))
    throw new AppError(409, 'invalid_transition', `Transition ${job.state} → ${to} is not allowed`)
  const transitionId = uuid()
  const ts = nowIso()
  const g: Guard = { jobId: job.id, transitionId }
  const set: Record<string, unknown> = { ...(o.set ?? {}) }
  if (to === 'DELIVERED') set.delivered_at = ts
  const setCols = Object.keys(set)
  const setSql = setCols.map((c) => `, ${c} = ?`).join('')

  const update = db
    .prepare(
      `UPDATE jobs SET state = ?, version = version + 1, last_transition_id = ?, updated_at = ?${setSql}
       WHERE id = ? AND state = ? AND version = ?`
    )
    .bind(to, transitionId, ts, ...setCols.map((c) => set[c] ?? null), job.id, job.state, job.version)

  const statements: D1PreparedStatement[] = [
    update,
    guardedInsert(
      db,
      'job_state_history',
      {
        id: uuid(),
        job_id: job.id,
        from_state: job.state,
        to_state: to,
        actor_type: o.actor.type,
        actor_id: o.actor.id,
        reason: (o.reason ?? '').slice(0, 500),
        correlation_id: o.cid,
        created_at: ts
      },
      g
    ),
    guardedInsert(
      db,
      'audit_events',
      {
        id: uuid(),
        actor_type: o.actor.type,
        actor_id: o.actor.id,
        action: o.auditAction ?? `job.transition.${to.toLowerCase()}`,
        resource_type: 'job',
        resource_id: job.id,
        correlation_id: o.cid,
        metadata_json: JSON.stringify({ from: job.state, to, ...(o.auditMeta ?? {}) }),
        created_at: ts
      },
      g
    ),
    ...(o.extra ? o.extra(g) : [])
  ]

  const results = await db.batch(statements)
  if ((results[0].meta.changes ?? 0) !== 1)
    throw new AppError(409, 'concurrent_modification', 'The job changed in the meantime; reload and retry')
  return { transitionId }
}
