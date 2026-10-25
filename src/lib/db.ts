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

export async function listDocs(): Promise<DocMeta[]> {
  const all = await (await db()).getAll('docs')
  return all.sort((a, b) => b.openedAt - a.openedAt)
}

export async function saveDoc(meta: DocMeta, content: DocContent) {
  const d = await db()
  const tx = d.transaction(['docs', 'content'], 'readwrite')
  await Promise.all([tx.objectStore('docs').put(meta), tx.objectStore('content').put(content), tx.done])
  // Ask the browser not to evict the library when storage gets tight (matters most on iPhone).
  try {
    await navigator.storage?.persist?.()
  } catch {
    /* not supported */
  }
}

export async function getDoc(id: string) {
  const d = await db()
  const [meta, content] = await Promise.all([d.get('docs', id), d.get('content', id)])
  return meta && content ? { meta, content } : null
}

export async function updateDocMeta(id: string, patch: Partial<DocMeta>) {
  const d = await db()
  const meta = await d.get('docs', id)
  if (!meta) return
  await d.put('docs', { ...meta, ...patch })
}

export async function savePosition(id: string, position: Position, progress?: number) {
  await updateDocMeta(id, { position, progress, openedAt: Date.now() })
}

export async function deleteDoc(id: string) {
  const d = await db()
  const tx = d.transaction(['docs', 'content'], 'readwrite')
  await Promise.all([tx.objectStore('docs').delete(id), tx.objectStore('content').delete(id), tx.done])
}

export async function listWords(): Promise<SavedWord[]> {
  const all = await (await db()).getAll('words')
  return all.sort((a, b) => b.addedAt - a.addedAt)
}

export async function saveWord(w: SavedWord) {
  await (await db()).put('words', w)
}

export async function deleteWord(id: string) {
  await (await db()).delete('words', id)
}
