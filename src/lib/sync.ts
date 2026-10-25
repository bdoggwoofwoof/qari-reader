import { useEffect, useState } from 'react'
import type { DocContent, DocMeta, Highlight, SavedWord } from '../types'
import {
  deleteDoc,
  deleteHighlight,
  deleteWord,
  getContent,
  getFile as getStoredFile,
  listDocs,
  listHighlights,
  listWords,
  loadTombstones,
  onLocalChange,
  putDocMeta,
  saveDoc,
  saveFile,
  saveHighlight,
  saveTombstones,
  saveWord,
} from './db'
import { applySyncedSettings, onSettingsChange, syncedSettings, type SyncedSettings } from './settings'
import { decryptBytes, decryptJSON, deriveKeys, encryptBytes, encryptJSON, type SyncKeys } from './syncCrypto'

// ---------- What's stored remotely ----------

interface RemoteDoc {
  meta: DocMeta
  chunks: number // the book's text, encrypted, in this many files
  fileChunks?: number // the original PDF, if uploaded; downloaded only when a page is viewed
  fileType?: string
}

interface Manifest {
  v: 1
  docs: Record<string, RemoteDoc>
  words: Record<string, SavedWord>
  highlights: Record<string, Highlight>
  deletedDocs: Record<string, number>
  deletedWords: Record<string, number>
  deletedHighlights: Record<string, number>
  settings?: SyncedSettings
}

const EMPTY: Manifest = { v: 1, docs: {}, words: {}, highlights: {}, deletedDocs: {}, deletedWords: {}, deletedHighlights: {} }
const CHUNK = 3_500_000 // stays under the 4.5 MB request limit of Vercel Functions
const MAX_ORIGINAL = 60 * 1024 * 1024 // originals larger than this stay on the device they were added on
const TOMB_DAYS = 120

// ---------- Status ----------

export type SyncState = 'off' | 'idle' | 'syncing' | 'error' | 'offline'
export interface SyncStatus {
  state: SyncState
  lastSync?: number
  error?: string
}

const CODE_KEY = 'qari.sync.code'
const LAST_KEY = 'qari.sync.last'

let status: SyncStatus = { state: 'off' }
const statusListeners = new Set<(s: SyncStatus) => void>()
function setStatus(s: Partial<SyncStatus>) {
  status = { ...status, ...s }
  statusListeners.forEach((l) => l(status))
}

export function useSyncStatus() {
  const [s, setS] = useState(status)
  useEffect(() => {
    statusListeners.add(setS)
    setS(status)
    return () => {
      statusListeners.delete(setS)
    }
  }, [])
  return s
}

export function getSyncCode() {
  try {
    return localStorage.getItem(CODE_KEY)
  } catch {
    return null
  }
}

// ---------- Transport ----------

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function getFile(space: string, file: string): Promise<{ data: Uint8Array; etag: string } | null> {
  const r = await fetch(`/api/sync?space=${space}&file=${file}`, { cache: 'no-store' })
  if (r.status === 404) return null
  if (!r.ok) throw new HttpError(r.status, await errorText(r))
  return { data: new Uint8Array(await r.arrayBuffer()), etag: r.headers.get('ETag') || '' }
}

async function putFile(space: string, file: string, data: Uint8Array, ifMatch?: string) {
  const r = await fetch(`/api/sync?space=${space}&file=${file}`, {
    method: 'PUT',
    body: data as BodyInit,
    headers: { 'Content-Type': 'application/octet-stream', ...(ifMatch ? { 'If-Match': ifMatch } : {}) },
  })
  if (!r.ok) throw new HttpError(r.status, await errorText(r))
}

async function errorText(r: Response) {
  try {
    return (await r.json()).error || r.statusText
  } catch {
    return r.statusText
  }
}

// ---------- Merge ----------

const newer = (a?: number, b?: number) => (a ?? 0) > (b ?? 0)

/** Picks the newer copy of each part of a book's record: edits, reading position and last-opened time separately. */
function mergeMeta(local: DocMeta, remote: DocMeta): DocMeta {
  const base = newer(remote.updatedAt, local.updatedAt) ? { ...remote } : { ...local }
  const pos = newer(remote.positionAt, local.positionAt) ? remote : local
  base.position = pos.position
  base.progress = pos.progress
  base.positionAt = pos.positionAt
  base.openedAt = Math.max(local.openedAt || 0, remote.openedAt || 0)
  return base
}

const lastTouched = (m: DocMeta) => Math.max(m.updatedAt ?? 0, m.positionAt ?? 0, m.addedAt ?? 0)

function maxMerge(a: Record<string, number>, b: Record<string, number>) {
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) out[k] = Math.max(out[k] ?? 0, v)
  const cutoff = Date.now() - TOMB_DAYS * 864e5
  for (const [k, v] of Object.entries(out)) if (v < cutoff) delete out[k]
  return out
}

function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

// ---------- Sync ----------

let keys: SyncKeys | null = null
let running = false
let again = false
let lastManifest: Manifest | null = null

/** Uploads a book's original PDF (encrypted) if this device has it. */
async function uploadOriginal(k: SyncKeys, id: string): Promise<Pick<RemoteDoc, 'fileChunks' | 'fileType'>> {
  const file = await getStoredFile(id)
  if (!file || file.data.size > MAX_ORIGINAL) return {}
  const bytes = await encryptBytes(k.key, new Uint8Array(await file.data.arrayBuffer()))
  const n = Math.max(1, Math.ceil(bytes.length / CHUNK))
  for (let i = 0; i < n; i++) await putFile(k.space, `f-${id}-${i}`, bytes.slice(i * CHUNK, (i + 1) * CHUNK))
  return { fileChunks: n, fileType: file.type }
}

async function syncOnce(k: SyncKeys): Promise<{ changedLocal: boolean }> {
  let changedLocal = false
  for (let attempt = 0; attempt < 3; attempt++) {
    const remoteFile = await getFile(k.space, 'manifest')
    const remote: Manifest = remoteFile ? { ...EMPTY, ...(await decryptJSON<Manifest>(k.key, remoteFile.data)) } : { ...EMPTY }
    const tomb = loadTombstones()
    const deletedDocs = maxMerge(remote.deletedDocs, tomb.docs)
    const deletedWords = maxMerge(remote.deletedWords, tomb.words)
    const deletedHighlights = maxMerge(remote.deletedHighlights, tomb.highlights)

    // Books
    const localDocs = new Map((await listDocs()).map((d) => [d.id, d]))
    const docs: Record<string, RemoteDoc> = {}
    for (const id of new Set([...localDocs.keys(), ...Object.keys(remote.docs)])) {
      const l = localDocs.get(id)
      const r = remote.docs[id]
      const gone = deletedDocs[id]
      if (gone && gone >= Math.max(l ? lastTouched(l) : 0, r ? lastTouched(r.meta) : 0)) {
        if (l) {
          await deleteDoc(id, { fromSync: true })
          changedLocal = true
        }
        continue
      }
      if (l && r) {
        const merged = mergeMeta(l, r.meta)
        if (JSON.stringify(merged) !== JSON.stringify(l)) {
          await putDocMeta(merged)
          changedLocal = true
        }
        docs[id] = { ...r, meta: merged, ...(r.fileChunks ? {} : await uploadOriginal(k, id)) }
      } else if (l) {
        const content = await getContent(id)
        if (!content) continue
        const bytes = await encryptJSON(k.key, content)
        const n = Math.max(1, Math.ceil(bytes.length / CHUNK))
        for (let i = 0; i < n; i++) await putFile(k.space, `c-${id}-${i}`, bytes.slice(i * CHUNK, (i + 1) * CHUNK))
        docs[id] = { meta: l, chunks: n, ...(await uploadOriginal(k, id)) }
      } else if (r) {
        const parts = await Promise.all(Array.from({ length: r.chunks }, (_, i) => getFile(k.space, `c-${id}-${i}`)))
        if (parts.some((p) => !p)) {
          docs[id] = r // still uploading from the other device; try again next time
          continue
        }
        const content = await decryptJSON<DocContent>(k.key, concat(parts.map((p) => p!.data)))
        await saveDoc(r.meta, content, { fromSync: true })
        docs[id] = r
        changedLocal = true
      }
    }

    // Saved words
    const localWords = new Map((await listWords()).map((w) => [w.id, w]))
    const words: Record<string, SavedWord> = {}
    for (const id of new Set([...localWords.keys(), ...Object.keys(remote.words)])) {
      const w = localWords.get(id) || remote.words[id]
      if (deletedWords[id] && deletedWords[id] >= w.addedAt) {
        if (localWords.has(id)) {
          await deleteWord(id, { fromSync: true })
          changedLocal = true
        }
        continue
      }
      if (!localWords.has(id)) {
        await saveWord(w, { fromSync: true })
        changedLocal = true
      }
      words[id] = w
    }

    // Highlights and notes: newest edit wins; a later deletion wins over an older edit.
    const localHl = new Map((await listHighlights()).map((h) => [h.id, h]))
    const highlights: Record<string, Highlight> = {}
    for (const id of new Set([...localHl.keys(), ...Object.keys(remote.highlights)])) {
      const l = localHl.get(id)
      const r = remote.highlights[id]
      const h = l && r ? (newer(r.updatedAt, l.updatedAt) ? r : l) : (l || r)!
      if (!docs[h.docId] || (deletedHighlights[id] && deletedHighlights[id] >= h.updatedAt)) {
        if (l) {
          await deleteHighlight(id, { fromSync: true })
          changedLocal = true
        }
        continue
      }
      if (h !== l) {
        await saveHighlight(h, { fromSync: true })
        changedLocal = true
      }
      highlights[id] = h
    }

    // Settings: the most recently changed device wins.
    const mine = syncedSettings()
    let settings = mine
    if (remote.settings && newer(remote.settings.updatedAt, mine.updatedAt)) {
      applySyncedSettings(remote.settings)
      settings = remote.settings
    }

    saveTombstones({ docs: deletedDocs, words: deletedWords, highlights: deletedHighlights })
    const next: Manifest = { v: 1, docs, words, highlights, deletedDocs, deletedWords, deletedHighlights, settings }
    const strip = (m: Manifest) => JSON.stringify({ ...m, v: 1 })
    if (remoteFile && strip(next) === strip(remote)) {
      lastManifest = next
      return { changedLocal }
    }
    try {
      await putFile(k.space, 'manifest', await encryptJSON(k.key, next), remoteFile?.etag)
      lastManifest = next
      return { changedLocal }
    } catch (e) {
      if (e instanceof HttpError && e.status === 412) continue // another device saved first: merge again
      throw e
    }
  }
  throw new Error('Another device kept changing the library; try again in a moment.')
}

/** Downloads a book's original PDF from sync (only when someone opens a page), and keeps it on this device. */
export async function fetchOriginal(docId: string): Promise<Blob | null> {
  if (!keys || !navigator.onLine) return null
  try {
    let m = lastManifest
    if (!m?.docs[docId]?.fileChunks) {
      const f = await getFile(keys.space, 'manifest')
      if (!f) return null
      m = { ...EMPTY, ...(await decryptJSON<Manifest>(keys.key, f.data)) }
    }
    const r = m.docs[docId]
    if (!r?.fileChunks) return null
    const k = keys
    const parts = await Promise.all(Array.from({ length: r.fileChunks }, (_, i) => getFile(k.space, `f-${docId}-${i}`)))
    if (parts.some((p) => !p)) return null
    const bytes = await decryptBytes(k.key, concat(parts.map((p) => p!.data)))
    const blob = new Blob([bytes as BlobPart], { type: r.fileType || 'application/pdf' })
    await saveFile(docId, blob)
    return blob
  } catch {
    return null
  }
}

export async function syncNow(): Promise<void> {
  if (!keys) return
  if (running) {
    again = true
    return
  }
  if (!navigator.onLine) {
    setStatus({ state: 'offline' })
    return
  }
  running = true
  setStatus({ state: 'syncing', error: undefined })
  try {
    const { changedLocal } = await syncOnce(keys)
    const now = Date.now()
    try {
      localStorage.setItem(LAST_KEY, String(now))
    } catch {
      /* ignore */
    }
    setStatus({ state: 'idle', lastSync: now })
    if (changedLocal) window.dispatchEvent(new CustomEvent('qari:synced'))
  } catch (e) {
    const msg =
      e instanceof HttpError && e.status === 503
        ? 'Sync storage isn’t set up on the server yet.'
        : e instanceof DOMException && e.name === 'OperationError'
          ? 'This sync code doesn’t match the one used on your other device.'
          : e instanceof Error
            ? e.message
            : String(e)
    setStatus({ state: navigator.onLine ? 'error' : 'offline', error: msg })
  } finally {
    running = false
    if (again) {
      again = false
      setTimeout(syncNow, 500)
    }
  }
}

// ---------- Turning sync on and off ----------

let debounce: number | null = null
function schedule(ms: number) {
  if (!keys) return
  if (debounce) clearTimeout(debounce)
  debounce = window.setTimeout(syncNow, ms)
}

let wired = false
function wire() {
  if (wired) return
  wired = true
  onLocalChange((kind) => schedule(kind === 'position' ? 20_000 : 2_000))
  onSettingsChange(() => schedule(3_000))
  document.addEventListener('visibilitychange', () => {
    if (!keys) return
    // Leaving the app: save now. Coming back: pick up what the other device did.
    syncNow()
  })
  window.addEventListener('online', () => keys && syncNow())
}

export async function startSync(code: string) {
  keys = await deriveKeys(code)
  try {
    localStorage.setItem(CODE_KEY, code)
  } catch {
    /* ignore */
  }
  const last = Number(localStorage.getItem(LAST_KEY)) || undefined
  setStatus({ state: 'idle', lastSync: last, error: undefined })
  wire()
  await syncNow()
}

export function stopSync() {
  keys = null
  try {
    localStorage.removeItem(CODE_KEY)
    localStorage.removeItem(LAST_KEY)
  } catch {
    /* ignore */
  }
  setStatus({ state: 'off', lastSync: undefined, error: undefined })
}

/** Called once at app start: resumes sync if this device has a code. */
export function initSync() {
  const code = getSyncCode()
  if (code) startSync(code)
}
