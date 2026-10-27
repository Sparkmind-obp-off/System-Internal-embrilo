import type { Context, MiddlewareHandler } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { randomToken, sha256Hex, timingSafeEqual } from './crypto'
import { AppError, forbidden } from './errors'
import { nowIso } from './db'
import type { AppEnv, OperatorCtx, Role } from '../types'

export const SESSION_TTL_MS = 8 * 60 * 60 * 1000 // absolute lifetime
export const SESSION_IDLE_MS = 2 * 60 * 60 * 1000 // idle timeout
export const MAX_FAILED_LOGINS = 5
export const LOCKOUT_MS = 15 * 60 * 1000

function isHttps(c: Context) {
  return new URL(c.req.url).protocol === 'https:'
}

/** `__Host-` prefix requires Secure; plain http is only used for local dev on localhost. */
export function cookieName(c: Context) {
  return isHttps(c) ? '__Host-embrilo_sid' : 'embrilo_sid'
}

export async function createSession(c: Context<AppEnv>, operatorId: string) {
  const token = randomToken(32)
  const csrf = randomToken(24)
  const now = Date.now()
  await c.env.DB.prepare(
    `INSERT INTO sessions (id_hash, operator_id, csrf_token, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(await sha256Hex(token), operatorId, csrf, nowIso(), new Date(now + SESSION_TTL_MS).toISOString(), nowIso())
    .run()
  setCookie(c, cookieName(c), token, {
    httpOnly: true,
    secure: isHttps(c),
    sameSite: 'Strict',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000
  })
}

export async function destroySession(c: Context<AppEnv>) {
  const token = getCookie(c, cookieName(c))
  if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(await sha256Hex(token)).run()
  deleteCookie(c, cookieName(c), { path: '/', secure: isHttps(c) })
}

type SessionRow = OperatorCtx & { csrf_token: string; expires_at: string; last_seen_at: string; id_hash: string; active: number }

/** Loads the operator from the session cookie, if any. Does not enforce. */
export const loadSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, cookieName(c))
  if (token && token.length <= 128) {
    const idHash = await sha256Hex(token)
    const row = await c.env.DB.prepare(
      `SELECT s.id_hash, s.csrf_token, s.expires_at, s.last_seen_at, o.id, o.email, o.display_name, o.role, o.active
       FROM sessions s JOIN operators o ON o.id = s.operator_id WHERE s.id_hash = ?`
    )
      .bind(idHash)
      .first<SessionRow>()
    const now = Date.now()
    if (row) {
      const expired =
        Date.parse(row.expires_at) < now || Date.parse(row.last_seen_at) + SESSION_IDLE_MS < now || row.active !== 1
      if (expired) {
        await c.env.DB.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(idHash).run()
      } else {
        c.set('operator', { id: row.id, email: row.email, display_name: row.display_name, role: row.role })
        c.set('csrf', row.csrf_token)
        // Touch at most once a minute to limit writes.
        if (Date.parse(row.last_seen_at) + 60_000 < now)
          await c.env.DB.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?').bind(nowIso(), idHash).run()
      }
    }
  }
  await next()
}

/** Requires an authenticated operator. HTML routes redirect to /login; JSON routes get 401. */
export function requireOperator(kind: 'html' | 'json'): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!c.get('operator')) {
      if (kind === 'html') return c.redirect('/login', 303)
      throw new AppError(401, 'unauthenticated', 'Login required')
    }
    await next()
  }
}

export function requireRole(op: OperatorCtx | undefined, ...roles: Role[]): OperatorCtx {
  if (!op) throw new AppError(401, 'unauthenticated', 'Login required')
  if (!roles.includes(op.role)) throw forbidden()
  return op
}

/**
 * CSRF protection for state-changing requests made with a session cookie:
 * synchronizer token (form field `_csrf` or header `X-CSRF-Token`) + Origin check.
 * SameSite=Strict cookies are an additional layer, not the only one.
 */
export function verifyCsrf(c: Context<AppEnv>, provided: string | undefined) {
  const origin = c.req.header('origin')
  if (origin && origin !== new URL(c.req.url).origin) throw new AppError(403, 'bad_origin', 'Cross-origin request rejected')
  const expected = c.get('csrf')
  if (!expected || !provided || !timingSafeEqual(provided, expected))
    throw new AppError(403, 'csrf_failed', 'Security token missing or invalid; reload the page and retry')
}
