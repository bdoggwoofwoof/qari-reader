import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { DocContent, DocMeta, Highlight, Position, SavedWord } from '../types'

export interface StoredFile {
  id: string // the doc id
  type: string
  data: Blob
}

interface QariDB extends DBSchema {
  docs: { key: string; value: DocMeta }
  content: { key: string; value: DocContent }
  words: { key: string; value: SavedWord; indexes: { byAdded: number } }
  highlights: { key: string; value: Highlight; indexes: { byDoc: string } }
  files: { key: string; value: StoredFile }
  vocab: { key: string; value: VocabRecord }
}

/** Known words for one language: normalized word → time marked (negative = marked not-known again). */
export interface VocabRecord {
  lang: string
  words: Record<string, number>
}

let dbPromise: Promise<IDBPDatabase<QariDB>> | null = null

function db() {
  if (!dbPromise) {
    dbPromise = openDB<QariDB>('qari', 3, {
      upgrade(d, oldVersion) {
        if (oldVersion < 1) {
          d.createObjectStore('docs', { keyPath: 'id' })
          d.createObjectStore('content', { keyPath: 'id' })
          const w = d.createObjectStore('words', { keyPath: 'id' })
          w.createIndex('byAdded', 'addedAt')
        }
        if (oldVersion < 2) {
          const h = d.createObjectStore('highlights', { keyPath: 'id' })
          h.createIndex('byDoc', 'docId')
          d.createObjectStore('files', { keyPath: 'id' })
        }
        if (oldVersion < 3) d.createObjectStore('vocab', { keyPath: 'lang' })
      },
      // Another tab is upgrading, or iOS dropped the connection: open again next time instead of failing forever.
      blocking(_v, _n, event) {
        ;(event.target as IDBDatabase).close()
        dbPromise = null
      },
      terminated() {
        dbPromise = null
      },
    })
    dbPromise.catch(() => {
      dbPromise = null
    })
  }
  return dbPromise
}

// ---------- Change notifications (sync listens to these) ----------

type ChangeKind = 'docs' | 'words' | 'position' | 'opened' | 'highlights' | 'vocab'
const changeListeners = new Set<(k: ChangeKind) => void>()
export function onLocalChange(cb: (k: ChangeKind) => void) {
  changeListeners.add(cb)
  return () => {
    changeListeners.delete(cb)
  }
}
const changed = (k: ChangeKind) => changeListeners.forEach((l) => l(k))

// Deletions are remembered for a while so other devices learn about them.
const TOMB_KEY = 'qari.tombstones'
export interface Tombstones {
  docs: Record<string, number>
  words: Record<string, number>
  highlights: Record<string, number>
}
export function loadTombstones(): Tombstones {
  try {
    return { docs: {}, words: {}, highlights: {}, ...JSON.parse(localStorage.getItem(TOMB_KEY) || '{}') }
  } catch {
    return { docs: {}, words: {}, highlights: {} }
  }
}
export function saveTombstones(t: Tombstones) {
  try {
    localStorage.setItem(TOMB_KEY, JSON.stringify(t))
  } catch {
    /* storage unavailable */
  }
}
function tombstone(kind: keyof Tombstones, id: string) {
  const t = loadTombstones()
  t[kind][id] = Date.now()
  saveTombstones(t)
}

// ---------- Documents ----------

export async function listDocs(): Promise<DocMeta[]> {
  const all = await (await db()).getAll('docs')
  return all.sort((a, b) => b.openedAt - a.openedAt)
}

export async function saveDoc(meta: DocMeta, content: DocContent, opts: { fromSync?: boolean } = {}) {
  const d = await db()
  const m = { ...meta, updatedAt: meta.updatedAt ?? Date.now() }
  const tx = d.transaction(['docs', 'content'], 'readwrite')
  await Promise.all([tx.objectStore('docs').put(m), tx.objectStore('content').put(content), tx.done])
  // Ask the browser not to evict the library when storage gets tight (matters most on iPhone).
  try {
    await navigator.storage?.persist?.()
  } catch {
    /* not supported */
  }
  if (!opts.fromSync) changed('docs')
}

export async function getDoc(id: string) {
  const d = await db()
  const [meta, content] = await Promise.all([d.get('docs', id), d.get('content', id)])
  return meta && content ? { meta, content } : null
}

export async function getContent(id: string) {
  return (await db()).get('content', id)
}

export async function updateDocMeta(id: string, patch: Partial<DocMeta>, kind: ChangeKind = 'docs') {
  const d = await db()
  const meta = await d.get('docs', id)
  if (!meta) return
  const now = Date.now()
  const stamp = kind === 'docs' ? { updatedAt: now } : kind === 'position' ? { positionAt: now } : {}
  await d.put('docs', { ...meta, ...patch, ...stamp })
  if (kind !== 'opened') changed(kind)
}

/** Writes metadata exactly as given (used when applying changes from another device). */
export async function putDocMeta(meta: DocMeta) {
  await (await db()).put('docs', meta)
}

export async function savePosition(id: string, position: Position, progress?: number) {
  await updateDocMeta(id, { position, progress, openedAt: Date.now() }, 'position')
}

export async function deleteDoc(id: string, opts: { fromSync?: boolean } = {}) {
  const d = await db()
  const hls = await d.getAllKeysFromIndex('highlights', 'byDoc', id)
  const tx = d.transaction(['docs', 'content', 'files', 'highlights'], 'readwrite')
  await Promise.all([
    tx.objectStore('docs').delete(id),
    tx.objectStore('content').delete(id),
    tx.objectStore('files').delete(id),
    ...hls.map((k) => tx.objectStore('highlights').delete(k)),
    tx.done,
  ])
  if (!opts.fromSync) {
    tombstone('docs', id)
    changed('docs')
  }
}

// ---------- Original files (for "Show original page") ----------

export async function saveFile(id: string, data: Blob) {
  await (await db()).put('files', { id, type: data.type, data })
}

export async function getFile(id: string) {
  return (await db()).get('files', id)
}

// ---------- Highlights and notes ----------

export async function listHighlights(docId?: string): Promise<Highlight[]> {
  const d = await db()
  const all = docId ? await d.getAllFromIndex('highlights', 'byDoc', docId) : await d.getAll('highlights')
  return all.sort((a, b) => a.chapter - b.chapter || a.startBlock - b.startBlock || a.start - b.start)
}

export async function saveHighlight(h: Highlight, opts: { fromSync?: boolean } = {}) {
  await (await db()).put('highlights', h)
  if (!opts.fromSync) changed('highlights')
}

export async function deleteHighlight(id: string, opts: { fromSync?: boolean } = {}) {
  await (await db()).delete('highlights', id)
  if (!opts.fromSync) {
    tombstone('highlights', id)
    changed('highlights')
  }
}

// ---------- Saved words ----------

export async function listWords(): Promise<SavedWord[]> {
  const all = await (await db()).getAll('words')
  return all.sort((a, b) => b.addedAt - a.addedAt)
}

export async function saveWord(w: SavedWord, opts: { fromSync?: boolean } = {}) {
  await (await db()).put('words', w)
  if (!opts.fromSync) changed('words')
}

export async function deleteWord(id: string, opts: { fromSync?: boolean } = {}) {
  await (await db()).delete('words', id)
  if (!opts.fromSync) {
    tombstone('words', id)
    changed('words')
  }
}

// ---------- Known words ----------

export async function getVocab(lang: string): Promise<VocabRecord> {
  return (await (await db()).get('vocab', lang)) || { lang, words: {} }
}

export async function listVocab(): Promise<VocabRecord[]> {
  return (await db()).getAll('vocab')
}

export async function putVocab(rec: VocabRecord, opts: { fromSync?: boolean } = {}) {
  await (await db()).put('vocab', rec)
  if (!opts.fromSync) changed('vocab')
}

// ---------- Backup ----------

interface Backup {
  qariBackup: 1
  createdAt: number
  docs: DocMeta[]
  content: DocContent[]
  words: SavedWord[]
  highlights: Highlight[]
  vocab: VocabRecord[]
  files: { id: string; type: string; base64: string }[]
}

function blobToBase64(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(b)
  })
}

/** Everything in the library as one file: books, original PDFs, notes, saved and known words. */
export async function exportLibrary(): Promise<Blob> {
  const d = await db()
  const files = await d.getAll('files')
  const backup: Backup = {
    qariBackup: 1,
    createdAt: Date.now(),
    docs: await d.getAll('docs'),
    content: await d.getAll('content'),
    words: await d.getAll('words'),
    highlights: await d.getAll('highlights'),
    vocab: await d.getAll('vocab'),
    files: await Promise.all(files.map(async (f) => ({ id: f.id, type: f.type, base64: await blobToBase64(f.data) }))),
  }
  return new Blob([JSON.stringify(backup)], { type: 'application/json' })
}

/** Adds what's missing from a backup. Books, words and notes already in the library are left as they are. */
export async function importLibrary(file: Blob): Promise<{ books: number; words: number }> {
  let b: Backup
  try {
    b = JSON.parse(await file.text())
  } catch {
    throw new Error('That file isn’t a Qari backup.')
  }
  if (b?.qariBackup !== 1 || !Array.isArray(b.docs)) throw new Error('That file isn’t a Qari backup.')
  const d = await db()
  const has = async (store: 'docs' | 'words' | 'highlights', id: string) => !!(await d.getKey(store, id))
  let books = 0
  let words = 0
  const content = new Map(b.content.map((c) => [c.id, c]))
  const files = new Map(b.files.map((f) => [f.id, f]))
  for (const meta of b.docs) {
    const c = content.get(meta.id)
    if (!c || (await has('docs', meta.id))) continue
    const f = files.get(meta.id)
    if (f) {
      const bytes = Uint8Array.from(atob(f.base64), (ch) => ch.charCodeAt(0))
      await d.put('files', { id: f.id, type: f.type, data: new Blob([bytes], { type: f.type }) })
    }
    await d.put('content', c)
    await d.put('docs', meta)
    books++
  }
  for (const w of b.words) {
    if (await has('words', w.id)) continue
    await d.put('words', w)
    words++
  }
  for (const h of b.highlights) if (!(await has('highlights', h.id))) await d.put('highlights', h)
  for (const v of b.vocab) {
    const mine = (await d.get('vocab', v.lang))?.words || {}
    await d.put('vocab', { lang: v.lang, words: { ...v.words, ...mine } })
  }
  changed('docs')
  changed('words')
  changed('highlights')
  changed('vocab')
  return { books, words }
}

/** Whether the browser has promised not to clear the library when space runs low. */
export async function storageIsPersistent(): Promise<boolean | null> {
  try {
    if (!navigator.storage?.persisted) return null
    return (await navigator.storage.persisted()) || (await navigator.storage.persist?.()) || false
  } catch {
    return null
  }
}
