import type { Child, FC } from 'hono/jsx'
import type { OperatorCtx } from '../types'
import { STATE_LABEL, type JobState } from '../lib/state'

export const Layout: FC<{ title: string; op?: OperatorCtx; csrf?: string; children?: Child }> = ({ title, op, csrf, children }) => (
  <html lang="id">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex, nofollow" />
      <title>{title} · Embrilo OS</title>
      <link rel="stylesheet" href="/static/console.css" />
      <script src="/static/console.js" defer></script>
    </head>
    <body>
      <a class="skip-link" href="#main">Skip to content</a>
      <header class="topbar">
        <a class="brand" href="/console">Embrilo OS <span class="badge-internal">INTERNAL</span></a>
        {op && (
          <nav aria-label="Main">
            <a href="/console">Queue</a>
            <a href="/console/metrics">Metrics</a>
            {op.role === 'ADMIN' && <a href="/console/audit">Audit</a>}
            <a href="/console/providers">Providers</a>
            <span class="who">
              {op.display_name} · <strong>{op.role}</strong>
            </span>
            <form method="post" action="/logout" class="inline">
              <input type="hidden" name="_csrf" value={csrf} />
              <button type="submit" class="btn-link">Log out</button>
            </form>
          </nav>
        )}
      </header>
      <main id="main">{children}</main>
      <footer class="foot">Embrilo OS · internal operations console · synthetic data only in this environment unless stated otherwise</footer>
    </body>
  </html>
)

export const StateBadge: FC<{ state: JobState }> = ({ state }) => (
  <span class={`state state-${state.toLowerCase()}`}>{STATE_LABEL[state]}</span>
)

export const Flash: FC<{ ok?: string; err?: string }> = ({ ok, err }) => (
  <>
    {ok && (
      <p class="flash ok" role="status">
        {ok}
      </p>
    )}
    {err && (
      <p class="flash err" role="alert">
        {err}
      </p>
    )}
  </>
)

export const Csrf: FC<{ token?: string }> = ({ token }) => <input type="hidden" name="_csrf" value={token} />

export const fmt = (iso?: string | null) => (iso ? iso.replace('T', ' ').slice(0, 16) + ' UTC' : '—')
