import { useEffect, useState } from 'react'
import type { Lang } from '../types'
import { getVocab, listWords, onLocalChange, putVocab } from './db'
import { stripArabicMarks } from './lang'

/** The form a word is tracked under: lowercase, no Arabic vowel marks, one spelling of alif/ya/ta marbuta. */
export function vocabKey(word: string, lang: Lang) {
  let w = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
  if (lang === 'ar' || lang === 'fa' || lang === 'ur') {
    w = stripArabicMarks(w).replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي')
  }
  return w.toLocaleLowerCase(lang)
}

/** Words worth tracking: has a letter, isn't a number or a single Latin letter. */
export function isTrackable(word: string) {
  return /\p{L}/u.test(word) && !(/^[a-z]$/i.test(word))
}

const cache = new Map<Lang, Map<string, number>>()
const learningCache = new Map<Lang, Set<string>>()
const listeners = new Set<() => void>()
let version = 0
const bump = () => {
  version++
  listeners.forEach((l) => l())
}

async function load(lang: Lang) {
  if (!cache.has(lang)) {
    const rec = await getVocab(lang)
    cache.set(lang, new Map(Object.entries(rec.words)))
  }
  return cache.get(lang)!
}

let learningLoaded: Promise<void> | null = null

async function loadLearning() {
  learningCache.clear()
  for (const w of await listWords()) {
    let set = learningCache.get(w.lang)
    if (!set) learningCache.set(w.lang, (set = new Set()))
    set.add(vocabKey(w.word, w.lang))
    if (w.lemma) set.add(vocabKey(w.lemma, w.lang))
  }
}

let wired = false
function wire() {
  if (wired) return
  wired = true
  onLocalChange((k) => {
    if (k === 'words') loadLearning().then(bump)
  })
  // Another device synced new known words or saved words.
  window.addEventListener('qari:synced', () => {
    cache.clear()
    learningLoaded = loadLearning()
    learningLoaded.then(bump)
  })
}

export function isKnown(lang: Lang, key: string) {
  return (cache.get(lang)?.get(key) ?? 0) > 0
}

export function isLearning(lang: Lang, key: string) {
  return learningCache.get(lang)?.has(key) ?? false
}

/** Marks words known (or not known again). */
export async function setKnown(lang: Lang, words: string[], known = true) {
  const map = await load(lang)
  const now = Date.now()
  for (const w of words) {
    const k = vocabKey(w, lang)
    if (k) map.set(k, known ? now : -now)
  }
  await putVocab({ lang, words: Object.fromEntries(map) })
  bump()
}

export function knownCount(lang: Lang) {
  let n = 0
  for (const v of cache.get(lang)?.values() || []) if (v > 0) n++
  return n
}

/** Re-renders when known or saved words change, after loading the lists for the given languages. */
export function useVocab(langs: Lang[]) {
  const [, setV] = useState(version)
  const key = langs.join(',')
  useEffect(() => {
    wire()
    let live = true
    const h = () => live && setV(version)
    listeners.add(h)
    // Only re-render readers when a list actually had to be loaded; opening a lookup shouldn't redraw the book.
    const missing = key.split(',').filter((l) => l && !cache.has(l))
    if (!learningLoaded) learningLoaded = loadLearning()
    const first = !!missing.length
    Promise.all([...missing.map(load), learningLoaded]).then(() => {
      if (first || version === 0) bump()
    })
    return () => {
      live = false
      listeners.delete(h)
    }
  }, [key])
  return version
}

/** Counts the distinct words in some text that you haven't marked known or saved. */
export function countNew(texts: string[], lang: Lang, segment: (t: string) => { start: number; end: number }[]) {
  const seen = new Set<string>()
  let fresh = 0
  for (const t of texts) {
    for (const s of segment(t)) {
      const w = t.slice(s.start, s.end)
      if (!isTrackable(w)) continue
      const k = vocabKey(w, lang)
      if (seen.has(k)) continue
      seen.add(k)
      if (!isKnown(lang, k) && !isLearning(lang, k)) fresh++
    }
  }
  return { unique: seen.size, fresh }
}
