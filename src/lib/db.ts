import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { DocContent, DocMeta, Position, SavedWord } from '../types'

interface QariDB extends DBSchema {
  docs: { key: string; value: DocMeta }
  content: { key: string; value: DocContent }
  words: { key: string; value: SavedWord; indexes: { byAdded: number } }
}

let dbPromise: Promise<IDBPDatabase<QariDB>> | null = null

function db() {
  if (!dbPromise) {
    dbPromise = openDB<QariDB>('qari', 1, {
      upgrade(d) {
        d.createObjectStore('docs', { keyPath: 'id' })
        d.createObjectStore('content', { keyPath: 'id' })
        const w = d.createObjectStore('words', { keyPath: 'id' })
        w.createIndex('byAdded', 'addedAt')
      },
    })
  }
  return dbPromise
}

// ---------- Change notifications (sync listens to these) ----------

type ChangeKind = 'docs' | 'words' | 'position' | 'opened'
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
}
export function loadTombstones(): Tombstones {
  try {
    return { docs: {}, words: {}, ...JSON.parse(localStorage.getItem(TOMB_KEY) || '{}') }
  } catch {
    return { docs: {}, words: {} }
  }
}
export function saveTombstones(t: Tombstones) {
  try {
    localStorage.setItem(TOMB_KEY, JSON.stringify(t))
  } catch {
    /* storage unavailable */
  }
}
function tombstone(kind: 'docs' | 'words', id: string) {
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
  const tx = d.transaction(['docs', 'content'], 'readwrite')
  await Promise.all([tx.objectStore('docs').delete(id), tx.objectStore('content').delete(id), tx.done])
  if (!opts.fromSync) {
    tombstone('docs', id)
    changed('docs')
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
