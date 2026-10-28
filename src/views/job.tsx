import type { Child, FC } from 'hono/jsx'
import { Alert, Chip, Csrf, EmptyState, Field, Flash, Layout, PriorityTag, Section, StateBadge, STATE_LABEL_ID, Time, describe } from './layout'
import { Icon } from './icons'
import { customerStatus, type JobState } from '../lib/state'
import { PLATFORMS, LANGUAGES, PRIORITIES } from '../lib/validate'
import { PROVIDERS, PROVIDER_ERROR_CODES } from '../lib/providers'
import { QC_CHECKLIST, BRIEF_EDITABLE } from '../services/jobs'
import type { OperatorCtx } from '../types'
import {
  LANGUAGE_LABEL,
  PLATFORM_LABEL,
  PRIORITY_LABEL,
  PROVIDER_ERROR_LABEL,
  QC_LABEL,
  RUN_STATUS_LABEL,
  SERVICE_LABEL,
  WORKFLOW_STEPS,
  ageLabel,
  fmtDateTime,
  nextAction,
  relTime,
  workflowIndex
} from './labels'

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

/** A form that failed validation: which form, field errors (by input name) and submitted values. */
export type FormState = { id: string; errors: Record<string, string>; values: Record<string, unknown> }

const CUSTOMER_STATUS_LABEL: Record<string, string> = {
  received: 'Diterima',
  needs_info: 'Perlu informasi',
  in_progress: 'Sedang diproses',
  delivered: 'Terkirim',
  cancelled: 'Dibatalkan'
}

const canWrite = (op: OperatorCtx) => op.role === 'ADMIN' || op.role === 'OPERATOR'
const str = (v: unknown) => (typeof v === 'string' ? v : '')

export const JobPage: FC<{ op: OperatorCtx; csrf: string; ok?: string; err?: string; d: JobDetail; form?: FormState; now: number }> = ({ op, csrf, ok, err, d, form, now }) => {
  const { job, order, brief } = d
  const s = job.state
  const w = canWrite(op)
  const runningRun = d.runs.find((r) => r.status === 'RUNNING')
  const base = `/console/jobs/${job.id}`
  const fe = (formId: string, name: string) => (form?.id === formId ? form.errors[name] : undefined)
  const fv = (formId: string, name: string, fallback = '') => (form?.id === formId ? str(form.values[name]) : fallback)
  const owner = d.operators.find((o) => o.id === job.assigned_operator_id)
  const age = ageLabel(job.created_at, now)
  const na = nextAction(s)

  return (
    <Layout title={`${order.public_ref} · ${STATE_LABEL_ID[s]}`} op={op} csrf={csrf} active="queue">
      <nav class="breadcrumb" aria-label="Remah roti">
        <a href="/console">
          <Icon name="arrowLeft" size={16} />
          Antrean
        </a>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{order.public_ref}</span>
      </nav>

      {/* ---------------- Job header ---------------- */}
      <header class="job-header card" data-animate="enter">
        <div class="job-header-top">
          <div>
            <p class="eyebrow mono">{order.public_ref}</p>
            <h1 class="page-title">
              {SERVICE_LABEL[order.service_code] ?? order.service_code} <span class="title-sub">untuk {order.customer_name}</span>
            </h1>
          </div>
          <div class="job-header-chips">
            <StateBadge state={s} />
            <PriorityTag priority={job.priority} />
          </div>
        </div>
        <dl class="job-meta">
          <div>
            <dt>Langkah berikutnya</dt>
            <dd class={`next next-${na.who}`}>{na.label}</dd>
          </div>
          <div>
            <dt>Pemilik</dt>
            <dd>{owner ? (owner.id === op.id ? `${owner.display_name} (saya)` : owner.display_name) : <span class="muted">Belum ditugaskan</span>}</dd>
          </div>
          <div>
            <dt>Umur</dt>
            <dd>
              <span class={age.stale && s !== 'DELIVERED' && s !== 'CANCELLED' ? 'age age-stale' : 'age'}>{age.text}</span>
              <span class="cell-sub">masuk {fmtDateTime(job.created_at)}</span>
            </dd>
          </div>
          <div>
            <dt>Diperbarui</dt>
            <dd>
              <Time iso={job.updated_at}>{relTime(job.updated_at, now)}</Time>
            </dd>
          </div>
          <div>
            <dt>Percobaan · revisi</dt>
            <dd>
              {job.attempts} produksi · revisi {job.revision_round}/{d.maxRevisions}
            </dd>
          </div>
          <div>
            <dt>Dilihat pelanggan sebagai</dt>
            <dd>
              <Chip tone="muted" dot={false}>
                {CUSTOMER_STATUS_LABEL[customerStatus(s)]}
              </Chip>
            </dd>
          </div>
        </dl>
        <Stepper state={s} />
      </header>

      <Flash ok={ok} err={err} />
      {!w && (
        <Alert tone="info" title="Mode baca saja" icon="eye">
          Peran Anda hanya dapat melihat. Tombol aksi disembunyikan, dan server juga menolak perubahan dari peran ini.
        </Alert>
      )}

      <div class="job-grid">
        <div class="job-main">
          {/* ---------------- Next action ---------------- */}
          {w && (
            <section class="card action-panel" aria-labelledby="action-title" data-animate="enter" id="next-action">
              <div class="card-head">
                <div>
                  <p class="eyebrow">Langkah aman berikutnya</p>
                  <h2 class="card-title" id="action-title">
                    {actionTitle(s)}
                  </h2>
                </div>
              </div>
              <div class="card-body stack">
                {s === 'SUBMITTED' && (
                  <>
                    <p class="muted">Permintaan baru dari Public Embrilo. Mulai triase untuk memeriksa kelengkapan brief dan hak materi.</p>
                    <form method="post" action={`${base}/triage`}>
                      <Csrf token={csrf} />
                      <input type="hidden" name="action" value="start" />
                      <button class="btn btn-primary" data-submit-label="Memulai…">
                        <Icon name="play" size={16} />
                        Mulai triase
                      </button>
                    </form>
                  </>
                )}

                {s === 'NEEDS_INFO' && (
                  <>
                    <Alert tone="warning" title="Menunggu jawaban pelanggan" icon="clock">
                      Pesan yang dilihat pelanggan: “{job.customer_message}”
                    </Alert>
                    <form method="post" action={`${base}/triage`}>
                      <Csrf token={csrf} />
                      <input type="hidden" name="action" value="start" />
                      <button class="btn btn-primary" data-submit-label="Memproses…">
                        <Icon name="rotate" size={16} />
                        Informasi diterima — kembali ke triase
                      </button>
                    </form>
                  </>
                )}

                {s === 'TRIAGE' && (
                  <div class="triage-grid">
                    <form method="post" action={`${base}/triage`} class="option-card">
                      <Csrf token={csrf} />
                      <input type="hidden" name="action" value="queue" />
                      <p class="option-title">Brief lengkap</p>
                      <p class="muted small">Masukkan ke antrean produksi.</p>
                      {!brief.rights_confirmed && (
                        <p class="field-error">
                          <Icon name="alert" size={14} />
                          Hak materi belum dikonfirmasi. Konfirmasi di bagian Brief terlebih dahulu.
                        </p>
                      )}
                      <Field id="triage-priority" label="Prioritas">
                        <select id="triage-priority" name="priority">
                          {PRIORITIES.map((p) => (
                            <option value={p} selected={p === job.priority}>
                              {PRIORITY_LABEL[p]}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <button class="btn btn-primary" disabled={!brief.rights_confirmed} data-submit-label="Memasukkan…">
                        <Icon name="check" size={16} />
                        Kualifikasi & masukkan antrean
                      </button>
                    </form>
                    <form method="post" action={`${base}/triage`} class="option-card">
                      <Csrf token={csrf} />
                      <input type="hidden" name="action" value="needs_info" />
                      <p class="option-title">Ada yang kurang</p>
                      <p class="muted small">Minta informasi tambahan ke pelanggan.</p>
                      <Field
                        id="needs-info-msg"
                        label="Pesan untuk pelanggan"
                        hint="Dilihat pelanggan. Tulis dengan sopan, jelas, dan tanpa catatan internal."
                        error={fe('needs_info', 'customer_message')}
                      >
                        <textarea
                          {...describe('needs-info-msg', 'x', fe('needs_info', 'customer_message'))}
                          name="customer_message"
                          rows={3}
                          maxlength={1000}
                          required
                        >
                          {fv('needs_info', 'customer_message')}
                        </textarea>
                      </Field>
                      <button class="btn btn-secondary" data-submit-label="Mengirim…">
                        <Icon name="message" size={16} />
                        Minta informasi
                      </button>
                    </form>
                  </div>
                )}

                {(s === 'QUEUED' || s === 'NEEDS_REVISION' || s === 'BLOCKED_PROVIDER') && (
                  <>
                    {s === 'NEEDS_REVISION' && openRevisionNotes(d)}
                    {s === 'BLOCKED_PROVIDER' && (
                      <Alert tone="danger" title="Produksi sebelumnya terhambat provider">
                        Pekerjaan aman dan bisa dicoba lagi. Lihat catatan kegagalan di “Riwayat produksi”.
                      </Alert>
                    )}
                    <form method="post" action={`${base}/start-production`} class="stack">
                      <Csrf token={csrf} />
                      <Field id="start-provider" label="Cara produksi" hint="Belum ada otomatisasi Genspark yang terverifikasi — semua mode adalah serah-terima manual.">
                        <select {...describe('start-provider', 'x')} name="provider">
                          {PROVIDERS.map((p) => (
                            <option value={p.id}>{p.id === 'genspark-manual' ? 'Genspark (manual-assisted)' : 'Penulis manusia (tanpa AI)'}</option>
                          ))}
                        </select>
                      </Field>
                      <div class="row">
                        <button class="btn btn-primary" data-submit-label="Menyiapkan prompt…">
                          <Icon name="sparkle" size={16} />
                          Mulai produksi & siapkan prompt
                        </button>
                      </div>
                    </form>
                  </>
                )}

                {(s === 'FAILED' || s === 'BLOCKED_PROVIDER' || s === 'NEEDS_REVISION') && (
                  <form method="post" action={`${base}/requeue`} class="secondary-action">
                    <Csrf token={csrf} />
                    {s === 'FAILED' && <p class="muted">Produksi gagal. Kembalikan ke antrean untuk dicoba lagi dari awal.</p>}
                    <button class={s === 'FAILED' ? 'btn btn-primary' : 'btn btn-ghost btn-sm'} data-submit-label="Memproses…">
                      <Icon name="rotate" size={16} />
                      Kembalikan ke antrean
                    </button>
                  </form>
                )}

                {s === 'IN_PRODUCTION' && runningRun && (
                  <ol class="guided">
                    <li class="guided-step">
                      <span class="step-n">1</span>
                      <div class="guided-body">
                        <p class="step-title">Periksa & salin prompt tersanitasi</p>
                        {d.prompt ? (
                          <div class="prompt-box">
                            <div class="prompt-head">
                              <span class="small">
                                Sanitized prompt · <code class="code-soft">{runningRun.template_version}</code> · digest{' '}
                                <code class="code-soft">{runningRun.input_digest.slice(0, 12)}</code>
                              </span>
                              <button type="button" class="btn btn-secondary btn-sm" data-copy="#prompt-text" hidden>
                                <Icon name="copy" size={16} />
                                <span data-copy-label>Salin prompt</span>
                              </button>
                            </div>
                            <label class="sr-only" for="prompt-text">
                              Prompt tersanitasi
                            </label>
                            <textarea id="prompt-text" readonly rows={12} class="mono">
                              {d.prompt}
                            </textarea>
                            <p class="field-hint">Sebelum menempel: pastikan tidak ada email, nomor telepon, kredensial, atau data pelanggan lain.</p>
                          </div>
                        ) : (
                          <p class="muted">Prompt tidak tersedia.</p>
                        )}
                      </div>
                    </li>
                    <li class="guided-step">
                      <span class="step-n">2</span>
                      <div class="guided-body">
                        <p class="step-title">Jalankan di workspace Genspark Anda</p>
                        <p class="muted small">
                          Mode <strong>{runningRun.provider === 'genspark-manual' ? 'Genspark manual-assisted' : 'penulis manusia'}</strong>. Aplikasi ini tidak memanggil Genspark
                          secara otomatis. Tinjau hasilnya; jangan percaya klaim yang tidak ada di brief.
                        </p>
                      </div>
                    </li>
                    <li class="guided-step">
                      <span class="step-n">3</span>
                      <div class="guided-body">
                        <p class="step-title">Lampirkan hasil</p>
                        <form method="post" action={`${base}/production-result`} enctype="multipart/form-data" class="stack">
                          <Csrf token={csrf} />
                          <input type="hidden" name="run_id" value={runningRun.id} />
                          <Field id="output-text" label="Tempel hasil sebagai teks" error={fe('result', 'output_text')}>
                            <textarea {...describe('output-text', undefined, fe('result', 'output_text'))} name="output_text" rows={10} maxlength={200000}>
                              {fv('result', 'output_text')}
                            </textarea>
                          </Field>
                          {d.r2Configured ? (
                            <Field id="output-file" label="…atau unggah file" hint="txt, md, csv, pdf, docx, png, jpg, webp · maks. 10 MB" optional error={fe('result', 'output_file')}>
                              <input
                                {...describe('output-file', 'x', fe('result', 'output_file'))}
                                type="file"
                                name="output_file"
                                accept=".txt,.md,.csv,.pdf,.docx,.png,.jpg,.jpeg,.webp"
                              />
                            </Field>
                          ) : (
                            <p class="muted small">Unggah file nonaktif: penyimpanan R2 belum dikonfigurasi di lingkungan ini.</p>
                          )}
                          <div class="form-row">
                            <Field id="result-minutes" label="Menit kerja operator" optional error={fe('result', 'operator_minutes')}>
                              <input {...describe('result-minutes', undefined, fe('result', 'operator_minutes'))} type="number" name="operator_minutes" min={0} max={10000} inputmode="numeric" value={fv('result', 'operator_minutes')} />
                            </Field>
                            <Field id="result-cost" label="Perkiraan biaya (sen)" optional error={fe('result', 'cost_estimate_cents')}>
                              <input {...describe('result-cost', undefined, fe('result', 'cost_estimate_cents'))} type="number" name="cost_estimate_cents" min={0} inputmode="numeric" value={fv('result', 'cost_estimate_cents')} />
                            </Field>
                          </div>
                          <div class="row">
                            <button class="btn btn-primary" data-submit-label="Melampirkan…">
                              <Icon name="upload" size={16} />
                              Lampirkan draf & kirim ke QC
                            </button>
                          </div>
                        </form>
                      </div>
                    </li>
                    <li class="guided-step guided-alt">
                      <span class="step-n" aria-hidden="true">
                        <Icon name="alert" size={14} />
                      </span>
                      <div class="guided-body">
                        <details open={form?.id === 'failure'}>
                          <summary>Provider gagal atau terhambat?</summary>
                          <form method="post" action={`${base}/production-failure`} class="stack">
                            <Csrf token={csrf} />
                            <input type="hidden" name="run_id" value={runningRun.id} />
                            <div class="form-row">
                              <Field id="fail-code" label="Jenis kendala">
                                <select id="fail-code" name="error_code">
                                  {PROVIDER_ERROR_CODES.map((e) => (
                                    <option value={e} selected={fv('failure', 'error_code') === e}>
                                      {PROVIDER_ERROR_LABEL[e]}
                                    </option>
                                  ))}
                                </select>
                              </Field>
                              <Field id="fail-outcome" label="Status pekerjaan">
                                <select id="fail-outcome" name="outcome">
                                  <option value="BLOCKED_PROVIDER">Terhambat — coba lagi nanti</option>
                                  <option value="FAILED" selected={fv('failure', 'outcome') === 'FAILED'}>
                                    Gagal — kembalikan ke antrean
                                  </option>
                                </select>
                              </Field>
                              <Field id="fail-minutes" label="Menit kerja" optional error={fe('failure', 'operator_minutes')}>
                                <input id="fail-minutes" type="number" name="operator_minutes" min={0} max={10000} inputmode="numeric" value={fv('failure', 'operator_minutes')} />
                              </Field>
                            </div>
                            <Field id="fail-note" label="Catatan" hint="Jangan tulis rahasia atau isi konten pelanggan." optional error={fe('failure', 'note')}>
                              <input {...describe('fail-note', 'x', fe('failure', 'note'))} type="text" name="note" maxlength={1000} value={fv('failure', 'note')} />
                            </Field>
                            <p class="muted small">Pekerjaan tidak akan pernah ditandai terkirim. Anda bisa mencoba produksi lagi setelahnya.</p>
                            <div class="row">
                              <button class="btn btn-danger-soft" data-submit-label="Mencatat…">
                                Catat kegagalan provider
                              </button>
                            </div>
                          </form>
                        </details>
                      </div>
                    </li>
                  </ol>
                )}

                {s === 'QC_REVIEW' && (
                  <form method="post" action={`${base}/review`} class="stack">
                    <Csrf token={csrf} />
                    <p class="muted">Bandingkan draf (di bawah) dengan brief. Semua poin harus lolos untuk menyetujui.</p>
                    <fieldset class="checklist" aria-describedby={form?.id === 'review' ? 'qc-error' : undefined}>
                      <legend>Daftar periksa kualitas</legend>
                      {QC_CHECKLIST.map(([key]) => (
                        <label class={`check-row${fe('review', key) ? ' has-error' : ''}`}>
                          <input type="checkbox" name={key} checked={form?.id === 'review' ? form.values[key] === 'on' : false} />
                          <span>{QC_LABEL[key]}</span>
                        </label>
                      ))}
                    </fieldset>
                    {form?.id === 'review' && Object.keys(form.errors).some((k) => k !== 'notes') && (
                      <p class="field-error" id="qc-error">
                        <Icon name="alert" size={14} />
                        Semua poin harus dicentang untuk menyetujui. Jika ada yang belum lolos, minta revisi.
                      </p>
                    )}
                    <Field id="review-notes" label="Catatan peninjau" hint="Wajib diisi bila meminta revisi. Akan dipakai sebagai instruksi revisi." optional error={fe('review', 'notes')}>
                      <textarea {...describe('review-notes', 'x', fe('review', 'notes'))} name="notes" rows={3} maxlength={2000}>
                        {fv('review', 'notes')}
                      </textarea>
                    </Field>
                    <div class="row">
                      <button class="btn btn-primary" name="decision" value="APPROVE" data-submit-label="Menyimpan…">
                        <Icon name="check" size={16} />
                        Setujui draf
                      </button>
                      <button class="btn btn-secondary" name="decision" value="REQUEST_REVISION" data-submit-label="Menyimpan…">
                        <Icon name="edit" size={16} />
                        Minta revisi
                      </button>
                    </div>
                  </form>
                )}

                {s === 'APPROVED' && (
                  <form method="post" action={`${base}/deliver`} class="stack">
                    <Csrf token={csrf} />
                    <p class="muted">Draf lolos QC. Setelah dikirim, pelanggan dapat mengunduhnya lewat Public Embrilo dengan tautan yang berlaku 5 menit.</p>
                    <label class="check-row">
                      <input type="checkbox" name="confirm_delivery" required />
                      <span>Saya sudah memastikan draf yang disetujui adalah versi final untuk pelanggan.</span>
                    </label>
                    <div class="row">
                      <button class="btn btn-primary" data-submit-label="Mengirim…">
                        <Icon name="send" size={16} />
                        Kirim ke pelanggan
                      </button>
                    </div>
                  </form>
                )}

                {s === 'DELIVERED' && (
                  <Alert tone="success" title="Terkirim ke pelanggan">
                    Dikirim {fmtDateTime(job.delivered_at)}. Pelanggan dapat meminta revisi lewat Public Embrilo (sisa {Math.max(0, d.maxRevisions - job.revision_round)} putaran).
                  </Alert>
                )}
                {s === 'CANCELLED' && (
                  <Alert tone="info" title="Pekerjaan dibatalkan" icon="ban">
                    Tidak ada tindakan lanjutan.
                  </Alert>
                )}

                {op.role === 'ADMIN' && s !== 'CANCELLED' && s !== 'DELIVERED' && (
                  <details class="danger-zone" open={form?.id === 'cancel'}>
                    <summary>Batalkan pekerjaan (admin)</summary>
                    <form method="post" action={`${base}/cancel`} class="stack">
                      <Csrf token={csrf} />
                      <p class="muted small">Pembatalan bersifat final dan tidak bisa dikembalikan. Pelanggan akan melihat status “Dibatalkan”.</p>
                      <Field id="cancel-reason" label="Alasan pembatalan" error={fe('cancel', 'reason')}>
                        <input {...describe('cancel-reason', undefined, fe('cancel', 'reason'))} type="text" name="reason" minlength={3} maxlength={500} required value={fv('cancel', 'reason')} />
                      </Field>
                      <label class="check-row">
                        <input type="checkbox" name="confirm_cancel" required />
                        <span>Saya mengerti pembatalan tidak bisa dibatalkan.</span>
                      </label>
                      <div class="row">
                        <button class="btn btn-danger" data-submit-label="Membatalkan…">
                          <Icon name="ban" size={16} />
                          Batalkan pekerjaan
                        </button>
                      </div>
                    </form>
                  </details>
                )}
              </div>
            </section>
          )}

          {/* ---------------- Draft preview ---------------- */}
          {d.draftPreview !== null && (
            <Section id="draft" title="Draf terbaru" icon="file" description="Internal — pelanggan baru bisa melihatnya setelah disetujui dan dikirim.">
              <pre class="draft">{d.draftPreview}</pre>
            </Section>
          )}

          {/* ---------------- Brief workspace ---------------- */}
          <Section
            id="brief"
            title="Brief pelanggan"
            icon="clipboard"
            description="Konten dari pelanggan bersifat tidak tepercaya. Tautan referensi tidak pernah diambil oleh server."
            actions={
              brief.rights_confirmed ? (
                <Chip tone="success">Hak materi dikonfirmasi</Chip>
              ) : (
                <Chip tone="warning">Hak materi belum dikonfirmasi</Chip>
              )
            }
          >
            <dl class="brief-view">
              <BriefRow label="Tujuan">{brief.objective}</BriefRow>
              <BriefRow label="Audiens">{brief.audience}</BriefRow>
              <BriefRow label="Fakta produk">{brief.product_facts}</BriefRow>
              <BriefRow label="Platform">
                <span class="chip-list">
                  {brief.platforms.map((p) => (
                    <Chip tone="neutral" dot={false}>
                      {PLATFORM_LABEL[p] ?? p}
                    </Chip>
                  ))}
                </span>
              </BriefRow>
              <BriefRow label="Bahasa · nada · CTA">
                {LANGUAGE_LABEL[brief.language] ?? brief.language} · {brief.tone || '—'} · {brief.cta || '—'}
              </BriefRow>
              <BriefRow label="Batasan / klaim terlarang">{brief.constraints || <span class="muted">Tidak disebutkan</span>}</BriefRow>
              <BriefRow label="Referensi">
                {brief.references.length ? (
                  <ul class="plain">
                    {brief.references.map((r) => (
                      <li>
                        <a href={r} rel="noopener noreferrer nofollow" target="_blank" class="ext-link">
                          {r}
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span class="muted">Tidak ada</span>
                )}
              </BriefRow>
            </dl>
            {w && BRIEF_EDITABLE.includes(s) && <BriefForm base={base} csrf={csrf} brief={brief} form={form} />}
          </Section>
        </div>

        <aside class="job-side" aria-label="Informasi pendukung">
          {w && (
            <Section id="assign" title="Penugasan" icon="user">
              <form method="post" action={`${base}/assign`} class="stack">
                <Csrf token={csrf} />
                <Field id="assign-op" label="Pemilik">
                  <select id="assign-op" name="assignee_id">
                    <option value="">Belum ditugaskan</option>
                    {d.operators.map((o) => (
                      <option value={o.id} selected={o.id === job.assigned_operator_id}>
                        {o.display_name}
                        {o.id === op.id ? ' (saya)' : ''}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field id="assign-prio" label="Prioritas">
                  <select id="assign-prio" name="priority">
                    {PRIORITIES.map((p) => (
                      <option value={p} selected={p === job.priority}>
                        {PRIORITY_LABEL[p]}
                      </option>
                    ))}
                  </select>
                </Field>
                <button class="btn btn-secondary btn-sm" data-submit-label="Menyimpan…">
                  Simpan penugasan
                </button>
              </form>
            </Section>
          )}

          <Section id="assets" title="Aset privat" icon="file">
            {d.assets.length === 0 ? (
              <p class="muted small">Belum ada aset.</p>
            ) : (
              <ul class="asset-list">
                {d.assets.map((a) => (
                  <li>
                    <a href={`/console/assets/${a.id}`} class="asset-link">
                      <Icon name="download" size={16} />
                      <span>{a.filename}</span>
                    </a>
                    <span class="cell-sub">
                      {a.kind === 'DRAFT' ? 'Draf' : 'Referensi'} · {Math.max(1, Math.ceil(a.size_bytes / 1024))} KB ·{' '}
                      {a.visibility === 'CUSTOMER' ? 'terkirim ke pelanggan' : 'internal'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {w && d.r2Configured && s !== 'CANCELLED' && s !== 'DELIVERED' && (
              <form method="post" action={`${base}/reference`} enctype="multipart/form-data" class="stack upload-form">
                <Csrf token={csrf} />
                <Field id="ref-file" label="Unggah referensi" hint="Maks. 10 MB · txt, md, csv, pdf, docx, png, jpg, webp">
                  <input {...describe('ref-file', 'x')} type="file" name="reference_file" accept=".txt,.md,.csv,.pdf,.docx,.png,.jpg,.jpeg,.webp" required />
                </Field>
                <button class="btn btn-secondary btn-sm" data-submit-label="Mengunggah…">
                  <Icon name="upload" size={16} />
                  Unggah
                </button>
              </form>
            )}
          </Section>

          <Section id="runs" title="Riwayat produksi" icon="sparkle">
            {d.runs.length === 0 ? (
              <p class="muted small">Belum ada proses produksi.</p>
            ) : (
              <ul class="run-list">
                {d.runs.map((r) => {
                  const st = RUN_STATUS_LABEL[r.status] ?? { label: r.status, tone: 'neutral' as const }
                  return (
                    <li>
                      <div class="run-top">
                        <Chip tone={st.tone}>{st.label}</Chip>
                        <span class="small">{r.provider === 'genspark-manual' ? 'Genspark (manual)' : 'Penulis manusia'}</span>
                      </div>
                      <span class="cell-sub">
                        {r.operator_name ?? '—'} · <Time iso={r.started_at}>{relTime(r.started_at, now)}</Time> · {r.template_version}
                        {r.operator_minutes !== null && ` · ${r.operator_minutes} mnt`}
                        {r.cost_estimate_cents !== null && ` · ${r.cost_estimate_cents}¢`}
                      </span>
                      {r.error_code && (
                        <span class="run-error">
                          {PROVIDER_ERROR_LABEL[r.error_code] ?? r.error_code}
                          {r.error_note && ` — ${r.error_note}`}
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </Section>

          <Section id="qc" title="Tinjauan & revisi" icon="check">
            {d.reviews.length === 0 && d.revisions.length === 0 ? (
              <p class="muted small">Belum ada tinjauan atau revisi.</p>
            ) : (
              <ul class="run-list">
                {d.reviews.map((r) => {
                  let passed = 0
                  try {
                    passed = Object.values(JSON.parse(r.checklist_json) as Record<string, boolean>).filter(Boolean).length
                  } catch {
                    /* ignore */
                  }
                  return (
                    <li>
                      <div class="run-top">
                        {r.decision === 'APPROVE' ? <Chip tone="success">Disetujui</Chip> : <Chip tone="warning">Minta revisi</Chip>}
                        <span class="small">
                          {passed}/{QC_CHECKLIST.length} poin lolos
                        </span>
                      </div>
                      <span class="cell-sub">
                        {r.reviewer_name ?? '—'} · <Time iso={r.created_at}>{relTime(r.created_at, now)}</Time>
                      </span>
                      {r.notes && <p class="note">{r.notes}</p>}
                    </li>
                  )
                })}
                {d.revisions.map((r) => (
                  <li>
                    <div class="run-top">
                      <Chip tone={r.status === 'OPEN' ? 'warning' : 'muted'}>{r.status === 'OPEN' ? 'Revisi terbuka' : 'Revisi selesai'}</Chip>
                      <span class="small">
                        Putaran {r.round} · {r.source === 'CUSTOMER' ? 'dari pelanggan' : 'dari QC'}
                      </span>
                    </div>
                    <p class="note">{r.summary}</p>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section id="history" title="Aktivitas" icon="history">
            <ol class="timeline">
              {d.history.map((h) => (
                <li class="timeline-item">
                  <span class="timeline-dot" aria-hidden="true"></span>
                  <div>
                    <p class="timeline-title">{STATE_LABEL_ID[h.to_state as JobState] ?? h.to_state}</p>
                    <p class="cell-sub">
                      {h.actor_type === 'OPERATOR' ? h.actor_name ?? 'Operator' : h.actor_type === 'CONNECTOR' ? 'Public Embrilo' : 'Sistem'} ·{' '}
                      <Time iso={h.created_at}>{relTime(h.created_at, now)}</Time>
                    </p>
                    {h.reason && <p class="cell-sub">{h.reason}</p>}
                    <p class="cell-sub mono">cid {h.correlation_id.slice(0, 8)}</p>
                  </div>
                </li>
              ))}
            </ol>
          </Section>
        </aside>
      </div>
    </Layout>
  )
}

function actionTitle(s: JobState): string {
  const m: Record<JobState, string> = {
    SUBMITTED: 'Mulai triase',
    TRIAGE: 'Kualifikasi brief',
    NEEDS_INFO: 'Menunggu informasi pelanggan',
    QUEUED: 'Mulai produksi',
    NEEDS_REVISION: 'Kerjakan revisi',
    BLOCKED_PROVIDER: 'Coba produksi lagi',
    FAILED: 'Pulihkan pekerjaan',
    IN_PRODUCTION: 'Produksi manual-assisted',
    QC_REVIEW: 'Tinjau kualitas draf',
    APPROVED: 'Kirim hasil ke pelanggan',
    DELIVERED: 'Pekerjaan terkirim',
    CANCELLED: 'Pekerjaan dibatalkan'
  }
  return m[s]
}

function openRevisionNotes(d: JobDetail) {
  const open = d.revisions.filter((r) => r.status === 'OPEN')
  if (!open.length) return null
  return (
    <Alert tone="warning" title="Instruksi revisi" icon="edit">
      <ul class="plain">
        {open.map((r) => (
          <li>
            <strong>{r.source === 'CUSTOMER' ? 'Pelanggan' : 'QC'}:</strong> {r.summary}
          </li>
        ))}
      </ul>
      <p class="small">Instruksi ini otomatis disertakan di prompt produksi berikutnya.</p>
    </Alert>
  )
}

const Stepper: FC<{ state: JobState }> = ({ state }) => {
  const idx = workflowIndex(state)
  const branch = !WORKFLOW_STEPS.some((w) => w.state === state)
  const pct = Math.round((idx / (WORKFLOW_STEPS.length - 1)) * 100)
  return (
    <div class={`stepper${state === 'CANCELLED' ? ' is-cancelled' : ''}`} aria-label="Posisi dalam alur kerja">
      <svg class="stepper-line" viewBox="0 0 100 2" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <line class="stepper-track" x1="0" y1="1" x2="100" y2="1" />
        {pct > 0 && state !== 'CANCELLED' && <line class="stepper-progress" x1="0" y1="1" x2={String(pct)} y2="1" data-animate="draw" />}
      </svg>
      <ol class="steps-row">
        {WORKFLOW_STEPS.map((w, i) => {
          const status = state === 'CANCELLED' ? 'upcoming' : i < idx || (i === idx && state === 'DELIVERED') ? 'done' : i === idx ? 'current' : 'upcoming'
          return (
            <li class={`step step-${status}`} aria-current={status === 'current' ? 'step' : undefined}>
              <span class="step-dot" aria-hidden="true">
                {status === 'done' ? <Icon name="check" size={12} /> : i + 1}
              </span>
              <span class="step-label">{w.label}</span>
              <span class="sr-only">{status === 'done' ? ' (selesai)' : status === 'current' ? ' (saat ini)' : ''}</span>
            </li>
          )
        })}
      </ol>
      {branch && (
        <p class="stepper-branch">
          <Icon name="info" size={14} />
          Cabang alur: <strong>{STATE_LABEL_ID[state]}</strong>
        </p>
      )}
    </div>
  )
}

const BriefRow: FC<{ label: string; children?: Child }> = ({ label, children }) => (
  <div class="brief-row">
    <dt>{label}</dt>
    <dd>{children}</dd>
  </div>
)

const BriefForm: FC<{ base: string; csrf: string; brief: JobDetail['brief']; form?: FormState }> = ({ base, csrf, brief, form }) => {
  const failed = form?.id === 'brief'
  const v = (name: keyof JobDetail['brief'], fallback: string) => (failed ? str(form!.values[name]) : fallback)
  const e = (name: string) => (failed ? form!.errors[name] : undefined)
  const platforms: string[] = failed
    ? (Array.isArray(form!.values.platforms) ? (form!.values.platforms as unknown[]) : form!.values.platforms ? [form!.values.platforms] : []).map(String)
    : brief.platforms
  const rights = failed ? form!.values.rights_confirmed === 'on' : brief.rights_confirmed
  return (
    <details class="edit-brief" open={failed}>
      <summary>
        <Icon name="edit" size={16} />
        Ubah brief
      </summary>
      <form method="post" action={`${base}/brief`} class="stack">
        <Csrf token={csrf} />
        <Field id="b-objective" label="Tujuan" error={e('objective')}>
          <textarea {...describe('b-objective', undefined, e('objective'))} name="objective" rows={2} maxlength={2000} required>
            {v('objective', brief.objective)}
          </textarea>
        </Field>
        <Field id="b-audience" label="Audiens" error={e('audience')}>
          <textarea {...describe('b-audience', undefined, e('audience'))} name="audience" rows={2} maxlength={1000} required>
            {v('audience', brief.audience)}
          </textarea>
        </Field>
        <Field id="b-facts" label="Fakta produk (terverifikasi)" error={e('product_facts')}>
          <textarea {...describe('b-facts', undefined, e('product_facts'))} name="product_facts" rows={4} maxlength={5000} required>
            {v('product_facts', brief.product_facts)}
          </textarea>
        </Field>
        <fieldset class={`checkset${e('platforms') ? ' has-error' : ''}`}>
          <legend>Platform</legend>
          {PLATFORMS.map((p) => (
            <label class="check-inline">
              <input type="checkbox" name="platforms" value={p} checked={platforms.includes(p)} />
              {PLATFORM_LABEL[p]}
            </label>
          ))}
          {e('platforms') && (
            <p class="field-error">
              <Icon name="alert" size={14} />
              {e('platforms')}
            </p>
          )}
        </fieldset>
        <div class="form-row">
          <Field id="b-language" label="Bahasa">
            <select id="b-language" name="language">
              {LANGUAGES.map((l) => (
                <option value={l} selected={l === v('language', brief.language)}>
                  {LANGUAGE_LABEL[l]}
                </option>
              ))}
            </select>
          </Field>
          <Field id="b-tone" label="Nada" optional error={e('tone')}>
            <input id="b-tone" type="text" name="tone" value={v('tone', brief.tone)} maxlength={300} />
          </Field>
          <Field id="b-cta" label="CTA" optional error={e('cta')}>
            <input id="b-cta" type="text" name="cta" value={v('cta', brief.cta)} maxlength={300} />
          </Field>
        </div>
        <Field id="b-constraints" label="Batasan / klaim terlarang" optional error={e('constraints')}>
          <textarea id="b-constraints" name="constraints" rows={2} maxlength={2000}>
            {v('constraints', brief.constraints)}
          </textarea>
        </Field>
        <Field id="b-refs" label="Referensi" hint="URL https, satu per baris, maks. 5" optional error={e('references')}>
          <textarea {...describe('b-refs', 'x', e('references'))} name="references" rows={2}>
            {failed ? str(form!.values.references) : brief.references.join('\n')}
          </textarea>
        </Field>
        <label class="check-row">
          <input type="checkbox" name="rights_confirmed" checked={rights} />
          <span>Pelanggan sudah mengonfirmasi hak atas materi yang diberikan</span>
        </label>
        <div class="row">
          <button class="btn btn-primary" data-submit-label="Menyimpan…">
            Simpan brief
          </button>
        </div>
      </form>
    </details>
  )
}

export { EmptyState }
