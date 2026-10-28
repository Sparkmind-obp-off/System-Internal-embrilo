import type { Child, FC } from 'hono/jsx'
import { Alert, Chip, Csrf, EmptyState, Field, Flash, Layout, PageHeader, PriorityTag, Section, StateBadge, Time, describe } from './layout'
import { BrandMark, Icon } from './icons'
import type { JobState } from '../lib/state'
import type { OperatorCtx } from '../types'
import { PROVIDERS } from '../lib/providers'
import {
  AUDIT_TYPES,
  QUEUE_VIEWS,
  SERVICE_LABEL,
  ageLabel,
  auditActionLabel,
  fmtDateTime,
  nextAction,
  relTime,
  type QueueView
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
export type QueueRow = {
  id: string
  public_ref: string
  service_code: string
  state: JobState
  priority: string
  customer_name: string
  assignee_name: string | null
  assigned_operator_id: string | null
  updated_at: string
  created_at: string
  prompt_status: 'READY' | 'DRAFT' | null
  rights_confirmed: number | null
}

export type QueueFilter = { view?: QueueView; state?: JobState; mine?: boolean; q?: string; prio?: string }

function queueHref(f: QueueFilter, patch: Partial<QueueFilter>) {
  const n = { ...f, ...patch }
  const p = new URLSearchParams()
  if (n.view) p.set('view', n.view)
  if (n.state) p.set('state', n.state)
  if (n.mine) p.set('mine', '1')
  if (n.q) p.set('q', n.q)
  if (n.prio) p.set('prio', n.prio)
  const s = p.toString()
  return s ? `/console?${s}` : '/console'
}

export const QueuePage: FC<Base & { rows: QueueRow[]; viewCounts: Record<string, number>; openCount: number; mineCount: number; filter: QueueFilter; now: number }> = (p) => {
  const f = p.filter
  const activeView = QUEUE_VIEWS.find((v) => v.id === f.view)
  const title = activeView ? activeView.label : f.state ? `Status: ${f.state}` : f.mine ? 'Ditugaskan ke saya' : 'Perlu perhatian'
  const filtered = !!(f.q || f.prio)
  return (
    <Layout title="Antrean" op={p.op} csrf={p.csrf} active="queue">
      <PageHeader
        eyebrow="Inbox pesanan"
        title="Apa yang perlu dikerjakan sekarang"
        description="Pesanan dari Embrilo Public masuk ke sini. Buka pesanan untuk memahami brief, lalu siapkan prompt di Prompt Studio dan jalankan secara manual."
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
            <a role="listitem" class={`tab${!f.view && !f.state && !f.mine ? ' is-active' : ''}`} href={queueHref({ q: f.q, prio: f.prio }, {})}>
              Semua terbuka <span class="tab-count">{p.openCount}</span>
            </a>
            <a role="listitem" class={`tab${f.mine ? ' is-active' : ''}`} href={queueHref({ q: f.q, prio: f.prio }, { mine: true })}>
              Milik saya <span class="tab-count">{p.mineCount}</span>
            </a>
            <a role="listitem" class={`tab${f.view === 'done' ? ' is-active' : ''}`} href={queueHref({ q: f.q, prio: f.prio }, { view: 'done' })}>
              Selesai <span class="tab-count">{p.viewCounts.done ?? 0}</span>
            </a>
          </div>
          <form method="get" action="/console" class="queue-search" role="search">
            {f.view && <input type="hidden" name="view" value={f.view} />}
            {f.state && <input type="hidden" name="state" value={f.state} />}
            {f.mine && <input type="hidden" name="mine" value="1" />}
            <label class="sr-only" for="queue-q">
              Cari referensi atau pelanggan
            </label>
            <span class="search-wrap">
              <Icon name="search" size={16} />
              <input id="queue-q" type="search" name="q" value={f.q ?? ''} maxlength={64} placeholder="Cari referensi / pelanggan" />
            </span>
            <label class="sr-only" for="queue-prio">
              Prioritas
            </label>
            <select id="queue-prio" name="prio">
              <option value="">Semua prioritas</option>
              {(['URGENT', 'HIGH', 'NORMAL', 'LOW'] as const).map((x) => (
                <option value={x} selected={f.prio === x}>
                  {{ URGENT: 'Mendesak', HIGH: 'Tinggi', NORMAL: 'Normal', LOW: 'Rendah' }[x]}
                </option>
              ))}
            </select>
            <button type="submit" class="btn btn-secondary btn-sm">
              <Icon name="filter" size={16} />
              Terapkan
            </button>
          </form>
        </div>

        <div class="queue-head">
          <h2 class="card-title" id="queue-title">
            {title} <span class="muted">· {p.rows.length} pekerjaan</span>
          </h2>
          {filtered && (
            <a class="btn btn-ghost btn-sm" href={queueHref({ view: f.view, state: f.state, mine: f.mine }, {})}>
              <Icon name="x" size={14} />
              Hapus filter
            </a>
          )}
        </div>

        {p.rows.length === 0 ? (
          <EmptyState icon={filtered ? 'search' : 'check'} title={filtered ? 'Tidak ada yang cocok' : 'Tidak ada pekerjaan di sini'}>
            {filtered
              ? 'Coba kata kunci lain atau hapus filter prioritas.'
              : f.view === 'done'
                ? 'Pekerjaan yang terkirim atau dibatalkan akan muncul di sini.'
                : 'Bagian ini kosong. Permintaan baru dari Public Embrilo akan masuk otomatis.'}
          </EmptyState>
        ) : (
          <div class="table-wrap">
            <table class="table queue-table">
              <caption class="sr-only">Daftar pekerjaan: {title}</caption>
              <thead>
                <tr>
                  <th scope="col">Referensi</th>
                  <th scope="col">Status</th>
                  <th scope="col">Langkah berikutnya</th>
                  <th scope="col">Prompt</th>
                  <th scope="col">Prioritas</th>
                  <th scope="col">Pemilik</th>
                  <th scope="col">Umur</th>
                </tr>
              </thead>
              <tbody>
                {p.rows.map((r) => {
                  const age = ageLabel(r.created_at, p.now)
                  const na = nextAction(r.state)
                  return (
                    <tr data-animate="row" class={`prio-row-${r.priority.toLowerCase()}`}>
                      <td data-label="Referensi" class="cell-ref">
                        <a class="ref-link" href={`/console/jobs/${r.id}`}>{r.public_ref}</a>
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
                      <td data-label="Prompt">
                        {r.prompt_status === 'READY' ? (
                          <Chip tone="success">Siap</Chip>
                        ) : r.prompt_status === 'DRAFT' ? (
                          <Chip tone="neutral">Draf</Chip>
                        ) : ['DELIVERED', 'CANCELLED', 'APPROVED', 'QC_REVIEW', 'IN_PRODUCTION'].includes(r.state) ? (
                          <span class="muted small">—</span>
                        ) : (
                          <a class="small" href={`/console/jobs/${r.id}/studio`}>Siapkan</a>
                        )}
                        {r.rights_confirmed === 0 && <span class="cell-sub warn-text">Info kurang: hak materi</span>}
                      </td>
                      <td data-label="Prioritas">
                        <PriorityTag priority={r.priority} />
                      </td>
                      <td data-label="Pemilik">
                        {r.assignee_name ? (
                          <span class={r.assigned_operator_id === p.op.id ? 'owner owner-me' : 'owner'}>
                            {r.assigned_operator_id === p.op.id ? 'Saya' : r.assignee_name}
                          </span>
                        ) : (
                          <span class="muted">Belum ditugaskan</span>
                        )}
                      </td>
                      <td data-label="Umur">
                        <span class={age.stale && r.state !== 'DELIVERED' && r.state !== 'CANCELLED' ? 'age age-stale' : 'age'} title={`Masuk ${fmtDateTime(r.created_at)}`}>
                          {age.text}
                        </span>
                        <span class="cell-sub">
                          diperbarui <Time iso={r.updated_at}>{relTime(r.updated_at, p.now)}</Time>
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
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
// Production AI (provider) page
// ---------------------------------------------------------------------------
export const ProvidersPage: FC<Base> = (p) => (
  <Layout title="Produksi AI" op={p.op} csrf={p.csrf} active="providers">
    <PageHeader
      eyebrow="Integrasi produksi"
      title="Produksi AI: manual-assisted"
      description="Bagaimana draf dibuat, dan apa yang benar-benar terintegrasi saat ini."
    />
    <Alert tone="warning" title="Belum ada otomatisasi Genspark yang terverifikasi" icon="info">
      Aplikasi ini tidak memanggil Genspark secara otomatis. Tidak ada API, connector, atau MCP Genspark yang sudah diuji dari Worker ini. Setiap produksi adalah
      serah-terima manual oleh operator, dan dicatat lengkap (operator, versi template, digest prompt).
    </Alert>
    <Section id="handoff" title="Alur serah-terima" icon="clipboard" description="Dilakukan dari halaman detail pekerjaan saat status “Siap diproduksi”.">
      <ol class="steps">
        <li>
          <span class="step-n">1</span>
          <div>
            <p class="step-title">Mulai produksi</p>
            <p class="muted">Konsol membuat prompt tersanitasi dari brief: email, nomor telepon, dan string mirip kunci rahasia disamarkan otomatis.</p>
          </div>
        </li>
        <li>
          <span class="step-n">2</span>
          <div>
            <p class="step-title">Periksa & salin prompt</p>
            <p class="muted">Pastikan tidak ada data pribadi atau data pelanggan lain, lalu salin dengan satu klik.</p>
          </div>
        </li>
        <li>
          <span class="step-n">3</span>
          <div>
            <p class="step-title">Jalankan di Genspark</p>
            <p class="muted">Tempel di workspace Genspark Anda sendiri. Tinjau hasilnya — jangan percaya klaim yang tidak ada di brief.</p>
          </div>
        </li>
        <li>
          <span class="step-n">4</span>
          <div>
            <p class="step-title">Lampirkan hasil</p>
            <p class="muted">Tempel teks atau unggah file. Pekerjaan pindah ke tinjauan QC. Jika provider gagal, catat kegagalannya — pekerjaan tetap bisa dipulihkan.</p>
          </div>
        </li>
      </ol>
    </Section>
    <Section id="adapters" title="Adapter yang tersedia" icon="plug">
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Adapter</th>
              <th scope="col">Mode</th>
              <th scope="col">Otomatis & terverifikasi</th>
              <th scope="col">Cara kerja</th>
            </tr>
          </thead>
          <tbody>
            {PROVIDERS.map((pr) => (
              <tr>
                <td data-label="Adapter">
                  <strong>{pr.id === 'genspark-manual' ? 'Genspark (manual-assisted)' : 'Penulis manusia (tanpa AI)'}</strong>
                  <span class="cell-sub">
                    <code class="code-soft">{pr.id}</code>
                  </span>
                </td>
                <td data-label="Mode">
                  <Chip tone="neutral">{pr.mode === 'manual' ? 'Manual' : pr.mode}</Chip>
                </td>
                <td data-label="Terverifikasi">{pr.verified ? <Chip tone="success">Ya</Chip> : <Chip tone="muted">Tidak — manual</Chip>}</td>
                <td data-label="Cara kerja" class="cell-wrap">
                  {pr.id === 'genspark-manual'
                    ? 'Operator menyalin prompt tersanitasi ke workspace Genspark-nya, meninjau hasil, lalu menempel/mengunggahnya di sini. Tidak ada panggilan otomatis.'
                    : 'Operator menulis hasil langsung berdasarkan brief.'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p class="muted small">
        Untuk menambah adapter otomatis: verifikasi integrasi resmi yang terdokumentasi, simpan kredensialnya sebagai secret Worker, implementasikan <code>execute()</code> di{' '}
        <code>src/lib/providers.ts</code>, lalu catat bukti uji end-to-end di <code>docs/08-implementation-status.md</code>.
      </p>
    </Section>
  </Layout>
)

// ---------------------------------------------------------------------------
// Errors
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

export { Csrf, describe }
