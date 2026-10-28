// Indonesian-first UI copy, tones and small formatting helpers shared by all views.
// Business identifiers (state codes, service codes) stay stable; only labels change here.
import type { JobState } from '../lib/state'

export type Tone = 'neutral' | 'info' | 'review' | 'success' | 'warning' | 'danger' | 'muted'

export const STATE_TONE: Record<JobState, Tone> = {
  SUBMITTED: 'neutral',
  TRIAGE: 'neutral',
  QUEUED: 'info',
  IN_PRODUCTION: 'info',
  QC_REVIEW: 'review',
  APPROVED: 'success',
  DELIVERED: 'success',
  NEEDS_INFO: 'warning',
  NEEDS_REVISION: 'warning',
  BLOCKED_PROVIDER: 'danger',
  FAILED: 'danger',
  CANCELLED: 'muted'
}

export const PRIORITY_LABEL: Record<string, string> = { LOW: 'Rendah', NORMAL: 'Normal', HIGH: 'Tinggi', URGENT: 'Mendesak' }
export const PRIORITY_TONE: Record<string, Tone> = { LOW: 'muted', NORMAL: 'neutral', HIGH: 'warning', URGENT: 'danger' }

export const SERVICE_LABEL: Record<string, string> = {
  SCRIPT_PACK: 'Paket skrip',
  HOOK_CAPTION_PACK: 'Hook & caption',
  PRODUCT_STORY: 'Cerita produk',
  CONTENT_CALENDAR: 'Kalender konten',
  PRODUCTION_BRIEF: 'Brief produksi'
}

export const PLATFORM_LABEL: Record<string, string> = {
  tiktok: 'TikTok',
  instagram_reels: 'Instagram Reels',
  youtube_shorts: 'YouTube Shorts',
  facebook: 'Facebook',
  other: 'Lainnya'
}

export const LANGUAGE_LABEL: Record<string, string> = { id: 'Bahasa Indonesia', en: 'Inggris', 'id-en': 'Indonesia + istilah Inggris' }

export const ROLE_LABEL: Record<string, string> = { ADMIN: 'Admin', OPERATOR: 'Operator', VIEWER: 'Peninjau (baca saja)' }

export const QC_LABEL: Record<string, string> = {
  factual_accuracy: 'Fakta sesuai brief — tidak ada spesifikasi, harga, testimoni, atau hasil yang dikarang',
  brand_fit: 'Nada dan gaya cocok dengan merek serta audiens',
  language_quality: 'Bahasa alami dan benar (Bahasa Indonesia diutamakan)',
  platform_format: 'Format, durasi, dan struktur sesuai platform tujuan',
  rights_clear: 'Tidak memakai materi pihak ketiga tanpa hak',
  no_prohibited_claims: 'Tidak ada klaim terlarang, menyesatkan, atau janji hasil'
}

export const PROVIDER_ERROR_LABEL: Record<string, string> = {
  PROVIDER_UNAVAILABLE: 'Provider tidak tersedia',
  PROVIDER_QUOTA: 'Kuota provider habis',
  OUTPUT_UNUSABLE: 'Hasil tidak layak pakai',
  SAFETY_REFUSAL: 'Ditolak oleh filter keamanan',
  BRIEF_INSUFFICIENT: 'Brief kurang lengkap',
  OTHER: 'Lainnya'
}

export const RUN_STATUS_LABEL: Record<string, { label: string; tone: Tone }> = {
  RUNNING: { label: 'Berjalan', tone: 'info' },
  SUCCEEDED: { label: 'Berhasil', tone: 'success' },
  FAILED: { label: 'Gagal', tone: 'danger' },
  BLOCKED: { label: 'Terhambat', tone: 'warning' }
}

// Queue groupings — they mirror the real state model, nothing is invented.
export type QueueView = 'triage' | 'info' | 'ready' | 'production' | 'review' | 'deliver' | 'done'
export const QUEUE_VIEWS: { id: QueueView; label: string; hint: string; states: JobState[] }[] = [
  { id: 'triage', label: 'Perlu triase', hint: 'Permintaan baru & sedang dikualifikasi', states: ['SUBMITTED', 'TRIAGE'] },
  { id: 'info', label: 'Menunggu informasi', hint: 'Menunggu jawaban pelanggan', states: ['NEEDS_INFO'] },
  { id: 'ready', label: 'Siap diproduksi', hint: 'Antre produksi & revisi', states: ['QUEUED', 'NEEDS_REVISION'] },
  { id: 'production', label: 'Produksi', hint: 'Sedang berjalan, terhambat, atau gagal', states: ['IN_PRODUCTION', 'BLOCKED_PROVIDER', 'FAILED'] },
  { id: 'review', label: 'Perlu ditinjau', hint: 'Draf menunggu QC', states: ['QC_REVIEW'] },
  { id: 'deliver', label: 'Siap dikirim', hint: 'Lolos QC, belum dikirim', states: ['APPROVED'] },
  { id: 'done', label: 'Selesai', hint: 'Terkirim atau dibatalkan', states: ['DELIVERED', 'CANCELLED'] }
]

export function nextAction(s: JobState): { label: string; who: 'ops' | 'customer' | 'none' } {
  switch (s) {
    case 'SUBMITTED':
      return { label: 'Mulai triase', who: 'ops' }
    case 'TRIAGE':
      return { label: 'Kualifikasi brief', who: 'ops' }
    case 'NEEDS_INFO':
      return { label: 'Tunggu jawaban pelanggan', who: 'customer' }
    case 'QUEUED':
      return { label: 'Mulai produksi', who: 'ops' }
    case 'NEEDS_REVISION':
      return { label: 'Kerjakan revisi', who: 'ops' }
    case 'IN_PRODUCTION':
      return { label: 'Lampirkan hasil', who: 'ops' }
    case 'BLOCKED_PROVIDER':
      return { label: 'Coba produksi lagi', who: 'ops' }
    case 'FAILED':
      return { label: 'Kembalikan ke antrean', who: 'ops' }
    case 'QC_REVIEW':
      return { label: 'Tinjau draf', who: 'ops' }
    case 'APPROVED':
      return { label: 'Kirim ke pelanggan', who: 'ops' }
    case 'DELIVERED':
      return { label: 'Selesai — revisi bila diminta', who: 'none' }
    case 'CANCELLED':
      return { label: 'Tidak ada', who: 'none' }
  }
}

export const WORKFLOW_STEPS: { state: JobState; label: string }[] = [
  { state: 'SUBMITTED', label: 'Masuk' },
  { state: 'TRIAGE', label: 'Triase' },
  { state: 'QUEUED', label: 'Antre' },
  { state: 'IN_PRODUCTION', label: 'Produksi' },
  { state: 'QC_REVIEW', label: 'QC' },
  { state: 'APPROVED', label: 'Disetujui' },
  { state: 'DELIVERED', label: 'Terkirim' }
]

/** Position on the main path (0..6). Branch states map onto the step they belong to. */
export function workflowIndex(s: JobState): number {
  const map: Partial<Record<JobState, number>> = { NEEDS_INFO: 1, NEEDS_REVISION: 3, BLOCKED_PROVIDER: 3, FAILED: 3, CANCELLED: 0 }
  const i = WORKFLOW_STEPS.findIndex((w) => w.state === s)
  return i >= 0 ? i : (map[s] ?? 0)
}

// ---------------------------------------------------------------------------
// Time formatting (UTC, Indonesian month names)
// ---------------------------------------------------------------------------
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des']
const pad = (n: number) => String(n).padStart(2, '0')

export function fmtDateTime(iso?: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
}

export function relTime(iso?: string | null, now = Date.now()): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '—'
  const s = Math.round((now - t) / 1000)
  if (s < 45) return 'baru saja'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} mnt lalu`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} jam lalu`
  const d = Math.round(h / 24)
  if (d < 30) return `${d} hari lalu`
  return fmtDateTime(iso).split(',')[0]
}

export function ageLabel(iso: string, now = Date.now()): { text: string; stale: boolean } {
  const h = (now - Date.parse(iso)) / 3_600_000
  if (!Number.isFinite(h) || h < 0) return { text: '—', stale: false }
  if (h < 1) return { text: '< 1 jam', stale: false }
  if (h < 24) return { text: `${Math.floor(h)} jam`, stale: false }
  return { text: `${Math.floor(h / 24)} hari`, stale: h >= 48 }
}

// ---------------------------------------------------------------------------
// Errors: map stable error codes and validation issues to Indonesian copy
// ---------------------------------------------------------------------------
export const ERROR_MESSAGES: Record<string, string> = {
  invalid_transition: 'Aksi ini tidak tersedia untuk status pekerjaan saat ini. Muat ulang halaman untuk melihat status terbaru.',
  concurrent_modification: 'Pekerjaan ini baru saja diubah orang lain. Muat ulang halaman, lalu coba lagi.',
  validation_failed: 'Periksa kembali isian yang ditandai.',
  rights_not_confirmed: 'Hak atas materi belum dikonfirmasi. Konfirmasi di bagian Brief sebelum memasukkan ke antrean.',
  run_in_progress: 'Masih ada proses produksi yang berjalan untuk pekerjaan ini.',
  run_not_running: 'Proses produksi ini sudah ditutup. Muat ulang halaman.',
  no_draft: 'Belum ada draf untuk ditinjau.',
  not_approved: 'Pengiriman butuh persetujuan QC untuk draf terbaru.',
  brief_locked: 'Brief tidak bisa diubah pada status ini.',
  job_closed: 'Pekerjaan ini sudah ditutup.',
  file_too_large: 'File melebihi batas 10 MB.',
  unsupported_file_type: 'Jenis file tidak didukung. Gunakan txt, md, csv, pdf, docx, png, jpg, atau webp.',
  storage_not_configured: 'Penyimpanan file belum dikonfigurasi. Tempel hasil sebagai teks.',
  rate_limited: 'Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.',
  csrf_failed: 'Token keamanan kedaluwarsa. Muat ulang halaman lalu coba lagi.',
  bad_origin: 'Permintaan dari situs lain ditolak demi keamanan.',
  forbidden: 'Anda tidak punya izin untuk tindakan ini.',
  not_found: 'Halaman atau data yang dicari tidak ditemukan.',
  unauthenticated: 'Silakan masuk terlebih dahulu.'
}

const ISSUE_RULES: [RegExp, string | ((m: RegExpMatchArray) => string)][] = [
  [/^is required: tell the customer/, 'Wajib diisi: jelaskan informasi apa yang kurang'],
  [/^is required$/, 'Wajib diisi'],
  [/^must be at least (\d+) characters$/, (m) => `Minimal ${m[1]} karakter`],
  [/^must be at most (\d+) characters$/, (m) => `Maksimal ${m[1]} karakter`],
  [/^must pass before approval$/, 'Harus lolos sebelum disetujui'],
  [/^explain what must change$/, 'Jelaskan apa yang harus diubah'],
  [/^provide the generated output/, 'Tempel hasil sebagai teks atau lampirkan file'],
  [/^provide either text or a file/, 'Pilih salah satu: teks atau file, bukan keduanya'],
  [/^must be an array of 1-5 platforms$/, 'Pilih 1–5 platform'],
  [/^must be an integer between/, 'Harus berupa angka bulat dalam rentang yang diizinkan'],
  [/^must be an https URL without credentials$/, 'Harus URL https tanpa nama pengguna/kata sandi'],
  [/^must be a valid URL$/, 'URL tidak valid'],
  [/^at most 5 references$/, 'Maksimal 5 referensi'],
  [/^must be one of/, 'Pilihan tidak valid'],
  [/^unknown operator$/, 'Operator tidak dikenal'],
  [/^unknown provider$/, 'Provider tidak dikenal'],
  [/^has an invalid format$/, 'Format tidak valid'],
  [/^must be true$/, 'Wajib dicentang'],
  [/^is required$/, 'Wajib diisi']
]

export function translateIssue(issue: string): string {
  for (const [re, out] of ISSUE_RULES) {
    const m = issue.match(re)
    if (m) return typeof out === 'string' ? out : out(m)
  }
  return issue
}

/** Maps a server field path (e.g. `brief.platforms[0]`, `checklist.brand_fit`) to the form input name. */
export function fieldKey(path: string): string {
  return path
    .replace(/^(brief|checklist)\./, '')
    .replace(/\[\d+\]$/, '')
    .split('.')[0]
}

export function auditActionLabel(action: string): string {
  const fixed: Record<string, string> = {
    'auth.login': 'Masuk ke konsol',
    'auth.logout': 'Keluar dari konsol',
    'auth.login_failed': 'Gagal masuk',
    'auth.locked': 'Akun dikunci sementara',
    'request.created': 'Permintaan baru masuk',
    'job.assigned': 'Penugasan / prioritas diubah',
    'brief.updated': 'Brief diperbarui',
    'production.result_recorded': 'Draf dilampirkan',
    'production.failed': 'Kegagalan provider dicatat',
    'review.recorded': 'Tinjauan QC dicatat',
    'delivery.released': 'Dikirim ke pelanggan',
    'revision.requested': 'Revisi diminta pelanggan',
    'asset.reference_added': 'Referensi diunggah',
    'asset.downloaded': 'Aset privat diunduh'
  }
  if (fixed[action]) return fixed[action]
  const m = action.match(/^job\.transition\.(.+)$/)
  if (m) return `Status → ${m[1].toUpperCase().replace(/_/g, ' ')}`
  return action
}

export const AUDIT_TYPES: { id: string; label: string; prefix: string }[] = [
  { id: 'auth', label: 'Akses & login', prefix: 'auth.' },
  { id: 'request', label: 'Permintaan masuk', prefix: 'request.' },
  { id: 'transition', label: 'Perubahan status', prefix: 'job.transition.' },
  { id: 'production', label: 'Produksi', prefix: 'production.' },
  { id: 'review', label: 'Tinjauan QC', prefix: 'review.' },
  { id: 'delivery', label: 'Pengiriman', prefix: 'delivery.' },
  { id: 'revision', label: 'Revisi', prefix: 'revision.' },
  { id: 'asset', label: 'Aset', prefix: 'asset.' }
]
