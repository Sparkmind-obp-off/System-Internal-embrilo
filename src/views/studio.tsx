import type { FC } from 'hono/jsx'
import { Alert, Chip, Csrf, EmptyState, Field, Flash, Layout, PageHeader, Section, StateBadge, STATE_LABEL_ID, Time, describe } from './layout'
import { Icon } from './icons'
import { LANGUAGE_LABEL, PLATFORM_LABEL, SERVICE_LABEL, fmtDateTime, relTime } from './labels'
import type { OperatorCtx } from '../types'
import type { StudioState, PromptVersionRow, DiffLine, ProviderStatus } from '../services/studio'
import type { WorkType } from '../lib/templates'
import type { LlmSettings } from '../lib/llm'

export type StudioForm = { body?: string; instruction?: string; internal_notes?: string; errors: Record<string, string> }

const PROVIDER_LABEL: Record<string, string> = { workers_ai: 'Cloudflare Workers AI', groq: 'Groq', template: 'Mode template (tanpa AI)' }
const SOURCE_LABEL: Record<string, string> = { TEMPLATE: 'Template', AI: 'AI', MANUAL: 'Suntingan' }
const STATUS_TONE = { DRAFT: 'neutral', READY: 'success', SUPERSEDED: 'muted' } as const
const STATUS_LABEL = { DRAFT: 'Draf', READY: 'Siap dieksekusi', SUPERSEDED: 'Digantikan' } as const

export const ProviderBadge: FC<{ status: ProviderStatus }> = ({ status }) =>
  status.active === 'template' ? (
    <Chip tone="neutral">Mode template · tanpa AI</Chip>
  ) : (
    <Chip tone="info">
      {PROVIDER_LABEL[status.active]} · {status.model}
    </Chip>
  )

export const StudioPage: FC<{
  op: OperatorCtx
  csrf: string
  ok?: string
  err?: string
  st: StudioState
  provider: ProviderStatus
  viewing: PromptVersionRow | null
  compareWith: PromptVersionRow | null
  diff: DiffLine[] | null
  form?: StudioForm
  now: number
}> = ({ op, csrf, ok, err, st, provider, viewing, compareWith, diff, form, now }) => {
  const canWrite = op.role === 'ADMIN' || op.role === 'OPERATOR'
  const w = canWrite && st.editable
  const base = `/console/jobs/${st.job.id}/studio`
  const ai = provider.active !== 'template'
  const shown = viewing ?? st.latest
  const editorBody = form?.body ?? st.latest?.body ?? ''
  const essential = st.gaps.filter((g) => g.severity === 'essential')
  return (
    <Layout title={`Prompt Studio · ${st.order.public_ref}`} op={op} csrf={csrf} active="queue">
      <nav class="breadcrumb" aria-label="Remah roti">
        <a href="/console">
          <Icon name="arrowLeft" size={16} />
          Inbox
        </a>
        <span aria-hidden="true">/</span>
        <a href={`/console/jobs/${st.job.id}`}>{st.order.public_ref}</a>
        <span aria-hidden="true">/</span>
        <span aria-current="page">Prompt Studio</span>
      </nav>

      <PageHeader
        eyebrow={`${st.order.public_ref} · ${SERVICE_LABEL[st.order.service_code] ?? st.order.service_code}`}
        title="Prompt Studio"
        description="Susun prompt produksi dari brief pesanan, lalu salin ke Genspark.ai atau alat AI lain dan jalankan secara manual. Menyalin atau menandai siap tidak berarti pekerjaan sudah dieksekusi."
        actions={
          <div class="row">
            <StateBadge state={st.job.state} />
            <ProviderBadge status={provider} />
          </div>
        }
      />
      <Flash ok={ok} err={err} />
      {provider.note && (
        <Alert tone="warning" title="Provider AI tidak aktif" icon="info">
          {provider.note}
        </Alert>
      )}
      {!st.editable && (
        <Alert tone="info" title="Prompt dikunci" icon="lock">
          Status pekerjaan saat ini ({STATE_LABEL_ID[st.job.state]}) tidak mengizinkan perubahan prompt. Riwayat versi tetap bisa dilihat dan disalin.
        </Alert>
      )}
      {!canWrite && (
        <Alert tone="info" title="Mode baca saja" icon="eye">
          Peran Anda hanya dapat melihat dan menyalin prompt.
        </Alert>
      )}

      <div class="studio-grid">
        {/* ---------------- Context column ---------------- */}
        <aside class="studio-context" aria-label="Konteks pesanan">
          <Section id="brief-context" title="Brief terstruktur" icon="clipboard" description="Sumber: data yang dikirim pelanggan.">
            <dl class="kv">
              <dt>Pelanggan</dt>
              <dd>{st.order.customer_name}</dd>
              <dt>Tujuan</dt>
              <dd>{st.brief.objective}</dd>
              <dt>Audiens</dt>
              <dd>{st.brief.audience}</dd>
              <dt>Fakta produk</dt>
              <dd>{st.brief.product_facts}</dd>
              <dt>Platform</dt>
              <dd>{st.brief.platforms.map((p) => PLATFORM_LABEL[p] ?? p).join(', ')}</dd>
              <dt>Bahasa · nada · CTA</dt>
              <dd>
                {LANGUAGE_LABEL[st.brief.language] ?? st.brief.language} · {st.brief.tone || '—'} · {st.brief.cta || '—'}
              </dd>
              <dt>Batasan</dt>
              <dd>{st.brief.constraints || <span class="muted">Tidak disebutkan</span>}</dd>
              <dt>Hak materi</dt>
              <dd>{st.brief.rights_confirmed ? <Chip tone="success">Dikonfirmasi</Chip> : <Chip tone="warning">Belum dikonfirmasi</Chip>}</dd>
            </dl>
            {st.brief.revision_notes && st.brief.revision_notes.length > 0 && (
              <Alert tone="warning" title="Instruksi revisi terbuka" icon="edit">
                <ul class="plain">
                  {st.brief.revision_notes.map((r) => (
                    <li>{r}</li>
                  ))}
                </ul>
              </Alert>
            )}
          </Section>

          <Section
            id="gaps"
            title="Informasi yang kurang"
            icon="alert"
            description="Deteksi otomatis berbasis aturan. Tidak ada yang dikarang."
            actions={st.gaps.length ? <Chip tone={essential.length ? 'warning' : 'neutral'}>{st.gaps.length} celah</Chip> : <Chip tone="success">Lengkap</Chip>}
          >
            {st.gaps.length === 0 ? (
              <p class="muted small">Tidak ada celah yang terdeteksi. Tetap tinjau asumsi di prompt.</p>
            ) : (
              <>
                <ul class="gap-list">
                  {st.gaps.map((g) => (
                    <li class={`gap gap-${g.severity}`}>
                      <span class="gap-label">
                        {g.label}
                        <span class="cell-sub">{g.severity === 'essential' ? 'wajib' : 'disarankan'}</span>
                      </span>
                    </li>
                  ))}
                </ul>
                <details class="clarify">
                  <summary>Draf pertanyaan untuk pelanggan</summary>
                  <label class="sr-only" for="clarify-text">
                    Draf pertanyaan klarifikasi
                  </label>
                  <textarea id="clarify-text" readonly rows={Math.min(12, st.gaps.length + 3)}>
                    {st.clarification}
                  </textarea>
                  <div class="row">
                    <button type="button" class="btn btn-secondary btn-sm" data-copy="#clarify-text" data-copy-toast="Pertanyaan tersalin. Kirim lewat saluran komunikasi Anda yang biasa." hidden>
                      <Icon name="copy" size={16} />
                      <span data-copy-label>Salin pertanyaan</span>
                    </button>
                  </div>
                  <p class="field-hint">
                    Tidak dikirim otomatis. Untuk meminta info lewat status pesanan, gunakan “Minta informasi” di halaman pekerjaan saat triase.
                  </p>
                </details>
              </>
            )}
          </Section>

          <Section id="meta" title="Jenis pekerjaan & catatan" icon="list">
            {canWrite ? (
              <form method="post" action={`${base}/meta`} class="stack">
                <Csrf token={csrf} />
                <Field id="work-type" label="Jenis pekerjaan" hint={st.workType.description}>
                  <select {...describe('work-type', 'x')} name="work_type">
                    {st.enabledWorkTypes.map((t) => (
                      <option value={t.id} selected={t.id === st.workType.id}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field id="internal-notes" label="Catatan internal" hint="Hanya untuk tim. Tidak dikirim ke pelanggan maupun ke provider AI." optional error={form?.errors.internal_notes}>
                  <textarea {...describe('internal-notes', 'x', form?.errors.internal_notes)} name="internal_notes" rows={3} maxlength={4000}>
                    {form?.internal_notes ?? st.job.internal_notes}
                  </textarea>
                </Field>
                <button class="btn btn-secondary btn-sm" data-submit-label="Menyimpan…">
                  Simpan
                </button>
              </form>
            ) : (
              <p>
                {st.workType.label}
                {st.job.internal_notes && <span class="note">{st.job.internal_notes}</span>}
              </p>
            )}
            <p class="cell-sub">
              Template: <code class="code-soft">{`${st.workType.id}@${st.workType.version}`}</code>
            </p>
          </Section>
        </aside>

        {/* ---------------- Workspace column ---------------- */}
        <div class="studio-main">
          {!st.latest ? (
            <section class="card action-panel" aria-labelledby="start-title" data-animate="enter">
              <div class="card-head">
                <div>
                  <p class="eyebrow">Langkah berikutnya</p>
                  <h2 class="card-title" id="start-title">
                    Buat draf prompt pertama
                  </h2>
                </div>
              </div>
              <div class="card-body stack">
                <p class="muted">
                  Draf disusun dari brief dan template <strong>{st.workType.label}</strong>: peran, konteks, tujuan, keluaran, arahan, batasan, langkah, daftar periksa,
                  struktur keluaran, serta pertanyaan yang belum terjawab.
                </p>
                {essential.length > 0 && (
                  <Alert tone="warning" title={`${essential.length} informasi wajib belum ada`}>
                    Draf tetap bisa dibuat. Bagian yang belum diketahui ditandai “[BELUM DIKETAHUI]”, tidak dikarang.
                  </Alert>
                )}
                {w ? (
                  <div class="row">
                    <form method="post" action={`${base}/draft`}>
                      <Csrf token={csrf} />
                      <input type="hidden" name="mode" value="template" />
                      <button class={ai ? 'btn btn-secondary' : 'btn btn-primary'} data-submit-label="Menyusun…">
                        <Icon name="file" size={16} />
                        Buat draf dari template
                      </button>
                    </form>
                    {ai && (
                      <form method="post" action={`${base}/draft`}>
                        <Csrf token={csrf} />
                        <input type="hidden" name="mode" value="ai" />
                        <button class="btn btn-primary" data-submit-label="AI sedang menyusun…">
                          <Icon name="sparkle" size={16} />
                          Buat draf dengan AI
                        </button>
                      </form>
                    )}
                  </div>
                ) : (
                  <p class="muted small">Belum ada prompt untuk pesanan ini.</p>
                )}
                {ai && w && (
                  <p class="field-hint">
                    Mode AI mengirim brief (tanpa catatan internal, email, atau nomor telepon) ke {PROVIDER_LABEL[provider.active]}.
                  </p>
                )}
              </div>
            </section>
          ) : (
            <section class="card editor-card" aria-labelledby="editor-title" data-animate="enter">
              <div class="card-head">
                <div>
                  <p class="eyebrow">Editor prompt</p>
                  <h2 class="card-title" id="editor-title">
                    Versi terbaru v{st.latest.version}
                    <Chip tone={STATUS_TONE[st.latest.status]}>{STATUS_LABEL[st.latest.status]}</Chip>
                  </h2>
                  <p class="card-desc">
                    {SOURCE_LABEL[st.latest.source]}
                    {st.latest.provider && ` · ${PROVIDER_LABEL[st.latest.provider]} ${st.latest.model ?? ''}`} · {st.latest.created_by_name ?? '—'} ·{' '}
                    <Time iso={st.latest.created_at}>{relTime(st.latest.created_at, now)}</Time>
                  </p>
                </div>
                <div class="card-actions">
                  <button type="button" class="btn btn-secondary btn-sm" data-copy="#prompt-editor" data-copy-toast="Prompt tersalin. Tempel di Genspark.ai atau alat AI lain — belum ada yang dieksekusi." hidden>
                    <Icon name="copy" size={16} />
                    <span data-copy-label>Salin prompt</span>
                  </button>
                </div>
              </div>
              <div class="card-body">
                <form method="post" action={`${base}/editor`} class="stack" id="editor-form">
                  <Csrf token={csrf} />
                  <input type="hidden" name="base_version_id" value={st.latest.id} />
                  <Field id="prompt-editor" label="Teks prompt" hint={`Sunting langsung. ${editorBody.length.toLocaleString('id-ID')} karakter · maks. 30.000.`} error={form?.errors.body}>
                    <textarea
                      {...describe('prompt-editor', 'x', form?.errors.body)}
                      name="body"
                      rows={22}
                      maxlength={30000}
                      class="mono prompt-editor"
                      readonly={!w}
                      spellcheck={false}
                    >
                      {editorBody}
                    </textarea>
                  </Field>
                  {w && (
                    <>
                      <div class="row">
                        <button class="btn btn-secondary" name="action" value="save" formnovalidate data-submit-label="Menyimpan…">
                          Simpan versi
                        </button>
                        <button class="btn btn-primary" name="action" value="ready" formnovalidate data-submit-label="Menandai…">
                          <Icon name="check" size={16} />
                          Tandai siap dieksekusi
                        </button>
                      </div>
                      <div class="refine-box">
                        <Field
                          id="refine-instruction"
                          label="Perbaiki prompt"
                          hint={
                            ai
                              ? `Contoh: “buat lebih singkat”, “tambahkan 3 variasi hook”, “tekankan tanpa gula”. Diproses oleh ${PROVIDER_LABEL[provider.active]}.`
                              : 'Mode template: instruksi ditambahkan ke bagian “Instruksi tambahan dari operator”. Aktifkan provider AI di Pengaturan untuk penulisan ulang otomatis.'
                          }
                          error={form?.errors.instruction}
                        >
                          <textarea {...describe('refine-instruction', 'x', form?.errors.instruction)} name="instruction" rows={2} maxlength={1000}>
                            {form?.instruction ?? ''}
                          </textarea>
                        </Field>
                        <input type="hidden" name="mode" value={ai ? 'ai' : 'template'} />
                        <div class="row">
                          <button class="btn btn-secondary" name="action" value="refine" data-submit-label={ai ? 'AI sedang memperbaiki…' : 'Menambahkan…'}>
                            <Icon name={ai ? 'sparkle' : 'edit'} size={16} />
                            {ai ? 'Perbaiki dengan AI' : 'Tambahkan instruksi'}
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                </form>
                {w && (
                  <div class="row studio-secondary">
                    <form method="post" action={`${base}/draft`}>
                      <Csrf token={csrf} />
                      <input type="hidden" name="mode" value="template" />
                      <button class="btn btn-ghost btn-sm" data-submit-label="Menyusun…">
                        <Icon name="rotate" size={14} />
                        Buat ulang dari template
                      </button>
                    </form>
                    {ai && (
                      <form method="post" action={`${base}/draft`}>
                        <Csrf token={csrf} />
                        <input type="hidden" name="mode" value="ai" />
                        <button class="btn btn-ghost btn-sm" data-submit-label="AI sedang menyusun…">
                          <Icon name="sparkle" size={14} />
                          Draf baru dengan AI
                        </button>
                      </form>
                    )}
                    <form method="post" action={`${base}/analyze`}>
                      <Csrf token={csrf} />
                      <input type="hidden" name="mode" value={ai ? 'ai' : 'template'} />
                      <button class="btn btn-ghost btn-sm" data-submit-label="Menganalisis…">
                        <Icon name="search" size={14} />
                        Cari celah informasi
                      </button>
                    </form>
                  </div>
                )}
              </div>
            </section>
          )}

          {st.ready && (
            <Alert tone="success" title={`v${st.ready.version} siap dieksekusi — belum dieksekusi`} icon="check">
              Salin prompt, jalankan secara manual di Genspark.ai atau alat AI lain, lalu kembali ke{' '}
              <a href={`/console/jobs/${st.job.id}#next-action`}>halaman pekerjaan</a> untuk memulai produksi, melampirkan hasil, dan QC.
            </Alert>
          )}

          {diff && compareWith && st.latest && (
            <Section id="diff" title={`Perbandingan v${compareWith.version} → v${st.latest.version}`} icon="list" actions={<a class="btn btn-ghost btn-sm" href={base}>Tutup</a>}>
              <pre class="diff" aria-label="Perbedaan baris">
                {diff.map((l) => (
                  <span class={`diff-${l.kind}`}>
                    {l.kind === 'add' ? '+ ' : l.kind === 'del' ? '− ' : '  '}
                    {l.text}
                    {'\n'}
                  </span>
                ))}
              </pre>
            </Section>
          )}

          {viewing && viewing.id !== st.latest?.id && (
            <Section id="viewing" title={`Versi v${viewing.version}`} icon="eye" actions={<a class="btn btn-ghost btn-sm" href={base}>Tutup</a>}>
              <label class="sr-only" for="view-text">
                Teks versi {viewing.version}
              </label>
              <textarea id="view-text" readonly rows={14} class="mono">
                {viewing.body}
              </textarea>
              <div class="row">
                <button type="button" class="btn btn-secondary btn-sm" data-copy="#view-text" data-copy-toast={`v${viewing.version} tersalin.`} hidden>
                  <Icon name="copy" size={16} />
                  <span data-copy-label>Salin v{viewing.version}</span>
                </button>
              </div>
            </Section>
          )}

          <Section id="versions" title="Riwayat versi" icon="history">
            {st.versions.length === 0 ? (
              <p class="muted small">Belum ada versi.</p>
            ) : (
              <ol class="version-list">
                {st.versions.map((v) => (
                  <li class={`version${shown?.id === v.id ? ' is-current' : ''}`}>
                    <div class="version-top">
                      <strong>v{v.version}</strong>
                      <Chip tone={STATUS_TONE[v.status]}>{STATUS_LABEL[v.status]}</Chip>
                      <span class="small muted">
                        {SOURCE_LABEL[v.source]}
                        {v.provider && ` · ${PROVIDER_LABEL[v.provider]}`}
                      </span>
                    </div>
                    <span class="cell-sub">
                      {v.note || '—'} · {v.created_by_name ?? '—'} · <time datetime={v.created_at}>{fmtDateTime(v.created_at)}</time> · {v.body.length.toLocaleString('id-ID')} karakter
                    </span>
                    <span class="version-links">
                      <a href={`${base}?v=${v.version}#viewing`}>Lihat</a>
                      {st.latest && v.id !== st.latest.id && <a href={`${base}?compare=${v.version}#diff`}>Bandingkan dengan terbaru</a>}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Section>

          <Section id="log" title="Log studio" icon="message" description="Instruksi operator dan catatan sistem untuk pesanan ini. Internal saja.">
            {st.messages.length === 0 ? (
              <EmptyState icon="message" title="Belum ada aktivitas">
                Buat draf pertama untuk memulai.
              </EmptyState>
            ) : (
              <ol class="chat">
                {st.messages.map((m) => (
                  <li class={`chat-msg chat-${m.role.toLowerCase()}`}>
                    <span class="chat-who">
                      {m.role === 'OPERATOR' ? m.created_by_name ?? 'Operator' : m.role === 'ASSISTANT' ? 'Asisten' : 'Sistem'} ·{' '}
                      <Time iso={m.created_at}>{relTime(m.created_at, now)}</Time>
                    </span>
                    <p class="chat-body">{m.body}</p>
                  </li>
                ))}
              </ol>
            )}
          </Section>
        </div>
      </div>
    </Layout>
  )
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
export const SettingsPage: FC<{
  op: OperatorCtx
  csrf: string
  ok?: string
  err?: string
  settings: LlmSettings & { stored: boolean }
  status: ProviderStatus
  enabledWorkTypes: string[]
  workTypes: WorkType[]
  workersAiModels: { id: string; label: string }[]
  usage: { provider: string; calls: number; ok_calls: number; neurons: number; in_tok: number; out_tok: number }[]
}> = (p) => {
  const admin = p.op.role === 'ADMIN'
  const u = (id: string) => p.usage.find((x) => x.provider === id)
  const neurons = u('workers_ai')?.neurons ?? 0
  return (
    <Layout title="Pengaturan" op={p.op} csrf={p.csrf} active="settings">
      <PageHeader
        eyebrow="Pengaturan workspace"
        title="Provider AI, template, dan batas pemakaian"
        description="Prompt Studio selalu bisa dipakai dalam mode template. Provider AI hanya dipakai bila dipilih di sini dan benar-benar terkonfigurasi."
        actions={<ProviderBadge status={p.status} />}
      />
      <Flash ok={p.ok} err={p.err} />
      {!admin && (
        <Alert tone="info" title="Hanya admin yang dapat mengubah pengaturan" icon="lock">
          Anda dapat melihat status provider dan pemakaian.
        </Alert>
      )}
      {p.status.note && (
        <Alert tone="warning" title="Provider yang dipilih tidak tersedia" icon="info">
          {p.status.note}
        </Alert>
      )}

      <div class="settings-grid">
        <Section id="providers" title="Status provider" icon="plug">
          <ul class="provider-list">
            <li>
              <div class="run-top">
                <strong>1. Cloudflare Workers AI</strong>
                {p.status.configured.workers_ai ? <Chip tone="success">Binding AI tersedia</Chip> : <Chip tone="muted">Binding AI belum ada</Chip>}
              </div>
              <p class="cell-sub">
                Berjalan di akun Cloudflare yang sama dengan aplikasi ini. Alokasi gratis 10.000 Neuron/hari (pricing resmi, diperiksa 28 Okt 2026); di atas itu perlu Workers
                Paid. Pemakaian hari ini (perkiraan): <strong>{neurons.toLocaleString('id-ID')}</strong> Neuron dari batas {p.settings.daily_neuron_cap.toLocaleString('id-ID')}.
              </p>
            </li>
            <li>
              <div class="run-top">
                <strong>2. Groq API</strong>
                {p.status.configured.groq ? <Chip tone="success">Secret GROQ_API_KEY diset</Chip> : <Chip tone="muted">Belum dikonfigurasi</Chip>}
              </div>
              <p class="cell-sub">
                Vendor terpisah: brief akan dikirim ke Groq. Untuk mengaktifkan, admin menyimpan kunci sebagai secret <code>GROQ_API_KEY</code> di Cloudflare (Workers &amp; Pages →
                embrilo-os → Settings → Variables and Secrets) — jangan pernah menempelnya di chat, kode, atau GitHub. Periksa model, batas, dan harga di akun Groq Anda.
                Panggilan hari ini: <strong>{u('groq')?.calls ?? 0}</strong> dari batas {p.settings.daily_groq_calls}.
              </p>
            </li>
            <li>
              <div class="run-top">
                <strong>3. Mode template</strong>
                <Chip tone="success">Selalu tersedia</Chip>
              </div>
              <p class="cell-sub">Prompt disusun dari template tepercaya tanpa mengirim data ke provider mana pun.</p>
            </li>
          </ul>
          <p class="field-hint">Tidak ada peralihan otomatis antar-provider. Jika provider gagal, draf operator tetap aman dan operator memilih langkah berikutnya.</p>
        </Section>

        <Section id="llm-settings" title="Provider aktif & batas" icon="sparkle">
          <form method="post" action="/console/settings/llm" class="stack">
            <Csrf token={p.csrf} />
            <fieldset class="checklist" disabled={!admin}>
              <legend>Provider untuk Prompt Studio</legend>
              {(['template', 'workers_ai', 'groq'] as const).map((id) => (
                <label class="check-row">
                  <input type="radio" name="provider" value={id} checked={p.settings.provider === id} />
                  <span>
                    {PROVIDER_LABEL[id]}
                    {id !== 'template' && !p.status.configured[id] && <span class="cell-sub">belum terkonfigurasi — jika dipilih, mode template tetap dipakai</span>}
                  </span>
                </label>
              ))}
            </fieldset>
            <div class="form-row">
              <Field id="wai-model" label="Model Workers AI">
                <select id="wai-model" name="workers_ai_model" disabled={!admin}>
                  {p.workersAiModels.map((m) => (
                    <option value={m.id} selected={m.id === p.settings.workers_ai_model}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id="groq-model" label="Model Groq" hint="Contoh dari quickstart Groq; verifikasi ketersediaan di akun Anda.">
                <input {...describe('groq-model', 'x')} type="text" name="groq_model" value={p.settings.groq_model} maxlength={80} disabled={!admin} />
              </Field>
            </div>
            <div class="form-row">
              <Field id="max-out" label="Maks. token keluaran per permintaan">
                <input id="max-out" type="number" name="max_output_tokens" min={200} max={4000} value={String(p.settings.max_output_tokens)} disabled={!admin} />
              </Field>
              <Field id="neuron-cap" label="Batas Neuron Workers AI / hari" hint="Default 8.000 (di bawah alokasi gratis 10.000).">
                <input {...describe('neuron-cap', 'x')} type="number" name="daily_neuron_cap" min={0} max={1000000} value={String(p.settings.daily_neuron_cap)} disabled={!admin} />
              </Field>
              <Field id="groq-cap" label="Batas panggilan Groq / hari">
                <input id="groq-cap" type="number" name="daily_groq_calls" min={0} max={10000} value={String(p.settings.daily_groq_calls)} disabled={!admin} />
              </Field>
            </div>
            {admin && (
              <div class="row">
                <button class="btn btn-primary" data-submit-label="Menyimpan…">
                  Simpan pengaturan
                </button>
              </div>
            )}
          </form>
          {admin && (
            <div class="row studio-secondary">
              {(['workers_ai', 'groq'] as const).map((id) => (
                <form method="post" action="/console/settings/health">
                  <Csrf token={p.csrf} />
                  <input type="hidden" name="provider" value={id} />
                  <button class="btn btn-ghost btn-sm" disabled={!p.status.configured[id]} data-submit-label="Menguji…">
                    <Icon name="play" size={14} />
                    Uji {PROVIDER_LABEL[id]}
                  </button>
                </form>
              ))}
            </div>
          )}
          <p class="field-hint">Uji mengirim satu permintaan pendek tanpa data pelanggan (“Balas hanya dengan satu kata: OK”).</p>
        </Section>
      </div>

      <Section id="work-types" title="Jenis pekerjaan & template" icon="list" description="Hanya jenis yang diaktifkan yang bisa dipilih di Prompt Studio. Template dikelola di kode (src/lib/templates.ts) dan berversi.">
        <form method="post" action="/console/settings/work-types" class="stack">
          <Csrf token={p.csrf} />
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th scope="col">Aktif</th>
                  <th scope="col">Jenis pekerjaan</th>
                  <th scope="col">Template</th>
                  <th scope="col">Keluaran utama</th>
                </tr>
              </thead>
              <tbody>
                {p.workTypes.map((t) => (
                  <tr>
                    <td data-label="Aktif">
                      <label class="sr-only" for={`wt-${t.id}`}>
                        Aktifkan {t.label}
                      </label>
                      <input id={`wt-${t.id}`} type="checkbox" name="work_types" value={t.id} checked={p.enabledWorkTypes.includes(t.id) || t.id === 'general'} disabled={!admin || t.id === 'general'} />
                    </td>
                    <td data-label="Jenis">
                      <strong>{t.label}</strong>
                      <span class="cell-sub">
                        {t.description}
                        {t.enabledByDefault ? ' · layanan Embrilo saat ini' : ' · belum menjadi layanan resmi'}
                      </span>
                    </td>
                    <td data-label="Template">
                      <code class="code-soft">{`${t.id}@${t.version}`}</code>
                    </td>
                    <td data-label="Keluaran" class="cell-wrap">
                      {t.deliverables.slice(0, 2).join('; ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {admin && (
            <div class="row">
              <button class="btn btn-secondary" data-submit-label="Menyimpan…">
                Simpan jenis pekerjaan
              </button>
            </div>
          )}
        </form>
      </Section>

      <Section id="privacy" title="Privasi & data" icon="shield">
        <ul class="plain small">
          <li>Yang dikirim ke provider AI: teks prompt yang disusun dari brief (email, nomor telepon, dan string mirip kunci disamarkan). Catatan internal, audit, dan data pesanan lain tidak pernah dikirim.</li>
          <li>Yang dicatat: provider, model, status, durasi, jumlah token, dan perkiraan Neuron — tanpa isi brief maupun prompt.</li>
          <li>Keluaran AI adalah draf tidak tepercaya: tidak pernah mengubah status pesanan, mengirim hasil, atau menjalankan tindakan apa pun.</li>
          <li>Kunci API hanya disimpan sebagai secret Cloudflare di server; tidak pernah dikirim ke browser.</li>
        </ul>
      </Section>
    </Layout>
  )
}
