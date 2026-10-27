#!/usr/bin/env node
// Generates SQL to create/update an operator with a PBKDF2 password hash.
// Output goes to .local/ (gitignored). Never commit the generated file.
//
// Usage:
//   node scripts/create-operator.mjs --email you@example.com --name "Your Name" --role ADMIN
//   (password is read from the OPERATOR_PASSWORD env var, or a strong one is generated and printed once)
// Then apply:
//   npx wrangler d1 execute embrilo-os-production --local  --file=.local/operator.sql   # local
//   npx wrangler d1 execute embrilo-os-production --remote --file=.local/operator.sql   # production
import { webcrypto as crypto, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, v, i, a) => (v.startsWith('--') ? [...acc, [v.slice(2), a[i + 1]]] : acc), [])
)
const email = (args.email || '').trim().toLowerCase()
const name = (args.name || '').trim()
const role = (args.role || 'OPERATOR').toUpperCase()
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !name || !['ADMIN', 'OPERATOR', 'VIEWER'].includes(role)) {
  console.error('Usage: --email <email> --name <name> [--role ADMIN|OPERATOR|VIEWER]')
  process.exit(1)
}
let password = process.env.OPERATOR_PASSWORD
let generated = false
if (!password) {
  password = randomBytes(18).toString('base64url')
  generated = true
}
if (password.length < 12) {
  console.error('Password must be at least 12 characters')
  process.exit(1)
}
const b64 = (b) => Buffer.from(b).toString('base64url')
const ITER = 100000
const salt = crypto.getRandomValues(new Uint8Array(16))
const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITER }, key, 256)
const hash = `pbkdf2-sha256$${ITER}$${b64(salt)}$${b64(bits)}`
const q = (s) => `'${String(s).replace(/'/g, "''")}'`
const now = new Date().toISOString()
const sql = `INSERT INTO operators (id, email, display_name, role, password_hash, active, failed_logins, created_at, updated_at)
VALUES (${q(randomUUID())}, ${q(email)}, ${q(name)}, ${q(role)}, ${q(hash)}, 1, 0, ${q(now)}, ${q(now)})
ON CONFLICT(email) DO UPDATE SET display_name = excluded.display_name, role = excluded.role, password_hash = excluded.password_hash,
  active = 1, failed_logins = 0, locked_until = NULL, updated_at = excluded.updated_at;
`
mkdirSync('.local', { recursive: true })
const file = args.out || '.local/operator.sql'
writeFileSync(file, sql, { mode: 0o600 })
console.log(`Wrote ${file} for ${email} (${role}).`)
if (generated) console.log(`Generated password (shown once, store it in a password manager): ${password}`)
