import { useEffect, useState } from 'react'
import { externalLinks, lookup, type LookupResult } from '../lib/dictionary'
import { saveWord } from '../lib/db'
import { speakWord } from '../lib/tts'
import { LANG_NAMES, RTL_LANGS, type Lang } from '../types'
import { Icon, Sheet } from './ui'

export interface Picked {
  word: string
  lang: Lang
  sentence: string
  block: number
  start: number
}

export default function LookupSheet({
  picked,
  source,
  voiceURI,
  onClose,
  onReadFromHere,
}: {
  picked: Picked | null
  source: string
  voiceURI?: string
  onClose: () => void
  onReadFromHere: (p: Picked) => void
}) {
  const [lang, setLang] = useState<Lang>(picked?.lang || 'en')
  const [result, setResult] = useState<LookupResult | null>(null)
  const [state, setState] = useState<'loading' | 'done' | 'offline'>('loading')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (picked) {
      setLang(picked.lang)
      setSaved(false)
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

  if (!picked) return null
  const rtl = RTL_LANGS.has(lang)
  const first = result?.entries[0]
  const lemma = result?.entries.find((e) => e.word !== first?.word)?.word

  const save = async () => {
    const def = result?.entries
      .slice(0, 3)
      .map((e) => `${e.partOfSpeech}${e.word !== picked.word ? ` (${e.word})` : ''}: ${e.senses.slice(0, 2).map((s) => s.text).join('; ')}`)
      .join('\n')
    await saveWord({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      word: picked.word,
      lemma,
      lang,
      definition: def || '',
      sentence: picked.sentence,
      source,
      addedAt: Date.now(),
    })
    setSaved(true)
  }

  return (
    <Sheet
      open
      onClose={onClose}
      wide
      title={
        <span className="flex items-baseline gap-3">
          <span dir={rtl ? 'rtl' : 'ltr'} lang={lang} className={rtl ? 'font-arabic text-3xl' : 'font-read text-2xl'}>
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
          disabled={saved}
          className="inline-flex h-9 items-center gap-1.5 rounded-full border border-line px-3 text-sm hover:bg-paper-2 disabled:border-moss disabled:text-moss"
        >
          <Icon name={saved ? 'bookmarkFilled' : 'bookmark'} size={17} /> {saved ? 'Saved' : 'Save word'}
        </button>
        <button
          type="button"
          onClick={() => onReadFromHere(picked)}
          className="inline-flex h-9 items-center gap-1.5 rounded-full border border-line px-3 text-sm hover:bg-paper-2"
        >
          <Icon name="play" size={15} /> Read from here
        </button>
        <label className="ml-auto inline-flex items-center gap-1 text-sm text-ink-3">
          <span className="sr-only">Word language</span>
          <select value={lang} onChange={(e) => setLang(e.target.value)} className="rounded-md bg-transparent py-1 text-ink-2">
            {Object.entries(LANG_NAMES).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-4 min-h-24">
        {state === 'loading' && <p className="text-ink-3">Looking it up…</p>}
        {state === 'offline' && <p className="text-ink-2">You’re offline, so the dictionary can’t be reached. You can still save the word and its sentence.</p>}
        {state === 'done' && result && result.entries.length === 0 && (
          <p className="text-ink-2">
            No {LANG_NAMES[lang] || lang} entry found in Wiktionary. Try another language above, or one of the dictionaries below.
          </p>
        )}
        {state === 'done' &&
          result?.entries.slice(0, 5).map((e, i) => (
            <div key={i} className="mb-4">
              <div className="text-sm font-semibold text-moss">
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
      </div>

      <blockquote dir="auto" className="rounded-xl bg-paper-2 px-4 py-3 font-read text-[0.95rem] leading-relaxed text-ink-2">
        {picked.sentence}
      </blockquote>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {externalLinks(picked.word, lang, picked.sentence).map((l) => (
          <a key={l.label} href={l.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-moss underline-offset-2 hover:underline">
            {l.label} <Icon name="external" size={14} />
          </a>
        ))}
      </div>
    </Sheet>
  )
}
