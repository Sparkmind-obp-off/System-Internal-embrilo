import type { FC } from 'hono/jsx'
import { Csrf, Flash, Layout, StateBadge, fmt } from './layout'
import { STATES, STATE_LABEL, type JobState } from '../lib/state'
import type { OperatorCtx } from '../types'
import { PROVIDERS } from '../lib/providers'

type Base = { op: OperatorCtx; csrf: string; ok?: string; err?: string }

export const LoginPage: FC<{ csrf: string; err?: string }> = ({ csrf, err }) => (
  <Layout title="Login">
    <section class="card narrow" aria-labelledby="login-title">
      <h1 id="login-title">Operator login</h1>
      <p class="muted">Internal access only. All actions are audited.</p>
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
        <button type="submit" class="btn primary">Log in</button>
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
  <Layout title="Queue" op={p.op} csrf={p.csrf}>
    <h1>Job queue</h1>
    <Flash ok={p.ok} err={p.err} />
    <nav class="filters" aria-label="Filter by state">
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
      <p class="empty">No jobs in this view.</p>
    ) : (
      <table class="table">
        <caption class="sr-only">Jobs</caption>
        <thead>
          <tr>
            <th scope="col">Reference</th>
            <th scope="col">Customer</th>
            <th scope="col">Service</th>
            <th scope="col">State</th>
            <th scope="col">Priority</th>
            <th scope="col">Assignee</th>
            <th scope="col">Updated</th>
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
              <td>{r.assignee_name ?? <span class="muted">unassigned</span>}</td>
              <td>{fmt(r.updated_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </Layout>
)

export const MetricsPage: FC<Base & { m: Record<string, number | string | null>; byState: { state: string; n: number }[] }> = (p) => (
  <Layout title="Metrics" op={p.op} csrf={p.csrf}>
    <h1>Operations metrics</h1>
    <p class="muted">Computed live from D1. Baselines need 10–20 real jobs before setting targets (docs/06).</p>
    <section class="grid-cards" aria-label="Key metrics">
      {Object.entries(p.m).map(([k, v]) => (
        <div class="metric">
          <div class="metric-value">{v ?? '—'}</div>
          <div class="metric-label">{k}</div>
        </div>
      ))}
    </section>
    <h2>Jobs by state</h2>
    <table class="table">
      <thead>
        <tr>
          <th scope="col">State</th>
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
    <h1>Audit trail</h1>
    <p class="muted">Latest 200 events. Metadata is limited to ids, codes and counts.</p>
    <table class="table small">
      <thead>
        <tr>
          <th scope="col">Time</th>
          <th scope="col">Actor</th>
          <th scope="col">Action</th>
          <th scope="col">Resource</th>
          <th scope="col">Correlation</th>
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
  <Layout title="Providers" op={p.op} csrf={p.csrf}>
    <h1>Production providers</h1>
    <Flash ok={p.ok} err={p.err} />
    <section class="callout warn">
      <h2>Genspark integration status: manual-assisted only</h2>
      <p>
        No Genspark generation API, connector or MCP endpoint that this Worker can call has been verified. Every Genspark run is a
        <strong> manual handoff</strong>: the console prepares a sanitized prompt, the operator runs it in their own Genspark workspace,
        reviews the output and attaches it here. The run records who did it, the template version and a digest of the prompt.
      </p>
      <p>
        To add an automated adapter later: verify a documented, supported integration, store its credential as a Worker secret, implement{' '}
        <code>execute()</code> in <code>src/lib/providers.ts</code>, and record end-to-end test evidence in{' '}
        <code>docs/08-implementation-status.md</code>.
      </p>
    </section>
    <table class="table">
      <thead>
        <tr>
          <th scope="col">Adapter</th>
          <th scope="col">Mode</th>
          <th scope="col">Automated &amp; verified</th>
          <th scope="col">How it works</th>
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
