import { Hono, type Context } from 'hono'
import { requireOperator, requireRole, verifyCsrf } from '../lib/auth'
import { readInput } from '../lib/http'
import { getJob } from '../lib/db'
import * as jobs from '../services/jobs'
import type { AppEnv, OperatorCtx } from '../types'

/**
 * Internal JSON API (same operations as the console forms). Session cookie +
 * X-CSRF-Token header required for every state change; role checked server-side.
 */
export const internal = new Hono<AppEnv>()
internal.use('/internal/*', requireOperator('json'))

async function writeCtx(c: Context<AppEnv>, ...roles: OperatorCtx['role'][]) {
  const op = requireRole(c.get('operator'), ...(roles.length ? roles : (['ADMIN', 'OPERATOR'] as const)))
  const input = await readInput(c)
  verifyCsrf(c, c.req.header('x-csrf-token') ?? (typeof input._csrf === 'string' ? input._csrf : undefined))
  delete input._csrf
  return { op, input, id: c.req.param('id') ?? '', cid: c.get('cid') }
}

internal.get('/internal/jobs/:id', async (c) => {
  requireRole(c.get('operator'), 'ADMIN', 'OPERATOR', 'VIEWER')
  const job = await getJob(c.env.DB, c.req.param('id'))
  return c.json({ job })
})

internal.post('/internal/jobs/:id/triage', async (c) => {
  const { op, input, id, cid } = await writeCtx(c)
  await jobs.triage(c.env.DB, op, id, input, cid)
  return c.json({ ok: true, job: await getJob(c.env.DB, id) })
})

internal.post('/internal/jobs/:id/assign', async (c) => {
  const { op, input, id, cid } = await writeCtx(c)
  await jobs.assign(c.env.DB, op, id, input, cid)
  return c.json({ ok: true })
})

internal.post('/internal/jobs/:id/brief', async (c) => {
  const { op, input, id, cid } = await writeCtx(c)
  await jobs.updateBrief(c.env.DB, op, id, input, cid)
  return c.json({ ok: true })
})

internal.post('/internal/jobs/:id/start-production', async (c) => {
  const { op, input, id, cid } = await writeCtx(c)
  return c.json({ ok: true, ...(await jobs.startProduction(c.env.DB, op, id, input, cid)) })
})

internal.post('/internal/jobs/:id/production-result', async (c) => {
  const { op, input, id, cid } = await writeCtx(c)
  return c.json({ ok: true, ...(await jobs.recordProductionResult(c.env, op, id, input, cid)) })
})

internal.post('/internal/jobs/:id/production-failure', async (c) => {
  const { op, input, id, cid } = await writeCtx(c)
  await jobs.recordProductionFailure(c.env.DB, op, id, input, cid)
  return c.json({ ok: true, job: await getJob(c.env.DB, id) })
})

internal.post('/internal/jobs/:id/requeue', async (c) => {
  const { op, input, id, cid } = await writeCtx(c)
  await jobs.requeue(c.env.DB, op, id, input, cid)
  return c.json({ ok: true })
})

internal.post('/internal/jobs/:id/review', async (c) => {
  const { op, input, id, cid } = await writeCtx(c)
  return c.json({ ok: true, ...(await jobs.review(c.env, op, id, input, cid)) })
})

internal.post('/internal/jobs/:id/deliver', async (c) => {
  const { op, id, cid } = await writeCtx(c)
  return c.json({ ok: true, ...(await jobs.deliver(c.env.DB, op, id, cid)) })
})

internal.post('/internal/jobs/:id/cancel', async (c) => {
  const { op, input, id, cid } = await writeCtx(c, 'ADMIN')
  await jobs.cancel(c.env.DB, op, id, input, cid)
  return c.json({ ok: true })
})
