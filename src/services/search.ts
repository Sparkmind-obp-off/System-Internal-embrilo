// Order search shared by the Inbox and the AI assistant's `search_orders` tool.
// Only parameterised SQL built from validated filters — never model- or user-written SQL.
import { STATES, type JobState } from '../lib/state'
import { SERVICE_CODES } from '../lib/validate'
import { QUEUE_VIEWS, type QueueView } from '../views/labels'
import type { OperatorCtx } from '../types'

export const PAGE_SIZES = [10, 25, 50] as const
export const SORTS = ['priority', 'updated', 'created'] as const
export type Sort = (typeof SORTS)[number]

/** States in which the operations team (not the customer) has the next step. */
export const OPS_ACTION_STATES: JobState[] = ['SUBMITTED', 'TRIAGE', 'QUEUED', 'NEEDS_REVISION', 'IN_PRODUCTION', 'BLOCKED_PROVIDER', 'FAILED', 'QC_REVIEW', 'APPROVED']

export type OrderFilter = {
  q?: string
  view?: QueueView
  state?: JobState
  /** 'open' (default) excludes delivered/cancelled; 'all' includes everything. Ignored when view/state is set. */
  scope?: 'open' | 'all'
  mine?: boolean
  /** Ops-actionable orders assigned to me or still unassigned. */
  needsMe?: boolean
  prio?: string
  services?: string[]
  prompt?: 'none' | 'draft' | 'ready'
  revision?: 'open'
  createdFrom?: string
  createdTo?: string
  updatedFrom?: string
  sort?: Sort
  page?: number
  pageSize?: number
}

export type OrderRow = {
  id: string
  public_ref: string
  service_code: string
  state: JobState
  priority: string
  customer_name: string
  assignee_name: string | null
  assigned_operator_id: string | null
  updated_at: string
  created_at: string
  revision_round: number
  prompt_status: 'READY' | 'DRAFT' | null
  rights_confirmed: number | null
  facts_len: number | null
  open_revisions: number
}

export type SearchResult = { rows: OrderRow[]; total: number; page: number; pageSize: number; pages: number; filter: OrderFilter }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const validDate = (s: unknown) => (typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) ? s : undefined)
const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString()

/** Normalises untrusted query parameters (URL or assistant tool args) into a safe filter. Unknown values are dropped. */
export function normalizeFilter(raw: Record<string, unknown>): OrderFilter {
  const str = (k: string, max = 64) => (typeof raw[k] === 'string' ? (raw[k] as string).trim().slice(0, max) : '')
  const f: OrderFilter = {}
  const q = str('q')
  if (q) f.q = q
  const view = str('view')
  if (QUEUE_VIEWS.some((v) => v.id === view)) f.view = view as QueueView
  const state = str('state')
  if (!f.view && (STATES as readonly string[]).includes(state)) f.state = state as JobState
  if (str('scope') === 'all') f.scope = 'all'
  if (raw.mine === true || raw.mine === '1') f.mine = true
  if (raw.needsMe === true || raw.needs_me === '1') f.needsMe = true
  const prio = str('prio')
  if (['LOW', 'NORMAL', 'HIGH', 'URGENT'].includes(prio)) f.prio = prio
  const services = str('service', 200)
    .split(',')
    .map((x) => x.trim())
    .filter((x) => (SERVICE_CODES as readonly string[]).includes(x))
  if (services.length) f.services = Array.from(new Set(services)).slice(0, 5)
  const prompt = str('prompt')
  if (prompt === 'none' || prompt === 'draft' || prompt === 'ready') f.prompt = prompt
  if (str('revision') === 'open') f.revision = 'open'
  f.createdFrom = validDate(raw.created_from ?? raw.createdFrom)
  f.createdTo = validDate(raw.created_to ?? raw.createdTo)
  f.updatedFrom = validDate(raw.updated_from ?? raw.updatedFrom)
  const sort = str('sort')
  if ((SORTS as readonly string[]).includes(sort)) f.sort = sort as Sort
  const page = Number(raw.page)
  if (Number.isInteger(page) && page >= 1 && page <= 1000) f.page = page
  const size = Number(raw.size ?? raw.pageSize)
  if ((PAGE_SIZES as readonly number[]).includes(size)) f.pageSize = size
  for (const k of Object.keys(f) as (keyof OrderFilter)[]) if (f[k] === undefined) delete f[k]
  return f
}

const likeEscape = (s: string) => `%${s.replace(/[\\%_]/g, (m) => '\\' + m)}%`

export async function searchOrders(db: D1Database, op: OperatorCtx, f: OrderFilter): Promise<SearchResult> {
  const where: string[] = []
  const params: unknown[] = []
  if (f.view) {
    const states = QUEUE_VIEWS.find((v) => v.id === f.view)!.states
    where.push(`j.state IN (${states.map(() => '?').join(',')})`)
    params.push(...states)
  } else if (f.state) {
    where.push('j.state = ?')
    params.push(f.state)
  } else if (f.scope !== 'all') {
    where.push(`j.state NOT IN ('DELIVERED','CANCELLED')`)
  }
  if (f.mine) {
    where.push('j.assigned_operator_id = ?')
    params.push(op.id)
  }
  if (f.needsMe) {
    where.push(`j.state IN (${OPS_ACTION_STATES.map(() => '?').join(',')}) AND (j.assigned_operator_id = ? OR j.assigned_operator_id IS NULL)`)
    params.push(...OPS_ACTION_STATES, op.id)
  }
  if (f.q) {
    const like = likeEscape(f.q)
    // Customer external refs are identifiers, so only roles that can act on orders may search by them.
    const refClause = op.role === 'VIEWER' ? '' : ` OR cu.external_ref LIKE ? ESCAPE '\\'`
    where.push(
      `(o.public_ref LIKE ? ESCAPE '\\' OR cu.display_name LIKE ? ESCAPE '\\' OR b.objective LIKE ? ESCAPE '\\' OR b.product_facts LIKE ? ESCAPE '\\'${refClause})`
    )
    params.push(like, like, like, like, ...(op.role === 'VIEWER' ? [] : [like]))
  }
  if (f.prio) {
    where.push('j.priority = ?')
    params.push(f.prio)
  }
  if (f.services?.length) {
    where.push(`o.service_code IN (${f.services.map(() => '?').join(',')})`)
    params.push(...f.services)
  }
  if (f.prompt === 'ready') where.push(`EXISTS (SELECT 1 FROM prompt_versions pv WHERE pv.job_id = j.id AND pv.status = 'READY')`)
  if (f.prompt === 'draft')
    where.push(`EXISTS (SELECT 1 FROM prompt_versions pv WHERE pv.job_id = j.id) AND NOT EXISTS (SELECT 1 FROM prompt_versions pv WHERE pv.job_id = j.id AND pv.status = 'READY')`)
  if (f.prompt === 'none') where.push(`NOT EXISTS (SELECT 1 FROM prompt_versions pv WHERE pv.job_id = j.id)`)
  if (f.revision === 'open') where.push(`(j.state = 'NEEDS_REVISION' OR EXISTS (SELECT 1 FROM revisions r WHERE r.job_id = j.id AND r.status = 'OPEN'))`)
  if (f.createdFrom) {
    where.push('j.created_at >= ?')
    params.push(`${f.createdFrom}T00:00:00.000Z`)
  }
  if (f.createdTo) {
    where.push('j.created_at < ?')
    params.push(nextDay(f.createdTo))
  }
  if (f.updatedFrom) {
    where.push('j.updated_at >= ?')
    params.push(`${f.updatedFrom}T00:00:00.000Z`)
  }
  const pageSize = f.pageSize ?? 25
  const from = `FROM jobs j JOIN orders o ON o.id = j.order_id JOIN customers cu ON cu.id = o.customer_id JOIN briefs b ON b.order_id = o.id
                LEFT JOIN operators op ON op.id = j.assigned_operator_id`
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const order =
    f.sort === 'updated'
      ? 'j.updated_at DESC'
      : f.sort === 'created'
        ? 'j.created_at DESC'
        : `CASE j.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END, j.created_at ASC`
  const countRow = await db.prepare(`SELECT COUNT(*) AS n ${from} ${whereSql}`).bind(...params).first<{ n: number }>()
  const total = countRow?.n ?? 0
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const page = Math.min(f.page ?? 1, pages)
  const rows = await db
    .prepare(
      `SELECT j.id, o.public_ref, o.service_code, j.state, j.priority, cu.display_name AS customer_name, op.display_name AS assignee_name,
              j.assigned_operator_id, j.updated_at, j.created_at, j.revision_round, b.rights_confirmed, LENGTH(b.product_facts) AS facts_len,
              (SELECT CASE WHEN SUM(status = 'READY') > 0 THEN 'READY' WHEN COUNT(*) > 0 THEN 'DRAFT' END FROM prompt_versions pv WHERE pv.job_id = j.id) AS prompt_status,
              (SELECT COUNT(*) FROM revisions r WHERE r.job_id = j.id AND r.status = 'OPEN') AS open_revisions
       ${from} ${whereSql} ORDER BY ${order}, j.id LIMIT ? OFFSET ?`
    )
    .bind(...params, pageSize, (page - 1) * pageSize)
    .all<OrderRow>()
  return { rows: rows.results, total, page, pageSize, pages, filter: f }
}

/** True when the brief is missing information the team cannot proceed without. */
export const briefIncomplete = (r: Pick<OrderRow, 'rights_confirmed' | 'facts_len'>) => r.rights_confirmed === 0 || (r.facts_len ?? 0) < 40

/** Resolves an order by public reference or job id (exact match only). */
export async function findJobId(db: D1Database, ref: string): Promise<{ id: string; public_ref: string } | null> {
  const r = ref.trim().toUpperCase()
  if (/^EMB-[0-9A-Z]{5}-[0-9A-Z]{5}$/.test(r))
    return db.prepare('SELECT j.id, o.public_ref FROM jobs j JOIN orders o ON o.id = j.order_id WHERE o.public_ref = ?').bind(r).first()
  if (/^[A-Za-z0-9-]{8,64}$/.test(ref.trim()))
    return db.prepare('SELECT j.id, o.public_ref FROM jobs j JOIN orders o ON o.id = j.order_id WHERE j.id = ?').bind(ref.trim()).first()
  return null
}
