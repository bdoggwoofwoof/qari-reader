import type { Chapter } from '../types'

/**
 * Folds text for matching: lowercase, no accents or Arabic vowel marks, one form of alif/ya/ta marbuta.
 * Returns the folded string plus, for each folded character, its index in the original.
 */
export function fold(text: string): { s: string; map: number[] } {
  let s = ''
  const map: number[] = []
  for (let i = 0; i < text.length; i++) {
    let ch = text[i]
    // Decompose so accents become separate marks, then drop marks (also Arabic harakat) and tatweel.
    const parts = ch.normalize('NFD')
    for (const p of parts) {
      if (/\p{M}/u.test(p) || p === 'ـ') continue
      ch = p.toLocaleLowerCase()
      if ('أإآٱ'.includes(ch)) ch = 'ا'
      else if (ch === 'ى') ch = 'ي'
      else if (ch === 'ة') ch = 'ه'
      else if (ch === 'ؤ') ch = 'و'
      else if (ch === 'ئ') ch = 'ي'
      else if (/\s/.test(ch)) ch = ' '
      if (ch === ' ' && s.endsWith(' ')) continue
      s += ch
      map.push(i)
    }
  }
  map.push(text.length)
  return { s, map }
}

export interface SearchHit {
  chapter: number
  block: number
  start: number
  end: number
  before: string
  match: string
  after: string
  page?: string
}

/** Finds every occurrence of the query in the book, in reading order. */
export function searchBook(chapters: Chapter[], query: string, limit = 200): SearchHit[] {
  const q = fold(query.trim()).s
  if (q.length < 2) return []
  const hits: SearchHit[] = []
  chapters.forEach((ch, c) => {
    ch.blocks.forEach((text, b) => {
      if (hits.length >= limit) return
      const { s, map } = fold(text)
      let from = 0
      for (;;) {
        const i = s.indexOf(q, from)
        if (i < 0 || hits.length >= limit) break
        const start = map[i]
        const end = map[i + q.length - 1] + 1
        const ctxStart = Math.max(0, start - 60)
        const ctxEnd = Math.min(text.length, end + 60)
        hits.push({
          chapter: c,
          block: b,
          start,
          end,
          before: (ctxStart > 0 ? '…' : '') + text.slice(ctxStart, start).replace(/^\S*\s/, ctxStart > 0 ? '' : '$&'),
          match: text.slice(start, end),
          after: text.slice(end, ctxEnd) + (ctxEnd < text.length ? '…' : ''),
          page: ch.pages?.[b],
        })
        from = i + q.length
      }
    })
  })
  return hits
}
