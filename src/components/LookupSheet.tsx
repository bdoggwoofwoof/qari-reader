import { useEffect, useState } from 'react'
import { externalLinks, lookup, type LookupResult } from '../lib/dictionary'
import { saveWord } from '../lib/db'
import { translate, type Translation } from '../lib/translate'
import { speakWord } from '../lib/tts'
import { isKnown, isLearning, setKnown, useVocab, vocabKey } from '../lib/vocab'
import { LANG_NAMES, RTL_LANGS, type Lang } from '../types'
import { Icon, Sheet } from './ui'

export interface Picked {
  word: string // a word, or a phrase when several words were selected
  lang: Lang
  sentence: string
  block: number
  start: number
}

type TState = { status: 'idle' } | { status: 'loading' } | { status: 'done'; t: Translation } | { status: 'error'; message: string }

function TranslationBox({ label, state, rtl }: { label: string; state: TState; rtl?: boolean }) {
  if (state.status === 'idle') return null
  return (
    <div className="mt-3 rounded-xl border border-line px-4 py-3" aria-live="polite">
      <div className="mb-1 flex items-baseline justify-between gap-3 text-xs text-ink-3">
        <span>{label}</span>
        {state.status === 'done' && <span>{state.t.engine === 'claude' ? 'Claude' : 'MyMemory (machine translation)'}</span>}
      </div>
      {state.status === 'loading' && <p className="text-ink-3">Translating…</p>}
      {state.status === 'error' && <p className="text-sm text-danger">{state.message}</p>}
      {state.status === 'done' && (
        <>
          <p className="font-read text-[1.02rem] leading-snug" dir={rtl ? 'rtl' : 'auto'}>
            {state.t.text}
          </p>
          {state.t.notes && <p className="mt-1.5 text-sm text-ink-2">{state.t.notes}</p>}
        </>
      )}
    </div>
  )
}

export default function LookupSheet({
  picked,
  source,
  voiceURI,
  onClose,
  onReadFromHere,
  learning,
  translateTo,
}: {
  picked: Picked | null
  source: string
  voiceURI?: string
  onClose: () => void
  onReadFromHere: (p: Picked) => void
  learning?: boolean // the word's language is one you're learning: show new/known
  translateTo?: Lang // offer translation into this language (undefined for English text)
}) {
  const [lang, setLang] = useState<Lang>(picked?.lang || 'en')
  const [result, setResult] = useState<LookupResult | null>(null)
  const [state, setState] = useState<'loading' | 'done' | 'offline'>('loading')
  const [saved, setSaved] = useState(false)
  const [tPhrase, setTPhrase] = useState<TState>({ status: 'idle' })
  const [tSentence, setTSentence] = useState<TState>({ status: 'idle' })
  useVocab(learning && picked ? [picked.lang] : [])

  const phrase = !!picked && /\s/.test(picked.word.trim())
  const canTranslate = !!translateTo && lang !== translateTo

  useEffect(() => {
    if (picked) {
      setLang(picked.lang)
      setSaved(false)
      setTPhrase({ status: 'idle' })
      setTSentence({ status: 'idle' })
    }
  }, [picked])

  useEffect(() => {
    if (!picked) return
    let live = true
    setState('loading')
    setResult(null)
    if (!navigator.onLine) {
      setState('offline')
      return
    }
    lookup(picked.word, lang)
      .then((r) => {
        if (!live) return
        setResult(r)
        setState('done')
      })
      .catch(() => live && setState('offline'))
    return () => {
      live = false
    }
  }, [picked, lang])

  const run = (set: (s: TState) => void, text: string, context?: string) => {
    if (!translateTo) return
    set({ status: 'loading' })
    translate(text, lang, translateTo, context)
      .then((t) => set({ status: 'done', t }))
      .catch((e) => set({ status: 'error', message: e instanceof Error ? e.message : String(e) }))
  }

  // Phrases, and words the dictionary doesn't have, are translated straight away.
  useEffect(() => {
    if (!picked || !canTranslate || state !== 'done' || tPhrase.status !== 'idle') return
    if (phrase || !result?.entries.length) run(setTPhrase, picked.word, picked.sentence)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked, state, result, canTranslate, phrase])

  if (!picked) return null
  const rtl = RTL_LANGS.has(lang)
  const first = result?.entries[0]
  const lemma = !phrase ? result?.entries.find((e) => e.word !== first?.word)?.word : undefined
  const key = vocabKey(picked.word, picked.lang)
  const known = learning && !phrase && isKnown(picked.lang, key)
  const isSaved = saved || (learning && isLearning(picked.lang, key))

  const save = async () => {
    const def =
      result?.entries
        .slice(0, 3)
        .map((e) => `${e.language && e.language !== LANG_NAMES[lang] ? e.language.replace(/ Arabic$/, '') + ' ' : ''}${e.partOfSpeech}${e.word !== picked.word ? ` (${e.word})` : ''}: ${e.senses.slice(0, 2).map((s) => s.text).join('; ')}`)
        .join('\n') || (tPhrase.status === 'done' ? tPhrase.t.text + (tPhrase.t.notes ? `\n${tPhrase.t.notes}` : '') : '')
    const now = Date.now()
    await saveWord({
      id: now.toString(36) + Math.random().toString(36).slice(2, 6),
      word: picked.word,
      lemma,
      lang,
      definition: def,
      sentence: picked.sentence,
      source,
      addedAt: now,
      updatedAt: now,
      phrase: phrase || undefined,
    })
    setSaved(true)
  }

  return (
    <Sheet
      open
      onClose={onClose}
      wide
      title={
        <span className="flex flex-wrap items-baseline gap-x-3">
          <span dir={rtl ? 'rtl' : 'ltr'} lang={lang} className={`${rtl ? 'font-arabic' : 'font-read'} ${phrase ? 'text-xl' : rtl ? 'text-3xl' : 'text-2xl'}`}>
            {picked.word}
          </span>
          {lemma && <span className="text-sm font-normal text-ink-3">from {lemma}</span>}
        </span>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => speakWord(picked.word, lang, voiceURI)}
          className="inline-flex h-9 items-center gap-1.5 rounded-full border border-line px-3 text-sm hover:bg-paper-2"
        >
          <Icon name="speaker" size={17} /> Hear it
        </button>
        <button
          type="button"
          onClick={save}
          disabled={isSaved}
          className="inline-flex h-9 items-center gap-1.5 rounded-full border border-line px-3 text-sm hover:bg-paper-2 disabled:border-moss disabled:text-moss"
        >
          <Icon name={isSaved ? 'bookmarkFilled' : 'bookmark'} size={17} /> {isSaved ? 'Saved' : phrase ? 'Save phrase' : 'Save word'}
        </button>
        {learning && !phrase && !isSaved && (
          <button
            type="button"
            onClick={() => setKnown(picked.lang, [picked.word], !known)}
            aria-pressed={!!known}
            className={`inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-sm ${known ? 'border-moss bg-wash text-moss' : 'border-line hover:bg-paper-2'}`}
          >
            <Icon name={known ? 'check' : 'plus'} size={16} /> {known ? 'Known' : 'I know this'}
          </button>
        )}
        <button
          type="button"
          onClick={() => onReadFromHere(picked)}
          className="inline-flex h-9 items-center gap-1.5 rounded-full border border-line px-3 text-sm hover:bg-paper-2"
        >
          <Icon name="play" size={15} /> Read from here
        </button>
        <label className="ml-auto inline-flex items-center gap-1 text-sm text-ink-3">
          <span className="sr-only">{phrase ? 'Phrase language' : 'Word language'}</span>
          <select value={lang} onChange={(e) => setLang(e.target.value)} className="rounded-md bg-transparent py-1 text-ink-2">
            {Object.entries(LANG_NAMES).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
      </div>

      {canTranslate && <TranslationBox label={phrase ? 'Translation' : 'Meaning in this sentence'} state={tPhrase} />}

      <div className="mt-4 min-h-16">
        {state === 'loading' && <p className="text-ink-3">Looking it up…</p>}
        {state === 'offline' && <p className="text-ink-2">You’re offline, so the dictionary can’t be reached. You can still save it with its sentence.</p>}
        {state === 'done' && result && result.entries.length === 0 && (
          <p className="text-sm text-ink-3">
            {phrase ? 'Wiktionary has no entry for this phrase.' : `No ${LANG_NAMES[lang] || lang} entry in Wiktionary.`}
            {!canTranslate && ' Try another language above, or one of the dictionaries below.'}
          </p>
        )}
        {state === 'done' &&
          result?.entries.slice(0, 5).map((e, i) => (
            <div key={i} className="mb-4">
              <div className="text-sm font-semibold text-moss">
                {e.language && e.language !== LANG_NAMES[lang] && (
                  <span className="mr-2 rounded-full bg-wash px-2 py-0.5 text-xs font-semibold text-ink">{e.language.replace(/ Arabic$/, '')}</span>
                )}
                {e.partOfSpeech}
                {e.word !== picked.word && (
                  <span className="ml-2 font-normal text-ink-3" dir="auto">
                    {e.word}
                  </span>
                )}
              </div>
              <ol className="mt-1 list-decimal space-y-1 pl-5 font-read text-[1.02rem] leading-snug marker:text-ink-3">
                {e.senses.map((s, j) => (
                  <li key={j} dir="auto">
                    {s.text}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        {canTranslate && !phrase && result?.entries.length && tPhrase.status === 'idle' ? (
          <button
            type="button"
            onClick={() => run(setTPhrase, picked.word, picked.sentence)}
            className="-mt-1 mb-2 text-sm text-moss underline-offset-2 hover:underline"
          >
            Meaning in this sentence
          </button>
        ) : null}
      </div>

      <blockquote dir="auto" className="rounded-xl bg-paper-2 px-4 py-3 font-read text-[0.95rem] leading-relaxed text-ink-2">
        {picked.sentence}
      </blockquote>
      {canTranslate &&
        (tSentence.status === 'idle' ? (
          <button
            type="button"
            onClick={() => run(setTSentence, picked.sentence)}
            className="mt-2 inline-flex h-9 items-center gap-1.5 rounded-full border border-line px-3 text-sm hover:bg-paper-2"
          >
            <Icon name="translate" size={16} /> Translate sentence
          </button>
        ) : (
          <TranslationBox label="Sentence" state={tSentence} />
        ))}

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {externalLinks(picked.word, lang, picked.sentence)
          .filter((l) => l.label !== 'Translate sentence')
          .map((l) => (
            <a key={l.label} href={l.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-moss underline-offset-2 hover:underline">
              {l.label} <Icon name="external" size={14} />
            </a>
          ))}
      </div>
    </Sheet>
  )
}
