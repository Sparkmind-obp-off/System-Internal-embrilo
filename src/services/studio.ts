// Prompt Studio: order → normalized brief → gaps → versioned production prompt.
// A prompt being generated, copied or marked READY never changes the job's workflow state
// and never counts as "executed" or "delivered".
import { AppError, forbidden, notFound } from '../lib/errors'
import { getJob, nowIso, type JobRow } from '../lib/db'
import { auditStmt } from '../lib/audit'
import { uuid } from '../lib/crypto'
import { rateLimit } from '../lib/ratelimit'
import { V, cleanText } from '../lib/validate'
import {
  WORK_TYPES,
  analyzeBriefRules,
  appendInstruction,
  buildTemplatePrompt,
  clarificationText,
  defaultWorkType,
  getWorkType,
  templateId,
  type Gap,
  type StudioBrief,
  type WorkType,
  type WorkTypeId
} from '../lib/templates'
import {
  DEFAULT_GROQ_MODEL,
  DEFAULT_WORKERS_AI_MODEL,
  LlmError,
  WORKERS_AI_MODELS,
  analyzeMessages,
  generateMessages,
  providerConfigured,
  refineMessages,
  runLlm,
  type LlmSettings,
  type ProviderChoice,
  type ProviderId
} from '../lib/llm'
import type { Actor, Bindings, OperatorCtx } from '../types'
import type { JobState } from '../lib/state'

const opActor = (op: OperatorCtx): Actor => ({ type: 'OPERATOR', id: op.id })
export const MAX_PROMPT_CHARS = 30_000
export const STUDIO_LOCKED: JobState[] = ['IN_PRODUCTION', 'QC_REVIEW', 'APPROVED', 'DELIVERED', 'CANCELLED']

// ---------------------------------------------------------------------------
// Settings (stored in D1 app_settings; secrets are NEVER stored here)
// ---------------------------------------------------------------------------
const DEFAULTS = (env: Bindings): LlmSettings => ({
  // Workers AI runs on the same Cloudflare account that already hosts the app, so it is the
  // default only when its binding exists. Groq (a different vendor) is never auto-selected.
  provider: providerConfigured(env, 'workers_ai') ? 'workers_ai' : 'template',
  workers_ai_model: DEFAULT_WORKERS_AI_MODEL,
  groq_model: DEFAULT_GROQ_MODEL,
  max_output_tokens: 1800,
  daily_neuron_cap: 8000, // below the 10,000 Neurons/day free allocation
  daily_groq_calls: 50
})

async function readSetting<T>(db: D1Database, key: string): Promise<T | null> {
  const r = await db.prepare('SELECT value FROM app_settings WHERE key = ?').bind(key).first<{ value: string }>()
  if (!r) return null
  try {
    return JSON.parse(r.value) as T
  } catch {
    return null
  }
}

export async function getLlmSettings(env: Bindings): Promise<LlmSettings & { stored: boolean }> {
  const stored = await readSetting<Partial<LlmSettings>>(env.DB, 'llm')
  const d = DEFAULTS(env)
  return { ...d, ...(stored ?? {}), stored: !!stored }
}

export type ProviderStatus = {
  selected: ProviderChoice
  active: ProviderChoice
  configured: Record<ProviderId, boolean>
  model: string | null
  note: string | null
}

export function providerStatus(env: Bindings, s: LlmSettings): ProviderStatus {
  const configured = { workers_ai: providerConfigured(env, 'workers_ai'), groq: providerConfigured(env, 'groq') }
  if (s.provider === 'template') return { selected: 'template', active: 'template', configured, model: null, note: null }
  if (!configured[s.provider])
    return {
      selected: s.provider,
      active: 'template',
      configured,
      model: null,
      note:
        s.provider === 'workers_ai'
          ? 'Workers AI dipilih, tetapi binding AI belum tersedia di deployment ini. Mode template dipakai.'
          : 'Groq dipilih, tetapi secret GROQ_API_KEY belum diset. Mode template dipakai.'
    }
  return { selected: s.provider, active: s.provider, configured, model: s.provider === 'workers_ai' ? s.workers_ai_model : s.groq_model, note: null }
}

export async function saveLlmSettings(env: Bindings, op: OperatorCtx, input: Record<string, unknown>, cid: string) {
  if (op.role !== 'ADMIN') throw forbidden('Hanya admin yang dapat mengubah pengaturan')
  const v = new V()
  const provider = v.enumOf(input.provider, 'provider', ['template', 'workers_ai', 'groq'] as const)
  const wModel = v.enumOf(input.workers_ai_model, 'workers_ai_model', WORKERS_AI_MODELS.map((m) => m.id) as unknown as readonly string[])
  const gModel = v.str(input.groq_model, 'groq_model', 3, 80, { pattern: /^[A-Za-z0-9._\/:-]+$/ })
  const maxOut = v.int(input.max_output_tokens, 'max_output_tokens', 200, 4000)
  const neuronCap = v.int(input.daily_neuron_cap, 'daily_neuron_cap', 0, 1_000_000)
  const groqCalls = v.int(input.daily_groq_calls, 'daily_groq_calls', 0, 10_000)
  v.throwIfAny()
  const value: LlmSettings = {
    provider,
    workers_ai_model: wModel,
    groq_model: gModel,
    max_output_tokens: maxOut!,
    daily_neuron_cap: neuronCap!,
    daily_groq_calls: groqCalls!
  }
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ('llm', ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
    ).bind(JSON.stringify(value), op.id, nowIso()),
    auditStmt(env.DB, opActor(op), 'settings.llm_updated', 'settings', 'llm', cid, { provider, workers_ai_model: wModel, groq_model: gModel })
  ])
}

export async function getEnabledWorkTypes(db: D1Database): Promise<WorkTypeId[]> {
  const stored = await readSetting<string[]>(db, 'work_types')
  const valid = (stored ?? []).filter((id): id is WorkTypeId => !!getWorkType(id))
  return stored ? valid : WORK_TYPES.filter((w) => w.enabledByDefault).map((w) => w.id)
}

export async function saveWorkTypes(db: D1Database, op: OperatorCtx, input: Record<string, unknown>, cid: string) {
  if (op.role !== 'ADMIN') throw forbidden('Hanya admin yang dapat mengubah pengaturan')
  const raw = Array.isArray(input.work_types) ? input.work_types : input.work_types ? [input.work_types] : []
  const ids = [...new Set(raw.map(String))].filter((id) => !!getWorkType(id))
  if (!ids.includes('general')) ids.push('general') // the catch-all type is always available
  await db.batch([
    db.prepare(
      `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES ('work_types', ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
    ).bind(JSON.stringify(ids), op.id, nowIso()),
    auditStmt(db, opActor(op), 'settings.work_types_updated', 'settings', 'work_types', cid, { count: ids.length })
  ])
}

export async function healthCheck(env: Bindings, op: OperatorCtx, input: Record<string, unknown>, cid: string) {
  if (op.role !== 'ADMIN') throw forbidden('Hanya admin yang dapat menguji provider')
  const v = new V()
  const provider = v.enumOf(input.provider, 'provider', ['workers_ai', 'groq'] as const)
  v.throwIfAny()
  await rateLimit(env.DB, `ai-health:${op.id}`, 5, 600)
  const s = await getLlmSettings(env)
  try {
    const r = await runLlm(env, s, provider, [{ role: 'user', content: 'Balas hanya dengan satu kata: OK' }], {
      jobId: null,
      operation: 'health',
      actorId: op.id,
      maxTokens: 12
    })
    await env.DB.batch([auditStmt(env.DB, opActor(op), 'ai.health_ok', 'settings', provider, cid, { model: r.model, ms: r.ms })])
    return { ok: true, model: r.model, ms: r.ms }
  } catch (e) {
    if (e instanceof LlmError) {
      await env.DB.batch([auditStmt(env.DB, opActor(op), 'ai.health_failed', 'settings', provider, cid, { error_code: e.code })])
      throw llmToAppError(e)
    }
    throw e
  }
}

export function llmToAppError(e: LlmError): AppError {
  const status = e.code === 'ai_not_configured' ? 503 : e.code === 'ai_rate_limited' || e.code === 'ai_daily_cap' ? 429 : 503
  return new AppError(status as 429 | 503, e.code, e.message)
}

// ---------------------------------------------------------------------------
// Studio state
// ---------------------------------------------------------------------------
export type PromptVersionRow = {
  id: string
  version: number
  work_type: string
  template_id: string
  source: 'TEMPLATE' | 'AI' | 'MANUAL'
  provider: string | null
  model: string | null
  body: string
  status: 'DRAFT' | 'READY' | 'SUPERSEDED'
  note: string
  created_by_name: string | null
  created_at: string
}
export type StudioMessage = { id: string; role: 'OPERATOR' | 'ASSISTANT' | 'SYSTEM'; body: string; provider: string | null; created_by_name: string | null; created_at: string }

export type StudioState = {
  job: JobRow & { work_type: string | null; internal_notes: string }
  order: { public_ref: string; service_code: string; customer_name: string }
  brief: StudioBrief
  workType: WorkType
  enabledWorkTypes: WorkType[]
  gaps: Gap[]
  clarification: string
  versions: PromptVersionRow[]
  latest: PromptVersionRow | null
  ready: PromptVersionRow | null
  messages: StudioMessage[]
  editable: boolean
}

export async function loadStudio(env: Bindings, jobId: string): Promise<StudioState> {
  const db = env.DB
  const row = await db
    .prepare(
      `SELECT j.*, o.public_ref, o.service_code, cu.display_name AS customer_name,
              b.objective, b.audience, b.product_facts, b.platforms, b.language, b.tone, b.cta, b.constraints, b.references_json, b.rights_confirmed
       FROM jobs j JOIN orders o ON o.id = j.order_id JOIN customers cu ON cu.id = o.customer_id JOIN briefs b ON b.order_id = o.id
       WHERE j.id = ?`
    )
    .bind(jobId)
    .first<Record<string, any>>()
  if (!row) throw notFound()
  const [versions, messages, revisions, enabled] = await Promise.all([
    db
      .prepare(
        `SELECT pv.*, op.display_name AS created_by_name FROM prompt_versions pv LEFT JOIN operators op ON op.id = pv.created_by
         WHERE pv.job_id = ? ORDER BY pv.version DESC`
      )
      .bind(jobId)
      .all<PromptVersionRow>(),
    db
      .prepare(
        `SELECT sm.id, sm.role, sm.body, sm.provider, sm.created_at, op.display_name AS created_by_name FROM studio_messages sm
         LEFT JOIN operators op ON op.id = sm.created_by WHERE sm.job_id = ? ORDER BY sm.created_at DESC, sm.rowid DESC LIMIT 50`
      )
      .bind(jobId)
      .all<StudioMessage>(),
    db.prepare(`SELECT summary FROM revisions WHERE job_id = ? AND status = 'OPEN' ORDER BY round, created_at`).bind(jobId).all<{ summary: string }>(),
    getEnabledWorkTypes(db)
  ])
  const brief: StudioBrief = {
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
    rights_confirmed: row.rights_confirmed === 1,
    revision_notes: revisions.results.map((r) => r.summary)
  }
  const workType = getWorkType(row.work_type) ?? getWorkType(defaultWorkType(row.service_code))!
  const enabledWorkTypes = WORK_TYPES.filter((w) => enabled.includes(w.id) || w.id === workType.id)
  const gaps = analyzeBriefRules(brief, workType.id)
  const list = versions.results
  return {
    job: row as StudioState['job'],
    order: { public_ref: row.public_ref, service_code: row.service_code, customer_name: row.customer_name },
    brief,
    workType,
    enabledWorkTypes,
    gaps,
    clarification: clarificationText(gaps),
    versions: list,
    latest: list[0] ?? null,
    ready: list.find((v) => v.status === 'READY') ?? null,
    messages: messages.results.reverse(),
    editable: !STUDIO_LOCKED.includes(row.state)
  }
}

function assertEditable(st: StudioState) {
  if (!st.editable) throw new AppError(409, 'studio_locked', 'Prompt tidak bisa diubah pada status pekerjaan ini')
}

function msgStmt(db: D1Database, jobId: string, role: StudioMessage['role'], body: string, createdBy: string, extra: { versionId?: string; provider?: string | null } = {}) {
  return db
    .prepare(
      `INSERT INTO studio_messages (id, job_id, role, body, prompt_version_id, provider, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(uuid(), jobId, role, body.slice(0, 4000), extra.versionId ?? null, extra.provider ?? null, createdBy, nowIso())
}

type NewVersion = {
  body: string
  source: 'TEMPLATE' | 'AI' | 'MANUAL'
  provider?: string | null
  model?: string | null
  note?: string
  status?: 'DRAFT' | 'READY'
  baseVersionId?: string | null
}

/** Inserts the next prompt version (append-only). Retries once if two saves race for the same number. */
async function insertVersion(env: Bindings, op: OperatorCtx, st: StudioState, v: NewVersion, cid: string, extra: D1PreparedStatement[] = []) {
  const db = env.DB
  for (let attempt = 0; attempt < 2; attempt++) {
    const max = await db.prepare('SELECT COALESCE(MAX(version), 0) AS m FROM prompt_versions WHERE job_id = ?').bind(st.job.id).first<{ m: number }>()
    const version = (max?.m ?? 0) + 1
    const id = uuid()
    const stmts: D1PreparedStatement[] = []
    if (v.status === 'READY')
      stmts.push(db.prepare(`UPDATE prompt_versions SET status = 'SUPERSEDED' WHERE job_id = ? AND status = 'READY'`).bind(st.job.id))
    stmts.push(
      db
        .prepare(
          `INSERT INTO prompt_versions (id, job_id, version, work_type, template_id, source, provider, model, body, status, note, base_version_id, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(id, st.job.id, version, st.workType.id, templateId(st.workType), v.source, v.provider ?? null, v.model ?? null, v.body, v.status ?? 'DRAFT', (v.note ?? '').slice(0, 300), v.baseVersionId ?? null, op.id, nowIso()),
      auditStmt(db, opActor(op), v.status === 'READY' ? 'studio.marked_ready' : 'studio.version_saved', 'job', st.job.id, cid, {
        version,
        source: v.source,
        provider: v.provider ?? null,
        model: v.model ?? null,
        chars: v.body.length
      }),
      ...extra.map((s) => s)
    )
    try {
      await db.batch(stmts)
      return { id, version }
    } catch (e) {
      if (attempt === 0 && /UNIQUE/i.test(String((e as Error)?.message))) continue
      throw e
    }
  }
  throw new AppError(409, 'concurrent_modification', 'Versi prompt baru saja dibuat orang lain. Muat ulang halaman.')
}

async function resolveMode(env: Bindings, mode: unknown): Promise<{ mode: 'template' } | { mode: 'ai'; provider: ProviderId; settings: LlmSettings }> {
  if (mode !== 'ai') return { mode: 'template' }
  const s = await getLlmSettings(env)
  const st = providerStatus(env, s)
  if (st.active === 'template')
    throw new AppError(503, 'ai_not_configured', st.note ?? 'Provider AI belum dikonfigurasi. Gunakan mode template, atau minta admin mengatur provider di Pengaturan.')
  return { mode: 'ai', provider: st.active, settings: s }
}

const PROVIDER_LABEL: Record<string, string> = { workers_ai: 'Cloudflare Workers AI', groq: 'Groq' }

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
export async function createDraft(env: Bindings, op: OperatorCtx, jobId: string, input: Record<string, unknown>, cid: string) {
  const st = await loadStudio(env, jobId)
  assertEditable(st)
  const m = await resolveMode(env, input.mode)
  await rateLimit(env.DB, `${m.mode === 'ai' ? 'ai' : 'studio'}:${op.id}`, m.mode === 'ai' ? 20 : 60, 600)
  const templatePrompt = buildTemplatePrompt(st.brief, st.workType, st.gaps)
  if (m.mode === 'template') {
    const v = await insertVersion(env, op, st, { body: templatePrompt, source: 'TEMPLATE', note: 'Draf dari template' }, cid, [
      msgStmt(env.DB, jobId, 'SYSTEM', `Draf v{N} dibuat dari template ${templateId(st.workType)} (tanpa AI).`, op.id)
    ])
    await fixVersionPlaceholder(env.DB, jobId, v.version)
    return v
  }
  try {
    const r = await runLlm(env, m.settings, m.provider, generateMessages(templatePrompt), { jobId, operation: 'generate', actorId: op.id, minChars: 200 })
    const v = await insertVersion(
      env,
      op,
      st,
      { body: r.text, source: 'AI', provider: r.provider, model: r.model, note: `Draf AI (${PROVIDER_LABEL[r.provider]})` },
      cid,
      [msgStmt(env.DB, jobId, 'ASSISTANT', `Draf v{N} dibuat dengan ${PROVIDER_LABEL[r.provider]} (${r.model}) dalam ${(r.ms / 1000).toFixed(1)} dtk. Tinjau sebelum dipakai.`, op.id, { provider: r.provider })]
    )
    await fixVersionPlaceholder(env.DB, jobId, v.version)
    return v
  } catch (e) {
    if (e instanceof LlmError) throw llmToAppError(e)
    throw e
  }
}

/** Replaces the `{N}` placeholder in the newest message with the real version number. */
async function fixVersionPlaceholder(db: D1Database, jobId: string, version: number) {
  await db
    .prepare(
      `UPDATE studio_messages SET body = REPLACE(body, 'v{N}', ?) WHERE job_id = ? AND body LIKE '%v{N}%'`
    )
    .bind(`v${version}`, jobId)
    .run()
}

/**
 * One editor form, three submit buttons:
 *  - save   → stores the edited text as a new MANUAL version
 *  - refine → applies an instruction (AI if mode=ai, otherwise appended as an operator instruction)
 *  - ready  → stores the text (if changed) and marks it READY for manual execution
 */
export async function editorAction(env: Bindings, op: OperatorCtx, jobId: string, input: Record<string, unknown>, cid: string) {
  const v = new V()
  const action = v.enumOf(input.action, 'action', ['save', 'refine', 'ready'] as const)
  const body = v.str(input.body, 'body', 50, MAX_PROMPT_CHARS)
  const instruction = v.str(input.instruction, 'instruction', 0, 1000, { optional: true })
  if (action === 'refine' && !instruction) v.fail('instruction', 'is required')
  v.throwIfAny()
  const st = await loadStudio(env, jobId)
  assertEditable(st)
  const baseVersionId = typeof input.base_version_id === 'string' ? input.base_version_id : null
  const unchanged = st.latest && st.latest.body === body

  if (action === 'save') {
    if (unchanged) throw new AppError(409, 'no_changes', 'Tidak ada perubahan untuk disimpan')
    return insertVersion(env, op, st, { body, source: 'MANUAL', note: 'Disunting operator', baseVersionId }, cid, [
      msgStmt(env.DB, jobId, 'SYSTEM', 'Versi baru disimpan dari editor.', op.id)
    ])
  }

  if (action === 'ready') {
    if (unchanged && st.latest!.status === 'READY') throw new AppError(409, 'already_ready', 'Versi ini sudah ditandai siap dieksekusi')
    if (unchanged) {
      await env.DB.batch([
        env.DB.prepare(`UPDATE prompt_versions SET status = 'SUPERSEDED' WHERE job_id = ? AND status = 'READY'`).bind(jobId),
        env.DB.prepare(`UPDATE prompt_versions SET status = 'READY' WHERE id = ?`).bind(st.latest!.id),
        auditStmt(env.DB, opActor(op), 'studio.marked_ready', 'job', jobId, cid, { version: st.latest!.version }),
        msgStmt(env.DB, jobId, 'SYSTEM', `v${st.latest!.version} ditandai siap dieksekusi. Belum dieksekusi — jalankan manual lalu catat di halaman pekerjaan.`, op.id)
      ])
      return { id: st.latest!.id, version: st.latest!.version }
    }
    const r = await insertVersion(env, op, st, { body, source: 'MANUAL', status: 'READY', note: 'Disunting & ditandai siap', baseVersionId }, cid, [
      msgStmt(env.DB, jobId, 'SYSTEM', 'Versi terbaru ditandai siap dieksekusi. Belum dieksekusi — jalankan manual lalu catat di halaman pekerjaan.', op.id)
    ])
    return r
  }

  // refine
  const m = await resolveMode(env, input.mode)
  await rateLimit(env.DB, `${m.mode === 'ai' ? 'ai' : 'studio'}:${op.id}`, m.mode === 'ai' ? 20 : 60, 600)
  const opMsg = msgStmt(env.DB, jobId, 'OPERATOR', cleanText(instruction), op.id)
  if (m.mode === 'template') {
    const next = appendInstruction(body, instruction)
    return insertVersion(env, op, st, { body: next, source: 'MANUAL', note: 'Instruksi ditambahkan (tanpa AI)', baseVersionId }, cid, [
      opMsg,
      msgStmt(env.DB, jobId, 'SYSTEM', 'Instruksi ditambahkan ke bagian "Instruksi tambahan dari operator" (mode template, tanpa AI).', op.id)
    ])
  }
  try {
    const r = await runLlm(env, m.settings, m.provider, refineMessages(body, instruction), { jobId, operation: 'refine', actorId: op.id, minChars: 200 })
    const v2 = await insertVersion(
      env,
      op,
      st,
      { body: r.text, source: 'AI', provider: r.provider, model: r.model, note: `Diperbaiki AI: ${instruction.slice(0, 120)}`, baseVersionId },
      cid,
      [opMsg, msgStmt(env.DB, jobId, 'ASSISTANT', `Versi v{N} dibuat dengan ${PROVIDER_LABEL[r.provider]} (${r.model}). Bandingkan dengan versi sebelumnya sebelum dipakai.`, op.id, { provider: r.provider })]
    )
    await fixVersionPlaceholder(env.DB, jobId, v2.version)
    return v2
  } catch (e) {
    if (e instanceof LlmError) {
      // Keep the operator's instruction in the log so it is not lost; the editor text is re-rendered by the route.
      await env.DB.batch([opMsg, msgStmt(env.DB, jobId, 'SYSTEM', `Permintaan AI gagal (${e.code}). Draf Anda tidak berubah.`, op.id)])
      throw llmToAppError(e)
    }
    throw e
  }
}

export async function analyzeGaps(env: Bindings, op: OperatorCtx, jobId: string, input: Record<string, unknown>, cid: string) {
  const st = await loadStudio(env, jobId)
  const m = await resolveMode(env, input.mode)
  if (m.mode === 'template') {
    const text = st.gaps.length ? `Celah terdeteksi (aturan, tanpa AI):\n${st.gaps.map((g, i) => `${i + 1}. ${g.question}`).join('\n')}` : 'Tidak ada celah yang terdeteksi oleh aturan.'
    await env.DB.batch([msgStmt(env.DB, jobId, 'ASSISTANT', text, op.id), auditStmt(env.DB, opActor(op), 'studio.analyzed', 'job', jobId, cid, { mode: 'template', gaps: st.gaps.length })])
    return
  }
  await rateLimit(env.DB, `ai:${op.id}`, 20, 600)
  const basis = st.latest?.body ?? buildTemplatePrompt(st.brief, st.workType, st.gaps)
  try {
    const r = await runLlm(env, m.settings, m.provider, analyzeMessages(basis), { jobId, operation: 'analyze', actorId: op.id, maxTokens: 600 })
    await env.DB.batch([
      msgStmt(env.DB, jobId, 'ASSISTANT', `Pertanyaan klarifikasi (${PROVIDER_LABEL[r.provider]}):\n${r.text}`, op.id, { provider: r.provider }),
      auditStmt(env.DB, opActor(op), 'studio.analyzed', 'job', jobId, cid, { mode: 'ai', provider: r.provider, model: r.model })
    ])
  } catch (e) {
    if (e instanceof LlmError) throw llmToAppError(e)
    throw e
  }
}

export async function updateMeta(env: Bindings, op: OperatorCtx, jobId: string, input: Record<string, unknown>, cid: string) {
  const job = await getJob(env.DB, jobId)
  const v = new V()
  const workType = v.str(input.work_type, 'work_type', 1, 40)
  const notes = v.str(input.internal_notes, 'internal_notes', 0, 4000, { optional: true })
  v.throwIfAny()
  const enabled = await getEnabledWorkTypes(env.DB)
  const current = (job as JobRow & { work_type?: string | null }).work_type
  if (!getWorkType(workType) || (!enabled.includes(workType as WorkTypeId) && workType !== current))
    throw new AppError(422, 'validation_failed', 'Jenis pekerjaan tidak tersedia', [{ field: 'work_type', issue: 'must be one of: enabled work types' }])
  await env.DB.batch([
    env.DB.prepare('UPDATE jobs SET work_type = ?, internal_notes = ?, updated_at = ? WHERE id = ?').bind(workType, notes, nowIso(), jobId),
    auditStmt(env.DB, opActor(op), 'studio.meta_updated', 'job', jobId, cid, { work_type: workType, notes_chars: notes.length })
  ])
}

// ---------------------------------------------------------------------------
// Line diff (for "bandingkan versi"); small inputs only.
// ---------------------------------------------------------------------------
export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string }
export function lineDiff(a: string, b: string): DiffLine[] {
  const A = a.split('\n').slice(0, 600)
  const B = b.split('\n').slice(0, 600)
  const n = A.length
  const m = B.length
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push({ kind: 'same', text: A[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ kind: 'del', text: A[i++] })
    else out.push({ kind: 'add', text: B[j++] })
  }
  while (i < n) out.push({ kind: 'del', text: A[i++] })
  while (j < m) out.push({ kind: 'add', text: B[j++] })
  return out
}

/** READY prompt for a job, used by startProduction for provenance. */
export async function readyPrompt(db: D1Database, jobId: string) {
  return db
    .prepare(`SELECT id, version, body, template_id FROM prompt_versions WHERE job_id = ? AND status = 'READY' ORDER BY version DESC LIMIT 1`)
    .bind(jobId)
    .first<{ id: string; version: number; body: string; template_id: string }>()
}
