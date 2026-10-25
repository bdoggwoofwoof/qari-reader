import { LANG_NAMES, type Lang, type SavedWord } from '../types'

/**
 * Sends saved words to Anki on this computer through the AnkiConnect add-on (code 2055492159).
 * Each language gets its own note type ("Qari Arabic", …) whose cards speak with Anki's built-in
 * text-to-speech, and its own deck ("Qari::Arabic" by default), so your other decks are never touched.
 */

const ENDPOINT = 'http://127.0.0.1:8765'

const TTS: Record<string, string> = {
  en: 'en_US', ar: 'ar_SA', fr: 'fr_FR', de: 'de_DE', es: 'es_ES', it: 'it_IT', pt: 'pt_BR',
  tr: 'tr_TR', ru: 'ru_RU', nl: 'nl_NL', el: 'el_GR', he: 'he_IL', fa: 'fa_IR', ur: 'ur_PK',
}

export class AnkiUnreachable extends Error {}
export class AnkiDenied extends Error {}

async function call<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
  let r: Response
  try {
    // A plain-text body keeps this a "simple" request, which AnkiConnect answers without a preflight.
    r = await fetch(ENDPOINT, { method: 'POST', body: JSON.stringify({ action, version: 6, params }) })
  } catch {
    throw new AnkiUnreachable('Anki isn’t reachable.')
  }
  const j = (await r.json()) as { result: T; error: string | null }
  if (j.error) throw new Error(`Anki: ${j.error}`)
  return j.result
}

export const modelName = (lang: Lang) => `Qari ${LANG_NAMES[lang] || lang}`
export const defaultDeck = (lang: Lang) => `Qari::${LANG_NAMES[lang] || lang}`

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const CSS = `.card { font-family: "Readex Pro", "Noto Naskh Arabic", system-ui, sans-serif; font-size: 22px; text-align: center; color: #1c2621; background: #f4f6f2; line-height: 1.5; }
.nightMode.card, .night_mode .card { color: #dbe3dc; background: #131916; }
.word { font-size: 2.1em; margin: .4em 0; }
.meaning { font-size: .9em; margin: .6em auto; max-width: 34em; white-space: pre-line; }
.base { font-size: .75em; opacity: .7; }
.sentence { font-size: .95em; margin: 1em auto .4em; max-width: 34em; }
.sentence b { background: rgba(243, 201, 105, .55); font-weight: inherit; border-radius: 3px; padding: 0 .1em; }
.source { font-size: .65em; opacity: .55; margin-top: .8em; }`

async function ensureModel(lang: Lang, existing: string[]) {
  const name = modelName(lang)
  if (existing.includes(name)) return name
  const tts = TTS[lang] || 'en_US'
  await call('createModel', {
    modelName: name,
    inOrderFields: ['Word', 'Meaning', 'Sentence', 'BaseForm', 'Source'],
    css: CSS,
    isCloze: false,
    cardTemplates: [
      {
        Name: 'Recognize',
        Front: `<div class="word" dir="auto">{{Word}}</div>\n{{tts ${tts}:Word}}`,
        Back: `{{FrontSide}}\n<hr id="answer">\n<div class="meaning">{{Meaning}}</div>\n{{#BaseForm}}<div class="base">from {{BaseForm}}</div>{{/BaseForm}}\n<div class="sentence" dir="auto">{{Sentence}}</div>\n{{tts ${tts}:Sentence}}\n<div class="source">{{Source}}</div>`,
      },
    ],
  })
  return name
}

function noteFor(w: SavedWord, deckName: string) {
  const sentence = esc(w.sentence).replace(esc(w.word), `<b>${esc(w.word)}</b>`)
  return {
    deckName,
    modelName: modelName(w.lang),
    fields: { Word: esc(w.word), Meaning: esc(w.definition).replace(/\n/g, '<br>'), Sentence: sentence, BaseForm: w.lemma ? esc(w.lemma) : '', Source: esc(w.source) },
    tags: ['qari', (LANG_NAMES[w.lang] || w.lang).toLowerCase().replace(/\s+/g, '_'), ...(w.phrase ? ['phrase'] : [])],
    options: { allowDuplicate: false, duplicateScope: 'deck' },
  }
}

export interface SendResult {
  added: number
  already: number // the same word was already in that deck
  sent: SavedWord[] // words now in Anki (added or already there), to mark as sent
  decks: string[]
}

export async function sendToAnki(words: SavedWord[], decks: Record<Lang, string>): Promise<SendResult> {
  const perm = await call<{ permission: string }>('requestPermission')
  if (perm.permission !== 'granted') throw new AnkiDenied('Anki didn’t allow Qari to connect.')

  const models = await call<string[]>('modelNames')
  const usedDecks = new Set<string>()
  const byLang = new Map<Lang, SavedWord[]>()
  for (const w of words) byLang.set(w.lang, [...(byLang.get(w.lang) || []), w])

  const result: SendResult = { added: 0, already: 0, sent: [], decks: [] }
  for (const [lang, list] of byLang) {
    await ensureModel(lang, models)
    const deck = decks[lang]?.trim() || defaultDeck(lang)
    await call('createDeck', { deck })
    usedDecks.add(deck)
    const notes = list.map((w) => noteFor(w, deck))
    const can = await call<boolean[]>('canAddNotes', { notes })
    const toAdd = notes.filter((_, i) => can[i])
    const ids = toAdd.length ? await call<(number | null)[]>('addNotes', { notes: toAdd }) : []
    let k = 0
    list.forEach((w, i) => {
      if (!can[i]) {
        result.already++
        result.sent.push(w)
      } else if (ids[k++]) {
        result.added++
        result.sent.push(w)
      }
    })
  }
  result.decks = [...usedDecks]
  return result
}
