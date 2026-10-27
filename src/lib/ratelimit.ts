import { AppError } from './errors'

/**
 * Fixed-window rate limiter backed by D1 (no paid add-ons needed).
 * Good enough for MVP volumes; swap for Cloudflare Rate Limiting rules later if needed.
 */
export async function rateLimit(db: D1Database, bucket: string, limit: number, windowSec: number) {
  const now = Math.floor(Date.now() / 1000)
  const windowStart = now - (now % windowSec)
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(bucket) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.count + 1 ELSE 1 END,
         window_start = excluded.window_start
       RETURNING count`
    )
    .bind(bucket, windowStart)
    .first<{ count: number }>()
  if ((row?.count ?? 0) > limit) {
    throw new AppError(429, 'rate_limited', 'Too many requests, slow down', undefined, windowStart + windowSec - now)
  }
}

export async function resetRateLimit(db: D1Database, bucket: string) {
  await db.prepare('DELETE FROM rate_limits WHERE bucket = ?').bind(bucket).run()
}
