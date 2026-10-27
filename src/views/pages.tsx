import type { FC } from 'hono/jsx'
import { Csrf, Flash, Layout, StateBadge, fmt } from './layout'
import { STATES, STATE_LABEL, type JobState } from '../lib/state'
import type { OperatorCtx } from '../types'
import { PROVIDERS } from '../lib/providers'

type Base = { op: OperatorCtx; csrf: string; ok?: string; err?: string }

export const LoginPage: FC<{ csrf: string; err?: string }> = ({ csrf, err }) => (
  <Layout title="Masuk">
    <section class="card narrow" aria-labelledby="login-title">
      <h1 id="login-title">Masuk operator</h1>
      <p class="muted">Akses khusus tim internal. Setiap tindakan tercatat di audit.</p>
      <Flash err={err} />
      <form method="post" action="/login" class="stack">
        <input type="hidden" name="_lcsrf" value={csrf} />
        <label>
          Email
          <input type="email" name="email" required autocomplete="username" maxlength={254} />
        </label>
        <label>
          Password
          <input type="password" name="password" required autocomplete="current-password" maxlength={256} />
        </label>
        <button type="submit" class="btn primary">Masuk</button>
      </form>
    </section>
  </Layout>
)

export type QueueRow = {
  id: string
  public_ref: string
  service_code: string
  state: JobState
  priority: string
  customer_name: string
  assignee_name: string | null
  updated_at: string
  created_at: string
}

export const QueuePage: FC<Base & { rows: QueueRow[]; counts: Record<string, number>; filter: { state?: string; mine?: boolean } }> = (p) => (
  <Layout title="Antrean" op={p.op} csrf={p.csrf}>
    <h1>Antrean pekerjaan</h1>
    <Flash ok={p.ok} err={p.err} />
    <nav class="filters" aria-label="Filter berdasarkan status">
      <a href="/console" class={!p.filter.state && !p.filter.mine ? 'active' : ''}>
        Open <span class="count">{p.counts.__open ?? 0}</span>
      </a>
      <a href="/console?mine=1" class={p.filter.mine ? 'active' : ''}>
        Assigned to me
      </a>
      {STATES.map((s) => (
        <a href={`/console?state=${s}`} class={p.filter.state === s ? 'active' : ''}>
          {STATE_LABEL[s]} <span class="count">{p.counts[s] ?? 0}</span>
        </a>
      ))}
    </nav>
    {p.rows.length === 0 ? (
      <p class="empty">Belum ada pekerjaan pada tampilan ini.</p>
    ) : (
      <table class="table">
        <caption class="sr-only">Jobs</caption>
        <thead>
          <tr>
            <th scope="col">Referensi</th>
            <th scope="col">Pelanggan</th>
            <th scope="col">Layanan</th>
            <th scope="col">Status</th>
            <th scope="col">Prioritas</th>
            <th scope="col">Penanggung jawab</th>
            <th scope="col">Diperbarui</th>
          </tr>
        </thead>
        <tbody>
          {p.rows.map((r) => (
            <tr>
              <td>
                <a href={`/console/jobs/${r.id}`}>{r.public_ref}</a>
              </td>
              <td>{r.customer_name}</td>
              <td>{r.service_code}</td>
              <td>
                <StateBadge state={r.state} />
              </td>
              <td>
                <span class={`prio prio-${r.priority.toLowerCase()}`}>{r.priority}</span>
              </td>
              <td>{r.assignee_name ?? <span class="muted">belum ditugaskan</span>}</td>
              <td>{fmt(r.updated_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </Layout>
)

export const MetricsPage: FC<Base & { m: Record<string, number | string | null>; byState: { state: string; n: number }[] }> = (p) => (
  <Layout title="Metrik" op={p.op} csrf={p.csrf}>
    <h1>Metrik operasional</h1>
    <p class="muted">Dihitung langsung dari D1. Gunakan 10–20 pekerjaan nyata untuk menetapkan baseline sebelum menentukan target (docs/06).</p>
    <section class="grid-cards" aria-label="Metrik utama">
      {Object.entries(p.m).map(([k, v]) => (
        <div class="metric">
          <div class="metric-value">{v ?? '—'}</div>
          <div class="metric-label">{k}</div>
        </div>
      ))}
    </section>
    <h2>Pekerjaan berdasarkan status</h2>
    <table class="table">
      <thead>
        <tr>
          <th scope="col">Status</th>
          <th scope="col">Jobs</th>
        </tr>
      </thead>
      <tbody>
        {p.byState.map((r) => (
          <tr>
            <td>
              <StateBadge state={r.state as JobState} />
            </td>
            <td>{r.n}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </Layout>
)

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

export const AuditPage: FC<Base & { rows: AuditRow[] }> = (p) => (
  <Layout title="Audit" op={p.op} csrf={p.csrf}>
    <h1>Jejak audit</h1>
    <p class="muted">200 aktivitas terbaru. Metadata dibatasi pada ID, kode, dan jumlah.</p>
    <table class="table small">
      <thead>
        <tr>
          <th scope="col">Waktu</th>
          <th scope="col">Pelaku</th>
          <th scope="col">Tindakan</th>
          <th scope="col">Sumber daya</th>
          <th scope="col">Korelasi</th>
          <th scope="col">Metadata</th>
        </tr>
      </thead>
      <tbody>
        {p.rows.map((r) => (
          <tr>
            <td>{fmt(r.created_at)}</td>
            <td>
              {r.actor_type}: {r.actor_name ?? r.actor_id.slice(0, 18)}
            </td>
            <td>
              <code>{r.action}</code>
            </td>
            <td>
              {r.resource_type === 'job' ? <a href={`/console/jobs/${r.resource_id}`}>job {r.resource_id.slice(0, 8)}</a> : `${r.resource_type} ${r.resource_id.slice(0, 8)}`}
            </td>
            <td>
              <code>{r.correlation_id.slice(0, 13)}</code>
            </td>
            <td>
              <code class="meta">{r.metadata_json}</code>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </Layout>
)

export const ProvidersPage: FC<Base> = (p) => (
  <Layout title="Produksi AI" op={p.op} csrf={p.csrf}>
    <h1>Provider produksi</h1>
    <Flash ok={p.ok} err={p.err} />
    <section class="callout warn">
      <h2>Status integrasi Genspark: masih dengan bantuan manual</h2>
      <p>
        Belum ada API generasi, connector, atau endpoint MCP Genspark yang terverifikasi untuk dipanggil oleh Worker ini. Setiap proses Genspark masih merupakan
        <strong> serah-terima manual</strong>: the console prepares a sanitized prompt, the operator runs it in their own Genspark workspace,
        reviews the output and attaches it here. The run records who did it, the template version and a digest of the prompt.
      </p>
      <p>
        Untuk menambahkan adapter otomatis nanti: verifikasi integrasi yang terdokumentasi dan didukung, simpan kredensial sebagai secret Worker, lalu implementasikan{' '}
        <code>execute()</code> in <code>src/lib/providers.ts</code>, and record end-to-end test evidence in{' '}
        <code>docs/08-implementation-status.md</code>.
      </p>
    </section>
    <table class="table">
      <thead>
        <tr>
          <th scope="col">Adapter</th>
          <th scope="col">Mode</th>
          <th scope="col">Otomatis &amp; terverifikasi</th>
          <th scope="col">Cara kerja</th>
        </tr>
      </thead>
      <tbody>
        {PROVIDERS.map((pr) => (
          <tr>
            <td>
              <strong>{pr.label}</strong>
              <br />
              <code>{pr.id}</code>
            </td>
            <td>{pr.mode}</td>
            <td>{pr.verified ? 'yes' : 'no — manual'}</td>
            <td>{pr.description}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </Layout>
)

export const ErrorPage: FC<{ status: number; message: string; op?: OperatorCtx; csrf?: string }> = (p) => (
  <Layout title={`Error ${p.status}`} op={p.op} csrf={p.csrf}>
    <section class="card narrow">
      <h1>Error {p.status}</h1>
      <p>{p.message}</p>
      <p>
        <a href="/console">Back to queue</a>
      </p>
    </section>
  </Layout>
)

export { Csrf }
