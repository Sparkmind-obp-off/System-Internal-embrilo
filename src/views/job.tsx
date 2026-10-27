import type { FC } from 'hono/jsx'
import { Csrf, Flash, Layout, StateBadge, fmt } from './layout'
import { customerStatus, type JobState } from '../lib/state'
import { PLATFORMS, LANGUAGES, PRIORITIES } from '../lib/validate'
import { PROVIDERS, PROVIDER_ERROR_CODES } from '../lib/providers'
import { QC_CHECKLIST } from '../services/jobs'
import type { OperatorCtx } from '../types'

export type JobDetail = {
  job: {
    id: string
    state: JobState
    priority: string
    attempts: number
    revision_round: number
    assigned_operator_id: string | null
    customer_message: string
    created_at: string
    updated_at: string
    delivered_at: string | null
  }
  order: { public_ref: string; service_code: string; customer_name: string; customer_ref: string }
  brief: {
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
  history: { from_state: string | null; to_state: string; actor_type: string; actor_name: string | null; reason: string; correlation_id: string; created_at: string }[]
  runs: {
    id: string
    provider: string
    mode: string
    template_version: string
    status: string
    input_digest: string
    operator_name: string | null
    error_code: string | null
    error_note: string | null
    operator_minutes: number | null
    cost_estimate_cents: number | null
    started_at: string
    finished_at: string | null
    output_asset_id: string | null
  }[]
  assets: { id: string; kind: string; filename: string; size_bytes: number; visibility: string; storage: string; created_at: string }[]
  reviews: { decision: string; reviewer_name: string | null; checklist_json: string; notes: string; created_at: string; run_id: string }[]
  revisions: { round: number; source: string; summary: string; status: string; created_at: string }[]
  operators: { id: string; display_name: string }[]
  draftPreview: string | null
  prompt: string | null
  maxRevisions: number
  r2Configured: boolean
}

const canWrite = (op: OperatorCtx) => op.role === 'ADMIN' || op.role === 'OPERATOR'

export const JobPage: FC<{ op: OperatorCtx; csrf: string; ok?: string; err?: string; d: JobDetail }> = ({ op, csrf, ok, err, d }) => {
  const { job, order, brief } = d
  const s = job.state
  const w = canWrite(op)
  const runningRun = d.runs.find((r) => r.status === 'RUNNING')
  const base = `/console/jobs/${job.id}`
  return (
    <Layout title={order.public_ref} op={op} csrf={csrf}>
      <p>
        <a href="/console">← Queue</a>
      </p>
      <header class="job-head">
        <h1>
          {order.public_ref} <StateBadge state={s} />
        </h1>
        <p class="muted">
          {order.service_code} · customer <strong>{order.customer_name}</strong> · priority {job.priority} · attempts {job.attempts} · revision
          round {job.revision_round}/{d.maxRevisions} · customer sees: <code>{customerStatus(s)}</code>
        </p>
      </header>
      <Flash ok={ok} err={err} />
      {!w && <p class="callout">Peran hanya-baca: tindakan disembunyikan dan tetap diblokir oleh server.</p>}

      <div class="cols">
        <div class="col-main">
          {/* ---------------- Tindakan berikutnya panel ---------------- */}
          {w && (
            <section class="card" aria-labelledby="actions-title">
              <h2 id="actions-title">Tindakan berikutnya</h2>

              {s === 'SUBMITTED' && (
                <form method="post" action={`${base}/triage`}>
                  <Csrf token={csrf} />
                  <input type="hidden" name="action" value="start" />
                  <button class="btn primary">Mulai pemeriksaan</button>
                </form>
              )}

              {s === 'NEEDS_INFO' && (
                <>
                  <p>Menunggu informasi pelanggan. Pesan yang ditampilkan kepada pelanggan: “{job.customer_message}”.</p>
                  <form method="post" action={`${base}/triage`}>
                    <Csrf token={csrf} />
                    <input type="hidden" name="action" value="start" />
                    <button class="btn">Informasi diterima → kembali ke pemeriksaan</button>
                  </form>
                </>
              )}

              {s === 'TRIAGE' && (
                <div class="stack">
                  <form method="post" action={`${base}/triage`} class="row">
                    <Csrf token={csrf} />
                    <input type="hidden" name="action" value="queue" />
                    <label>
                      Prioritas
                      <select name="priority">
                        {PRIORITIES.map((p) => (
                          <option value={p} selected={p === job.priority}>
                            {p}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button class="btn primary" disabled={!brief.rights_confirmed}>
                      Qualify → queue
                    </button>
                    {!brief.rights_confirmed && <span class="muted">Hak penggunaan belum dikonfirmasi — pekerjaan belum bisa masuk antrean.</span>}
                  </form>
                  <form method="post" action={`${base}/triage`} class="stack">
                    <Csrf token={csrf} />
                    <input type="hidden" name="action" value="needs_info" />
                    <label>
                      Message to customer (customer-safe, what is missing)
                      <textarea name="customer_message" rows={2} maxlength={1000} required></textarea>
                    </label>
                    <button class="btn">Minta informasi tambahan</button>
                  </form>
                </div>
              )}

              {(s === 'QUEUED' || s === 'NEEDS_REVISION' || s === 'BLOCKED_PROVIDER') && (
                <form method="post" action={`${base}/start-production`} class="row">
                  <Csrf token={csrf} />
                  <label>
                    Provider
                    <select name="provider">
                      {PROVIDERS.map((p) => (
                        <option value={p.id}>{p.label}</option>
                      ))}
                    </select>
                  </label>
                  <button class="btn primary">Mulai proses produksi</button>
                </form>
              )}

              {(s === 'FAILED' || s === 'BLOCKED_PROVIDER' || s === 'NEEDS_REVISION') && (
                <form method="post" action={`${base}/requeue`} class="row">
                  <Csrf token={csrf} />
                  <button class="btn">Kembali ke antrean</button>
                </form>
              )}

              {s === 'IN_PRODUCTION' && runningRun && (
                <div class="stack">
                  <p>
                    Run <code>{runningRun.id.slice(0, 8)}</code> via <strong>{runningRun.provider}</strong> ({runningRun.mode}). Copy the
                    sanitized prompt, run it in your Genspark workspace, review the output, then attach it below.
                  </p>
                  {d.prompt && (
                    <div class="prompt-box">
                      <div class="row between">
                        <strong>Prompt yang sudah disanitasi · {runningRun.template_version}</strong>
                        <button type="button" class="btn small" data-copy="#prompt-text">
                          Salin prompt
                        </button>
                      </div>
                      <textarea id="prompt-text" readonly rows={14}>
                        {d.prompt}
                      </textarea>
                      <p class="muted small">
                        Check before pasting: no emails, phone numbers, credentials or other customers’ data. Prompt digest{' '}
                        <code>{runningRun.input_digest.slice(0, 16)}</code>.
                      </p>
                    </div>
                  )}
                  <form method="post" action={`${base}/production-result`} enctype="multipart/form-data" class="stack">
                    <Csrf token={csrf} />
                    <input type="hidden" name="run_id" value={runningRun.id} />
                    <label>
                      Generated output (paste text)
                      <textarea name="output_text" rows={10} maxlength={200000}></textarea>
                    </label>
                    {d.r2Configured ? (
                      <label>
                        …or attach a file (txt, md, csv, pdf, docx, png, jpg, webp · max 10 MB)
                        <input type="file" name="output_file" accept=".txt,.md,.csv,.pdf,.docx,.png,.jpg,.jpeg,.webp" />
                      </label>
                    ) : (
                      <p class="muted small">Lampiran file belum aktif: binding R2 belum dikonfigurasi di lingkungan ini.</p>
                    )}
                    <div class="row">
                      <label>
                        Durasi kerja operator (menit)
                        <input type="number" name="operator_minutes" min={0} max={10000} />
                      </label>
                      <label>
                        Est. cost (cents)
                        <input type="number" name="cost_estimate_cents" min={0} />
                      </label>
                    </div>
                    <button class="btn primary">Lampirkan draf → tinjauan kualitas</button>
                  </form>
                  <details>
                    <summary>Provider gagal / terblokir</summary>
                    <form method="post" action={`${base}/production-failure`} class="stack">
                      <Csrf token={csrf} />
                      <input type="hidden" name="run_id" value={runningRun.id} />
                      <div class="row">
                        <label>
                          Error
                          <select name="error_code">
                            {PROVIDER_ERROR_CODES.map((e) => (
                              <option value={e}>{e}</option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Outcome
                          <select name="outcome">
                            <option value="BLOCKED_PROVIDER">Terblokir (coba lagi nanti)</option>
                            <option value="FAILED">Gagal (masukkan kembali ke antrean)</option>
                          </select>
                        </label>
                        <label>
                          Minutes
                          <input type="number" name="operator_minutes" min={0} max={10000} />
                        </label>
                      </div>
                      <label>
                        Note (no secrets / private content)
                        <input type="text" name="note" maxlength={1000} />
                      </label>
                      <button class="btn danger">Catat kegagalan provider</button>
                    </form>
                  </details>
                </div>
              )}

              {s === 'QC_REVIEW' && (
                <form method="post" action={`${base}/review`} class="stack">
                  <Csrf token={csrf} />
                  <fieldset>
                    <legend>QC checklist (all must pass to approve)</legend>
                    {QC_CHECKLIST.map(([key, label]) => (
                      <label class="check">
                        <input type="checkbox" name={key} /> {label}
                      </label>
                    ))}
                  </fieldset>
                  <label>
                    Reviewer notes (required for revision)
                    <textarea name="notes" rows={3} maxlength={2000}></textarea>
                  </label>
                  <div class="row">
                    <button class="btn primary" name="decision" value="APPROVE">
                      Setujui
                    </button>
                    <button class="btn" name="decision" value="REQUEST_REVISION">
                      Minta revisi
                    </button>
                  </div>
                </form>
              )}

              {s === 'APPROVED' && (
                <form method="post" action={`${base}/deliver`} class="row">
                  <Csrf token={csrf} />
                  <button class="btn primary">Kirim hasil yang disetujui kepada pelanggan</button>
                </form>
              )}

              {s === 'DELIVERED' && <p>Delivered {fmt(job.delivered_at)}. Pelanggan dapat mengajukan revisi melalui Public Embrilo.</p>}
              {s === 'CANCELLED' && <p>Pekerjaan dibatalkan.</p>}

              {op.role === 'ADMIN' && s !== 'CANCELLED' && s !== 'DELIVERED' && (
                <details class="danger-zone">
                  <summary>Batalkan pekerjaan (admin)</summary>
                  <form method="post" action={`${base}/cancel`} class="row">
                    <Csrf token={csrf} />
                    <input type="text" name="reason" minlength={3} maxlength={500} placeholder="Alasan" required />
                    <button class="btn danger">Batalkan pekerjaan</button>
                  </form>
                </details>
              )}
            </section>
          )}

          {/* ---------------- Draft preview ---------------- */}
          {d.draftPreview !== null && (
            <section class="card" aria-labelledby="draft-title">
              <h2 id="draft-title">Draf terbaru</h2>
              <pre class="draft">{d.draftPreview}</pre>
            </section>
          )}

          {/* ---------------- Workspace brief ---------------- */}
          <section class="card" aria-labelledby="brief-title">
            <h2 id="brief-title">Workspace brief</h2>
            <p class="muted small">Konten dari pelanggan diperlakukan sebagai input yang belum tepercaya. Tautan referensi tidak diambil oleh server.</p>
            {w ? (
              <form method="post" action={`${base}/brief`} class="stack">
                <Csrf token={csrf} />
                <label>
                  Tujuan
                  <textarea name="objective" rows={2} maxlength={2000} required>
                    {brief.objective}
                  </textarea>
                </label>
                <label>
                  Audiens
                  <textarea name="audience" rows={2} maxlength={1000} required>
                    {brief.audience}
                  </textarea>
                </label>
                <label>
                  Fakta produk (verified)
                  <textarea name="product_facts" rows={4} maxlength={5000} required>
                    {brief.product_facts}
                  </textarea>
                </label>
                <fieldset>
                  <legend>Platform</legend>
                  {PLATFORMS.map((p) => (
                    <label class="check inline">
                      <input type="checkbox" name="platforms" value={p} checked={brief.platforms.includes(p)} /> {p}
                    </label>
                  ))}
                </fieldset>
                <div class="row">
                  <label>
                    Bahasa
                    <select name="language">
                      {LANGUAGES.map((l) => (
                        <option value={l} selected={l === brief.language}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Gaya bahasa
                    <input type="text" name="tone" value={brief.tone} maxlength={300} />
                  </label>
                  <label>
                    Ajakan bertindak
                    <input type="text" name="cta" value={brief.cta} maxlength={300} />
                  </label>
                </div>
                <label>
                  Batasan / prohibited claims
                  <textarea name="constraints" rows={2} maxlength={2000}>
                    {brief.constraints}
                  </textarea>
                </label>
                <label>
                  References (https, one per line, max 5)
                  <textarea name="references" rows={2}>
                    {brief.references.join('\n')}
                  </textarea>
                </label>
                <label class="check">
                  <input type="checkbox" name="rights_confirmed" checked={brief.rights_confirmed} /> Pelanggan mengonfirmasi hak penggunaan materi yang dikirim
                </label>
                <button class="btn">Simpan brief</button>
              </form>
            ) : (
              <dl class="brief">
                <dt>Tujuan</dt>
                <dd>{brief.objective}</dd>
                <dt>Audiens</dt>
                <dd>{brief.audience}</dd>
                <dt>Fakta produk</dt>
                <dd>{brief.product_facts}</dd>
                <dt>Platform</dt>
                <dd>{brief.platforms.join(', ')}</dd>
                <dt>Bahasa / gaya / Ajakan bertindak</dt>
                <dd>
                  {brief.language} / {brief.tone || '—'} / {brief.cta || '—'}
                </dd>
                <dt>Batasan</dt>
                <dd>{brief.constraints || '—'}</dd>
              </dl>
            )}
          </section>
        </div>

        <aside class="col-side">
          {w && (
            <section class="card" aria-labelledby="assign-title">
              <h2 id="assign-title">Penugasan</h2>
              <form method="post" action={`${base}/assign`} class="stack">
                <Csrf token={csrf} />
                <label>
                  Assignee
                  <select name="assignee_id">
                    <option value="">Belum ditugaskan</option>
                    {d.operators.map((o) => (
                      <option value={o.id} selected={o.id === job.assigned_operator_id}>
                        {o.display_name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Prioritas
                  <select name="priority">
                    {PRIORITIES.map((p) => (
                      <option value={p} selected={p === job.priority}>
                        {p}
                      </option>
                    ))}
                  </select>
                </label>
                <button class="btn small">Simpan</button>
              </form>
            </section>
          )}

          <section class="card" aria-labelledby="assets-title">
            <h2 id="assets-title">Aset privat</h2>
            {d.assets.length === 0 ? (
              <p class="muted">Belum ada data.</p>
            ) : (
              <ul class="plain">
                {d.assets.map((a) => (
                  <li>
                    <a href={`/console/assets/${a.id}`}>{a.filename}</a>
                    <br />
                    <span class="muted small">
                      {a.kind} · {Math.ceil(a.size_bytes / 1024)} KB · {a.visibility} · {a.storage}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {w && d.r2Configured && s !== 'CANCELLED' && s !== 'DELIVERED' && (
              <form method="post" action={`${base}/reference`} enctype="multipart/form-data" class="stack">
                <Csrf token={csrf} />
                <label>
                  Add reference file
                  <input type="file" name="reference_file" accept=".txt,.md,.csv,.pdf,.docx,.png,.jpg,.jpeg,.webp" required />
                </label>
                <button class="btn small">Unggah</button>
              </form>
            )}
          </section>

          <section class="card" aria-labelledby="runs-title">
            <h2 id="runs-title">Riwayat produksi</h2>
            {d.runs.length === 0 ? (
              <p class="muted">Belum ada data.</p>
            ) : (
              <ul class="plain">
                {d.runs.map((r) => (
                  <li>
                    <strong>{r.status}</strong> · {r.provider} ({r.mode})<br />
                    <span class="muted small">
                      {r.template_version} · by {r.operator_name ?? '?'} · {fmt(r.started_at)}
                      {r.operator_minutes !== null && ` · ${r.operator_minutes} min`}
                      {r.cost_estimate_cents !== null && ` · ${r.cost_estimate_cents}¢`}
                      {r.error_code && ` · error ${r.error_code}`}
                      {r.error_note && ` — ${r.error_note}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section class="card" aria-labelledby="reviews-title">
            <h2 id="reviews-title">Tinjauan &amp; revisi</h2>
            {d.reviews.map((r) => (
              <p class="small">
                <strong>{r.decision}</strong> by {r.reviewer_name ?? '?'} · {fmt(r.created_at)}
                {r.notes && <>: {r.notes}</>}
              </p>
            ))}
            {d.revisions.map((r) => (
              <p class="small">
                Round {r.round} · {r.source} · {r.status}: {r.summary}
              </p>
            ))}
            {d.reviews.length === 0 && d.revisions.length === 0 && <p class="muted">Belum ada data.</p>}
          </section>

          <section class="card" aria-labelledby="history-title">
            <h2 id="history-title">Riwayat status</h2>
            <ol class="timeline">
              {d.history.map((h) => (
                <li>
                  <span class="small">
                    {h.from_state ?? '∅'} → <strong>{h.to_state}</strong>
                  </span>
                  <br />
                  <span class="muted small">
                    {h.actor_type}: {h.actor_name ?? '—'} · {fmt(h.created_at)} · cid {h.correlation_id.slice(0, 8)}
                    {h.reason && ` · ${h.reason}`}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        </aside>
      </div>
    </Layout>
  )
}
