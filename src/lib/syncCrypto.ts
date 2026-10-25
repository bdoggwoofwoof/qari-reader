// End-to-end encryption for sync. The sync code never leaves the device; the server only sees
// a hash of it (the "space" id) and AES-GCM ciphertext.

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O or 1/I, so codes are easy to read and type
const te = new TextEncoder()
const td = new TextDecoder()

/** A new random 32-character sync code (160 bits). */
export function newSyncCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes, (b) => ALPHABET[b % 32]).join('')
}

/** Uppercases, removes spaces/dashes, and maps easily-confused characters. Returns null if it isn't a valid code. */
export function normalizeCode(input: string): string | null {
  // Codes may also arrive inside a join link: take the part after the last slash.
  const c = input.trim().split('/').pop()!.toUpperCase().replace(/[\s-]/g, '')
  if (c.length !== 32 || [...c].some((ch) => !ALPHABET.includes(ch))) return null
  return c
}

export function formatCode(code: string) {
  return code.match(/.{1,4}/g)!.join('-')
}

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')

export interface SyncKeys {
  space: string
  key: CryptoKey
}

export async function deriveKeys(code: string): Promise<SyncKeys> {
  const space = hex(await crypto.subtle.digest('SHA-256', te.encode('qari-space:' + code)))
  const base = await crypto.subtle.importKey('raw', te.encode(code), 'HKDF', false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: te.encode('qari-sync-v1'), info: te.encode('encryption') },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
  return { space, key }
}

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream) {
  const out = new Blob([data as BlobPart]).stream().pipeThrough(stream)
  return new Uint8Array(await new Response(out).arrayBuffer())
}

/** JSON → gzip → AES-GCM. Layout: [1 version byte][12-byte IV][ciphertext]. */
export async function encryptJSON(key: CryptoKey, value: unknown): Promise<Uint8Array> {
  const zipped = await pipe(te.encode(JSON.stringify(value)), new CompressionStream('gzip'))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, zipped as BufferSource))
  const out = new Uint8Array(1 + iv.length + ct.length)
  out[0] = 1
  out.set(iv, 1)
  out.set(ct, 13)
  return out
}

/** Raw bytes (e.g. an original PDF, already compressed) → AES-GCM. Layout: [2][IV][ciphertext]. */
export async function encryptBytes(key: CryptoKey, bytes: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes as BufferSource))
  const out = new Uint8Array(13 + ct.length)
  out[0] = 2
  out.set(iv, 1)
  out.set(ct, 13)
  return out
}

export async function decryptBytes(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  if (data[0] !== 2) throw new Error('Unknown sync data version.')
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(1, 13) }, key, data.slice(13) as BufferSource))
}

export async function decryptJSON<T>(key: CryptoKey, data: Uint8Array): Promise<T> {
  if (data[0] !== 1) throw new Error('Unknown sync data version.')
  const iv = data.slice(1, 13)
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data.slice(13) as BufferSource)
  const unzipped = await pipe(new Uint8Array(plain), new DecompressionStream('gzip'))
  return JSON.parse(td.decode(unzipped)) as T
}
