import type { Child, FC } from 'hono/jsx'
import type { OperatorCtx } from '../types'
import { STATE_LABEL, type JobState } from '../lib/state'
import { Icon, BrandMark, type IconName } from './icons'
import { STATE_TONE, PRIORITY_LABEL, PRIORITY_TONE, ROLE_LABEL, fmtDateTime, type Tone } from './labels'

export type NavKey = 'queue' | 'metrics' | 'audit' | 'providers' | 'none'

const NAV: { key: NavKey; href: string; label: string; icon: IconName; admin?: boolean }[] = [
  { key: 'queue', href: '/console', label: 'Antrean', icon: 'inbox' },
  { key: 'providers', href: '/console/providers', label: 'Produksi AI', icon: 'sparkle' },
  { key: 'metrics', href: '/console/metrics', label: 'Metrik', icon: 'chart' },
  { key: 'audit', href: '/console/audit', label: 'Audit', icon: 'shield', admin: true }
]

export const Layout: FC<{ title: string; op?: OperatorCtx; csrf?: string; active?: NavKey; children?: Child }> = ({ title, op, csrf, active = 'none', children }) => (
  <html lang="id">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex, nofollow" />
      <meta name="color-scheme" content="light" />
      <meta name="theme-color" content="#1f4d3a" />
      <title>{`${title} · Embrilo OS`}</title>
      <script src="/static/boot.js"></script>
      <link rel="stylesheet" href="/static/console.css" />
      <script type="module" src="/static/console.js"></script>
    </head>
    <body class={op ? 'has-shell' : 'no-shell'}>
      <a class="skip-link" href="#main">
        Lompat ke konten utama
      </a>
      {op ? (
        <div class="shell">
          <header class="sidebar" id="app-sidebar">
            <a class="brand" href="/console" aria-label="Embrilo OS — ke antrean">
              <BrandMark />
              <span class="brand-text">
                <span class="brand-name">Embrilo OS</span>
                <span class="brand-sub">Konsol operasional internal</span>
              </span>
            </a>
            <nav class="nav" aria-label="Navigasi utama">
              {NAV.filter((n) => !n.admin || op.role === 'ADMIN').map((n) => (
                <a href={n.href} class={`nav-link${active === n.key ? ' is-active' : ''}`} aria-current={active === n.key ? 'page' : undefined}>
                  <Icon name={n.icon} />
                  <span>{n.label}</span>
                </a>
              ))}
            </nav>
            <div class="sidebar-foot">
              <div class="who">
                <span class="avatar" aria-hidden="true">
                  {op.display_name.slice(0, 1).toUpperCase()}
                </span>
                <span class="who-text">
                  <span class="who-name">{op.display_name}</span>
                  <span class="who-role">{ROLE_LABEL[op.role] ?? op.role}</span>
                </span>
              </div>
              <form method="post" action="/logout" class="logout-form">
                <input type="hidden" name="_csrf" value={csrf} />
                <button type="submit" class="btn btn-ghost btn-sm" aria-label="Keluar dari konsol">
                  <Icon name="logout" size={16} />
                  <span>Keluar</span>
                </button>
              </form>
            </div>
          </header>
          <main id="main" class="main" tabindex={-1}>
            {children}
            <footer class="app-foot">
              Embrilo OS · konsol internal · semua tindakan tercatat di audit. Produksi Genspark berjalan secara <strong>manual-assisted</strong>.
            </footer>
          </main>
        </div>
      ) : (
        <main id="main" class="main-bare" tabindex={-1}>
          {children}
        </main>
      )}
      <div class="toast-region" id="toast-region" role="status" aria-live="polite" aria-atomic="true"></div>
    </body>
  </html>
)

export const PageHeader: FC<{ eyebrow?: string; title: string; description?: Child; actions?: Child; children?: Child }> = ({ eyebrow, title, description, actions, children }) => (
  <header class="page-header" data-animate="enter">
    <div class="page-header-text">
      {eyebrow && <p class="eyebrow">{eyebrow}</p>}
      <h1 class="page-title">{title}</h1>
      {description && <p class="page-desc">{description}</p>}
      {children}
    </div>
    {actions && <div class="page-actions">{actions}</div>}
  </header>
)

export const Chip: FC<{ tone: Tone; children?: Child; dot?: boolean; class?: string }> = ({ tone, children, dot = true, class: cls }) => (
  <span class={`chip tone-${tone}${cls ? ` ${cls}` : ''}`}>
    {dot && <span class="chip-dot" aria-hidden="true"></span>}
    {children}
  </span>
)

export const StateBadge: FC<{ state: JobState }> = ({ state }) => (
  <Chip tone={STATE_TONE[state]} class="state-chip">
    {STATE_LABEL_ID[state]}
  </Chip>
)

export const PriorityTag: FC<{ priority: string }> = ({ priority }) => (
  <span class={`prio tone-${PRIORITY_TONE[priority] ?? 'neutral'}`}>
    <Icon name="flag" size={14} />
    {PRIORITY_LABEL[priority] ?? priority}
  </span>
)

export const STATE_LABEL_ID: Record<JobState, string> = {
  SUBMITTED: 'Baru masuk',
  TRIAGE: 'Sedang ditriase',
  QUEUED: 'Siap diproduksi',
  IN_PRODUCTION: 'Sedang dikerjakan',
  QC_REVIEW: 'Perlu ditinjau',
  APPROVED: 'Siap dikirim',
  DELIVERED: 'Terkirim',
  NEEDS_INFO: 'Menunggu informasi',
  NEEDS_REVISION: 'Perlu revisi',
  BLOCKED_PROVIDER: 'Terhambat provider',
  FAILED: 'Gagal',
  CANCELLED: 'Dibatalkan'
}
// Keep the original English labels available for code that still references them.
export { STATE_LABEL }

export const Flash: FC<{ ok?: string; err?: string }> = ({ ok, err }) => (
  <>
    {ok && (
      <div class="alert alert-success" role="status" data-animate="flash">
        <Icon name="check" />
        <p>{ok}</p>
      </div>
    )}
    {err && (
      <div class="alert alert-danger" role="alert" data-animate="flash">
        <Icon name="alert" />
        <p>{err}</p>
      </div>
    )}
  </>
)

export const Alert: FC<{ tone: 'info' | 'warning' | 'danger' | 'success'; title?: string; icon?: IconName; children?: Child }> = ({ tone, title, icon, children }) => (
  <div class={`alert alert-${tone}`}>
    <Icon name={icon ?? (tone === 'success' ? 'check' : tone === 'info' ? 'info' : 'alert')} />
    <div>
      {title && <p class="alert-title">{title}</p>}
      <div class="alert-body">{children}</div>
    </div>
  </div>
)

export const EmptyState: FC<{ icon?: IconName; title: string; children?: Child; action?: Child }> = ({ icon = 'inbox', title, children, action }) => (
  <div class="empty" data-animate="enter">
    <span class="empty-icon" aria-hidden="true">
      <Icon name={icon} size={22} />
    </span>
    <p class="empty-title">{title}</p>
    {children && <p class="empty-text">{children}</p>}
    {action && <div class="empty-action">{action}</div>}
  </div>
)

export const Section: FC<{ id?: string; title: string; icon?: IconName; description?: Child; actions?: Child; class?: string; children?: Child }> = ({ id, title, icon, description, actions, class: cls, children }) => {
  const hid = id ? `${id}-title` : undefined
  return (
    <section class={`card${cls ? ` ${cls}` : ''}`} id={id} aria-labelledby={hid} data-animate="enter">
      <div class="card-head">
        <div>
          <h2 class="card-title" id={hid}>
            {icon && <Icon name={icon} size={18} />}
            {title}
          </h2>
          {description && <p class="card-desc">{description}</p>}
        </div>
        {actions && <div class="card-actions">{actions}</div>}
      </div>
      <div class="card-body">{children}</div>
    </section>
  )
}

/** Form field with persistent label, optional hint and accessible field-level error. */
export const Field: FC<{ id: string; label: string; hint?: string; error?: string; optional?: boolean; class?: string; children?: Child }> = ({ id, label, hint, error, optional, class: cls, children }) => (
  <div class={`field${error ? ' has-error' : ''}${cls ? ` ${cls}` : ''}`}>
    <label class="field-label" for={id}>
      {label}
      {optional && <span class="field-optional">opsional</span>}
    </label>
    {children}
    {hint && (
      <p class="field-hint" id={`${id}-hint`}>
        {hint}
      </p>
    )}
    {error && (
      <p class="field-error" id={`${id}-error`}>
        <Icon name="alert" size={14} />
        {error}
      </p>
    )}
  </div>
)

/** aria attributes for an input inside <Field>. */
export const describe = (id: string, hint?: string, error?: string) => ({
  id,
  'aria-invalid': error ? ('true' as const) : undefined,
  'aria-describedby': [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined
})

export const Csrf: FC<{ token?: string }> = ({ token }) => <input type="hidden" name="_csrf" value={token} />

export const Time: FC<{ iso?: string | null; children?: Child }> = ({ iso, children }) =>
  iso ? (
    <time datetime={iso} title={fmtDateTime(iso)}>
      {children ?? fmtDateTime(iso)}
    </time>
  ) : (
    <span class="muted">—</span>
  )

/** @deprecated kept for backwards compatibility with older views */
export const fmt = fmtDateTime
