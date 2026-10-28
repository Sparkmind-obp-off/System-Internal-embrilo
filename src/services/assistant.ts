// Internal AI assistant: a controlled interface to existing, read-only application
// capabilities. Questions are mapped to ONE whitelisted tool (deterministic rules first;
// the configured LLM only as a router that returns a validated tool call). Answers are
// built from real database rows. The LLM may optionally phrase a summary of facts the
// app already loaded — that text is always labelled as an AI suggestion, never a fact.
// Mutations are never executed from a question: they are stored as PROPOSED actions and
// run only after explicit operator confirmation, through the existing services.
import { AppError } from '../lib/errors'
import { nowIso } from '../lib/db'
import { uuid } from '../lib/crypto'
import { auditStmt } from '../lib/audit'
import { rateLimit } from '../lib/ratelimit'
import { cleanText } from '../lib/validate'
import { sanitizeForPrompt } from '../lib/prompt'
import { LlmError, plannerMessages, runLlm, summaryMessages } from '../lib/llm'
import { analyzeBriefRules, buildTemplatePrompt, detectConflicts } from '../lib/templates'
import { STATE_LABEL_ID } from '../views/layout'
import { SERVICE_LABEL, nextAction, relTime, fmtDateTime } from '../views/labels'
import * as studio from './studio'
import * as jobs from './jobs'
import { briefIncomplete, findJobId, normalizeFilter, searchOrders, type OrderFilter } from './search'
import type { Actor, Bindings, OperatorCtx } from '../types'
import type { JobState } from '../lib/state'

export const TOOLS = [
  'search_orders',
  'get_order_details',
  'summarize_order',
  'identify_missing_brief_fields',
  'draft_production_prompt',
  'get_prompt_versions',
  'get_order_activity'
] as const
export type ToolName = (typeof TOOLS)[number]
export const ACTION_KINDS = ['create_prompt_draft', 'mark_prompt_ready', 'assign_to_me'] as const
export type ActionKind = (typeof ACTION_KINDS)[number]
const ORDER_TOOLS: ToolName[] = ['get_order_details', 'summarize_order', 'identify_missing_brief_fields', 'draft_production_prompt', 'get_prompt_versions', 'get_order_activity']
const ACTION_TTL_MS = 15 * 60 * 1000
const MAX_QUESTION = 500
const actor = (op: OperatorCtx): Actor => ({ type: 'OPERATOR', id: op.id })
const canWrite = (op: OperatorCtx) => op.role === 'ADMIN' || op.role === 'OPERATOR'

export type Source = { ref: string; jobId: string; fields: string[] }
export type ResultRow = { id: string; ref: string; state: JobState; service: string; priority: string; updated_at: string; next: string; flags: string[]; owner: string | null }
export type AnswerData = {
  tool: ToolName | 'clarify'
  planner: 'rules' | 'ai'
  args?: Record<string, unknown>
  facts?: string[]
  rows?: ResultRow[]
  total?: number
  moreHref?: string
  sources: Source[]
  notes?: string[]
  suggestion?: { text: string; provider: string; model: string }
  aiError?: string
  promptPreview?: string
  list?: { label: string; meta: string; href?: string }[]
  actionId?: string
  clarify?: string
}

// ---------------------------------------------------------------------------
// Intent parsing (rules). Returns a validated tool call or null.
// ---------------------------------------------------------------------------
type Plan =
  | { tool: 'search_orders'; filter: OrderFilter; via: 'rules' | 'ai' }
  | { tool: Exclude<ToolName, 'search_orders'>; ref: string | null; useContext: boolean; via: 'rules' | 'ai'; action?: ActionKind }
  | { tool: 'clarify'; question: string; via: 'rules' | 'ai' }

const REF_RE = /\bEMB-[0-9A-Z]{5}-[0-9A-Z]{5}\b/i
const VIDEO_SERVICES = ['SCRIPT_PACK', 'PRODUCT_STORY', 'PRODUCTION_BRIEF']
const isoDay = (offsetDays = 0) => new Date(Date.now() - offsetDays * 86_400_000).toISOString().slice(0, 10)

export function parseFilters(t: string): { filter: OrderFilter; matched: boolean } {
  const f: OrderFilter = {}
  let matched = false
  const hit = (re: RegExp) => re.test(t)
  if (hit(/\bvideo\b/)) (f.services = VIDEO_SERVICES), (matched = true)
  else if (hit(/\b(caption|hook)\b/)) (f.services = ['HOOK_CAPTION_PACK']), (matched = true)
  else if (hit(/\bkalender\b/)) (f.services = ['CONTENT_CALENDAR']), (matched = true)
  else if (hit(/cerita produk/)) (f.services = ['PRODUCT_STORY']), (matched = true)
  else if (hit(/\b(skrip|script)\b/)) (f.services = ['SCRIPT_PACK']), (matched = true)
  if (hit(/revisi/)) (f.revision = 'open'), (matched = true)
  if (hit(/menunggu (info|informasi|jawaban|klarifikasi)/)) (f.view = 'info'), (matched = true)
  else if (hit(/(perlu )?(ditinjau|\bqc\b|review)/)) (f.view = 'review'), (matched = true)
  else if (hit(/siap dikirim/)) (f.view = 'deliver'), (matched = true)
  else if (hit(/siap diproduksi|\bantre/)) (f.view = 'ready'), (matched = true)
  else if (hit(/sedang (dikerjakan|diproduksi|produksi)/)) (f.state = 'IN_PRODUCTION'), (matched = true)
  else if (hit(/\bgagal\b/)) (f.state = 'FAILED'), (matched = true)
  else if (hit(/terhambat/)) (f.state = 'BLOCKED_PROVIDER'), (matched = true)
  else if (hit(/triase|baru masuk/)) (f.view = 'triage'), (matched = true)
  else if (hit(/dibatalkan|batal\b/)) (f.state = 'CANCELLED'), (matched = true)
  else if (!hit(/belum (selesai|terkirim|dikirim)/) && hit(/(sudah (selesai|terkirim|dikirim)|\bterkirim\b)/)) (f.view = 'done'), (matched = true)
  if (hit(/belum (selesai|terkirim|dikirim)|masih (berjalan|aktif|terbuka)|\bterbuka\b/)) matched = true // open is the default scope
  if (hit(/mendesak|urgent/)) (f.prio = 'URGENT'), (matched = true)
  else if (hit(/prioritas tinggi/)) (f.prio = 'HIGH'), (matched = true)
  if (hit(/prompt (sudah )?siap|prompt ready/)) (f.prompt = 'ready'), (matched = true)
  else if (hit(/(belum (ada |punya )?prompt|tanpa prompt)/)) (f.prompt = 'none'), (matched = true)
  if (hit(/(milik|punya|ditugaskan ke) (saya|aku|ku)\b/)) (f.mine = true), (matched = true)
  if (hit(/(tindakan ?ku|tindakan saya|perlu (saya|aku)|butuh (saya|aku)|tugas ?ku|tugas saya|(saya|aku) kerjakan|giliran (saya|aku))/)) (f.needsMe = true), (matched = true)
  if (hit(/hari ini/)) (f.updatedFrom = isoDay(0)), (matched = true)
  else if (hit(/minggu ini|7 hari/)) (f.createdFrom = isoDay(7)), (matched = true)
  if (hit(/\bsemua\b/) && !f.view && !f.state) f.scope = 'all'
  const quoted = t.match(/["“']([^"”']{2,60})["”']/)
  if (quoted) (f.q = quoted[1].trim()), (matched = true)
  return { filter: f, matched }
}

function orderToolFor(t: string): { tool: Exclude<ToolName, 'search_orders'>; action?: ActionKind } | null {
  if (/(tugaskan ke (saya|aku)|ambil (order|pesanan)|assign (ke )?(saya|aku|me))/.test(t)) return { tool: 'get_order_details', action: 'assign_to_me' }
  if (/(tandai|jadikan|set).{0,30}(siap|ready)/.test(t) && /prompt|versi/.test(t)) return { tool: 'get_prompt_versions', action: 'mark_prompt_ready' }
  if (/(versi|riwayat|histori)\s+prompt|prompt\s+versi|daftar prompt/.test(t)) return { tool: 'get_prompt_versions' }
  if (/(buat|bikin|susun|generate|siapkan|draf(kan)?|tulis)\b.{0,40}prompt|prompt.{0,30}(produksi|berikutnya)/.test(t)) return { tool: 'draft_production_prompt' }
  if (/(kurang|belum lengkap|celah|missing|informasi apa|data apa|konflik|bertentangan|klarifikasi)/.test(t)) return { tool: 'identify_missing_brief_fields' }
  if (/(aktivitas|riwayat|histori|\blog\b|timeline|jejak)/.test(t)) return { tool: 'get_order_activity' }
  if (/(ringkas|rangkum|progres|progress|summary|perkembangan|bagaimana (status|kabar)|status order)/.test(t)) return { tool: 'summarize_order' }
  return null
}

export function planByRules(question: string, hasContext: boolean): Plan | null {
  const t = question.toLowerCase()
  const refMatch = question.match(REF_RE)
  const deictic = /\b(ini|tersebut|this)\b/.test(t)
  const orderTool = orderToolFor(t)
  const { filter, matched } = parseFilters(t)
  const searchCue =
    /(\bcari\b|\bdaftar\b|(order|pesanan) mana|tampilkan (semua|order|pesanan|yang)|ada berapa|berapa (order|pesanan)|\byang (belum|sudah|menunggu|perlu|butuh|masih|membutuhkan)|\bsemua (order|pesanan))/.test(t) ||
    !!filter.needsMe
  const ref = refMatch ? refMatch[0].toUpperCase() : null
  if ((ref || deictic) && orderTool) return { ...orderTool, ref, useContext: !ref, via: 'rules' }
  if (!ref && (searchCue || (matched && !orderTool))) return { tool: 'search_orders', filter, via: 'rules' }
  if (orderTool) return { ...orderTool, ref: null, useContext: true, via: 'rules' }
  if (ref) return { tool: 'get_order_details', ref, useContext: false, via: 'rules' }
  if (hasContext && /(order ini|pesanan ini|detail|brief)/.test(t)) return { tool: 'get_order_details', ref: null, useContext: true, via: 'rules' }
  return null
}

const TOOL_SPEC = `- {"tool":"search_orders","filter":{...}} filter keys (all optional): q (keyword), view (triage|info|ready|production|review|deliver|done), state (SUBMITTED|TRIAGE|QUEUED|IN_PRODUCTION|QC_REVIEW|APPROVED|DELIVERED|NEEDS_INFO|NEEDS_REVISION|BLOCKED_PROVIDER|FAILED|CANCELLED), scope (open|all), mine (true), needs_me (true), prio (LOW|NORMAL|HIGH|URGENT), service (SCRIPT_PACK|HOOK_CAPTION_PACK|PRODUCT_STORY|CONTENT_CALENDAR|PRODUCTION_BRIEF, comma-separated allowed), prompt (none|draft|ready), revision (open), created_from / created_to / updated_from (YYYY-MM-DD), sort (priority|updated|created)
- {"tool":"get_order_details","ref":"EMB-XXXXX-XXXXX or null for the current order"}
- {"tool":"summarize_order","ref":...}
- {"tool":"identify_missing_brief_fields","ref":...}
- {"tool":"draft_production_prompt","ref":...}
- {"tool":"get_prompt_versions","ref":...}
- {"tool":"get_order_activity","ref":...}`

/** Validates an LLM router reply. Anything outside the schema becomes a clarification. */
export function parsePlannerOutput(text: string): Plan {
  const m = text.match(/\{[\s\S]*\}/)
  let j: any = null
  try {
    j = m ? JSON.parse(m[0]) : null
  } catch {
    j = null
  }
  if (!j || typeof j !== 'object' || typeof j.tool !== 'string') return { tool: 'clarify', question: 'Maaf, saya belum memahami pertanyaannya. Bisa diperjelas?', via: 'ai' }
  if (j.tool === 'clarify') return { tool: 'clarify', question: cleanText(String(j.question ?? '')).slice(0, 300) || 'Bisa diperjelas?', via: 'ai' }
  if (j.tool === 'search_orders') {
    const raw = j.filter && typeof j.filter === 'object' && !Array.isArray(j.filter) ? (j.filter as Record<string, unknown>) : {}
    const flat: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(raw)) flat[k] = typeof v === 'boolean' ? (v ? '1' : '') : v
    return { tool: 'search_orders', filter: normalizeFilter(flat), via: 'ai' }
  }
  if ((ORDER_TOOLS as string[]).includes(j.tool)) {
    const ref = typeof j.ref === 'string' && REF_RE.test(j.ref) ? j.ref.match(REF_RE)![0].toUpperCase() : null
    return { tool: j.tool, ref, useContext: !ref, via: 'ai' }
  }
  return { tool: 'clarify', question: 'Permintaan itu belum didukung asisten. Coba cari order, ringkas order, atau buat prompt.', via: 'ai' }
}

// ---------------------------------------------------------------------------
// Tools (read-only, bounded). Each returns AnswerData built from real rows.
// ---------------------------------------------------------------------------
const FIELD_LABEL: Record<string, string> = {
  state: 'status',
  priority: 'prioritas',
  owner: 'pemilik',
  updated_at: 'waktu pembaruan',
  created_at: 'waktu masuk',
  service: 'layanan',
  brief: 'brief',
  prompt_versions: 'versi prompt',
  production_runs: 'proses produksi',
  revisions: 'revisi',
  reviews: 'tinjauan QC',
  deliveries: 'pengiriman',
  history: 'riwayat status',
  audit: 'jejak audit',
  customer_name: 'nama pelanggan'
}
export const fieldLabel = (f: string) => FIELD_LABEL[f] ?? f

async function loadOrder(db: D1Database, jobId: string) {
  return db
    .prepare(
      `SELECT j.id, j.state, j.priority, j.revision_round, j.assigned_operator_id, j.customer_message, j.created_at, j.updated_at, j.delivered_at, j.work_type,
              o.public_ref, o.service_code, cu.display_name AS customer_name, cu.external_ref AS customer_ref, op.display_name AS owner_name,
              b.objective, b.audience, b.product_facts, b.platforms, b.language, b.tone, b.cta, b.constraints, b.references_json, b.rights_confirmed
       FROM jobs j JOIN orders o ON o.id = j.order_id JOIN customers cu ON cu.id = o.customer_id JOIN briefs b ON b.order_id = o.id
       LEFT JOIN operators op ON op.id = j.assigned_operator_id WHERE j.id = ?`
    )
    .bind(jobId)
    .first<Record<string, any>>()
}

function rowFlags(r: { state: JobState; prompt_status: string | null; rights_confirmed: number | null; facts_len: number | null; open_revisions: number }) {
  const f: string[] = []
  if (briefIncomplete(r)) f.push('Brief kurang')
  if (r.state === 'NEEDS_INFO') f.push('Menunggu klarifikasi')
  if (r.prompt_status === 'READY') f.push('Prompt siap')
  else if (r.prompt_status === 'DRAFT') f.push('Prompt draf')
  if (r.state === 'NEEDS_REVISION' || r.open_revisions > 0) f.push('Revisi')
  return f
}

export function filterSummary(f: OrderFilter): string {
  const parts: string[] = []
  if (f.view) parts.push(`tampilan ${f.view}`)
  if (f.state) parts.push(`status ${STATE_LABEL_ID[f.state]}`)
  if (!f.view && !f.state) parts.push(f.scope === 'all' ? 'semua status' : 'belum selesai')
  if (f.services?.length) parts.push(`layanan ${f.services.map((s) => SERVICE_LABEL[s] ?? s).join('/')}`)
  if (f.revision) parts.push('ada revisi terbuka')
  if (f.prio) parts.push(`prioritas ${f.prio}`)
  if (f.prompt) parts.push(`prompt ${f.prompt === 'none' ? 'belum ada' : f.prompt === 'ready' ? 'siap' : 'draf'}`)
  if (f.mine) parts.push('ditugaskan ke saya')
  if (f.needsMe) parts.push('perlu tindakan tim (milik saya atau belum ditugaskan)')
  if (f.createdFrom) parts.push(`masuk sejak ${f.createdFrom}`)
  if (f.updatedFrom) parts.push(`diperbarui sejak ${f.updatedFrom}`)
  if (f.q) parts.push(`kata kunci “${f.q}”`)
  return parts.join(', ')
}

export function inboxHref(f: OrderFilter): string {
  const p = new URLSearchParams()
  if (f.q) p.set('q', f.q)
  if (f.view) p.set('view', f.view)
  if (f.state) p.set('state', f.state)
  if (f.scope === 'all') p.set('scope', 'all')
  if (f.mine) p.set('mine', '1')
  if (f.needsMe) p.set('needs_me', '1')
  if (f.prio) p.set('prio', f.prio)
  if (f.services?.length) p.set('service', f.services.join(','))
  if (f.prompt) p.set('prompt', f.prompt)
  if (f.revision) p.set('revision', 'open')
  if (f.createdFrom) p.set('created_from', f.createdFrom)
  if (f.createdTo) p.set('created_to', f.createdTo)
  if (f.updatedFrom) p.set('updated_from', f.updatedFrom)
  if (f.sort) p.set('sort', f.sort)
  const s = p.toString()
  return s ? `/console?${s}` : '/console'
}

async function toolSearch(env: Bindings, op: OperatorCtx, filter: OrderFilter): Promise<{ text: string; data: Partial<AnswerData> }> {
  const res = await searchOrders(env.DB, op, { ...filter, pageSize: 10, page: 1 })
  const desc = filterSummary(filter)
  const rows: ResultRow[] = res.rows.map((r) => ({
    id: r.id,
    ref: r.public_ref,
    state: r.state,
    service: r.service_code,
    priority: r.priority,
    updated_at: r.updated_at,
    next: nextAction(r.state).label,
    flags: rowFlags(r),
    owner: r.assignee_name
  }))
  const text = res.total === 0 ? `Tidak ada order yang cocok (${desc}).` : `Ditemukan ${res.total} order (${desc})${res.total > rows.length ? `; ${rows.length} teratas ditampilkan` : ''}.`
  return {
    text,
    data: {
      rows,
      total: res.total,
      moreHref: inboxHref(filter),
      sources: rows.map((r) => ({ ref: r.ref, jobId: r.id, fields: ['state', 'service', 'priority', 'owner', 'updated_at'] })),
      notes: res.total === 0 ? ['Hanya data yang benar-benar tercatat di database yang ditampilkan. Coba longgarkan filter.'] : undefined
    }
  }
}

type Order = NonNullable<Awaited<ReturnType<typeof loadOrder>>>

async function orderStats(db: D1Database, jobId: string) {
  const [pv, runs, revs, review, delivery, lastHist] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS n, MAX(version) AS latest, MAX(CASE WHEN status = 'READY' THEN version END) AS ready FROM prompt_versions WHERE job_id = ?`).bind(jobId).first<{ n: number; latest: number | null; ready: number | null }>(),
    db.prepare(`SELECT COUNT(*) AS n, (SELECT status FROM production_runs WHERE job_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1) AS last_status, (SELECT started_at FROM production_runs WHERE job_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1) AS last_at FROM production_runs WHERE job_id = ?`).bind(jobId, jobId, jobId).first<{ n: number; last_status: string | null; last_at: string | null }>(),
    db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END) AS open FROM revisions WHERE job_id = ?`).bind(jobId).first<{ total: number; open: number | null }>(),
    db.prepare(`SELECT decision, created_at FROM reviews WHERE job_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).bind(jobId).first<{ decision: string; created_at: string }>(),
    db.prepare(`SELECT COUNT(*) AS n, MAX(created_at) AS last FROM deliveries WHERE job_id = ?`).bind(jobId).first<{ n: number; last: string | null }>(),
    db.prepare(`SELECT to_state, created_at FROM job_state_history WHERE job_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).bind(jobId).first<{ to_state: JobState; created_at: string }>()
  ])
  return { pv: pv!, runs: runs!, revs: revs!, review, delivery: delivery!, lastHist }
}

const RUN_LABEL: Record<string, string> = { RUNNING: 'berjalan', SUCCEEDED: 'berhasil', FAILED: 'gagal', BLOCKED: 'terhambat' }

function orderFacts(o: Order, s: Awaited<ReturnType<typeof orderStats>>, now: number): string[] {
  const f: string[] = []
  f.push(`Status: ${STATE_LABEL_ID[o.state as JobState]} (${o.state}). Langkah berikutnya menurut alur kerja: ${nextAction(o.state).label}.`)
  f.push(`Layanan: ${SERVICE_LABEL[o.service_code] ?? o.service_code}. Prioritas: ${o.priority}. Pemilik: ${o.owner_name ?? 'belum ditugaskan'}.`)
  f.push(`Masuk ${fmtDateTime(o.created_at)}; terakhir diperbarui ${relTime(o.updated_at, now)}.`)
  f.push(
    s.pv.n === 0
      ? 'Prompt: belum ada versi di Prompt Studio.'
      : `Prompt: ${s.pv.n} versi, terbaru v${s.pv.latest}${s.pv.ready ? `, v${s.pv.ready} ditandai siap dieksekusi` : ', belum ada yang ditandai siap'}.`
  )
  f.push(
    s.runs.n === 0
      ? 'Produksi: belum ada proses produksi tercatat.'
      : `Produksi: ${s.runs.n} proses tercatat; terakhir ${RUN_LABEL[s.runs.last_status ?? ''] ?? s.runs.last_status} (${relTime(s.runs.last_at, now)}).`
  )
  if (s.review) f.push(`Tinjauan QC terakhir: ${s.review.decision === 'APPROVE' ? 'disetujui' : 'minta revisi'} (${relTime(s.review.created_at, now)}).`)
  if ((s.revs.total ?? 0) > 0) f.push(`Revisi: ${s.revs.total} tercatat, ${s.revs.open ?? 0} masih terbuka. Putaran revisi pelanggan: ${o.revision_round}.`)
  f.push(s.delivery.n > 0 ? `Pengiriman: tercatat terkirim ${fmtDateTime(s.delivery.last)}.` : 'Pengiriman: belum ada pengiriman tercatat.')
  if (o.state === 'NEEDS_INFO' && o.customer_message) f.push(`Pesan klarifikasi ke pelanggan: “${String(o.customer_message).slice(0, 200)}”`)
  return f
}

const studioBrief = (o: Order) => ({
  public_ref: o.public_ref,
  service_code: o.service_code,
  objective: o.objective,
  audience: o.audience,
  product_facts: o.product_facts,
  platforms: JSON.parse(o.platforms),
  language: o.language,
  tone: o.tone,
  cta: o.cta,
  constraints: o.constraints,
  references: JSON.parse(o.references_json),
  rights_confirmed: o.rights_confirmed === 1
})

// ---------------------------------------------------------------------------
// Ask: plan → run tool → store question + answer (+ proposed action)
// ---------------------------------------------------------------------------
export async function ask(env: Bindings, op: OperatorCtx, input: Record<string, unknown>, cid: string) {
  const question = cleanText(input.q).slice(0, MAX_QUESTION)
  if (question.length < 2) throw new AppError(422, 'validation_failed', 'Pertanyaan kosong', [{ field: 'q', issue: 'is required' }])
  await rateLimit(env.DB, `assistant:${op.id}`, 40, 600)
  const contextId = typeof input.job_id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(input.job_id) ? input.job_id : null
  const context = contextId ? await env.DB.prepare('SELECT j.id, o.public_ref FROM jobs j JOIN orders o ON o.id = j.order_id WHERE j.id = ?').bind(contextId).first<{ id: string; public_ref: string }>() : null
  const useAi = input.use_ai === '1' || input.use_ai === true
  const settings = await studio.getLlmSettings(env)
  const pstatus = studio.providerStatus(env, settings)
  const aiAvailable = pstatus.active !== 'template'

  let plan = planByRules(question, !!context)
  let routerError: string | undefined
  if (!plan && aiAvailable && useAi) {
    try {
      await rateLimit(env.DB, `ai:${op.id}`, 20, 600)
      const r = await runLlm(env, settings, pstatus.active as 'workers_ai' | 'groq', plannerMessages(question, TOOL_SPEC), {
        jobId: context?.id ?? null,
        operation: 'assistant',
        actorId: op.id,
        maxTokens: 300
      })
      plan = parsePlannerOutput(r.text)
    } catch (e) {
      if (e instanceof LlmError) routerError = e.code
      else if (e instanceof AppError && e.code === 'rate_limited') routerError = 'ai_rate_limited'
      else throw e
    }
  }
  if (!plan)
    plan = {
      tool: 'clarify',
      via: 'rules',
      question: routerError
        ? `Provider AI tidak tersedia (${routerError}), dan aturan bawaan belum mengenali pertanyaan ini. Coba: “Cari order video yang belum selesai”, “Ringkas progres order ini”, atau sebutkan referensi EMB-….`
        : 'Saya belum yakin maksudnya. Coba: “Cari order video yang belum selesai”, “Tampilkan order yang menunggu revisi”, “Order mana yang membutuhkan tindakanku?”, atau “Ringkas progres EMB-…”.'
    }

  let text = ''
  let data: AnswerData = { tool: 'clarify', planner: plan.via, sources: [] }
  let proposal: { kind: ActionKind; jobId: string; payload: Record<string, unknown>; label: string } | null = null

  if (plan.tool === 'clarify') {
    text = plan.question
    data = { tool: 'clarify', planner: plan.via, clarify: plan.question, sources: [] }
  } else if (plan.tool === 'search_orders') {
    const r = await toolSearch(env, op, plan.filter)
    text = r.text
    data = { tool: 'search_orders', planner: plan.via, args: { ...plan.filter }, sources: [], ...r.data }
  } else {
    let target: { id: string; public_ref: string } | null = null
    if (plan.ref) target = await findJobId(env.DB, plan.ref)
    else if (plan.useContext && context) target = context
    if (!target) {
      text = plan.ref ? `Order ${plan.ref} tidak ditemukan di database.` : 'Order mana yang dimaksud? Buka halaman order, atau sebutkan referensinya (EMB-XXXXX-XXXXX).'
      data = { tool: 'clarify', planner: plan.via, clarify: text, sources: [] }
    } else {
      const o = (await loadOrder(env.DB, target.id))!
      const now = Date.now()
      const src = (fields: string[]): Source[] => [{ ref: o.public_ref, jobId: o.id, fields }]
      data = { tool: plan.tool, planner: plan.via, args: { ref: o.public_ref }, sources: [] }

      if (plan.tool === 'get_order_details') {
        const b = studioBrief(o)
        text = `Detail ${o.public_ref}: ${SERVICE_LABEL[o.service_code] ?? o.service_code} untuk ${o.customer_name}, status ${STATE_LABEL_ID[o.state as JobState]}.`
        data.facts = [
          `Pelanggan: ${o.customer_name}${canWrite(op) ? ` (ref ${o.customer_ref})` : ''}.`,
          `Status: ${STATE_LABEL_ID[o.state as JobState]} · prioritas ${o.priority} · pemilik ${o.owner_name ?? 'belum ditugaskan'}.`,
          `Tujuan: ${b.objective}`,
          `Audiens: ${b.audience}`,
          `Fakta produk: ${b.product_facts}`,
          `Platform: ${b.platforms.join(', ')} · bahasa ${b.language}${b.tone ? ` · nada ${b.tone}` : ''}${b.cta ? ` · CTA ${b.cta}` : ''}`,
          `Batasan: ${b.constraints || '—'}`,
          `Hak materi: ${b.rights_confirmed ? 'dikonfirmasi pelanggan' : 'BELUM dikonfirmasi'} · referensi: ${b.references.length}`
        ]
        data.sources = src(['state', 'priority', 'owner', 'customer_name', 'brief'])
        if (plan.action === 'assign_to_me') {
          if (!canWrite(op)) data.notes = ['Peran Anda hanya baca, jadi penugasan tidak bisa diusulkan.']
          else if (o.assigned_operator_id === op.id) data.notes = ['Order ini sudah ditugaskan ke Anda.']
          else if (o.state === 'DELIVERED' || o.state === 'CANCELLED') data.notes = ['Order sudah ditutup, penugasan tidak bisa diubah.']
          else proposal = { kind: 'assign_to_me', jobId: o.id, payload: { previous_owner: o.assigned_operator_id }, label: `Tugaskan ${o.public_ref} ke saya` }
        }
      } else if (plan.tool === 'summarize_order') {
        const stats = await orderStats(env.DB, o.id)
        const facts = orderFacts(o, stats, now)
        text = `Ringkasan ${o.public_ref}: ${STATE_LABEL_ID[o.state as JobState]}, langkah berikutnya “${nextAction(o.state).label}”.`
        data.facts = facts
        data.sources = src(['state', 'priority', 'owner', 'updated_at', 'prompt_versions', 'production_runs', 'reviews', 'revisions', 'deliveries'])
        const notes: string[] = []
        if (!stats.lastHist) notes.push('Belum ada riwayat perubahan status yang tercatat.')
        if (useAi && aiAvailable) {
          try {
            await rateLimit(env.DB, `ai:${op.id}`, 20, 600)
            const block = [...facts, `Tujuan brief (tersanitasi): ${sanitizeForPrompt(o.objective).slice(0, 400)}`].join('\n')
            const r = await runLlm(env, settings, pstatus.active as 'workers_ai' | 'groq', summaryMessages(block), { jobId: o.id, operation: 'assistant', actorId: op.id, maxTokens: 400, minChars: 20 })
            data.suggestion = { text: r.text.slice(0, 1500), provider: r.provider, model: r.model }
          } catch (e) {
            if (e instanceof LlmError) data.aiError = e.code
            else if (e instanceof AppError && e.code === 'rate_limited') data.aiError = 'ai_rate_limited'
            else throw e
          }
        } else if (useAi && !aiAvailable) notes.push('Provider AI tidak aktif; hanya fakta tercatat yang ditampilkan.')
        if (notes.length) data.notes = notes
      } else if (plan.tool === 'identify_missing_brief_fields') {
        const b = studioBrief(o)
        const st = await studio.loadStudio(env, o.id)
        const gaps = analyzeBriefRules(b, st.workType.id)
        const conflicts = detectConflicts(b)
        text =
          gaps.length + conflicts.length === 0
            ? `Aturan tidak menemukan informasi yang kurang atau bertentangan pada brief ${o.public_ref}.`
            : `${o.public_ref}: ${gaps.filter((g) => g.severity === 'essential').length} kekurangan wajib, ${gaps.filter((g) => g.severity !== 'essential').length} disarankan, ${conflicts.length} potensi konflik.`
        data.list = [
          ...gaps.map((g) => ({ label: `${g.severity === 'essential' ? 'Wajib' : 'Disarankan'} · ${g.label}`, meta: g.question })),
          ...conflicts.map((c) => ({ label: `Konflik · ${c.label}`, meta: c.detail }))
        ]
        data.notes = ['Deteksi berbasis aturan (tanpa AI). Konfirmasi ke pelanggan sebelum berasumsi.']
        data.sources = src(['brief', 'service'])
      } else if (plan.tool === 'draft_production_prompt') {
        const st = await studio.loadStudio(env, o.id)
        const preview = buildTemplatePrompt(st.brief, st.workType, st.gaps)
        data.promptPreview = preview.slice(0, 6000)
        data.sources = src(['brief', 'service', 'revisions', 'prompt_versions'])
        const notes: string[] = [`Pratinjau dari template ${st.workType.id}@${st.workType.version} memakai brief asli order ini. Belum disimpan dan belum dieksekusi di mana pun.`]
        if (st.ready) notes.push(`Sudah ada versi v${st.ready.version} yang ditandai siap; draf baru tidak menggantikannya sampai ditandai siap.`)
        if (st.gaps.some((g) => g.severity === 'essential')) notes.push('Ada informasi wajib yang kurang; prompt memuat penanda [BELUM DIKETAHUI …].')
        text = `Draf prompt untuk ${o.public_ref} (${STATE_LABEL_ID[o.state as JobState]}) siap ditinjau.`
        if (!st.editable) {
          notes.push(`Prompt terkunci karena status order ${STATE_LABEL_ID[o.state as JobState]}; tidak ada draf yang bisa disimpan.`)
        } else if (!canWrite(op)) notes.push('Peran Anda hanya baca, jadi draf tidak bisa disimpan.')
        else proposal = { kind: 'create_prompt_draft', jobId: o.id, payload: { template: `${st.workType.id}@${st.workType.version}` }, label: `Simpan sebagai draf prompt baru untuk ${o.public_ref}` }
        data.notes = notes
      } else if (plan.tool === 'get_prompt_versions') {
        const versions = await env.DB.prepare(
          `SELECT pv.id, pv.version, pv.source, pv.status, pv.provider, pv.model, pv.created_at, LENGTH(pv.body) AS chars, op.display_name AS by_name
           FROM prompt_versions pv LEFT JOIN operators op ON op.id = pv.created_by WHERE pv.job_id = ? ORDER BY pv.version DESC LIMIT 20`
        )
          .bind(o.id)
          .all<any>()
        const v = versions.results
        const STATUS: Record<string, string> = { DRAFT: 'Draf', READY: 'Siap dieksekusi', SUPERSEDED: 'Digantikan' }
        const SRC: Record<string, string> = { TEMPLATE: 'template', AI: 'AI', MANUAL: 'suntingan' }
        data.list = v.map((x) => ({
          label: `v${x.version} · ${STATUS[x.status] ?? x.status}`,
          meta: `${SRC[x.source] ?? x.source}${x.provider ? ` (${x.provider} ${x.model ?? ''})` : ''} · ${x.chars} karakter · ${x.by_name ?? '—'} · ${relTime(x.created_at, now)}`,
          href: `/console/jobs/${o.id}/studio?v=${x.version}`
        }))
        text = v.length ? `${o.public_ref} punya ${v.length} versi prompt.` : `${o.public_ref} belum punya versi prompt.`
        data.sources = src(['prompt_versions'])
        if (plan.action === 'mark_prompt_ready') {
          const latest = v[0]
          const st = await studio.loadStudio(env, o.id)
          if (!latest) data.notes = ['Belum ada versi untuk ditandai siap.']
          else if (!canWrite(op)) data.notes = ['Peran Anda hanya baca.']
          else if (!st.editable) data.notes = [`Prompt terkunci pada status ${STATE_LABEL_ID[o.state as JobState]}.`]
          else if (latest.status === 'READY') data.notes = [`v${latest.version} sudah ditandai siap.`]
          else proposal = { kind: 'mark_prompt_ready', jobId: o.id, payload: { version_id: latest.id, version: latest.version }, label: `Tandai v${latest.version} siap dieksekusi (${o.public_ref})` }
        }
      } else if (plan.tool === 'get_order_activity') {
        const [hist, events] = await Promise.all([
          env.DB.prepare(
            `SELECT h.from_state, h.to_state, h.reason, h.created_at, h.actor_type, op.display_name AS actor_name FROM job_state_history h
             LEFT JOIN operators op ON op.id = h.actor_id WHERE h.job_id = ? ORDER BY h.created_at DESC, h.rowid DESC LIMIT 10`
          )
            .bind(o.id)
            .all<any>(),
          env.DB.prepare(
            `SELECT a.action, a.created_at, op.display_name AS actor_name FROM audit_events a LEFT JOIN operators op ON op.id = a.actor_id
             WHERE a.resource_type = 'job' AND a.resource_id = ? AND a.action NOT LIKE 'job.transition.%' ORDER BY a.created_at DESC, a.rowid DESC LIMIT 10`
          )
            .bind(o.id)
            .all<any>()
        ])
        const items = [
          ...hist.results.map((h) => ({
            at: h.created_at as string,
            label: `${h.from_state ? STATE_LABEL_ID[h.from_state as JobState] : 'Baru'} → ${STATE_LABEL_ID[h.to_state as JobState]}`,
            meta: `${h.actor_name ?? (h.actor_type === 'CONNECTOR' ? 'Public Embrilo' : h.actor_type)}${h.reason ? ` · ${String(h.reason).slice(0, 120)}` : ''}`
          })),
          ...events.results.map((e) => ({ at: e.created_at as string, label: e.action as string, meta: e.actor_name ?? '—' }))
        ]
          .sort((a, b) => (a.at < b.at ? 1 : -1))
          .slice(0, 15)
        data.list = items.map((i) => ({ label: i.label, meta: `${i.meta} · ${fmtDateTime(i.at)}` }))
        text = items.length ? `${items.length} aktivitas terbaru untuk ${o.public_ref}.` : `Belum ada aktivitas tercatat untuk ${o.public_ref}.`
        data.sources = src(['history', 'audit'])
      }
    }
  }

  // Persist question, answer and (optionally) the proposed action atomically.
  const qId = uuid()
  const aId = uuid()
  const t0 = nowIso()
  const t1 = new Date(Date.parse(t0) + 1).toISOString()
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(`INSERT INTO assistant_messages (id, operator_id, job_id, role, body, data_json, provider, created_at) VALUES (?, ?, ?, 'OPERATOR', ?, '{}', NULL, ?)`).bind(qId, op.id, context?.id ?? null, question, t0)
  ]
  if (proposal) {
    const actionId = uuid()
    data.actionId = actionId
    stmts.push(
      env.DB.prepare(
        `INSERT INTO assistant_actions (id, operator_id, job_id, kind, payload_json, status, message_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, 'PROPOSED', ?, ?, ?)`
      ).bind(actionId, op.id, proposal.jobId, proposal.kind, JSON.stringify({ ...proposal.payload, label: proposal.label }), aId, t1, new Date(Date.now() + ACTION_TTL_MS).toISOString()),
      auditStmt(env.DB, actor(op), 'assistant.action_proposed', 'job', proposal.jobId, cid, { action_id: actionId, kind: proposal.kind })
    )
  }
  stmts.splice(
    1,
    0,
    env.DB.prepare(`INSERT INTO assistant_messages (id, operator_id, job_id, role, body, data_json, provider, created_at) VALUES (?, ?, ?, 'ASSISTANT', ?, ?, ?, ?)`).bind(
      aId,
      op.id,
      context?.id ?? null,
      text.slice(0, 2000),
      JSON.stringify(data).slice(0, 60_000),
      data.suggestion?.provider ?? (plan.via === 'ai' ? pstatus.active : null),
      t1
    )
  )
  stmts.push(auditStmt(env.DB, actor(op), 'assistant.asked', context ? 'job' : 'assistant', context?.id ?? op.id, cid, { tool: data.tool, planner: data.planner, results: data.total ?? null }))
  await env.DB.batch(stmts)
  return { messageId: aId, data }
}

// ---------------------------------------------------------------------------
// Confirmation-gated actions
// ---------------------------------------------------------------------------
export type ActionRow = { id: string; job_id: string; kind: ActionKind; payload_json: string; status: string; result_note: string | null; expires_at: string; message_id: string | null }

export async function decideAction(env: Bindings, op: OperatorCtx, actionId: string, decision: 'confirm' | 'cancel', cid: string) {
  const a = await env.DB.prepare('SELECT * FROM assistant_actions WHERE id = ? AND operator_id = ?').bind(actionId, op.id).first<ActionRow>()
  if (!a) throw new AppError(404, 'not_found', 'Usulan tindakan tidak ditemukan')
  if (a.status !== 'PROPOSED') throw new AppError(409, 'action_decided', 'Usulan ini sudah diputuskan sebelumnya')
  const decidedAt = nowIso()
  if (decision === 'cancel') {
    await env.DB.batch([
      env.DB.prepare(`UPDATE assistant_actions SET status = 'CANCELLED', decided_at = ? WHERE id = ? AND status = 'PROPOSED'`).bind(decidedAt, a.id),
      auditStmt(env.DB, actor(op), 'assistant.action_cancelled', 'job', a.job_id, cid, { action_id: a.id, kind: a.kind })
    ])
    return { status: 'CANCELLED' as const, note: 'Usulan dibatalkan. Tidak ada yang diubah.' }
  }
  if (!canWrite(op)) throw new AppError(403, 'forbidden', 'Peran Anda hanya baca')
  if (Date.parse(a.expires_at) < Date.now()) {
    await env.DB.prepare(`UPDATE assistant_actions SET status = 'FAILED', result_note = ?, decided_at = ? WHERE id = ? AND status = 'PROPOSED'`).bind('Kedaluwarsa', decidedAt, a.id).run()
    throw new AppError(409, 'action_expired', 'Usulan kedaluwarsa (lebih dari 15 menit). Tanyakan lagi ke asisten.')
  }
  // Claim atomically so a double click cannot execute twice.
  const claim = await env.DB.prepare(`UPDATE assistant_actions SET status = 'CONFIRMED', decided_at = ? WHERE id = ? AND status = 'PROPOSED'`).bind(decidedAt, a.id).run()
  if (!claim.meta.changes) throw new AppError(409, 'action_decided', 'Usulan ini sudah diputuskan sebelumnya')
  const payload = JSON.parse(a.payload_json) as Record<string, any>
  try {
    let note = ''
    if (a.kind === 'create_prompt_draft') {
      const v = await studio.createDraft(env, op, a.job_id, { mode: 'template' }, cid)
      note = `Draf prompt v${v.version} disimpan dari template. Belum dieksekusi — tinjau di Prompt Studio.`
    } else if (a.kind === 'mark_prompt_ready') {
      const st = await studio.loadStudio(env, a.job_id)
      if (!st.latest || st.latest.id !== payload.version_id)
        throw new AppError(409, 'concurrent_modification', 'Versi prompt sudah berubah sejak usulan dibuat. Tanyakan lagi ke asisten.')
      await studio.editorAction(env, op, a.job_id, { action: 'ready', body: st.latest.body }, cid)
      note = `v${payload.version} ditandai siap dieksekusi. Belum dieksekusi — jalankan manual lalu catat di halaman order.`
    } else if (a.kind === 'assign_to_me') {
      const job = await env.DB.prepare('SELECT assigned_operator_id FROM jobs WHERE id = ?').bind(a.job_id).first<{ assigned_operator_id: string | null }>()
      if ((job?.assigned_operator_id ?? null) !== (payload.previous_owner ?? null))
        throw new AppError(409, 'concurrent_modification', 'Penugasan order sudah berubah sejak usulan dibuat. Tanyakan lagi ke asisten.')
      await jobs.assign(env.DB, op, a.job_id, { assignee_id: op.id }, cid)
      note = 'Order ditugaskan ke Anda.'
    }
    await env.DB.batch([
      env.DB.prepare('UPDATE assistant_actions SET result_note = ? WHERE id = ?').bind(note, a.id),
      auditStmt(env.DB, actor(op), 'assistant.action_confirmed', 'job', a.job_id, cid, { action_id: a.id, kind: a.kind })
    ])
    return { status: 'CONFIRMED' as const, note }
  } catch (e) {
    const code = e instanceof AppError ? e.code : 'internal_error'
    const msg = e instanceof AppError ? e.message : 'Kesalahan tak terduga'
    await env.DB.batch([
      env.DB.prepare(`UPDATE assistant_actions SET status = 'FAILED', result_note = ? WHERE id = ?`).bind(`Gagal: ${msg}`.slice(0, 300), a.id),
      auditStmt(env.DB, actor(op), 'assistant.action_failed', 'job', a.job_id, cid, { action_id: a.id, kind: a.kind, error_code: code })
    ])
    if (e instanceof AppError) throw e
    throw e
  }
}

// ---------------------------------------------------------------------------
// Thread (per operator, per context). Operators only ever see their own messages.
// ---------------------------------------------------------------------------
export type ThreadMessage = { id: string; role: 'OPERATOR' | 'ASSISTANT'; body: string; data: AnswerData | null; provider: string | null; created_at: string; action: ActionRow | null }

export async function loadThread(db: D1Database, op: OperatorCtx, jobId: string | null, limit = 20): Promise<ThreadMessage[]> {
  const rows = await db
    .prepare(
      `SELECT id, role, body, data_json, provider, created_at FROM assistant_messages WHERE operator_id = ? AND ${jobId ? 'job_id = ?' : 'job_id IS NULL'}
       ORDER BY created_at DESC, rowid DESC LIMIT ?`
    )
    .bind(...(jobId ? [op.id, jobId, limit] : [op.id, limit]))
    .all<{ id: string; role: 'OPERATOR' | 'ASSISTANT'; body: string; data_json: string; provider: string | null; created_at: string }>()
  const ids = rows.results.filter((r) => r.role === 'ASSISTANT').map((r) => r.id)
  const actions = ids.length
    ? (await db.prepare(`SELECT * FROM assistant_actions WHERE operator_id = ? AND message_id IN (${ids.map(() => '?').join(',')})`).bind(op.id, ...ids).all<ActionRow>()).results
    : []
  return rows.results.reverse().map((r) => {
    let data: AnswerData | null = null
    try {
      data = r.role === 'ASSISTANT' ? (JSON.parse(r.data_json) as AnswerData) : null
    } catch {
      data = null
    }
    return { id: r.id, role: r.role, body: r.body, data, provider: r.provider, created_at: r.created_at, action: actions.find((a) => a.message_id === r.id) ?? null }
  })
}

export async function clearThread(db: D1Database, op: OperatorCtx, jobId: string | null, cid: string) {
  await db.batch([
    db.prepare(`DELETE FROM assistant_messages WHERE operator_id = ? AND ${jobId ? 'job_id = ?' : 'job_id IS NULL'}`).bind(...(jobId ? [op.id, jobId] : [op.id])),
    db.prepare(`UPDATE assistant_actions SET status = 'CANCELLED', decided_at = ? WHERE operator_id = ? AND status = 'PROPOSED' AND ${jobId ? 'job_id = ?' : '1=1'}`).bind(
      ...(jobId ? [nowIso(), op.id, jobId] : [nowIso(), op.id])
    ),
    auditStmt(db, actor(op), 'assistant.cleared', jobId ? 'job' : 'assistant', jobId ?? op.id, cid, {})
  ])
}
