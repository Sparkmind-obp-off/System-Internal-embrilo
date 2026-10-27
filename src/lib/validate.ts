import { AppError, type Issue } from './errors'

// Small strict validators (no runtime dependency). Unknown fields are rejected.

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

export function cleanText(v: unknown): string {
  return typeof v === 'string' ? v.replace(CONTROL, '').replace(/\r\n/g, '\n').trim() : ''
}

export class V {
  issues: Issue[] = []

  fail(field: string, issue: string) {
    this.issues.push({ field, issue })
  }

  obj(v: unknown, field: string, allowed: string[]): Record<string, unknown> {
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      this.fail(field, 'must be an object')
      return {}
    }
    for (const k of Object.keys(v)) if (!allowed.includes(k)) this.fail(field ? `${field}.${k}` : k, 'unknown field')
    return v as Record<string, unknown>
  }

  str(v: unknown, field: string, min: number, max: number, opts: { pattern?: RegExp; optional?: boolean } = {}) {
    if (v === undefined || v === null || v === '') {
      if (opts.optional) return ''
      this.fail(field, 'is required')
      return ''
    }
    if (typeof v !== 'string') {
      this.fail(field, 'must be a string')
      return ''
    }
    const s = cleanText(v)
    if (s.length < min) this.fail(field, `must be at least ${min} characters`)
    else if (s.length > max) this.fail(field, `must be at most ${max} characters`)
    else if (opts.pattern && !opts.pattern.test(s)) this.fail(field, 'has an invalid format')
    return s
  }

  enumOf<T extends string>(v: unknown, field: string, values: readonly T[], optional = false): T {
    if ((v === undefined || v === '') && optional) return '' as T
    if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) {
      this.fail(field, `must be one of: ${values.join(', ')}`)
      return values[0]
    }
    return v as T
  }

  bool(v: unknown, field: string, mustBeTrue = false) {
    if (typeof v !== 'boolean') {
      this.fail(field, 'must be a boolean')
      return false
    }
    if (mustBeTrue && !v) this.fail(field, 'must be true')
    return v
  }

  int(v: unknown, field: string, min: number, max: number, optional = false): number | null {
    if ((v === undefined || v === null || v === '') && optional) return null
    const n = typeof v === 'string' ? Number(v) : v
    if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
      this.fail(field, `must be an integer between ${min} and ${max}`)
      return null
    }
    return n
  }

  throwIfAny() {
    if (this.issues.length) throw new AppError(422, 'validation_failed', 'Request validation failed', this.issues)
  }
}

export const SERVICE_CODES = [
  'SCRIPT_PACK',
  'HOOK_CAPTION_PACK',
  'PRODUCT_STORY',
  'CONTENT_CALENDAR',
  'PRODUCTION_BRIEF'
] as const
export const PLATFORMS = ['tiktok', 'instagram_reels', 'youtube_shorts', 'facebook', 'other'] as const
export const LANGUAGES = ['id', 'en', 'id-en'] as const
export const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const

export type BriefInput = {
  objective: string
  audience: string
  product_facts: string
  platforms: string[]
  language: string
  tone: string
  cta: string
  constraints: string
  references: string[]
  rights_confirmed: boolean
}

export type PublicRequestInput = {
  customer: { external_ref: string; display_name: string }
  consent: { accepted: boolean; terms_version: string; accepted_at: string }
  service_code: string
  brief: BriefInput
}

const REF_RE = /^[A-Za-z0-9_-]+$/
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/

export function validateReferences(v: V, raw: unknown, field: string): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    v.fail(field, 'must be an array')
    return []
  }
  if (raw.length > 5) v.fail(field, 'at most 5 references')
  const out: string[] = []
  raw.slice(0, 5).forEach((r, i) => {
    const s = v.str(r, `${field}[${i}]`, 8, 500)
    if (!s) return
    try {
      const u = new URL(s)
      if (u.protocol !== 'https:' || u.username || u.password) v.fail(`${field}[${i}]`, 'must be an https URL without credentials')
      else out.push(u.toString())
    } catch {
      v.fail(`${field}[${i}]`, 'must be a valid URL')
    }
  })
  return out
}

export function validateBrief(v: V, raw: unknown, field = 'brief', requireRights = true): BriefInput {
  const b = v.obj(raw, field, [
    'objective',
    'audience',
    'product_facts',
    'platforms',
    'language',
    'tone',
    'cta',
    'constraints',
    'references',
    'rights_confirmed'
  ])
  const platformsRaw = b.platforms
  let platforms: string[] = []
  if (!Array.isArray(platformsRaw) || platformsRaw.length < 1 || platformsRaw.length > 5) {
    v.fail(`${field}.platforms`, 'must be an array of 1-5 platforms')
  } else {
    platforms = [...new Set(platformsRaw.map((p, i) => v.enumOf(p, `${field}.platforms[${i}]`, PLATFORMS)))]
  }
  return {
    objective: v.str(b.objective, `${field}.objective`, 10, 2000),
    audience: v.str(b.audience, `${field}.audience`, 3, 1000),
    product_facts: v.str(b.product_facts, `${field}.product_facts`, 10, 5000),
    platforms,
    language: v.enumOf(b.language, `${field}.language`, LANGUAGES),
    tone: v.str(b.tone, `${field}.tone`, 0, 300, { optional: true }),
    cta: v.str(b.cta, `${field}.cta`, 0, 300, { optional: true }),
    constraints: v.str(b.constraints, `${field}.constraints`, 0, 2000, { optional: true }),
    references: validateReferences(v, b.references, `${field}.references`),
    rights_confirmed: v.bool(b.rights_confirmed, `${field}.rights_confirmed`, requireRights)
  }
}

export function validatePublicRequest(raw: unknown): PublicRequestInput {
  const v = new V()
  const root = v.obj(raw, '', ['customer', 'consent', 'service_code', 'brief'])
  const c = v.obj(root.customer, 'customer', ['external_ref', 'display_name'])
  const consent = v.obj(root.consent, 'consent', ['accepted', 'terms_version', 'accepted_at'])
  const out: PublicRequestInput = {
    customer: {
      external_ref: v.str(c.external_ref, 'customer.external_ref', 8, 64, { pattern: REF_RE }),
      display_name: v.str(c.display_name, 'customer.display_name', 1, 120)
    },
    consent: {
      accepted: v.bool(consent.accepted, 'consent.accepted', true),
      terms_version: v.str(consent.terms_version, 'consent.terms_version', 1, 32, { pattern: /^[A-Za-z0-9._-]+$/ }),
      accepted_at: v.str(consent.accepted_at, 'consent.accepted_at', 20, 24, { pattern: ISO_RE })
    },
    service_code: v.enumOf(root.service_code, 'service_code', SERVICE_CODES),
    brief: validateBrief(v, root.brief)
  }
  v.throwIfAny()
  return out
}

export function validateIdempotencyKey(k: string | undefined | null): string {
  if (!k || !/^[A-Za-z0-9_.:-]{16,128}$/.test(k))
    throw new AppError(400, 'idempotency_key_required', 'Idempotency-Key header (16-128 safe chars) is required')
  return k
}

export function validateCustomerExternalRef(k: string | undefined | null): string {
  if (!k || k.length < 8 || k.length > 64 || !REF_RE.test(k))
    throw new AppError(401, 'customer_auth_required', 'Customer authentication is required')
  return k
}

/** Stable JSON for request hashing (sorted keys). */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  if (v && typeof v === 'object')
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(v)
}
