import { uuid } from './crypto'
import { nowIso } from './db'
import type { Actor } from '../types'

/** Builds an audit insert. Metadata must be safe: ids, codes, counts — never brief text or secrets. */
export function auditStmt(
  db: D1Database,
  actor: Actor,
  action: string,
  resourceType: string,
  resourceId: string,
  cid: string,
  meta: Record<string, unknown> = {}
) {
  return db
    .prepare(
      `INSERT INTO audit_events (id, actor_type, actor_id, action, resource_type, resource_id, correlation_id, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(uuid(), actor.type, actor.id, action, resourceType, resourceId, cid, JSON.stringify(meta), nowIso())
}

export async function audit(
  db: D1Database,
  actor: Actor,
  action: string,
  resourceType: string,
  resourceId: string,
  cid: string,
  meta: Record<string, unknown> = {}
) {
  await auditStmt(db, actor, action, resourceType, resourceId, cid, meta).run()
}
