import type { Child, FC } from 'hono/jsx'
import type { OperatorCtx } from '../types'
import { STATE_LABEL, type JobState } from '../lib/state'

export const Layout: FC<{ title: string; op?: OperatorCtx; csrf?: string; children?: Child }> = ({ title, op, csrf, children }) => (
  <html lang="id">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content="noindex, nofollow" />
      <meta name="theme-color" content="#176b55" />
      <meta name="color-scheme" content="light" />
      <title>{title} · Embrilo OS</title>
      <link rel="stylesheet" href="/static/console.css" />
      <script src="/static/console.js" defer></script>
    </head>
    <body>
      <a class="skip-link" href="#main">Lewati ke konten</a>
      <header class="topbar">
        <a class="brand" href="/console" aria-label="Embrilo OS — Beranda">Embrilo OS <span class="badge-internal">INTERNAL</span></a>
        {op && (
          <nav aria-label="Navigasi utama">
            <a href="/console">Antrean</a>
            <a href="/console/metrics">Metrik</a>
            {op.role === 'ADMIN' && <a href="/console/audit">Audit</a>}
            <a href="/console/providers">Produksi AI</a>
            <span class="who">
              {op.display_name} · <strong>{op.role === 'ADMIN' ? 'ADMIN' : op.role === 'OPERATOR' ? 'OPERATOR' : 'VIEWER'}</strong>
            </span>
            <form method="post" action="/logout" class="inline">
              <input type="hidden" name="_csrf" value={csrf} />
              <button type="submit" class="btn-link">Keluar</button>
            </form>
          </nav>
        )}
      </header>
      <main id="main">{children}</main>
      <footer class="foot">Embrilo OS · Workspace operasional internal · Data demo ditandai secara eksplisit</footer>
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
