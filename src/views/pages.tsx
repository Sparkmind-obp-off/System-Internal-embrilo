import type { Child, FC } from 'hono/jsx'
import { Alert, Chip, EmptyState, Field, Flash, Layout, PageHeader, PriorityTag, Section, StateBadge, STATE_LABEL_ID, Time } from './layout'
import { BrandMark, Icon } from './icons'
import type { JobState } from '../lib/state'
import type { OperatorCtx } from '../types'
import { STATES } from '../lib/state'
import { SERVICE_CODES } from '../lib/validate'
import { briefIncomplete, type OrderFilter, type SearchResult } from '../services/search'
import { inboxHref } from '../services/assistant'
import {
  AUDIT_TYPES,
  QUEUE_VIEWS,
  PRIORITY_LABEL,
  SERVICE_LABEL,
  ageLabel,
  auditActionLabel,
  fmtDateTime,
  nextAction,
  relTime
} from './labels'

type Base = { op: OperatorCtx; csrf: string; ok?: string; err?: string }

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
export const LoginPage: FC<{ csrf: string; err?: string; email?: string }> = ({ csrf, err, email }) => (
  <Layout title="Masuk">
    <div class="login">
      <aside class="login-aside" aria-hidden="true">
        <div class="login-aside-inner">
          <BrandMark size={40} />
          <p class="login-aside-title">Dari brief sampai terkirim — rapi, terlacak, ditinjau manusia.</p>
          <ol class="login-steps">
            <li>Triase & lengkapi brief</li>
            <li>Produksi dengan Genspark (manual-assisted)</li>
            <li>Tinjauan kualitas & revisi</li>
            <li>Kirim hasil yang sudah disetujui</li>
          </ol>
        </div>
      </aside>
      <section class="login-panel" aria-labelledby="login-title">
        <div class="login-card" data-animate="enter">
          <div class="login-brand">
            <BrandMark size={36} />
            <span>Embrilo OS</span>
          </div>
          <h1 id="login-title" class="login-title">
            Masuk ke konsol operasional
          </h1>
          <p class="muted">Khusus tim internal. Setiap tindakan tercatat di audit.</p>
          {err && (
            <div class="alert alert-danger" role="alert">
              <Icon name="alert" />
              <p>{err}</p>
            </div>
          )}
          <form method="post" action="/login" class="stack" data-submit-label="Memeriksa…">
            <input type="hidden" name="_lcsrf" value={csrf} />
            <Field id="login-email" label="Email kerja">
              <input id="login-email" type="email" name="email" required autocomplete="username" maxlength={254} value={email ?? ''} autofocus />
            </Field>
            <Field id="login-password" label="Kata sandi" hint="Akun terkunci 15 menit setelah 5 kali salah.">
              <div class="input-group">
                <input id="login-password" type="password" name="password" required autocomplete="current-password" maxlength={256} aria-describedby="login-password-hint" />
                <button type="button" class="btn btn-ghost btn-sm input-addon" data-toggle-password="#login-password" hidden>
                  Tampilkan
                </button>
              </div>
            </Field>
            <button type="submit" class="btn btn-primary btn-block">
              <Icon name="lock" size={16} />
              Masuk
            </button>
          </form>
          <p class="login-help">
            Lupa kata sandi atau akun terkunci? Hubungi admin Embrilo OS untuk mengatur ulang akun Anda. Jika muncul pesan formulir kedaluwarsa, pastikan
            cookie diizinkan dan buka tautan di Chrome/Safari (bukan browser di dalam aplikasi lain).
          </p>
        </div>
      </section>
    </div>
  </Layout>
)

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------
const STATE_OPTIONS = STATES
const SERVICE_OPTIONS = SERVICE_CODES

/** Builds an Inbox URL from the current filter plus a patch (undefined removes a key). */
function queueHref(f: OrderFilter, patch: Partial<OrderFilter>) {
  const n: OrderFilter = { ...f, ...patch }
  if (!('page' in patch)) delete n.page
  const href = inboxHref(n)
  const p = new URLSearchParams(href.split('?')[1] ?? '')
  if (n.page && n.page > 1) p.set('page', String(n.page))
  if (n.pageSize && n.pageSize !== 25) p.set('size', String(n.pageSize))
  const s = p.toString()
  return s ? `/console?${s}` : '/console'
}

const ADVANCED_KEYS: (keyof OrderFilter)[] = ['state', 'services', 'prompt', 'revision', 'createdFrom', 'createdTo', 'updatedFrom', 'sort', 'scope', 'needsMe']

export const QueuePage: FC<Base & { result: SearchResult; viewCounts: Record<string, number>; openCount: number; mineCount: number; now: number }> = (p) => {
  const { rows, total, page, pages, pageSize } = p.result
  const f = p.result.filter
  const activeView = QUEUE_VIEWS.find((v) => v.id === f.view)
  const title = activeView
    ? activeView.label
    : f.state
      ? `Status: ${STATE_LABEL_ID[f.state]}`
      : f.needsMe
        ? 'Perlu tindakan saya'
        : f.mine
          ? 'Ditugaskan ke saya'
          : f.scope === 'all'
            ? 'Semua order'
            : 'Semua terbuka'
  const filtered = !!(f.q || f.prio || ADVANCED_KEYS.some((k) => f[k] !== undefined))
  const advancedOpen = ADVANCED_KEYS.some((k) => f[k] !== undefined)
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1
  const last = Math.min(total, page * pageSize)
  const tab = (active: boolean) => `tab${active ? ' is-active' : ''}`
  const plain = !f.view && !f.state && !f.mine && !f.needsMe && f.scope !== 'all'
  return (
    <Layout title="Inbox" op={p.op} csrf={p.csrf} active="queue">
      <PageHeader
        eyebrow="Inbox pesanan"
        title="Apa yang perlu dikerjakan sekarang"
        description="Cari dan saring order nyata dari database. Buka order untuk memahami brief, siapkan prompt di Prompt Studio, lalu jalankan secara manual."
        actions={
          <a class="btn btn-secondary btn-sm" href="/console/assistant">
            <Icon name="message" size={16} />
            Tanya asisten
          </a>
        }
      />
      <Flash ok={p.ok} err={p.err} />

      <nav class="summary" aria-label="Ringkasan antrean">
        {QUEUE_VIEWS.filter((v) => v.id !== 'done').map((v) => (
          <a class={`summary-card${f.view === v.id ? ' is-active' : ''}`} href={queueHref({}, { view: v.id })} data-animate="item" aria-current={f.view === v.id ? 'true' : undefined}>
            <span class="summary-count">{p.viewCounts[v.id] ?? 0}</span>
            <span class="summary-label">{v.label}</span>
            <span class="summary-hint">{v.hint}</span>
          </a>
        ))}
      </nav>

      <section class="card queue-card" aria-labelledby="queue-title" data-animate="enter">
        <div class="queue-toolbar">
          <div class="tabs" role="list" aria-label="Tampilan">
            <a role="listitem" class={tab(plain)} href={queueHref({ q: f.q, prio: f.prio }, {})}>
              Semua terbuka <span class="tab-count">{p.openCount}</span>
            </a>
            <a role="listitem" class={tab(!!f.needsMe && !f.view)} href={queueHref({ q: f.q, prio: f.prio }, { needsMe: true })}>
              Perlu tindakan saya
            </a>
            <a role="listitem" class={tab(!!f.mine && !f.needsMe)} href={queueHref({ q: f.q, prio: f.prio }, { mine: true })}>
              Milik saya <span class="tab-count">{p.mineCount}</span>
            </a>
            <a role="listitem" class={tab(f.view === 'done')} href={queueHref({ q: f.q, prio: f.prio }, { view: 'done' })}>
              Selesai <span class="tab-count">{p.viewCounts.done ?? 0}</span>
            </a>
          </div>
        </div>

        <form method="get" action="/console" class="queue-filters" role="search" id="order-search">
          {f.view && <input type="hidden" name="view" value={f.view} />}
          {f.mine && <input type="hidden" name="mine" value="1" />}
          <div class="queue-search">
            <label class="sr-only" for="queue-q">
              Cari order
            </label>
            <span class="search-wrap">
              <Icon name="search" size={16} />
              <input
                id="queue-q"
                type="search"
                name="q"
                value={f.q ?? ''}
                maxlength={64}
                placeholder={p.op.role === 'VIEWER' ? 'Cari referensi, pelanggan, atau kata kunci brief' : 'Cari referensi, pelanggan, ref pelanggan, atau kata kunci brief'}
                data-shortcut="/"
                aria-keyshortcuts="/"
              />
            </span>
            <label class="sr-only" for="queue-prio">
              Prioritas
            </label>
            <select id="queue-prio" name="prio">
              <option value="">Semua prioritas</option>
              {(['URGENT', 'HIGH', 'NORMAL', 'LOW'] as const).map((x) => (
                <option value={x} selected={f.prio === x}>
                  {PRIORITY_LABEL[x]}
                </option>
              ))}
            </select>
            <button type="submit" class="btn btn-primary btn-sm">
              <Icon name="filter" size={16} />
              Terapkan
            </button>
          </div>
          <details class="filter-more" open={advancedOpen}>
            <summary>Filter lanjutan</summary>
            <div class="filter-grid">
              <div class="field">
                <label class="field-label" for="flt-state">
                  Status
                </label>
                <select id="flt-state" name="state" disabled={!!f.view}>
                  <option value="">{f.view ? 'Mengikuti tampilan' : 'Semua status terbuka'}</option>
                  {STATE_OPTIONS.map((s2) => (
                    <option value={s2} selected={f.state === s2}>
                      {STATE_LABEL_ID[s2]}
                    </option>
                  ))}
                </select>
              </div>
              <div class="field">
                <label class="field-label" for="flt-service">
                  Layanan
                </label>
                <select id="flt-service" name="service">
                  <option value="">Semua layanan</option>
                  {SERVICE_OPTIONS.map((sv) => (
                    <option value={sv} selected={f.services?.length === 1 && f.services[0] === sv}>
                      {SERVICE_LABEL[sv] ?? sv}
                    </option>
                  ))}
                  {f.services && f.services.length > 1 && (
                    <option value={f.services.join(',')} selected>
                      {f.services.map((x) => SERVICE_LABEL[x] ?? x).join(' / ')}
                    </option>
                  )}
                </select>
              </div>
              <div class="field">
                <label class="field-label" for="flt-prompt">
                  Prompt
                </label>
                <select id="flt-prompt" name="prompt">
                  <option value="">Semua</option>
                  <option value="none" selected={f.prompt === 'none'}>
                    Belum ada prompt
                  </option>
                  <option value="draft" selected={f.prompt === 'draft'}>
                    Draf, belum siap
                  </option>
                  <option value="ready" selected={f.prompt === 'ready'}>
                    Siap dieksekusi
                  </option>
                </select>
              </div>
              <div class="field">
                <label class="field-label" for="flt-revision">
                  Revisi
                </label>
                <select id="flt-revision" name="revision">
                  <option value="">Semua</option>
                  <option value="open" selected={f.revision === 'open'}>
                    Ada revisi terbuka
                  </option>
                </select>
              </div>
              <div class="field">
                <label class="field-label" for="flt-cfrom">
                  Masuk sejak
                </label>
                <input id="flt-cfrom" type="date" name="created_from" value={f.createdFrom ?? ''} />
              </div>
              <div class="field">
                <label class="field-label" for="flt-cto">
                  Masuk sampai
                </label>
                <input id="flt-cto" type="date" name="created_to" value={f.createdTo ?? ''} />
              </div>
              <div class="field">
                <label class="field-label" for="flt-ufrom">
                  Diperbarui sejak
                </label>
                <input id="flt-ufrom" type="date" name="updated_from" value={f.updatedFrom ?? ''} />
              </div>
              <div class="field">
                <label class="field-label" for="flt-sort">
                  Urutkan
                </label>
                <select id="flt-sort" name="sort">
                  <option value="">Prioritas, lalu terlama</option>
                  <option value="updated" selected={f.sort === 'updated'}>
                    Terakhir diperbarui
                  </option>
                  <option value="created" selected={f.sort === 'created'}>
                    Terbaru masuk
                  </option>
                </select>
              </div>
              <div class="field">
                <label class="field-label" for="flt-scope">
                  Cakupan
                </label>
                <select id="flt-scope" name="scope" disabled={!!f.view || !!f.state}>
                  <option value="">Hanya yang belum selesai</option>
                  <option value="all" selected={f.scope === 'all'}>
                    Termasuk terkirim & dibatalkan
                  </option>
                </select>
              </div>
              <div class="field">
                <label class="field-label" for="flt-size">
                  Per halaman
                </label>
                <select id="flt-size" name="size">
                  {[10, 25, 50].map((n) => (
                    <option value={String(n)} selected={pageSize === n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
              <label class="check filter-check">
                <input type="checkbox" name="needs_me" value="1" checked={!!f.needsMe} />
                <span>Hanya yang perlu tindakan tim (milik saya / belum ditugaskan)</span>
              </label>
            </div>
          </details>
        </form>

        <div class="queue-head">
          <h2 class="card-title" id="queue-title">
            {title}{' '}
            <span class="muted" aria-live="polite">
              · {total === 0 ? 'tidak ada order' : `${first}–${last} dari ${total} order`}
            </span>
          </h2>
          {filtered && (
            <a class="btn btn-ghost btn-sm" href={queueHref({ view: f.view, mine: f.mine }, {})}>
              <Icon name="x" size={14} />
              Hapus filter
            </a>
          )}
        </div>

        {rows.length === 0 ? (
          <EmptyState icon={filtered ? 'search' : 'check'} title={filtered ? 'Tidak ada yang cocok' : 'Tidak ada pekerjaan di sini'}>
            {filtered
              ? 'Tidak ada order di database yang cocok dengan pencarian atau filter ini. Coba kata kunci lain atau hapus filter.'
              : f.view === 'done'
                ? 'Pekerjaan yang terkirim atau dibatalkan akan muncul di sini.'
                : 'Bagian ini kosong. Permintaan baru dari Public Embrilo akan masuk otomatis.'}
          </EmptyState>
        ) : (
          <div class="table-wrap">
            <table class="table queue-table">
              <caption class="sr-only">Daftar order: {title}</caption>
              <thead>
                <tr>
                  <th scope="col">Referensi</th>
                  <th scope="col">Status</th>
                  <th scope="col">Langkah berikutnya</th>
                  <th scope="col">Indikator</th>
                  <th scope="col">Prioritas</th>
                  <th scope="col">Pemilik</th>
                  <th scope="col">Pembaruan</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const age = ageLabel(r.created_at, p.now)
                  const na = nextAction(r.state)
                  const closed = ['DELIVERED', 'CANCELLED', 'APPROVED', 'QC_REVIEW', 'IN_PRODUCTION'].includes(r.state)
                  return (
                    <tr data-animate="row" class={`prio-row-${r.priority.toLowerCase()}`}>
                      <td data-label="Referensi" class="cell-ref">
                        <a class="ref-link" href={`/console/jobs/${r.id}`}>
                          {r.public_ref}
                        </a>
                        <span class="cell-sub">
                          {r.customer_name} · {SERVICE_LABEL[r.service_code] ?? r.service_code}
                        </span>
                      </td>
                      <td data-label="Status">
                        <StateBadge state={r.state} />
                      </td>
                      <td data-label="Berikutnya">
                        <span class={`next next-${na.who}`}>
                          {na.who === 'ops' && <Icon name="arrowRight" size={14} />}
                          {na.who === 'customer' && <Icon name="clock" size={14} />}
                          {na.label}
                        </span>
                      </td>
                      <td data-label="Indikator">
                        <span class="chip-list">
                          {r.prompt_status === 'READY' ? (
                            <Chip tone="success">Prompt siap</Chip>
                          ) : r.prompt_status === 'DRAFT' ? (
                            <Chip tone="neutral">Prompt draf</Chip>
                          ) : closed ? null : (
                            <a class="chip chip-link" href={`/console/jobs/${r.id}/studio`}>
                              Siapkan prompt
                            </a>
                          )}
                          {briefIncomplete(r) && <Chip tone="warning">Brief kurang</Chip>}
                          {r.state === 'NEEDS_INFO' && <Chip tone="warning">Menunggu klarifikasi</Chip>}
                          {(r.state === 'NEEDS_REVISION' || r.open_revisions > 0) && <Chip tone="review">Revisi{r.open_revisions ? ` · ${r.open_revisions}` : ''}</Chip>}
                          {r.state === 'DELIVERED' && <Chip tone="success">Terkirim</Chip>}
                        </span>
                      </td>
                      <td data-label="Prioritas">
                        <PriorityTag priority={r.priority} />
                      </td>
                      <td data-label="Pemilik">
                        {r.assignee_name ? (
                          <span class={r.assigned_operator_id === p.op.id ? 'owner owner-me' : 'owner'}>{r.assigned_operator_id === p.op.id ? 'Saya' : r.assignee_name}</span>
                        ) : (
                          <span class="muted">Belum ditugaskan</span>
                        )}
                      </td>
                      <td data-label="Pembaruan">
                        <Time iso={r.updated_at}>{relTime(r.updated_at, p.now)}</Time>
                        <span class={age.stale && r.state !== 'DELIVERED' && r.state !== 'CANCELLED' ? 'cell-sub age-stale' : 'cell-sub'} title={`Masuk ${fmtDateTime(r.created_at)}`}>
                          umur {age.text}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {pages > 1 && (
          <nav class="pager" aria-label="Halaman hasil">
            {page > 1 ? (
              <a class="btn btn-secondary btn-sm" href={queueHref(f, { page: page - 1 })} rel="prev">
                <Icon name="arrowLeft" size={14} />
                Sebelumnya
              </a>
            ) : (
              <span class="btn btn-secondary btn-sm is-disabled" aria-disabled="true">
                <Icon name="arrowLeft" size={14} />
                Sebelumnya
              </span>
            )}
            <span class="pager-info">
              Halaman {page} dari {pages}
            </span>
            {page < pages ? (
              <a class="btn btn-secondary btn-sm" href={queueHref(f, { page: page + 1 })} rel="next">
                Berikutnya
                <Icon name="arrowRight" size={14} />
              </a>
            ) : (
              <span class="btn btn-secondary btn-sm is-disabled" aria-disabled="true">
                Berikutnya
                <Icon name="arrowRight" size={14} />
              </span>
            )}
          </nav>
        )}
      </section>
    </Layout>
  )
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------
export type Metric = { label: string; value: string | null; sample: string; definition: string }

export const MetricsPage: FC<Base & { metrics: Metric[]; byState: { label: string; state: JobState; n: number }[]; total: number }> = (p) => (
  <Layout title="Metrik" op={p.op} csrf={p.csrf} active="metrics">
    <PageHeader
      eyebrow="Metrik operasional"
      title="Kinerja produksi"
      description="Semua angka dihitung langsung dari catatan D1 saat halaman dibuka — bukan perkiraan dan bukan target."
    />
    <Alert tone="info" title="Belum ada target">
      Target numerik baru ditetapkan setelah ada baseline dari 10–20 pekerjaan nyata (docs/06). “Belum ada data” berarti belum ada pekerjaan yang memenuhi syarat
      perhitungan — bukan nol.
    </Alert>
    <section class="metric-grid" aria-label="Metrik utama">
      {p.metrics.map((m) => (
        <article class="metric" data-animate="item">
          <p class="metric-label">{m.label}</p>
          <p class={`metric-value${m.value === null ? ' is-empty' : ''}`}>{m.value ?? 'Belum ada data'}</p>
          <p class="metric-sample">{m.sample}</p>
          <details class="metric-def">
            <summary>Cara menghitung</summary>
            <p>{m.definition}</p>
          </details>
        </article>
      ))}
    </section>
    <Section id="by-state" title="Pekerjaan per status" icon="list" description={`Total ${p.total} pekerjaan tercatat.`}>
      {p.byState.length === 0 ? (
        <EmptyState title="Belum ada pekerjaan">Pekerjaan akan muncul setelah permintaan pertama masuk dari Public Embrilo.</EmptyState>
      ) : (
        <ul class="bars">
          {p.byState.map((r) => (
            <li class="bar-row">
              <span class="bar-label">
                <StateBadge state={r.state} />
              </span>
              <progress class="bar-meter" max={p.total} value={r.n} data-animate="bar" aria-label={`${r.label}: ${r.n} dari ${p.total}`}>
                {r.n}
              </progress>
              <span class="bar-value">{r.n}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  </Layout>
)

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------
export type AuditRow = {
  created_at: string
  actor_type: string
  actor_id: string
  actor_name: string | null
  action: string
  resource_type: string
  resource_id: string
  correlation_id: string
  metadata_json: string
}

export const AuditPage: FC<Base & { rows: AuditRow[]; filter: { type?: string; q?: string }; nextBefore?: string; now: number }> = (p) => (
  <Layout title="Audit" op={p.op} csrf={p.csrf} active="audit">
    <PageHeader
      eyebrow="Khusus admin"
      title="Jejak audit"
      description="Catatan kronologis setiap tindakan. Metadata dibatasi pada ID, kode, dan jumlah — tidak pernah isi brief atau rahasia."
    />
    <form method="get" action="/console/audit" class="card filter-bar" role="search" data-animate="enter">
      <div class="field">
        <label class="field-label" for="audit-type">
          Jenis kejadian
        </label>
        <select id="audit-type" name="type">
          <option value="">Semua jenis</option>
          {AUDIT_TYPES.map((t) => (
            <option value={t.id} selected={p.filter.type === t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      <div class="field grow">
        <label class="field-label" for="audit-q">
          Correlation ID atau ID sumber
        </label>
        <input id="audit-q" type="search" name="q" value={p.filter.q ?? ''} maxlength={64} placeholder="mis. 3f2a9c1e atau ID pekerjaan" />
      </div>
      <div class="filter-actions">
        <button type="submit" class="btn btn-secondary">
          <Icon name="filter" size={16} />
          Terapkan
        </button>
        {(p.filter.type || p.filter.q) && (
          <a class="btn btn-ghost" href="/console/audit">
            Reset
          </a>
        )}
      </div>
    </form>
    {p.rows.length === 0 ? (
      <EmptyState icon="shield" title="Tidak ada kejadian yang cocok">
        Ubah filter atau reset untuk melihat semua kejadian.
      </EmptyState>
    ) : (
      <section class="card" aria-label="Daftar kejadian audit" data-animate="enter">
        <ol class="audit-list">
          {p.rows.map((r) => {
            let meta: Record<string, unknown> = {}
            try {
              meta = JSON.parse(r.metadata_json)
            } catch {
              /* ignore malformed */
            }
            const metaKeys = Object.keys(meta)
            return (
              <li class="audit-item" data-animate="row">
                <div class="audit-time">
                  <Time iso={r.created_at}>{relTime(r.created_at, p.now)}</Time>
                  <span class="cell-sub">{fmtDateTime(r.created_at)}</span>
                </div>
                <div class="audit-main">
                  <p class="audit-action">
                    {auditActionLabel(r.action)} <code class="code-soft">{r.action}</code>
                  </p>
                  <p class="cell-sub">
                    {r.actor_type === 'OPERATOR' ? 'Operator' : r.actor_type === 'CONNECTOR' ? 'Connector (Public Embrilo)' : 'Sistem'}:{' '}
                    <strong>{r.actor_name ?? r.actor_id.slice(0, 18)}</strong> ·{' '}
                    {r.resource_type === 'job' ? (
                      <a href={`/console/jobs/${r.resource_id}`}>pekerjaan {r.resource_id.slice(0, 8)}</a>
                    ) : (
                      `${r.resource_type} ${r.resource_id.slice(0, 8)}`
                    )}{' '}
                    · cid <code class="code-soft">{r.correlation_id}</code>
                  </p>
                  {metaKeys.length > 0 && (
                    <details class="audit-meta">
                      <summary>Metadata ({metaKeys.length})</summary>
                      <dl>
                        {metaKeys.map((k) => (
                          <>
                            <dt>{k}</dt>
                            <dd>
                              <code class="code-soft">{typeof meta[k] === 'string' ? (meta[k] as string) : JSON.stringify(meta[k])}</code>
                            </dd>
                          </>
                        ))}
                      </dl>
                    </details>
                  )}
                </div>
              </li>
            )
          })}
        </ol>
        {p.nextBefore && (
          <div class="card-foot">
            <a
              class="btn btn-secondary btn-sm"
              href={`/console/audit?${new URLSearchParams({ ...(p.filter.type ? { type: p.filter.type } : {}), ...(p.filter.q ? { q: p.filter.q } : {}), before: p.nextBefore }).toString()}`}
            >
              Muat kejadian lebih lama
            </a>
          </div>
        )}
      </section>
    )}
  </Layout>
)

// ---------------------------------------------------------------------------
const ERROR_COPY: Record<number, { title: string; body: string }> = {
  400: { title: 'Permintaan tidak valid', body: 'Data yang dikirim tidak bisa diproses. Kembali dan coba lagi.' },
  403: { title: 'Akses ditolak', body: 'Peran Anda tidak mengizinkan tindakan ini, atau token keamanan kedaluwarsa. Muat ulang halaman lalu coba lagi.' },
  404: { title: 'Tidak ditemukan', body: 'Halaman atau data yang Anda cari tidak ada, atau Anda tidak berhak melihatnya.' },
  409: { title: 'Status sudah berubah', body: 'Pekerjaan ini sudah berubah. Buka lagi untuk melihat status terbaru.' },
  413: { title: 'File terlalu besar', body: 'Batas unggahan adalah 10 MB.' },
  415: { title: 'Jenis file tidak didukung', body: 'Gunakan txt, md, csv, pdf, docx, png, jpg, atau webp.' },
  429: { title: 'Terlalu banyak permintaan', body: 'Tunggu sebentar, lalu coba lagi.' },
  500: { title: 'Terjadi kesalahan', body: 'Ada kesalahan tak terduga di server. Coba lagi; jika berulang, laporkan kode referensi di bawah ke admin.' },
  503: { title: 'Layanan belum siap', body: 'Konfigurasi layanan belum lengkap. Hubungi admin.' }
}

export const ErrorPage: FC<{ status: number; message?: string; reference?: string; op?: OperatorCtx; csrf?: string; children?: Child }> = (p) => {
  const copy = ERROR_COPY[p.status] ?? ERROR_COPY[500]
  return (
    <Layout title={copy.title} op={p.op} csrf={p.csrf}>
      <section class={`error-page${p.op ? '' : ' error-bare'}`} aria-labelledby="error-title" data-animate="enter">
        <p class="error-code">Kode {p.status}</p>
        <h1 id="error-title" class="page-title">
          {copy.title}
        </h1>
        <p class="page-desc">{p.message ?? copy.body}</p>
        {p.reference && (
          <p class="muted small">
            Referensi: <code class="code-soft">{p.reference}</code>
          </p>
        )}
        <div class="error-actions">
          {p.op ? (
            <a class="btn btn-primary" href="/console">
              <Icon name="arrowLeft" size={16} />
              Kembali ke antrean
            </a>
          ) : (
            <a class="btn btn-primary" href="/login">
              Ke halaman masuk
            </a>
          )}
        </div>
      </section>
    </Layout>
  )
}

