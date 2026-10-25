import type { Pronunciation } from '../types'

interface Edit {
  start: number
  end: number
  replacement: string
}

// In-text citations and references that sound like noise when read aloud.
const CITATION_PATTERNS: RegExp[] = [
  // (Smith, 2019) · (van der Kolk, 2014) · (Smith & Lee, 2019, p. 4) · (see Lee et al., 2020; Kim, n.d.)
  /\s?\([^()]{0,220}?\p{L}[^()]{0,220}?,\s*(?:(?:1[6-9]|20)\d{2}[a-z]?|n\.d\.)(?![\d:])[^()]{0,80}\)/gu,
  // (Smith 2019) · (Smith et al. 2019, 45) — author-date without a comma
  /\s?\((?:see |cf\. )?\p{Lu}[\p{L}'’-]+(?: (?:et al\.|and \p{Lu}[\p{L}'’-]+|& \p{Lu}[\p{L}'’-]+))? (?:1[6-9]|20)\d{2}[a-z]?(?:,\s*[\d–-]+)?\)/gu,
  // Smith (2019) · Smith (2019, p. 4)
  /\s?\((?:1[6-9]|20)\d{2}[a-z]?(?:,\s*(?:pp?\.|para\.)\s*[\d–-]+)?\)/g,
  // [12] · [3, 4] · [1–3]
  /\s?\[\d+(?:\s*[,–-]\s*\d+)*\]/g,
  // URLs and DOIs
  /\s?(?:https?:\/\/|www\.)\S+[^\s.,;:)]/gi,
  /\s?\bdoi:\s*\S+[^\s.,;:)]/gi,
]

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function overlaps(e: Edit, list: Edit[]) {
  return list.some((x) => e.start < x.end && e.end > x.start)
}

export interface SpeechText {
  text: string
  /** For each character index in `text`, the index in the original string. One extra entry for the end. */
  map: number[]
}

/** Turns displayed text into what the voice should say, keeping a map back to the original for highlighting. */
export function speechText(original: string, opts: { skipCitations: boolean; pronunciations: Pronunciation[] }): SpeechText {
  const edits: Edit[] = []
  if (opts.skipCitations) {
    for (const re of CITATION_PATTERNS) {
      re.lastIndex = 0
      for (const m of original.matchAll(re)) {
        const e = { start: m.index!, end: m.index! + m[0].length, replacement: '' }
        if (!overlaps(e, edits)) edits.push(e)
      }
    }
  }
  for (const p of opts.pronunciations) {
    const from = p.from.trim()
    if (!from) continue
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(from)}(?![\\p{L}\\p{N}])`, 'giu')
    for (const m of original.matchAll(re)) {
      const e = { start: m.index!, end: m.index! + m[0].length, replacement: p.to }
      if (!overlaps(e, edits)) edits.push(e)
    }
  }
  if (!edits.length) {
    return { text: original, map: Array.from({ length: original.length + 1 }, (_, i) => i) }
  }
  edits.sort((a, b) => a.start - b.start)
  let text = ''
  const map: number[] = []
  let i = 0
  for (const e of edits) {
    for (; i < e.start; i++) {
      text += original[i]
      map.push(i)
    }
    for (const ch of e.replacement) {
      text += ch
      map.push(e.start)
    }
    i = e.end
  }
  for (; i < original.length; i++) {
    text += original[i]
    map.push(i)
  }
  map.push(original.length)
  return { text, map }
}
