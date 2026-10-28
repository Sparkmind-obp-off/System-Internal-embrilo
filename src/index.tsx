import { Hono } from 'hono'
import { AppError } from './lib/errors'
import { correlationId, securityHeaders, wantsJson } from './lib/http'
import { loadSession } from './lib/auth'
import { connector } from './routes/connector'
import { internal } from './routes/internal'
import { consoleApp } from './routes/console'
import { studioApp } from './routes/studio'
import { ErrorPage } from './views/pages'
import { ERROR_MESSAGES } from './views/labels'
import type { AppEnv } from './types'

const app = new Hono<AppEnv>()

app.use('*', correlationId)
app.use('*', securityHeaders)

// Minimal unauthenticated health check: no version, bindings or data details.
app.get('/health', (c) => c.json({ ok: true }))

// Server-to-server connector API (HMAC-signed). No session, no CORS.
app.route('/v1', connector)

// Internal API + console (operator session).
app.use('/v1/internal/*', loadSession)
app.route('/v1', internal)
app.use('/login', loadSession)
app.use('/logout', loadSession)
app.use('/console', loadSession)
app.use('/console/*', loadSession)
app.route('/', consoleApp)
app.route('/', studioApp)

app.get('/', (c) => c.redirect('/console', 302))

app.notFound((c) => {
  if (wantsJson(c)) return c.json({ error: { code: 'not_found', message: 'Not found', correlation_id: c.get('cid') } }, 404)
  return c.html(<ErrorPage status={404} op={c.get('operator')} csrf={c.get('csrf')} />, 404)
})

app.onError((err, c) => {
  const cid = c.get('cid')
  if (err instanceof AppError) {
    if (err.retryAfter) c.header('Retry-After', String(err.retryAfter))
    if (wantsJson(c))
      return c.json({ error: { code: err.code, message: err.message, details: err.details, correlation_id: cid } }, err.status)
    if (err.status === 401) return c.redirect('/login', 303)
    return c.html(<ErrorPage status={err.status} message={ERROR_MESSAGES[err.code]} reference={cid} op={c.get('operator')} csrf={c.get('csrf')} />, err.status)
  }
  // Unexpected error: log only safe identifiers, never request bodies.
  console.error(JSON.stringify({ level: 'error', cid, path: new URL(c.req.url).pathname, name: err?.name, msg: String(err?.message ?? '').slice(0, 200) }))
  if (wantsJson(c)) return c.json({ error: { code: 'internal_error', message: 'Unexpected error', correlation_id: cid } }, 500)
  return c.html(<ErrorPage status={500} reference={cid} op={c.get('operator')} csrf={c.get('csrf')} />, 500)
})

export default app
