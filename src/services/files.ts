import { AppError } from '../lib/errors'
import { sha256Hex, uuid } from '../lib/crypto'
import type { Bindings } from '../types'

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024 // 10 MB

// Allowlist by extension AND declared MIME type. Content is never executed or rendered inline.
const ALLOWED: Record<string, string[]> = {
  txt: ['text/plain'],
  md: ['text/markdown', 'text/plain', 'text/x-markdown'],
  csv: ['text/csv', 'text/plain', 'application/vnd.ms-excel'],
  pdf: ['application/pdf'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  png: ['image/png'],
  jpg: ['image/jpeg'],
  jpeg: ['image/jpeg'],
  webp: ['image/webp']
}

// Magic-byte checks for binary types so a renamed file is rejected.
const MAGIC: Record<string, number[][]> = {
  pdf: [[0x25, 0x50, 0x44, 0x46]],
  png: [[0x89, 0x50, 0x4e, 0x47]],
  jpg: [[0xff, 0xd8, 0xff]],
  jpeg: [[0xff, 0xd8, 0xff]],
  webp: [[0x52, 0x49, 0x46, 0x46]],
  docx: [[0x50, 0x4b, 0x03, 0x04]]
}

export type StoredFile = {
  storage: 'R2' | 'INLINE'
  storage_key: string | null
  inline_text: string | null
  filename: string
  content_type: string
  size_bytes: number
  checksum_sha256: string
}

export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file'
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 100)
  return cleaned || 'file'
}

export function checkFile(file: File, bytes: Uint8Array) {
  if (file.size > MAX_UPLOAD_BYTES || bytes.length > MAX_UPLOAD_BYTES)
    throw new AppError(413, 'file_too_large', `File exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`)
  if (bytes.length === 0) throw new AppError(422, 'validation_failed', 'File is empty', [{ field: 'file', issue: 'empty' }])
  const ext = (file.name.split('.').pop() ?? '').toLowerCase()
  const mime = (file.type || '').split(';')[0].trim().toLowerCase()
  const allowed = ALLOWED[ext]
  if (!allowed || !allowed.includes(mime))
    throw new AppError(415, 'unsupported_file_type', `Allowed types: ${Object.keys(ALLOWED).join(', ')}`)
  const magic = MAGIC[ext]
  if (magic && !magic.some((sig) => sig.every((b, i) => bytes[i] === b)))
    throw new AppError(415, 'unsupported_file_type', 'File content does not match its extension')
  return { ext, mime }
}

/** Stores an uploaded file in the PRIVATE R2 bucket under a random key (no customer data in the key). */
export async function storeFile(env: Bindings, file: File, kind: 'REFERENCE' | 'DRAFT'): Promise<StoredFile> {
  if (file.size > MAX_UPLOAD_BYTES) throw new AppError(413, 'file_too_large', `File exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`)
  const bytes = new Uint8Array(await file.arrayBuffer())
  const { mime } = checkFile(file, bytes)
  if (!env.R2) throw new AppError(503, 'storage_not_configured', 'File storage (R2) is not configured; paste text output instead')
  const key = `${kind.toLowerCase()}/${uuid()}`
  const checksum = await sha256Hex(bytes)
  await env.R2.put(key, bytes, {
    httpMetadata: { contentType: mime },
    customMetadata: { sha256: checksum }
  })
  return {
    storage: 'R2',
    storage_key: key,
    inline_text: null,
    filename: safeFilename(file.name),
    content_type: mime,
    size_bytes: bytes.length,
    checksum_sha256: checksum
  }
}

type AssetRow = {
  storage: 'R2' | 'INLINE'
  storage_key: string | null
  inline_text: string | null
  filename: string
  content_type: string
}

/** Streams an asset as an attachment. Callers MUST authorize before calling. */
export async function assetResponse(env: Bindings, a: AssetRow): Promise<Response> {
  const headers = new Headers({
    'Content-Type': a.storage === 'INLINE' ? 'text/plain; charset=utf-8' : a.content_type,
    'Content-Disposition': `attachment; filename="${safeFilename(a.filename)}"`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox"
  })
  if (a.storage === 'INLINE') return new Response(a.inline_text ?? '', { headers })
  if (!env.R2 || !a.storage_key) throw new AppError(503, 'storage_not_configured', 'File storage is not configured')
  const obj = await env.R2.get(a.storage_key)
  if (!obj) throw new AppError(404, 'not_found', 'File not found')
  return new Response(obj.body, { headers })
}
