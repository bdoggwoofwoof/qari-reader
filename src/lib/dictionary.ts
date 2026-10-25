import type { Lang } from '../types'
import { arabicCandidates, stripArabicMarks } from './lang'

export interface Sense {
  text: string
  formOf?: string // "plural of chien" -> "chien"
}

export interface Entry {
  word: string // the headword that matched
  partOfSpeech: string
  senses: Sense[]
}

export interface LookupResult {
  query: string
  entries: Entry[]
}

const WIKI_LANG_NAME: Record<string, string> = {
  en: 'English', ar: 'Arabic', fr: 'French', de: 'German', es: 'Spanish', it: 'Italian', pt: 'Portuguese',
  tr: 'Turkish', fa: 'Persian', ur: 'Urdu', he: 'Hebrew', ru: 'Russian', nl: 'Dutch', el: 'Greek',
}

const POS = /^(noun|verb|adjective|adverb|pronoun|preposition|conjunction|interjection|particle|determiner|article|numeral|participle|proper noun|prefix|suffix|phrase|contraction|letter|postposition|idiom|proverb|prepositional phrase)/i

const cache = new Map<string, Promise<Entry[]>>()

function htmlToSense(html: string): Sense | null {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
  const root = doc.body.firstElementChild as HTMLElement
  // Drop nested example lists, citations and references.
  root.querySelectorAll('ul, dl, ol, .citation-whole, .reference, sup, style, .HQToggle').forEach((n) => n.remove())
  const text = (root.textContent || '').replace(/\s+/g, ' ').trim()
  if (!text) return null
  let formOf: string | undefined
  const formEl = root.querySelector('.form-of-definition-link a, .form-of-definition a, i a, a')
  if (/\b(of|form of)\b/i.test(text) && formEl) {
    const t = formEl.getAttribute('title') || formEl.textContent || ''
    if (t && !/^(Appendix|Wiktionary):/.test(t)) formOf = t.replace(/#.*$/, '')
  }
  return { text, formOf }
}

async function viaRest(term: string, lang: Lang): Promise<Entry[] | null> {
  const r = await fetch(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(term)}?redirect=true`)
  if (r.status === 404) return []
  if (!r.ok) return null
  const data = (await r.json()) as Record<string, { partOfSpeech: string; language: string; definitions: { definition: string }[] }[]>
  const groups = data[lang] || Object.values(data).flat().filter((g) => g.language === WIKI_LANG_NAME[lang])
  return groups
    .map((g) => ({
      word: term,
      partOfSpeech: g.partOfSpeech,
      senses: g.definitions.map((d) => htmlToSense(d.definition)).filter((s): s is Sense => !!s).slice(0, 4),
    }))
    .filter((e) => e.senses.length)
}

/** Backup route: parse the full Wiktionary page if the quick definitions endpoint is unavailable. */
async function viaParse(term: string, lang: Lang): Promise<Entry[]> {
  const url = `https://en.wiktionary.org/w/api.php?action=parse&page=${encodeURIComponent(term)}&prop=text&format=json&formatversion=2&redirects=1&origin=*`
  const r = await fetch(url)
  if (!r.ok) return []
  const data = await r.json()
  const html: string | undefined = data?.parse?.text
  if (!html) return []
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const want = WIKI_LANG_NAME[lang] || 'English'
  const out: Entry[] = []
  let inLang = false
  let pos = ''
  for (const el of Array.from(doc.querySelectorAll('h2, h3, h4, h5, ol'))) {
    const tag = el.tagName.toLowerCase()
    if (tag === 'h2') {
      inLang = (el.textContent || '').trim() === want
      pos = ''
    } else if (tag !== 'ol') {
      const t = (el.textContent || '').trim()
      pos = POS.test(t) ? t : ''
    } else if (inLang && pos && !el.parentElement?.closest('li')) {
      const senses = Array.from(el.children)
        .map((li) => htmlToSense(li.innerHTML))
        .filter((s): s is Sense => !!s)
        .slice(0, 4)
      if (senses.length) out.push({ word: term, partOfSpeech: pos, senses })
      pos = ''
    }
  }
  return out
}

async function fetchTerm(term: string, lang: Lang): Promise<Entry[]> {
  const key = lang + ':' + term
  let p = cache.get(key)
  if (!p) {
    p = (async () => {
      try {
        const rest = await viaRest(term, lang)
        if (rest !== null) return rest
      } catch {
        /* fall through to the backup route */
      }
      try {
        return await viaParse(term, lang)
      } catch {
        return []
      }
    })()
    cache.set(key, p)
  }
  return p
}

function candidates(word: string, lang: Lang): string[] {
  const w = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').replace(/[’']$/, '')
  if (lang === 'ar' || lang === 'fa' || lang === 'ur') return arabicCandidates(w)
  const lower = w.toLocaleLowerCase(lang)
  const list = lang === 'de' ? [w, lower] : [lower, w]
  // French/Italian elision: l'homme -> homme, qu'il -> il
  const elided = w.match(/^(?:l|d|j|m|n|s|t|c|qu|jusqu|lorsqu|puisqu)['’](.+)$/i)
  if (elided) list.unshift(elided[1].toLocaleLowerCase(lang))
  if (lang === 'en') {
    if (/'s$/.test(lower)) list.push(lower.slice(0, -2))
  }
  return [...new Set(list)].filter(Boolean)
}

/** Looks a word up in Wiktionary, trying likely dictionary forms until one matches. */
export async function lookup(word: string, lang: Lang): Promise<LookupResult> {
  const tries = candidates(word, lang)
  for (const t of tries) {
    const entries = await fetchTerm(t, lang)
    if (entries.length) {
      // Inflected form ("plural of X", "past tense of Y"): also fetch the base word.
      const formOf = entries.flatMap((e) => e.senses).find((s) => s.formOf)?.formOf
      if (formOf && formOf !== t && entries.every((e) => e.senses.every((s) => s.formOf || /\bof\b/.test(s.text)))) {
        const base = await fetchTerm(formOf, lang)
        return { query: word, entries: [...entries.slice(0, 1), ...base.map((b) => ({ ...b, word: formOf }))] }
      }
      return { query: word, entries }
    }
  }
  return { query: word, entries: [] }
}

export function externalLinks(word: string, lang: Lang, sentence: string) {
  const w = lang === 'ar' ? stripArabicMarks(word) : word
  const enc = encodeURIComponent(w)
  const links: { label: string; url: string }[] = [
    { label: 'Wiktionary', url: `https://en.wiktionary.org/wiki/${enc}#${WIKI_LANG_NAME[lang] || ''}` },
  ]
  if (lang === 'ar') {
    links.push({ label: 'Almaany', url: `https://www.almaany.com/en/dict/ar-en/${enc}/` })
  } else if (lang === 'fr' || lang === 'de' || lang === 'es' || lang === 'it' || lang === 'pt') {
    links.push({ label: 'WordReference', url: `https://www.wordreference.com/${lang}en/${enc}` })
  } else if (lang === 'en') {
    links.push({ label: 'Merriam-Webster', url: `https://www.merriam-webster.com/dictionary/${enc}` })
  }
  if (lang !== 'en') {
    links.push({
      label: 'Translate sentence',
      url: `https://translate.google.com/?sl=${lang}&tl=en&op=translate&text=${encodeURIComponent(sentence.slice(0, 800))}`,
    })
  }
  return links
}
