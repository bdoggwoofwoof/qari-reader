import type { Lang } from '../types'

const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/g
const HEBREW = /[֐-׿]/g
const CYRILLIC = /[Ѐ-ӿ]/g
const GREEK = /[Ͱ-Ͽ]/g
const LETTER = /\p{L}/gu

const STOPWORDS: Record<string, string[]> = {
  en: ['the', 'and', 'of', 'to', 'is', 'in', 'that', 'it', 'was', 'for', 'with', 'he', 'she', 'this', 'are', 'not', 'be', 'you', 'they', 'have', 'i', 'a', 'am', 'my', 'what', 'we', 'thank', 'hello'],
  fr: ['le', 'la', 'les', 'et', 'de', 'des', 'est', 'une', 'un', 'que', 'qui', 'dans', 'pour', 'pas', 'il', 'elle', 'du', 'au', 'sur', 'nous', 'vous', 'avec', 'je', 'tu', 'suis', 'vais', 'bien', 'merci', 'bonjour', 'oui', 'mais', 'très', 'ce', 'cette', 'ne', 'mon', 'ma', 'c', 'j', 'l', 'd', 'qu', 'n'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ein', 'eine', 'zu', 'mit', 'den', 'von', 'sich', 'auf', 'ich', 'sie', 'es', 'wir', 'auch', 'dem', 'für', 'du', 'bin', 'danke', 'ja', 'nein', 'gut', 'wie', 'hallo', 'mein', 'aber', 'sehr', 'heute'],
  es: ['el', 'la', 'los', 'las', 'y', 'de', 'que', 'en', 'un', 'una', 'es', 'por', 'con', 'para', 'no', 'del', 'se', 'su', 'como', 'pero'],
  it: ['il', 'lo', 'la', 'gli', 'le', 'e', 'di', 'che', 'un', 'una', 'per', 'non', 'con', 'del', 'della', 'sono', 'è', 'nel', 'ma'],
  pt: ['o', 'a', 'os', 'as', 'e', 'de', 'que', 'em', 'um', 'uma', 'para', 'não', 'com', 'do', 'da', 'por', 'se', 'mais', 'no', 'na'],
  nl: ['de', 'het', 'een', 'en', 'van', 'is', 'dat', 'niet', 'op', 'te', 'zijn', 'met', 'voor', 'ik', 'je', 'ze', 'maar', 'ook'],
}

const LETTER_HINTS: Record<string, RegExp> = {
  fr: /[çœèêëîïûù]|\b(?:[cdjlnst]|qu)['’]/g,
  de: /[äöüß]/g,
  es: /[ñ¿¡]/g,
  pt: /[ãõ]/g,
}

function count(text: string, re: RegExp) {
  return (text.match(re) || []).length
}

/** Detects the main language of a chunk of text. Script first, then common little words. */
export function detectLang(text: string, fallback: Lang = 'en'): Lang {
  const sample = text.slice(0, 20000)
  const letters = count(sample, LETTER) || 1
  if (count(sample, ARABIC) / letters > 0.3) {
    // Persian and Urdu share the script; look for their tell-tale letters.
    const fa = count(sample, /[پچژگک‌ی]/g)
    const ar = count(sample, /[ةيكى]/g)
    return fa > ar * 1.5 ? 'fa' : 'ar'
  }
  if (count(sample, HEBREW) / letters > 0.3) return 'he'
  if (count(sample, CYRILLIC) / letters > 0.3) return 'ru'
  if (count(sample, GREEK) / letters > 0.3) return 'el'
  const words = sample.toLowerCase().match(/\p{L}+/gu) || []
  if (words.length < 3) return fallback
  let best = fallback
  let bestScore = 0
  const lower = sample.toLowerCase()
  for (const [lang, list] of Object.entries(STOPWORDS)) {
    const set = new Set(list)
    let s = 0
    for (const w of words) if (set.has(w)) s++
    // Letters only one of these languages uses settle short lines ("Ça va très bien", "Schön, danke").
    const hint = LETTER_HINTS[lang]
    if (hint) s += Math.min(3, count(lower, hint)) * 0.5
    if (s > bestScore) {
      bestScore = s
      best = lang
    }
  }
  return bestScore / words.length > 0.04 ? best : fallback
}

/** True when most letters in the text are Arabic script. Used for per-sentence voice switching. */
export function isMostlyArabic(text: string) {
  const letters = count(text, LETTER)
  return letters > 0 && count(text, ARABIC) / letters > 0.5
}

export function baseLang(tag: string): Lang {
  return tag.toLowerCase().split(/[-_]/)[0]
}

// ---------- Segmentation ----------

export interface Span {
  start: number
  end: number
}

const segCache = new Map<string, Intl.Segmenter>()
function segmenter(lang: Lang, granularity: 'sentence' | 'word') {
  const key = lang + granularity
  let s = segCache.get(key)
  if (!s) {
    s = new Intl.Segmenter(lang, { granularity })
    segCache.set(key, s)
  }
  return s
}

const ABBREV = /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|cf|p|pp|vol|ch|ed|eds|no|Fig|Jan|Feb|Mar|Apr|Aug|Sept|Oct|Nov|Dec|M|Mme|Hr|Fr|z\.B|bzw|ca|S)\.|\b[A-Z]\.)\s*$/

const MAX_CHUNK = 180

/** Cuts a span that is still too long at the space nearest the middle of each MAX_CHUNK window. */
function splitAtSpaces(text: string, span: Span): Span[] {
  const out: Span[] = []
  let start = span.start
  while (span.end - start > MAX_CHUNK + 40) {
    const target = start + Math.round(MAX_CHUNK * 0.8)
    let cut = text.lastIndexOf(' ', target)
    if (cut <= start + 40) cut = text.indexOf(' ', target)
    if (cut < 0 || cut >= span.end - 20) break
    out.push({ start, end: cut + 1 })
    start = cut + 1
  }
  out.push({ start, end: span.end })
  return out
}

/** Splits a paragraph into sentences, keeping long sentences speakable. */
export function sentences(text: string, lang: Lang): Span[] {
  const raw: Span[] = []
  for (const seg of segmenter(lang, 'sentence').segment(text)) {
    raw.push({ start: seg.index, end: seg.index + seg.segment.length })
  }
  // Re-join splits that happened after abbreviations like "Dr." or "e.g."
  const merged: Span[] = []
  for (const s of raw) {
    const prev = merged[merged.length - 1]
    if (prev && ABBREV.test(text.slice(prev.start, prev.end))) prev.end = s.end
    else merged.push({ ...s })
  }
  // Break long sentences at commas/semicolons, and failing that between words, so no single utterance runs
  // much past ten seconds: some voices (Chrome's Google voices) go silent after about fifteen.
  const out: Span[] = []
  for (const s of merged) {
    if (s.end - s.start <= MAX_CHUNK) {
      out.push(s)
      continue
    }
    const pieces: Span[] = []
    let start = s.start
    const re = /[,;:،؛]\s+/g
    re.lastIndex = s.start
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) && m.index < s.end) {
      const cut = m.index + m[0].length
      if (cut - start >= 80 && s.end - cut >= 40) {
        pieces.push({ start, end: cut })
        start = cut
      }
    }
    pieces.push({ start, end: s.end })
    for (const p of pieces) out.push(...splitAtSpaces(text, p))
  }
  return out.filter((s) => text.slice(s.start, s.end).trim().length > 0)
}

/** Word spans (letters/numbers only, punctuation excluded). */
export function words(text: string, lang: Lang): Span[] {
  const out: Span[] = []
  for (const seg of segmenter(lang, 'word').segment(text)) {
    if (seg.isWordLike) out.push({ start: seg.index, end: seg.index + seg.segment.length })
  }
  return out
}

// ---------- Arabic helpers ----------

const TASHKEEL = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g

export function stripArabicMarks(s: string) {
  return s.replace(TASHKEEL, '')
}

/** Candidate dictionary forms of an Arabic word, most likely first. */
export function arabicCandidates(word: string): string[] {
  const w = stripArabicMarks(word)
  const out = new Set<string>([w])
  const prefixes = ['وال', 'فال', 'بال', 'كال', 'لل', 'ال', 'و', 'ف', 'ب', 'ل', 'ك', 'س']
  const suffixes = ['هما', 'كما', 'تما', 'هم', 'هن', 'كم', 'كن', 'نا', 'ها', 'ون', 'ين', 'ان', 'ات', 'وا', 'ه', 'ك', 'ي', 'ت']
  const stems = new Set<string>([w])
  // Prefixes stack: و/ف (and), then ب/ل/ك (with/for/like) or س (will), then ال (the) — وبالكتاب → كتاب.
  const strip = (x: string, list: string[]) => {
    for (const p of list) if (x.startsWith(p) && x.length - p.length >= 2) stems.add(x.slice(p.length))
  }
  strip(w, prefixes)
  for (const c of ['و', 'ف']) if (w.startsWith(c) && w.length > 3) strip(w.slice(1), prefixes)
  for (const x of [...stems]) if (x.startsWith('ال') && x.length > 3) stems.add(x.slice(2))
  for (const s of [...stems]) {
    out.add(s)
    for (const suf of suffixes) {
      if (s.endsWith(suf) && s.length - suf.length >= 2) {
        const base = s.slice(0, -suf.length)
        out.add(base)
        if (suf === 'ات') out.add(base + 'ة')
        if (base.endsWith('ت')) out.add(base.slice(0, -1) + 'ة')
      }
    }
    if (s.endsWith('ة')) out.add(s.slice(0, -1))
  }
  // Also try alif-hamza variants, which texts often write inconsistently.
  for (const c of [...out]) {
    if (/^[اأإآ]/.test(c)) for (const a of ['ا', 'أ', 'إ', 'آ']) out.add(a + c.slice(1))
  }
  return [...out].filter((c) => c.length >= 2).slice(0, 14)
}
