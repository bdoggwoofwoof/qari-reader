import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { go } from '../App'
import { getDoc, savePosition, updateDocMeta } from '../lib/db'
import { detectLang, isMostlyArabic, sentences, words, type Span } from '../lib/lang'
import { useSettings } from '../lib/settings'
import { getVoices, onVoicesChanged, pickVoice, SentenceSpeaker, speechSupported, voicesFor } from '../lib/tts'
import { ARABIC_FONTS, LANG_NAMES, RTL_LANGS, type ArabicFont, type DocContent, type DocMeta, type Lang } from '../types'
import LookupSheet, { type Picked } from './LookupSheet'
import { Icon, IconButton, Sheet } from './ui'

interface BlockInfo {
  lang: Lang
  sents: Span[]
  words: Span[]
}

interface Highlight {
  chapter: number
  block: number
  sent: number
  word: number // start offset of current word inside the block, -1 for none
}

const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]

/** One paragraph, split into tappable words grouped by sentence. Re-renders only when its own highlight changes. */
const Block = memo(function Block({
  text,
  index,
  info,
  heading,
  activeSent,
  activeWord,
  pickedStart,
}: {
  text: string
  index: number
  info: BlockInfo
  heading: boolean
  activeSent: number
  activeWord: number
  pickedStart: number
}) {
  const rtl = RTL_LANGS.has(info.lang)
  const parts: React.ReactNode[] = []
  let cursor = 0
  let wi = 0
  info.sents.forEach((s, si) => {
    if (s.start > cursor) parts.push(text.slice(cursor, s.start))
    const inner: React.ReactNode[] = []
    let c = s.start
    while (wi < info.words.length && info.words[wi].start < s.end) {
      const w = info.words[wi]
      if (w.start > c) inner.push(text.slice(c, w.start))
      const cls = `w${w.start === activeWord && si === activeSent ? ' now' : ''}${w.start === pickedStart ? ' picked' : ''}`
      inner.push(
        <span key={w.start} className={cls} data-b={index} data-s={w.start} data-e={w.end}>
          {text.slice(w.start, w.end)}
        </span>,
      )
      c = w.end
      wi++
    }
    if (c < s.end) inner.push(text.slice(c, s.end))
    parts.push(
      <span key={'s' + si} className={`s${si === activeSent ? ' on' : ''}`} data-sb={index} data-si={si}>
        {inner}
      </span>,
    )
    cursor = s.end
  })
  if (cursor < text.length) parts.push(text.slice(cursor))
  const Tag = heading ? 'h2' : 'p'
  return (
    <Tag className={heading ? 'h text-[1.35em]' : undefined} dir={rtl ? 'rtl' : 'auto'} lang={info.lang} data-block={index}>
      {parts}
    </Tag>
  )
})

export default function Reader({ id }: { id: string }) {
  const [meta, setMeta] = useState<DocMeta | null>(null)
  const [content, setContent] = useState<DocContent | null>(null)
  const [missing, setMissing] = useState(false)
  const [chapter, setChapter] = useState(0)
  const [hl, setHl] = useState<Highlight>({ chapter: 0, block: 0, sent: -1, word: -1 })
  const [playing, setPlaying] = useState(false)
  const [picked, setPicked] = useState<Picked | null>(null)
  const [tocOpen, setTocOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [voicesVersion, setVoicesVersion] = useState(0)
  const [settings, updateSettings] = useSettings()

  const speaker = useRef(new SentenceSpeaker())
  const pos = useRef({ chapter: 0, block: 0, sent: 0 })
  const lastWord = useRef<number | null>(null)
  const playingRef = useRef(false)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const metaRef = useRef<DocMeta | null>(null)
  metaRef.current = meta
  const contentRef = useRef<DocContent | null>(null)
  contentRef.current = content
  const infoCache = useRef(new Map<string, BlockInfo>())
  const userScrolledAt = useRef(0)
  const saveTimer = useRef<number | null>(null)
  const wakeLock = useRef<{ release: () => Promise<void> } | null>(null)
  const warnedLangs = useRef(new Set<string>())

  // ---------- Load ----------
  useEffect(() => {
    getDoc(id).then((d) => {
      if (!d) return setMissing(true)
      setMeta(d.meta)
      setContent(d.content)
      const p = d.meta.position
      const ch = Math.min(p.chapter, d.content.chapters.length - 1)
      setChapter(ch)
      pos.current = { chapter: ch, block: p.block, sent: 0 }
      setHl({ chapter: ch, block: p.block, sent: -1, word: -1 })
      updateDocMeta(id, { openedAt: Date.now() })
      requestAnimationFrame(() => {
        document.querySelector(`[data-block="${p.block}"]`)?.scrollIntoView({ block: 'start' })
        window.scrollBy(0, -80)
      })
    })
    getVoices().then(() => setVoicesVersion((v) => v + 1))
    const off = onVoicesChanged(() => setVoicesVersion((v) => v + 1))
    const sp = speaker.current
    return () => {
      off()
      sp.stop()
    }
  }, [id])

  const infoFor = useCallback((c: number, b: number): BlockInfo | null => {
    const doc = contentRef.current
    const m = metaRef.current
    const text = doc?.chapters[c]?.blocks[b]
    if (text === undefined || !m) return null
    const key = `${m.lang}:${c}:${b}`
    let info = infoCache.current.get(key)
    if (!info) {
      let lang = m.lang
      // Switch voices for paragraphs in another script (Arabic quotes in an English book and vice versa).
      if (lang !== 'ar' && isMostlyArabic(text)) lang = 'ar'
      else if (RTL_LANGS.has(lang) && !/[֐-ۿ]/.test(text)) lang = detectLang(text, 'en')
      info = { lang, sents: sentences(text, lang), words: words(text, lang) }
      infoCache.current.set(key, info)
    }
    return info
  }, [])

  const chapterData = content?.chapters[chapter]
  const blockInfos = useMemo(() => (chapterData ? chapterData.blocks.map((_, b) => infoFor(chapter, b)!) : []), [chapterData, chapter, infoFor, meta?.lang])
  const headingSet = useMemo(() => new Set(chapterData?.headings || []), [chapterData])
  const chapterLangs = useMemo(() => {
    const set = new Set<Lang>(meta ? [meta.lang] : [])
    for (const i of blockInfos) set.add(i.lang)
    return [...set]
  }, [blockInfos, meta])

  // ---------- Position saving ----------
  const persist = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      const m = metaRef.current
      const doc = contentRef.current
      if (!m || !doc) return
      const { chapter: c, block: b } = pos.current
      const inChapter = doc.chapters[c].blocks.slice(0, b).reduce((n, t) => n + t.length, 0)
      const progress = m.charCount ? Math.min(1, ((m.charsBefore[c] ?? 0) + inChapter) / m.charCount) : 0
      savePosition(m.id, { chapter: c, block: b, offset: 0 }, progress)
    }, 800)
  }, [])

  // ---------- Playback ----------
  const setPlayingState = (v: boolean) => {
    playingRef.current = v
    setPlaying(v)
    if (v && 'wakeLock' in navigator && !wakeLock.current) {
      ;(navigator as unknown as { wakeLock: { request: (t: string) => Promise<{ release: () => Promise<void> }> } }).wakeLock
        .request('screen')
        .then((l) => (wakeLock.current = l))
        .catch(() => {})
    }
    if (!v && wakeLock.current) {
      wakeLock.current.release().catch(() => {})
      wakeLock.current = null
    }
  }

  const speakAt = useCallback(
    (c: number, b: number, s: number, fromOffset?: number): void => {
      const doc = contentRef.current
      const info = infoFor(c, b)
      if (!doc || !info) {
        setPlayingState(false)
        return
      }
      const span = info.sents[s]
      if (!span) {
        advance(c, b, s)
        return
      }
      pos.current = { chapter: c, block: b, sent: s }
      const start = fromOffset !== undefined && fromOffset > span.start && fromOffset < span.end ? fromOffset : span.start
      const text = doc.chapters[c].blocks[b].slice(start, span.end)
      lastWord.current = start
      setChapter((prev) => (prev === c ? prev : c))
      setHl({ chapter: c, block: b, sent: s, word: -1 })
      persist()
      const st = settingsRef.current
      const voice = pickVoice(info.lang, st.voices[info.lang])
      if (!voice && !warnedLangs.current.has(info.lang)) {
        warnedLangs.current.add(info.lang)
        setNotice(`This device has no ${LANG_NAMES[info.lang] || info.lang} voice installed, so it may be read in the wrong accent or skipped. See Settings for how to add one.`)
      }
      speaker.current.speak({
        text,
        lang: info.lang,
        voice,
        rate: st.rate,
        onWord: (ws) => {
          lastWord.current = start + ws
          setHl({ chapter: c, block: b, sent: s, word: start + ws })
        },
        onEnd: () => {
          lastWord.current = null
          if (playingRef.current) advance(c, b, s)
        },
        onError: (msg) => {
          setNotice(msg)
          setPlayingState(false)
        },
      })
    },
    [infoFor, persist],
  )

  const advance = useCallback(
    (c: number, b: number, s: number): void => {
      const doc = contentRef.current
      if (!doc) return
      const info = infoFor(c, b)
      if (info && s + 1 < info.sents.length) {
        speakAt(c, b, s + 1)
        return
      }
      // Next paragraph with something to say, then the next chapter.
      let nc = c
      let nb = b + 1
      while (nc < doc.chapters.length) {
        while (nb < doc.chapters[nc].blocks.length) {
          if (infoFor(nc, nb)?.sents.length) {
            speakAt(nc, nb, 0)
            return
          }
          nb++
        }
        nc++
        nb = 0
      }
      setPlayingState(false)
      setHl((h) => ({ ...h, sent: -1, word: -1 }))
      setNotice('You’ve reached the end.')
    },
    [infoFor, speakAt],
  )

  const play = useCallback(() => {
    if (!speechSupported()) {
      setNotice('This browser can’t speak text aloud. Try Chrome, Edge or Safari.')
      return
    }
    setPlayingState(true)
    const p = pos.current
    const info = infoFor(p.chapter, p.block)
    if (!info?.sents.length) return advance(p.chapter, p.block, 0)
    speakAt(p.chapter, p.block, Math.min(p.sent, info.sents.length - 1), lastWord.current ?? undefined)
  }, [advance, infoFor, speakAt])

  const pause = useCallback(() => {
    setPlayingState(false)
    speaker.current.stop()
  }, [])

  const toggle = useCallback(() => (playingRef.current ? pause() : play()), [pause, play])

  const step = useCallback(
    (dir: 1 | -1) => {
      const doc = contentRef.current
      if (!doc) return
      let { chapter: c, block: b, sent: s } = pos.current
      lastWord.current = null
      if (dir === 1) {
        const info = infoFor(c, b)
        if (info && s + 1 < info.sents.length) s++
        else {
          const nextB = doc.chapters[c].blocks.findIndex((_, i) => i > b && (infoFor(c, i)?.sents.length ?? 0) > 0)
          if (nextB >= 0) {
            b = nextB
            s = 0
          } else if (c + 1 < doc.chapters.length) {
            c++
            b = 0
            s = 0
          }
        }
      } else {
        if (s > 0) s--
        else {
          let pb = b - 1
          while (pb >= 0 && !(infoFor(c, pb)?.sents.length ?? 0)) pb--
          if (pb >= 0) {
            b = pb
            s = (infoFor(c, pb)?.sents.length ?? 1) - 1
          }
        }
      }
      pos.current = { chapter: c, block: b, sent: s }
      userScrolledAt.current = 0
      if (playingRef.current) speakAt(c, b, s)
      else {
        setChapter(c)
        setHl({ chapter: c, block: b, sent: s, word: -1 })
        persist()
      }
    },
    [infoFor, persist, speakAt],
  )

  // Restart the current sentence from the current word when speed or voice changes mid-playback.
  const rateKey = settings.rate + JSON.stringify(settings.voices)
  const firstRate = useRef(true)
  useEffect(() => {
    if (firstRate.current) {
      firstRate.current = false
      return
    }
    if (playingRef.current) {
      const p = pos.current
      speakAt(p.chapter, p.block, p.sent, lastWord.current ?? undefined)
    }
  }, [rateKey, speakAt])

  // ---------- Auto-scroll ----------
  useEffect(() => {
    if (hl.sent < 0 || hl.chapter !== chapter || !settings.autoScroll) return
    if (Date.now() - userScrolledAt.current < 5000) return
    const el = document.querySelector(`[data-sb="${hl.block}"][data-si="${hl.sent}"]`)
    if (!el) return
    const r = el.getBoundingClientRect()
    const vh = window.innerHeight
    if (r.top < 90 || r.bottom > vh - 150) {
      window.scrollTo({ top: window.scrollY + r.top - vh * 0.33, behavior: 'smooth' })
    }
  }, [hl.block, hl.sent, hl.chapter, chapter, settings.autoScroll])

  useEffect(() => {
    const mark = () => (userScrolledAt.current = Date.now())
    window.addEventListener('wheel', mark, { passive: true })
    window.addEventListener('touchmove', mark, { passive: true })
    return () => {
      window.removeEventListener('wheel', mark)
      window.removeEventListener('touchmove', mark)
    }
  }, [])

  // ---------- Keyboard & lock-screen controls ----------
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (picked || tocOpen || settingsOpen) return
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return
      if (e.code === 'Space') {
        e.preventDefault()
        toggle()
      } else if (e.key === 'ArrowRight') step(1)
      else if (e.key === 'ArrowLeft') step(-1)
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [toggle, step, picked, tocOpen, settingsOpen])

  useEffect(() => {
    if (!('mediaSession' in navigator) || !meta) return
    navigator.mediaSession.metadata = new MediaMetadata({ title: meta.title, artist: meta.author || 'Qari' })
    navigator.mediaSession.setActionHandler('play', play)
    navigator.mediaSession.setActionHandler('pause', pause)
    navigator.mediaSession.setActionHandler('nexttrack', () => step(1))
    navigator.mediaSession.setActionHandler('previoustrack', () => step(-1))
  }, [meta, play, pause, step])

  // ---------- Tap a word ----------
  const onTextClick = (e: MouseEvent) => {
    const el = (e.target as HTMLElement).closest('.w') as HTMLElement | null
    if (!el || !content) return
    const b = Number(el.dataset.b)
    const start = Number(el.dataset.s)
    const info = infoFor(chapter, b)
    if (!info) return
    if (playingRef.current) pause()
    const text = content.chapters[chapter].blocks[b]
    const sent = info.sents.find((s) => start >= s.start && start < s.end) || { start: 0, end: text.length }
    setPicked({ word: el.textContent || '', lang: info.lang, sentence: text.slice(sent.start, sent.end).trim(), block: b, start })
  }

  const readFromHere = (p: Picked) => {
    setPicked(null)
    const info = infoFor(chapter, p.block)
    if (!info) return
    const si = Math.max(0, info.sents.findIndex((s) => p.start >= s.start && p.start < s.end))
    pos.current = { chapter, block: p.block, sent: si }
    lastWord.current = p.start
    userScrolledAt.current = 0
    play()
  }

  const goChapter = (c: number) => {
    pause()
    setTocOpen(false)
    lastWord.current = null
    pos.current = { chapter: c, block: 0, sent: 0 }
    setChapter(c)
    setHl({ chapter: c, block: 0, sent: -1, word: -1 })
    persist()
    window.scrollTo({ top: 0 })
  }

  const setDocLang = async (lang: Lang) => {
    if (!meta) return
    pause()
    infoCache.current.clear()
    const next = { ...meta, lang }
    setMeta(next)
    await updateDocMeta(meta.id, { lang })
  }

  // ---------- Render ----------
  if (missing)
    return (
      <div className="mx-auto max-w-md px-6 py-20 text-center">
        <p className="font-read text-xl">This book isn’t in your library on this device.</p>
        <button type="button" className="mt-6 text-moss underline" onClick={() => go('')}>
          Back to library
        </button>
      </div>
    )
  if (!meta || !content || !chapterData) return <div className="p-10 text-center text-ink-3">Opening…</div>

  const voicesNow = (lang: Lang) => {
    void voicesVersion
    return voicesFor(lang)
  }
  const isLast = chapter >= content.chapters.length - 1

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-30 border-b border-line/70 bg-paper/90 pt-[env(safe-area-inset-top)] backdrop-blur">
        <div className="mx-auto flex h-14 max-w-3xl items-center gap-1 px-2">
          <IconButton icon="back" label="Library" onClick={() => go('')} />
          <button type="button" onClick={() => setTocOpen(true)} className="min-w-0 flex-1 rounded-lg px-1 text-left">
            <div className="truncate text-[0.95rem] font-semibold" dir="auto">
              {meta.title}
            </div>
            <div className="truncate text-xs text-ink-3" dir="auto">
              {chapterData.title}
            </div>
          </button>
          <IconButton icon="list" label="Contents" onClick={() => setTocOpen(true)} />
          <IconButton icon="sliders" label="Reading settings" onClick={() => setSettingsOpen(true)} />
        </div>
      </header>

      {notice && (
        <div className="mx-auto mt-3 flex max-w-[38rem] items-start gap-3 rounded-xl border border-line bg-paper-2 px-4 py-3 text-sm" role="status">
          <span className="flex-1">{notice}</span>
          <button type="button" className="shrink-0 text-ink-3 underline" onClick={() => setNotice(null)}>
            OK
          </button>
        </div>
      )}

      <main
        className="prose-read mx-auto max-w-[38rem] px-5 pt-6 pb-44"
        style={{ fontSize: settings.fontSize }}
        onClick={onTextClick}
      >
        {chapterData.blocks.map((text, b) => (
          <Block
            key={b}
            text={text}
            index={b}
            info={blockInfos[b]}
            heading={headingSet.has(b)}
            activeSent={hl.chapter === chapter && hl.block === b ? hl.sent : -1}
            activeWord={hl.chapter === chapter && hl.block === b ? hl.word : -1}
            pickedStart={picked && picked.block === b ? picked.start : -1}
          />
        ))}
        <div className="mt-12 flex justify-between gap-3 font-ui text-sm">
          <button type="button" disabled={chapter === 0} onClick={() => goChapter(chapter - 1)} className="rounded-full border border-line px-4 py-2 disabled:opacity-30">
            Previous section
          </button>
          <button type="button" disabled={isLast} onClick={() => goChapter(chapter + 1)} className="rounded-full border border-line px-4 py-2 disabled:opacity-30">
            Next section
          </button>
        </div>
      </main>

      {/* Player */}
      <div className="safe-b fixed inset-x-0 bottom-0 z-30 px-3 pt-2">
        <div className="mx-auto flex max-w-md items-center justify-between gap-1 rounded-full border border-line bg-paper/95 p-1.5 shadow-[0_6px_30px_rgb(0_0_0/0.10)] backdrop-blur">
          <button
            type="button"
            onClick={() => {
              const i = RATES.findIndex((r) => r >= settings.rate - 0.01)
              updateSettings({ rate: RATES[(i + 1) % RATES.length] })
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              setSettingsOpen(true)
            }}
            className="h-11 min-w-14 rounded-full px-2 text-sm font-semibold tabular-nums text-ink-2 hover:bg-paper-2"
            aria-label={`Speed ${settings.rate}×, tap to change`}
          >
            {Number.isInteger(settings.rate) ? settings.rate.toFixed(1) : String(Number(settings.rate.toFixed(2)))}×
          </button>
          <IconButton icon="prev" label="Previous sentence" onClick={() => step(-1)} />
          <button
            type="button"
            onClick={toggle}
            aria-label={playing ? 'Pause' : 'Play'}
            className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-moss text-moss-ink hover:opacity-90"
          >
            <Icon name={playing ? 'pause' : 'play'} size={26} />
          </button>
          <IconButton icon="next" label="Next sentence" onClick={() => step(1)} />
          <IconButton icon="words" label="Saved words" onClick={() => go('words')} />
        </div>
      </div>

      <Sheet open={tocOpen} onClose={() => setTocOpen(false)} title="Contents" wide>
        <ol className="-mx-2">
          {content.chapters.map((c, i) => (
            <li key={i}>
              <button
                type="button"
                onClick={() => goChapter(i)}
                dir="auto"
                className={`w-full rounded-lg px-2 py-2.5 text-left font-read hover:bg-paper-2 ${i === chapter ? 'bg-wash font-semibold' : ''}`}
              >
                {c.title}
              </button>
            </li>
          ))}
        </ol>
      </Sheet>

      <Sheet open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Reading settings" wide>
        <section className="mb-6">
          <div className="mb-2 flex items-baseline justify-between">
            <h3 className="font-semibold">Speed</h3>
            <span className="tabular-nums text-ink-2">{settings.rate.toFixed(2)}×</span>
          </div>
          <input type="range" min={0.5} max={3} step={0.05} value={settings.rate} onChange={(e) => updateSettings({ rate: Number(e.target.value) })} className="w-full" aria-label="Speed" />
          <p className="mt-1 text-xs text-ink-3">Some device voices top out around 2×; going higher won’t speed them up further.</p>
        </section>

        <section className="mb-6">
          <h3 className="mb-2 font-semibold">Voices</h3>
          {chapterLangs.map((lang) => {
            const list = voicesNow(lang)
            const chosen = pickVoice(lang, settings.voices[lang])
            return (
              <div key={lang} className="mb-3">
                <label className="mb-1 block text-sm text-ink-2" htmlFor={'v-' + lang}>
                  {LANG_NAMES[lang] || lang}
                </label>
                {list.length ? (
                  <select
                    id={'v-' + lang}
                    value={chosen?.voiceURI}
                    onChange={(e) => updateSettings({ voices: { ...settings.voices, [lang]: e.target.value } })}
                    className="h-11 w-full rounded-xl border border-line bg-paper-2 px-3"
                  >
                    {list.map((v) => (
                      <option key={v.voiceURI} value={v.voiceURI}>
                        {v.name} ({v.lang}){v.localService ? '' : ' · online'}
                      </option>
                    ))}
                  </select>
                ) : (
                  <p className="rounded-xl bg-paper-2 px-3 py-2 text-sm text-ink-2">
                    No {LANG_NAMES[lang] || lang} voice on this device. On iPhone: Settings › Accessibility › Spoken Content › Voices. On Android: Settings › Text-to-speech ›
                    Install voice data. On Windows: Settings › Time &amp; language › Speech. Then reopen this page.
                  </p>
                )}
              </div>
            )
          })}
          <p className="text-xs text-ink-3">Voices marked “online” need an internet connection. Voices with “Natural”, “Enhanced” or “Premium” in the name sound best.</p>
        </section>

        <section className="mb-6">
          <label className="mb-2 block font-semibold" htmlFor="doc-lang">
            Language of this book
          </label>
          <select id="doc-lang" value={meta.lang} onChange={(e) => setDocLang(e.target.value)} className="h-11 w-full rounded-xl border border-line bg-paper-2 px-3">
            {Object.entries(LANG_NAMES).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-ink-3">Paragraphs in Arabic script are read with the Arabic voice automatically.</p>
        </section>

        <section className="mb-6 flex items-center justify-between gap-4">
          <h3 className="font-semibold">Text size</h3>
          <div className="flex items-center gap-1">
            <IconButton icon="minus" label="Smaller text" onClick={() => updateSettings({ fontSize: Math.max(14, settings.fontSize - 1) })} className="border border-line" />
            <span className="w-10 text-center tabular-nums">{settings.fontSize}</span>
            <IconButton icon="plus" label="Larger text" onClick={() => updateSettings({ fontSize: Math.min(32, settings.fontSize + 1) })} className="border border-line" />
          </div>
        </section>

        <section className="mb-6">
          <h3 className="mb-2 font-semibold">Page</h3>
          <div className="grid grid-cols-3 gap-2">
            {(['light', 'sepia', 'dark'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => updateSettings({ theme: t })}
                className={`h-11 rounded-xl border capitalize ${settings.theme === t ? 'border-moss bg-wash font-semibold' : 'border-line'}`}
              >
                {t}
              </button>
            ))}
          </div>
        </section>

        <section className="mb-6">
          <h3 className="mb-2 font-semibold">Arabic font</h3>
          <div className="grid grid-cols-3 gap-2">
            {(Object.entries(ARABIC_FONTS) as [ArabicFont, (typeof ARABIC_FONTS)[ArabicFont]][]).map(([k, f]) => (
              <button
                key={k}
                type="button"
                onClick={() => updateSettings({ arabicFont: k })}
                aria-label={f.label}
                className={`flex flex-col items-center rounded-xl border px-1 py-2 ${settings.arabicFont === k ? 'border-moss bg-wash' : 'border-line'}`}
              >
                <span lang="ar" dir="rtl" className="text-xl leading-tight" style={{ fontFamily: f.family }}>
                  ثَبَتَ تُجّار
                </span>
                <span className={`mt-1 text-xs ${settings.arabicFont === k ? 'font-semibold' : 'text-ink-2'}`}>{f.label}</span>
              </button>
            ))}
          </div>
        </section>

        <label className="flex items-center justify-between gap-4 pb-2">
          <span>
            <span className="block font-semibold">Follow along</span>
            <span className="text-sm text-ink-3">Scroll to keep the spoken sentence in view.</span>
          </span>
          <input type="checkbox" checked={settings.autoScroll} onChange={(e) => updateSettings({ autoScroll: e.target.checked })} className="h-5 w-5 accent-[var(--moss)]" />
        </label>
      </Sheet>

      <LookupSheet
        picked={picked}
        source={meta.title}
        voiceURI={picked ? settings.voices[picked.lang] : undefined}
        onClose={() => setPicked(null)}
        onReadFromHere={readFromHere}
      />
    </div>
  )
}
