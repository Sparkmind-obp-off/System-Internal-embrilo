import { Hono, type Context } from 'hono'
import { requireOperator, requireRole, verifyCsrf } from '../lib/auth'
import { AppError } from '../lib/errors'
import { readInput } from '../lib/http'
import { audit } from '../lib/audit'
import { WORK_TYPES } from '../lib/templates'
import { GROQ_MODELS, WORKERS_AI_MODELS, usageToday } from '../lib/llm'
import * as studio from '../services/studio'
import { StudioPage, SettingsPage, type StudioForm } from '../views/studio'
import { ERROR_MESSAGES, fieldKey, translateIssue } from '../views/labels'
import type { AppEnv, OperatorCtx } from '../types'

export const studioApp = new Hono<AppEnv>()
studioApp.use('/console/*', requireOperator('html'))

const STUDIO_ERRORS: Record<string, string> = {
  ai_not_configured: 'Provider AI belum dikonfigurasi. Draf Anda aman — gunakan mode template, atau minta admin mengatur provider di Pengaturan.',
  ai_daily_cap: 'Batas pemakaian AI harian tercapai. Draf Anda aman — lanjutkan dengan mode template atau coba lagi besok.',
  ai_rate_limited: 'Provider AI sedang membatasi permintaan. Draf Anda aman — tunggu sebentar lalu coba lagi.',
  ai_auth: 'Provider AI menolak kredensial atau model ini. Draf Anda aman — admin perlu memeriksa Pengaturan.',
  ai_timeout: 'Provider AI tidak merespons tepat waktu. Draf Anda aman — coba lagi.',
  ai_provider_error: 'Provider AI mengalami kesalahan. Draf Anda aman — coba lagi atau gunakan mode template.',
  ai_bad_output: 'Keluaran AI kosong atau tidak valid, jadi tidak disimpan. Draf Anda aman — coba lagi.',
  studio_locked: 'Prompt tidak bisa diubah pada status pekerjaan ini (sedang produksi, QC, atau sudah selesai).',
  no_changes: 'Tidak ada perubahan untuk disimpan.',
  already_ready: 'Versi ini sudah ditandai siap dieksekusi.'
}
const errText = (e: AppError) => STUDIO_ERRORS[e.code] ?? ERROR_MESSAGES[e.code] ?? e.message

async function renderStudio(c: Context<AppEnv>, jobId: string, extra: { ok?: string; err?: string; form?: StudioForm; status?: number } = {}) {
  const op = c.get('operator') as OperatorCtx
  const st = await studio.loadStudio(c.env, jobId)
  const settings = await studio.getLlmSettings(c.env)
  const status = studio.providerStatus(c.env, settings)
  const vParam = Number(c.req.query('v'))
  const cmpParam = Number(c.req.query('compare'))
  const viewing = Number.isInteger(vParam) ? st.versions.find((x) => x.version === vParam) ?? null : null
  const compareWith = Number.isInteger(cmpParam) ? st.versions.find((x) => x.version === cmpParam) ?? null : null
  const diff = compareWith && st.latest && compareWith.id !== st.latest.id ? studio.lineDiff(compareWith.body, st.latest.body) : null
  return c.html(
    <StudioPage
      op={op}
      csrf={c.get('csrf') as string}
      ok={extra.ok ?? c.req.query('ok')?.slice(0, 200)}
      err={extra.err ?? c.req.query('err')?.slice(0, 300)}
      st={st}
      provider={status}
      viewing={viewing}
      compareWith={compareWith}
      diff={diff}
      form={extra.form}
      now={Date.now()}
    />,
    (extra.status ?? 200) as 200
  )
}

studioApp.get('/console/jobs/:id/studio', (c) => {
  requireRole(c.get('operator'), 'ADMIN', 'OPERATOR', 'VIEWER')
  return renderStudio(c, c.req.param('id'))
})

/**
 * Export one prompt version as a Markdown file. Read-only and audited; exporting is NOT execution.
 * Defaults to the READY version, else the latest.
 */
studioApp.get('/console/jobs/:id/studio/export', async (c) => {
  const op = requireRole(c.get('operator'), 'ADMIN', 'OPERATOR', 'VIEWER')
  const st = await studio.loadStudio(c.env, c.req.param('id'))
  const vParam = Number(c.req.query('v'))
  const v = Number.isInteger(vParam) ? st.versions.find((x) => x.version === vParam) : (st.ready ?? st.latest)
  if (!v) throw new AppError(404, 'not_found', 'Belum ada versi prompt')
  await audit(c.env.DB, { type: 'OPERATOR', id: op.id }, 'studio.exported', 'job', st.job.id, c.get('cid'), { version: v.version, status: v.status })
  const header = [
    `<!-- Embrilo OS · ${st.order.public_ref} · prompt v${v.version} (${v.status}) · ${v.template_id} · diekspor ${new Date().toISOString()} -->`,
    '<!-- Ekspor bukan eksekusi: jalankan manual, lalu catat hasilnya di halaman order. -->',
    ''
  ].join('\n')
  return new Response(header + v.body + '\n', {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="${st.order.public_ref}-prompt-v${v.version}.md"`,
      'cache-control': 'no-store'
    }
  })
})

type StudioAction = (c: Context<AppEnv>, op: OperatorCtx, id: string, input: Record<string, unknown>, cid: string) => Promise<unknown>
/** Studio form handler: success → redirect (PRG); recoverable failure → re-render with the operator's text preserved. */
function studioForm(okMsg: string | ((input: Record<string, unknown>) => string), fn: StudioAction) {
  return async (c: Context<AppEnv>) => {
    const id = c.req.param('id') ?? ''
    const input = await readInput(c)
    verifyCsrf(c, typeof input._csrf === 'string' ? input._csrf : undefined)
    delete input._csrf
    const op = requireRole(c.get('operator'), 'ADMIN', 'OPERATOR')
    try {
      await fn(c, op, id, input, c.get('cid'))
      const msg = typeof okMsg === 'function' ? okMsg(input) : okMsg
      return c.redirect(`/console/jobs/${encodeURIComponent(id)}/studio?ok=${encodeURIComponent(msg)}`, 303)
    } catch (e) {
      if (e instanceof AppError && e.status !== 401 && e.status !== 403 && e.status !== 404) {
        const errors: Record<string, string> = {}
        for (const d of e.details ?? []) {
          const k = fieldKey(d.field)
          if (!errors[k]) errors[k] = translateIssue(d.issue)
        }
        const form: StudioForm = {
          body: typeof input.body === 'string' ? input.body : undefined,
          instruction: typeof input.instruction === 'string' ? input.instruction : undefined,
          internal_notes: typeof input.internal_notes === 'string' ? input.internal_notes : undefined,
          errors
        }
        return renderStudio(c, id, { err: errText(e), form, status: e.status })
      }
      throw e
    }
  }
}

const ACTION_OK: Record<string, string> = {
  save: 'Versi baru disimpan',
  refine: 'Prompt diperbarui sebagai versi baru',
  ready: 'Prompt ditandai siap dieksekusi. Belum dieksekusi — jalankan manual, lalu catat hasilnya di halaman pekerjaan.'
}

studioApp.post('/console/jobs/:id/studio/draft', studioForm((i) => (i.mode === 'ai' ? 'Draf AI dibuat — tinjau sebelum dipakai' : 'Draf dari template dibuat'), (c, op, id, i, cid) => studio.createDraft(c.env, op, id, i, cid)))
studioApp.post('/console/jobs/:id/studio/editor', studioForm((i) => ACTION_OK[String(i.action)] ?? 'Tersimpan', (c, op, id, i, cid) => studio.editorAction(c.env, op, id, i, cid)))
studioApp.post('/console/jobs/:id/studio/analyze', studioForm('Analisis celah ditambahkan ke log studio', (c, op, id, i, cid) => studio.analyzeGaps(c.env, op, id, i, cid)))
studioApp.post('/console/jobs/:id/studio/meta', studioForm('Jenis pekerjaan & catatan disimpan', (c, op, id, i, cid) => studio.updateMeta(c.env, op, id, i, cid)))

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
async function renderSettings(c: Context<AppEnv>, extra: { ok?: string; err?: string; status?: number } = {}) {
  const op = c.get('operator') as OperatorCtx
  const settings = await studio.getLlmSettings(c.env)
  const [enabled, usage] = await Promise.all([studio.getEnabledWorkTypes(c.env.DB), usageToday(c.env.DB)])
  return c.html(
    <SettingsPage
      op={op}
      csrf={c.get('csrf') as string}
      ok={extra.ok ?? c.req.query('ok')?.slice(0, 200)}
      err={extra.err ?? c.req.query('err')?.slice(0, 300)}
      settings={settings}
      status={studio.providerStatus(c.env, settings)}
      enabledWorkTypes={enabled}
      workTypes={WORK_TYPES}
      workersAiModels={WORKERS_AI_MODELS as unknown as { id: string; label: string }[]}
      groqModels={GROQ_MODELS as unknown as { id: string; label: string }[]}
      usage={usage}
    />,
    (extra.status ?? 200) as 200
  )
}

studioApp.get('/console/settings', (c) => {
  requireRole(c.get('operator'), 'ADMIN', 'OPERATOR', 'VIEWER')
  return renderSettings(c)
})

function settingsForm(okMsg: string | ((r: unknown) => string), fn: (c: Context<AppEnv>, op: OperatorCtx, input: Record<string, unknown>, cid: string) => Promise<unknown>) {
  return async (c: Context<AppEnv>) => {
    const input = await readInput(c)
    verifyCsrf(c, typeof input._csrf === 'string' ? input._csrf : undefined)
    delete input._csrf
    const op = requireRole(c.get('operator'), 'ADMIN')
    try {
      const r = await fn(c, op, input, c.get('cid'))
      const msg = typeof okMsg === 'function' ? okMsg(r) : okMsg
      return c.redirect(`/console/settings?ok=${encodeURIComponent(msg)}`, 303)
    } catch (e) {
      if (e instanceof AppError && e.status !== 401 && e.status !== 403 && e.status !== 404) {
        const detail = e.details?.map((d) => `${d.field}: ${translateIssue(d.issue)}`).join('; ')
        return renderSettings(c, { err: detail ? `${errText(e)} — ${detail}` : errText(e), status: e.status })
      }
      throw e
    }
  }
}

studioApp.post('/console/settings/llm', settingsForm('Pengaturan provider disimpan', (c, op, i, cid) => studio.saveLlmSettings(c.env, op, i, cid)))
studioApp.post('/console/settings/work-types', settingsForm('Jenis pekerjaan disimpan', (c, op, i, cid) => studio.saveWorkTypes(c.env.DB, op, i, cid)))
studioApp.post(
  '/console/settings/health',
  settingsForm(
    (r) => {
      const x = r as { model: string; ms: number }
      return `Uji provider berhasil: ${x.model} merespons dalam ${(x.ms / 1000).toFixed(1)} dtk`
    },
    (c, op, i, cid) => studio.healthCheck(c.env, op, i, cid)
  )
)
