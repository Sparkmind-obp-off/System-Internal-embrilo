import { Hono, type Context } from 'hono'
import { requireOperator, requireRole, verifyCsrf } from '../lib/auth'
import { AppError } from '../lib/errors'
import { readInput } from '../lib/http'
import * as assistant from '../services/assistant'
import * as studio from '../services/studio'
import { AssistantPage } from '../views/assistant'
import { ERROR_MESSAGES } from '../views/labels'
import type { AppEnv, OperatorCtx } from '../types'

export const assistantApp = new Hono<AppEnv>()
assistantApp.use('/console/*', requireOperator('html'))

// Job ids are opaque; accept a safe character set and verify existence in D1 (parameterised).
const UUID = /^[A-Za-z0-9-]{8,64}$/
const ASSISTANT_ERRORS: Record<string, string> = {
  action_decided: 'Usulan ini sudah diputuskan sebelumnya. Tidak ada yang dijalankan dua kali.',
  action_expired: 'Usulan kedaluwarsa (lebih dari 15 menit). Tanyakan lagi ke asisten agar status terbaru diperiksa ulang.',
  studio_locked: 'Prompt tidak bisa diubah pada status order ini.',
  already_ready: 'Versi ini sudah ditandai siap dieksekusi.'
}
const errText = (e: AppError) => ASSISTANT_ERRORS[e.code] ?? ERROR_MESSAGES[e.code] ?? e.message

/** Only same-app return targets are allowed (no open redirects). */
function backTarget(raw: unknown, jobId: string | null): string {
  if (typeof raw === 'string') {
    if (raw === '/console/assistant') return raw
    const m = raw.match(/^\/console\/(jobs\/([A-Za-z0-9-]{8,64})|assistant\?job=([A-Za-z0-9-]{8,64}))$/)
    if (m) return raw
  }
  return jobId ? `/console/assistant?job=${jobId}` : '/console/assistant'
}
const withMsg = (back: string, key: 'ok' | 'err', msg: string, anchor = 'assistant') =>
  `${back}${back.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(msg)}#${anchor}`

assistantApp.get('/console/assistant', async (c) => {
  const op = requireRole(c.get('operator'), 'ADMIN', 'OPERATOR', 'VIEWER')
  const jobParam = c.req.query('job') ?? ''
  const ctx = UUID.test(jobParam)
    ? await c.env.DB.prepare('SELECT j.id, o.public_ref, j.state FROM jobs j JOIN orders o ON o.id = j.order_id WHERE j.id = ?').bind(jobParam).first<{ id: string; public_ref: string; state: string }>()
    : null
  const settings = await studio.getLlmSettings(c.env)
  const thread = await assistant.loadThread(c.env.DB, op, ctx?.id ?? null, 30)
  return c.html(
    <AssistantPage
      op={op}
      csrf={c.get('csrf') as string}
      ok={c.req.query('ok')?.slice(0, 300)}
      err={c.req.query('err')?.slice(0, 300)}
      context={ctx ? { jobId: ctx.id, ref: ctx.public_ref } : null}
      thread={thread}
      provider={studio.providerStatus(c.env, settings)}
      now={Date.now()}
    />
  )
})

async function formInput(c: Context<AppEnv>) {
  const input = await readInput(c)
  verifyCsrf(c, typeof input._csrf === 'string' ? input._csrf : undefined)
  delete input._csrf
  return input
}

assistantApp.post('/console/assistant/ask', async (c) => {
  const input = await formInput(c)
  const op = requireRole(c.get('operator'), 'ADMIN', 'OPERATOR', 'VIEWER')
  const jobId = typeof input.job_id === 'string' && UUID.test(input.job_id) ? input.job_id : null
  const back = backTarget(input.back, jobId)
  try {
    await assistant.ask(c.env, op, input, c.get('cid'))
    return c.redirect(`${back}#assistant-latest`, 303)
  } catch (e) {
    if (e instanceof AppError && (e.status === 422 || e.status === 429)) return c.redirect(withMsg(back, 'err', e.status === 422 ? 'Tulis pertanyaan terlebih dahulu.' : errText(e)), 303)
    throw e
  }
})

assistantApp.post('/console/assistant/actions/:id', async (c) => {
  const input = await formInput(c)
  const op = c.get('operator') as OperatorCtx
  const id = c.req.param('id')
  if (!UUID.test(id)) throw new AppError(404, 'not_found')
  const row = await c.env.DB.prepare('SELECT job_id FROM assistant_actions WHERE id = ? AND operator_id = ?').bind(id, op.id).first<{ job_id: string }>()
  const back = backTarget(input.back, row?.job_id ?? null)
  const decision = input.decision === 'confirm' ? 'confirm' : input.decision === 'cancel' ? 'cancel' : null
  if (!decision) return c.redirect(withMsg(back, 'err', 'Keputusan tidak valid.'), 303)
  try {
    const r = await assistant.decideAction(c.env, op, id, decision, c.get('cid'))
    return c.redirect(withMsg(back, 'ok', r.note, 'assistant-latest'), 303)
  } catch (e) {
    if (e instanceof AppError && e.status !== 401 && e.status !== 404) return c.redirect(withMsg(back, 'err', errText(e)), 303)
    throw e
  }
})

assistantApp.post('/console/assistant/clear', async (c) => {
  const input = await formInput(c)
  const op = c.get('operator') as OperatorCtx
  const jobId = typeof input.job_id === 'string' && UUID.test(input.job_id) ? input.job_id : null
  await assistant.clearThread(c.env.DB, op, jobId, c.get('cid'))
  return c.redirect(withMsg(backTarget(input.back, jobId), 'ok', 'Percakapan dihapus. Usulan yang belum diputuskan dibatalkan.'), 303)
})
