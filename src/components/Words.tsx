import { useEffect, useMemo, useState } from 'react'
import { go } from '../App'
import { deleteWord, listWords } from '../lib/db'
import { speakWord } from '../lib/tts'
import { useSettings } from '../lib/settings'
import { LANG_NAMES, RTL_LANGS, type SavedWord } from '../types'
import { Icon, IconButton } from './ui'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const cell = (s: string) => s.replace(/[\t\r]/g, ' ').replace(/\n/g, '<br>')

/** Anki-ready file: tab-separated, HTML allowed, the word bolded inside its sentence. */
function toAnki(list: SavedWord[]) {
  const lines = ['#separator:tab', '#html:true', '#columns:Word\tMeaning\tSentence\tSource\tTags', '#tags column:5']
  for (const w of list) {
    const sentence = esc(w.sentence).replace(esc(w.word), `<b>${esc(w.word)}</b>`)
    const meaning = esc(w.definition) + (w.lemma ? `<br><i>base form: ${esc(w.lemma)}</i>` : '')
    lines.push([cell(esc(w.word)), cell(meaning), cell(sentence), cell(esc(w.source)), `qari ${(LANG_NAMES[w.lang] || w.lang).replace(/\s+/g, '_')}`].join('\t'))
  }
  return lines.join('\n')
}

export default function Words() {
  const [list, setList] = useState<SavedWord[] | null>(null)
  const [lang, setLang] = useState<string>('all')
  const [settings] = useSettings()

  useEffect(() => {
    listWords().then(setList)
  }, [])

  const langs = useMemo(() => [...new Set((list || []).map((w) => w.lang))], [list])
  const shown = (list || []).filter((w) => lang === 'all' || w.lang === lang)

  const exportAnki = () => {
    const blob = new Blob([toAnki(shown)], { type: 'text/plain;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `qari-words-${lang === 'all' ? 'all' : lang}-${new Date().toISOString().slice(0, 10)}.txt`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  const remove = async (id: string) => {
    await deleteWord(id)
    setList((l) => (l || []).filter((w) => w.id !== id))
  }

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-30 border-b border-line/70 bg-paper/90 pt-[env(safe-area-inset-top)] backdrop-blur">
        <div className="mx-auto flex h-14 max-w-3xl items-center gap-1 px-2">
          <IconButton icon="back" label="Back" onClick={() => history.length > 1 ? history.back() : go('')} />
          <h1 className="flex-1 text-[0.95rem] font-semibold">Saved words</h1>
          <button
            type="button"
            onClick={exportAnki}
            disabled={!shown.length}
            className="mr-1 inline-flex h-10 items-center gap-1.5 rounded-full border border-line px-3 text-sm font-semibold hover:bg-paper-2 disabled:opacity-40"
          >
            <Icon name="download" size={17} /> Export for Anki
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 pb-16 sm:px-6">
        {langs.length > 1 && (
          <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Filter by language">
            {['all', ...langs].map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setLang(l)}
                className={`h-9 rounded-full border px-3 text-sm ${lang === l ? 'border-moss bg-wash font-semibold' : 'border-line'}`}
              >
                {l === 'all' ? 'All' : LANG_NAMES[l] || l}
              </button>
            ))}
          </div>
        )}

        {list && !list.length && (
          <div className="mt-16 text-center">
            <p className="font-read text-xl">No saved words yet.</p>
            <p className="mt-2 text-ink-2">While reading, tap any word, then choose “Save word”. It’s kept with the sentence you found it in.</p>
          </div>
        )}

        <ul className="mt-4 divide-y divide-line border-y border-line">
          {shown.map((w) => {
            const rtl = RTL_LANGS.has(w.lang)
            return (
              <li key={w.id} className="group flex gap-2 py-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-3">
                    <span dir={rtl ? 'rtl' : 'ltr'} lang={w.lang} className={rtl ? 'font-arabic text-2xl' : 'font-read text-xl'}>
                      {w.word}
                    </span>
                    {w.lemma && <span className="text-sm text-ink-3">from {w.lemma}</span>}
                    <span className="text-xs text-ink-3">{LANG_NAMES[w.lang] || w.lang}</span>
                  </div>
                  {w.definition && <p className="mt-1 whitespace-pre-line text-sm text-ink-2">{w.definition}</p>}
                  <p dir="auto" className="mt-2 font-read text-[0.95rem] leading-relaxed text-ink-2">
                    {w.sentence}
                  </p>
                  <p className="mt-1 truncate text-xs text-ink-3">{w.source}</p>
                </div>
                <div className="flex flex-col">
                  <IconButton icon="speaker" label={`Hear ${w.word}`} onClick={() => speakWord(w.word, w.lang, settings.voices[w.lang])} />
                  <IconButton icon="trash" label={`Delete ${w.word}`} onClick={() => remove(w.id)} className="opacity-60 group-hover:opacity-100" />
                </div>
              </li>
            )
          })}
        </ul>
        {shown.length > 0 && (
          <p className="mt-4 text-sm text-ink-3">
            In Anki: File › Import, choose the exported file, and pick a note type with at least three fields (Word, Meaning, Sentence). Each card is tagged with its language.
          </p>
        )}
      </main>
    </div>
  )
}
