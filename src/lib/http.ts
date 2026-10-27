import type { Context, MiddlewareHandler } from 'hono'
import { AppError } from './errors'
import type { AppEnv } from '../types'

const ARRAY_FIELDS = new Set(['platforms'])

/** Parses JSON or form bodies into a plain object. Repeated form fields become arrays. */
export async function readInput(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const ct = (c.req.header('content-type') ?? '').toLowerCase()
  if (ct.includes('application/json')) {
    let j: unknown
    try {
      j = await c.req.json()
    } catch {
      throw new AppError(400, 'invalid_json', 'Body must be valid JSON')
    }
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new AppError(400, 'invalid_json', 'Body must be a JSON object')
    return j as Record<string, unknown>
  }
  if (ct.includes('multipart/form-data') || ct.includes('application/x-www-form-urlencoded')) {
    const fd = await c.req.formData()
    const out: Record<string, unknown> = {}
    for (const [k, v] of fd.entries()) {
      if (k in out) {
        const prev = out[k]
        out[k] = Array.isArray(prev) ? [...prev, v] : [prev, v]
      } else out[k] = ARRAY_FIELDS.has(k) ? [v] : v
    }
    return out
  }
  if (c.req.method === 'GET' || c.req.method === 'HEAD') return {}
  const len = Number(c.req.header('content-length') ?? '0')
  if (!len) return {}
  throw new AppError(415, 'unsupported_media_type', 'Use application/json or a form submission')
}

export const correlationId: MiddlewareHandler<AppEnv> = async (c, next) => {
  const incoming = c.req.header('x-correlation-id')
  const cid = incoming && /^[A-Za-z0-9_-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID()
  c.set('cid', cid)
  await next()
  c.header('X-Correlation-Id', cid)
}

export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next()
  const h = c.res.headers
  if (!h.has('Content-Security-Policy'))
    h.set(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'"
    )
  h.set('X-Content-Type-Options', 'nosniff')
  h.set('X-Frame-Options', 'DENY')
  h.set('Referrer-Policy', 'no-referrer')
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
  h.set('Cross-Origin-Opener-Policy', 'same-origin')
  h.set('Cross-Origin-Resource-Policy', 'same-origin')
  if (new URL(c.req.url).protocol === 'https:') h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  if (!h.has('Cache-Control')) h.set('Cache-Control', 'no-store')
}

export const wantsJson = (c: Context) =>
  new URL(c.req.url).pathname.startsWith('/v1/') || (c.req.header('accept') ?? '').includes('application/json')

export function clientIp(c: Context) {
  return c.req.header('cf-connecting-ip') ?? 'local'
}
