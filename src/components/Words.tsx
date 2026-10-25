import { useEffect, useMemo, useState } from 'react'
import { go } from '../App'
import { AnkiDenied, AnkiUnreachable, defaultDeck, sendToAnki, type SendResult } from '../lib/anki'
import { deleteWord, listWords, saveWord } from '../lib/db'
import { speakWord } from '../lib/tts'
import { useSettings } from '../lib/settings'
import { LANG_NAMES, RTL_LANGS, type SavedWord } from '../types'
import { Icon, IconButton } from './ui'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const cell = (s: string) => s.replace(/[\t\r]/g, ' ').replace(/\n/g, '<br>')
const onPhone = () => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && 'ontouchend' in document)

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

type SendState = { kind: 'idle' } | { kind: 'sending' } | { kind: 'done'; r: SendResult } | { kind: 'help'; reason: 'unreachable' | 'denied' | 'phone' } | { kind: 'error'; message: string }

export default function Words() {
  const [list, setList] = useState<SavedWord[] | null>(null)
  const [lang, setLang] = useState<string>('all')
  const [send, setSend] = useState<SendState>({ kind: 'idle' })
  const [settings, updateSettings] = useSettings()

  const load = () => listWords().then(setList)
  useEffect(() => {
    load()
    window.addEventListener('qari:synced', load)
    return () => window.removeEventListener('qari:synced', load)
  }, [])

  const langs = useMemo(() => [...new Set((list || []).map((w) => w.lang))], [list])
  const shown = (list || []).filter((w) => lang === 'all' || w.lang === lang)
  const unsent = shown.filter((w) => !w.ankiAt)

  const exportAnki = () => {
    const blob = new Blob([toAnki(shown)], { type: 'text/plain;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `qari-words-${lang === 'all' ? 'all' : lang}-${new Date().toISOString().slice(0, 10)}.txt`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  const sendNow = async () => {
    if (!unsent.length) return
    setSend({ kind: 'sending' })
    try {
      const r = await sendToAnki(unsent, settings.ankiDecks)
      const now = Date.now()
      for (const w of r.sent) await saveWord({ ...w, ankiAt: now, updatedAt: now })
      await load()
      setSend({ kind: 'done', r })
    } catch (e) {
      if (e instanceof AnkiUnreachable) setSend({ kind: 'help', reason: onPhone() ? 'phone' : 'unreachable' })
      else if (e instanceof AnkiDenied) setSend({ kind: 'help', reason: 'denied' })
      else setSend({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }

  const remove = async (id: string) => {
    await deleteWord(id)
    setList((l) => (l || []).filter((w) => w.id !== id))
  }

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-30 border-b border-line/70 bg-paper/90 pt-[env(safe-area-inset-top)] backdrop-blur">
        <div className="mx-auto flex h-14 max-w-3xl items-center gap-1 px-2">
          <IconButton icon="back" label="Back" onClick={() => (history.length > 1 ? history.back() : go(''))} />
          <h1 className="flex-1 text-[0.95rem] font-semibold">Saved words</h1>
          <IconButton icon="download" label="Export a file for Anki" onClick={exportAnki} disabled={!shown.length} />
          <button
            type="button"
            onClick={sendNow}
            disabled={!unsent.length || send.kind === 'sending'}
            className="mr-1 inline-flex h-10 items-center gap-1.5 rounded-full bg-moss px-4 text-sm font-semibold text-moss-ink hover:opacity-90 disabled:opacity-40"
          >
            <Icon name="anki" size={17} /> {send.kind === 'sending' ? 'Sending…' : unsent.length ? `Send ${unsent.length} to Anki` : 'All in Anki'}
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 pb-16 sm:px-6">
        {send.kind === 'done' && (
          <div className="mt-4 flex items-start gap-3 rounded-xl border border-moss/50 bg-wash px-4 py-3 text-sm" role="status">
            <Icon name="check" size={18} className="mt-0.5 shrink-0 text-moss" />
            <span className="flex-1">
              {send.r.added ? `Added ${send.r.added} ${send.r.added === 1 ? 'card' : 'cards'} to ${send.r.decks.join(', ')}.` : 'Nothing new to add.'}
              {send.r.already > 0 && ` ${send.r.already} ${send.r.already === 1 ? 'was' : 'were'} already there.`} Each card speaks with Anki’s own voice.
            </span>
            <button type="button" className="shrink-0 text-ink-3 underline" onClick={() => setSend({ kind: 'idle' })}>
              OK
            </button>
          </div>
        )}
        {send.kind === 'error' && (
          <div className="mt-4 rounded-xl border border-danger/40 px-4 py-3 text-sm text-danger" role="alert">
            {send.message}
          </div>
        )}
        {send.kind === 'help' && (
          <div className="mt-4 rounded-xl border border-line bg-paper-2 px-4 py-3 text-sm" role="alert">
            {send.reason === 'phone' ? (
              <>
                <p className="font-semibold">Sending to Anki works from your computer.</p>
                <p className="mt-1 text-ink-2">
                  It uses the AnkiConnect add-on in Anki on your computer. With sync on, the words you save here appear in Qari on your laptop; open them there and tap Send to
                  Anki. They’re marked as sent, so nothing is added twice. To add them on this phone instead, use the download button to export a file and import it in
                  AnkiMobile or AnkiDroid.
                </p>
              </>
            ) : send.reason === 'denied' ? (
              <>
                <p className="font-semibold">Anki said no to Qari.</p>
                <p className="mt-1 text-ink-2">Tap Send again and choose Yes when Anki asks whether to allow this site.</p>
              </>
            ) : (
              <>
                <p className="font-semibold">Qari couldn’t reach Anki on this computer.</p>
                <ol className="mt-1 list-decimal space-y-1 pl-5 text-ink-2">
                  <li>
                    Open Anki. Once only: Tools › Add-ons › Get Add-ons…, enter <span className="font-mono font-semibold text-ink">2055492159</span> (AnkiConnect) and restart Anki.
                  </li>
                  <li>Tap Send to Anki again. Anki asks whether to allow this site: choose Yes.</li>
                  <li>If the browser asks to let this site reach devices on your local network, allow it.</li>
                </ol>
                <p className="mt-2 text-ink-3">Still stuck? Chrome and Edge work best for this. Or use the download button to export a file and import it in Anki.</p>
              </>
            )}
            <button type="button" className="mt-2 text-ink-3 underline" onClick={() => setSend({ kind: 'idle' })}>
              Close
            </button>
          </div>
        )}

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
            <p className="mt-2 text-ink-2">While reading, tap a word (or select a phrase and choose Look up), then Save. It’s kept with the sentence you found it in.</p>
          </div>
        )}

        <ul className="mt-4 divide-y divide-line border-y border-line">
          {shown.map((w) => {
            const rtl = RTL_LANGS.has(w.lang)
            return (
              <li key={w.id} className="group flex gap-2 py-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-3">
                    <span dir={rtl ? 'rtl' : 'ltr'} lang={w.lang} className={rtl ? 'font-arabic text-2xl' : 'font-read text-xl'}>
                      {w.word}
                    </span>
                    {w.lemma && <span className="text-sm text-ink-3">from {w.lemma}</span>}
                    <span className="text-xs text-ink-3">{LANG_NAMES[w.lang] || w.lang}</span>
                    {w.ankiAt && (
                      <span className="inline-flex items-center gap-0.5 text-xs text-moss">
                        <Icon name="check" size={12} /> In Anki
                      </span>
                    )}
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

        {langs.length > 0 && (
          <details className="mt-6 rounded-xl border border-line px-4 py-3 text-sm">
            <summary className="cursor-pointer font-semibold">Anki decks</summary>
            <p className="mt-2 text-ink-3">
              Each language’s words go to their own deck with a “Qari” note type, so your other decks aren’t touched. To put them into a deck you already have, type its exact
              name (use :: for a subdeck).
            </p>
            {langs.map((l) => (
              <label key={l} className="mt-2 flex items-center gap-3">
                <span className="w-20 shrink-0 text-ink-2">{LANG_NAMES[l] || l}</span>
                <input
                  value={settings.ankiDecks[l] ?? ''}
                  placeholder={defaultDeck(l)}
                  onChange={(e) => updateSettings({ ankiDecks: { ...settings.ankiDecks, [l]: e.target.value } })}
                  dir="auto"
                  className="h-10 min-w-0 flex-1 rounded-lg border border-line bg-paper-2 px-3 outline-none focus:border-moss"
                />
              </label>
            ))}
          </details>
        )}
      </main>
    </div>
  )
}
