import type { Lang } from '../types'

const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/g
const HEBREW = /[֐-׿]/g
const CYRILLIC = /[Ѐ-ӿ]/g
const GREEK = /[Ͱ-Ͽ]/g
const LETTER = /\p{L}/gu

const STOPWORDS: Record<string, string[]> = {
  en: ['the', 'and', 'of', 'to', 'is', 'in', 'that', 'it', 'was', 'for', 'with', 'he', 'she', 'this', 'are', 'not', 'be', 'you', 'they', 'have'],
  fr: ['le', 'la', 'les', 'et', 'de', 'des', 'est', 'une', 'un', 'que', 'qui', 'dans', 'pour', 'pas', 'il', 'elle', 'du', 'au', 'sur', 'nous', 'vous', 'avec'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ein', 'eine', 'zu', 'mit', 'den', 'von', 'sich', 'auf', 'ich', 'sie', 'es', 'wir', 'auch', 'dem', 'für'],
  es: ['el', 'la', 'los', 'las', 'y', 'de', 'que', 'en', 'un', 'una', 'es', 'por', 'con', 'para', 'no', 'del', 'se', 'su', 'como', 'pero'],
  it: ['il', 'lo', 'la', 'gli', 'le', 'e', 'di', 'che', 'un', 'una', 'per', 'non', 'con', 'del', 'della', 'sono', 'è', 'nel', 'ma'],
  pt: ['o', 'a', 'os', 'as', 'e', 'de', 'que', 'em', 'um', 'uma', 'para', 'não', 'com', 'do', 'da', 'por', 'se', 'mais', 'no', 'na'],
  nl: ['de', 'het', 'een', 'en', 'van', 'is', 'dat', 'niet', 'op', 'te', 'zijn', 'met', 'voor', 'ik', 'je', 'ze', 'maar', 'ook'],
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
  for (const [lang, list] of Object.entries(STOPWORDS)) {
    const set = new Set(list)
    let s = 0
    for (const w of words) if (set.has(w)) s++
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
  // Break very long sentences at commas/semicolons so the voice never runs too long in one go.
  const out: Span[] = []
  for (const s of merged) {
    if (s.end - s.start <= 280) {
      out.push(s)
      continue
    }
    let start = s.start
    const re = /[,;:،؛]\s+/g
    re.lastIndex = s.start
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) && m.index < s.end) {
      const cut = m.index + m[0].length
      if (cut - start >= 120 && s.end - cut >= 40) {
        out.push({ start, end: cut })
        start = cut
      }
    }
    out.push({ start, end: s.end })
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
  for (const p of prefixes) if (w.startsWith(p) && w.length - p.length >= 2) stems.add(w.slice(p.length))
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
