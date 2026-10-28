import type { FC } from 'hono/jsx'
import { Chip, Csrf, EmptyState, Flash, Layout, PageHeader, StateBadge, Time } from './layout'
import { Icon } from './icons'
import { SERVICE_LABEL, relTime } from './labels'
import { fieldLabel, type AnswerData, type ThreadMessage } from '../services/assistant'
import type { ProviderStatus } from '../services/studio'
import type { OperatorCtx } from '../types'

const PROVIDER_LABEL: Record<string, string> = { workers_ai: 'Cloudflare Workers AI', groq: 'Groq' }
const TOOL_LABEL: Record<string, string> = {
  search_orders: 'Cari order',
  get_order_details: 'Detail order',
  summarize_order: 'Ringkas order',
  identify_missing_brief_fields: 'Cek kelengkapan brief',
  draft_production_prompt: 'Draf prompt produksi',
  get_prompt_versions: 'Versi prompt',
  get_order_activity: 'Aktivitas order',
  clarify: 'Perlu klarifikasi'
}
const ACTION_STATUS: Record<string, { label: string; tone: 'neutral' | 'success' | 'danger' | 'muted' }> = {
  PROPOSED: { label: 'Menunggu konfirmasi', tone: 'neutral' },
  CONFIRMED: { label: 'Dijalankan', tone: 'success' },
  FAILED: { label: 'Gagal', tone: 'danger' },
  CANCELLED: { label: 'Dibatalkan', tone: 'muted' }
}
const AI_ERROR: Record<string, string> = {
  ai_not_configured: 'provider belum dikonfigurasi',
  ai_daily_cap: 'batas harian tercapai',
  ai_rate_limited: 'provider sedang membatasi permintaan',
  ai_auth: 'kredensial ditolak',
  ai_timeout: 'provider tidak merespons tepat waktu',
  ai_provider_error: 'kesalahan provider',
  ai_bad_output: 'keluaran tidak valid'
}

const GLOBAL_EXAMPLES = ['Order mana yang membutuhkan tindakanku?', 'Cari order video yang belum selesai', 'Tampilkan order yang menunggu revisi', 'Order mana yang belum punya prompt?']
const ORDER_EXAMPLES = ['Ringkas progres order ini', 'Informasi apa yang kurang di brief ini?', 'Buat prompt untuk tahap produksi berikutnya', 'Tampilkan aktivitas order ini']

export type AssistantPanelProps = {
  op: OperatorCtx
  csrf: string
  context: { jobId: string; ref: string } | null
  thread: ThreadMessage[]
  provider: ProviderStatus
  back: string
  now: number
  compact?: boolean
}

/** Reusable assistant panel: standalone page and the order workspace sidebar. Works without JavaScript. */
export const AssistantPanel: FC<AssistantPanelProps> = (p) => {
  const aiActive = p.provider.active !== 'template'
  const examples = p.context ? ORDER_EXAMPLES : GLOBAL_EXAMPLES
  const shown = p.compact ? p.thread.slice(-6) : p.thread
  const lastAssistant = [...shown].reverse().find((m) => m.role === 'ASSISTANT')
  return (
    <section class={`card assistant${p.compact ? ' assistant-compact' : ''}`} id="assistant" aria-labelledby="assistant-title">
      <div class="card-head">
        <div>
          <p class="eyebrow">Asisten order</p>
          <h2 class="card-title" id="assistant-title">
            {p.context ? `Tanya tentang ${p.context.ref}` : 'Tanya tentang order'}
          </h2>
          <p class="card-desc">
            Jawaban dibuat dari data tercatat. {aiActive ? `AI (${PROVIDER_LABEL[p.provider.active]}) hanya dipakai bila Anda mencentangnya.` : 'Provider AI tidak aktif — asisten memakai aturan bawaan.'}
          </p>
        </div>
        {p.thread.length > 0 && (
          <form method="post" action="/console/assistant/clear" class="card-actions">
            <Csrf token={p.csrf} />
            {p.context && <input type="hidden" name="job_id" value={p.context.jobId} />}
            <input type="hidden" name="back" value={p.back} />
            <button class="btn btn-ghost btn-sm" data-submit-label="Menghapus…">
              <Icon name="x" size={14} />
              Hapus percakapan
            </button>
          </form>
        )}
      </div>
      <div class="card-body assistant-body">
        {shown.length === 0 ? (
          <EmptyState icon="message" title="Belum ada percakapan">
            {p.context ? 'Tanyakan progres, kekurangan brief, atau minta draf prompt untuk order ini.' : 'Cari order dengan bahasa sehari-hari, misalnya “order video yang belum selesai”.'}
          </EmptyState>
        ) : (
          <ol class="thread" aria-label="Percakapan dengan asisten">
            {p.compact && p.thread.length > shown.length && (
              <li class="thread-more">
                <a href={p.context ? `/console/assistant?job=${p.context.jobId}` : '/console/assistant'}>Lihat {p.thread.length - shown.length} pesan sebelumnya</a>
              </li>
            )}
            {shown.map((m) =>
              m.role === 'OPERATOR' ? (
                <li class="msg msg-op">
                  <p class="msg-meta">
                    Anda · <Time iso={m.created_at}>{relTime(m.created_at, p.now)}</Time>
                  </p>
                  <p class="msg-text">{m.body}</p>
                </li>
              ) : (
                <li class="msg msg-ai" id={m.id === lastAssistant?.id ? 'assistant-latest' : undefined} tabindex={m.id === lastAssistant?.id ? -1 : undefined}>
                  <Answer m={m} p={p} />
                </li>
              )
            )}
          </ol>
        )}

        <form method="post" action="/console/assistant/ask" class="ask-form" id="assistant-form">
          <Csrf token={p.csrf} />
          {p.context && <input type="hidden" name="job_id" value={p.context.jobId} />}
          <input type="hidden" name="back" value={p.back} />
          <label class="field-label" for={`ask-q${p.compact ? '-c' : ''}`}>
            Pertanyaan
          </label>
          <div class="ask-row">
            <textarea
              id={`ask-q${p.compact ? '-c' : ''}`}
              name="q"
              rows={2}
              maxlength={500}
              required
              placeholder={p.context ? 'Misalnya: Ringkas progres order ini' : 'Misalnya: Cari order video yang belum selesai'}
              data-submit-on-enter
            ></textarea>
            <button class="btn btn-primary" data-submit-label="Mencari…">
              <Icon name="send" size={16} />
              Tanya
            </button>
          </div>
          {aiActive ? (
            <label class="check ask-ai">
              <input type="checkbox" name="use_ai" value="1" />
              <span>
                Gunakan AI ({PROVIDER_LABEL[p.provider.active]}) untuk memahami pertanyaan bebas dan menulis saran ringkasan. Hanya fakta order yang sedang dibahas yang dikirim, sudah disanitasi.
              </span>
            </label>
          ) : (
            <p class="field-hint">AI tidak aktif. Admin dapat memilih provider di Pengaturan; pencarian dan ringkasan berbasis aturan tetap berjalan.</p>
          )}
        </form>
        <div class="ask-examples" aria-label="Contoh pertanyaan">
          {examples.map((q) => (
            <form method="post" action="/console/assistant/ask">
              <Csrf token={p.csrf} />
              {p.context && <input type="hidden" name="job_id" value={p.context.jobId} />}
              <input type="hidden" name="back" value={p.back} />
              <input type="hidden" name="q" value={q} />
              <button class="chip chip-button" data-submit-label="…">
                {q}
              </button>
            </form>
          ))}
        </div>
      </div>
    </section>
  )
}

const Answer: FC<{ m: ThreadMessage; p: AssistantPanelProps }> = ({ m, p }) => {
  const d: AnswerData | null = m.data
  const a = m.action
  const payload = a ? (JSON.parse(a.payload_json) as { label?: string }) : null
  return (
    <>
      <p class="msg-meta">
        Asisten · {TOOL_LABEL[d?.tool ?? 'clarify'] ?? d?.tool} · {d?.planner === 'ai' ? `dipetakan AI (${PROVIDER_LABEL[m.provider ?? ''] ?? 'AI'})` : 'dipetakan aturan'} ·{' '}
        <Time iso={m.created_at}>{relTime(m.created_at, p.now)}</Time>
      </p>
      <p class="msg-text">{m.body}</p>

      {d?.facts && d.facts.length > 0 && (
        <div class="msg-block">
          <p class="msg-label">
            <Icon name="check" size={14} />
            Fakta tercatat
          </p>
          <ul class="fact-list">
            {d.facts.map((f) => (
              <li>{f}</li>
            ))}
          </ul>
        </div>
      )}

      {d?.rows && d.rows.length > 0 && (
        <div class="msg-block">
          <ul class="result-list">
            {d.rows.map((r) => (
              <li>
                <a class="ref-link" href={`/console/jobs/${r.id}`}>
                  {r.ref}
                </a>
                <StateBadge state={r.state} />
                <span class="cell-sub">
                  {SERVICE_LABEL[r.service] ?? r.service} · {r.owner ?? 'belum ditugaskan'} · berikutnya: {r.next} · diperbarui {relTime(r.updated_at, p.now)}
                </span>
                {r.flags.length > 0 && (
                  <span class="chip-list">
                    {r.flags.map((f) => (
                      <Chip tone={f === 'Prompt siap' ? 'success' : f === 'Revisi' ? 'review' : f === 'Prompt draf' ? 'neutral' : 'warning'} dot={false}>
                        {f}
                      </Chip>
                    ))}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {d.moreHref && (d.total ?? 0) > 0 && (
            <a class="btn btn-ghost btn-sm" href={d.moreHref}>
              Buka {d.total} hasil di Inbox
              <Icon name="arrowRight" size={14} />
            </a>
          )}
        </div>
      )}

      {d?.list && d.list.length > 0 && (
        <ul class="fact-list fact-list-rich">
          {d.list.map((i) => (
            <li>
              {i.href ? <a href={i.href}>{i.label}</a> : <strong>{i.label}</strong>}
              <span class="cell-sub">{i.meta}</span>
            </li>
          ))}
        </ul>
      )}

      {d?.promptPreview && (
        <div class="msg-block">
          <label class="msg-label" for={`pv-${m.id}`}>
            <Icon name="file" size={14} />
            Pratinjau prompt (belum disimpan)
          </label>
          <textarea id={`pv-${m.id}`} class="mono" rows={p.compact ? 8 : 14} readonly>
            {d.promptPreview}
          </textarea>
          <button type="button" class="btn btn-secondary btn-sm" data-copy={`#pv-${m.id}`} data-copy-toast="Pratinjau prompt tersalin. Belum disimpan dan belum dieksekusi." hidden>
            <Icon name="copy" size={14} />
            <span data-copy-label>Salin pratinjau</span>
          </button>
        </div>
      )}

      {d?.suggestion && (
        <div class="msg-block suggestion">
          <p class="msg-label">
            <Icon name="sparkle" size={14} />
            Saran AI — bukan fakta · {PROVIDER_LABEL[d.suggestion.provider] ?? d.suggestion.provider} · {d.suggestion.model}
          </p>
          <p class="msg-text pre">{d.suggestion.text}</p>
        </div>
      )}
      {d?.aiError && <p class="field-hint warn-text">Saran AI tidak tersedia ({AI_ERROR[d.aiError] ?? d.aiError}). Fakta di atas tetap berasal dari database.</p>}

      {d?.notes?.map((n) => (
        <p class="field-hint">{n}</p>
      ))}

      {a && (
        <div class={`action-card action-${a.status.toLowerCase()}`}>
          <p class="msg-label">
            <Icon name="flag" size={14} />
            Usulan tindakan <Chip tone={ACTION_STATUS[a.status]?.tone ?? 'neutral'}>{ACTION_STATUS[a.status]?.label ?? a.status}</Chip>
          </p>
          <p class="msg-text">
            <strong>{payload?.label}</strong>
          </p>
          {a.status === 'PROPOSED' ? (
            <>
              <p class="field-hint">Belum ada yang diubah. Server memeriksa ulang izin dan status order saat Anda mengonfirmasi; tindakan dicatat di audit. Berlaku 15 menit.</p>
              <div class="row">
                <form method="post" action={`/console/assistant/actions/${a.id}`}>
                  <Csrf token={p.csrf} />
                  <input type="hidden" name="back" value={p.back} />
                  <input type="hidden" name="decision" value="confirm" />
                  <button class="btn btn-primary btn-sm" data-submit-label="Menjalankan…">
                    <Icon name="check" size={14} />
                    Konfirmasi & jalankan
                  </button>
                </form>
                <form method="post" action={`/console/assistant/actions/${a.id}`}>
                  <Csrf token={p.csrf} />
                  <input type="hidden" name="back" value={p.back} />
                  <input type="hidden" name="decision" value="cancel" />
                  <button class="btn btn-ghost btn-sm" data-submit-label="Membatalkan…">
                    Batalkan
                  </button>
                </form>
              </div>
            </>
          ) : (
            a.result_note && <p class="field-hint">{a.result_note}</p>
          )}
        </div>
      )}

      {d && d.sources.length > 0 && (
        <details class="sources">
          <summary>Sumber data ({d.sources.length} order)</summary>
          <ul>
            {d.sources.map((s) => (
              <li>
                <a href={`/console/jobs/${s.jobId}`}>{s.ref}</a>: {s.fields.map(fieldLabel).join(', ')}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  )
}

export const AssistantPage: FC<{
  op: OperatorCtx
  csrf: string
  ok?: string
  err?: string
  context: { jobId: string; ref: string } | null
  thread: ThreadMessage[]
  provider: ProviderStatus
  now: number
}> = (p) => {
  const back = p.context ? `/console/assistant?job=${p.context.jobId}` : '/console/assistant'
  return (
    <Layout title="Asisten" op={p.op} csrf={p.csrf} active="assistant">
      <PageHeader
        eyebrow="Asisten internal"
        title={p.context ? `Asisten untuk ${p.context.ref}` : 'Asisten order'}
        description="Asisten hanya membaca data yang boleh Anda lihat melalui alat yang terdaftar: cari order, detail, ringkasan, kelengkapan brief, draf prompt, versi prompt, dan aktivitas. Perubahan data selalu butuh konfirmasi Anda."
        actions={
          p.context ? (
            <a class="btn btn-secondary btn-sm" href={`/console/jobs/${p.context.jobId}`}>
              <Icon name="arrowLeft" size={16} />
              Kembali ke order
            </a>
          ) : (
            <a class="btn btn-secondary btn-sm" href="/console">
              <Icon name="inbox" size={16} />
              Ke Inbox
            </a>
          )
        }
      />
      <Flash ok={p.ok} err={p.err} />
      <AssistantPanel op={p.op} csrf={p.csrf} context={p.context} thread={p.thread} provider={p.provider} back={back} now={p.now} />
    </Layout>
  )
}
