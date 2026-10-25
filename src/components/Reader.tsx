import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { go } from '../App'
import { getDoc, getFile, listHighlights, onLocalChange, savePosition, saveHighlight, updateDocMeta } from '../lib/db'
import { quoteLine } from '../lib/quotes'
import { getSyncCode } from '../lib/sync'
import type { SearchHit } from '../lib/search'
import BookPanel, { type PanelTab } from './BookPanel'
import HighlightSheet from './HighlightSheet'
import PageViewer from './PageViewer'
import { detectLang, isMostlyArabic, sentences, stripArabicMarks, words, type Span } from '../lib/lang'
import { rateFor, useSettings } from '../lib/settings'
import { speechText } from '../lib/speechText'
import { CHARS_PER_SEC, getVoices, SAMPLES, onVoicesChanged, pickVoice, SentenceSpeaker, speechSupported, speakWord, voicesFor } from '../lib/tts'
import { ARABIC_FONTS, LANG_NAMES, RTL_LANGS, type ArabicFont, type DocContent, type DocMeta, type Highlight, type Lang } from '../types'
import LookupSheet, { type Picked } from './LookupSheet'
import { Icon, IconButton, Sheet } from './ui'

interface BlockInfo {
  lang: Lang
  sents: Span[]
  words: Span[]
}

/** Where the voice is: the spoken sentence and word. */
interface Spot {
  chapter: number
  block: number
  sent: number
  word: number // start offset of current word inside the block, -1 for none
}

/** Part of a saved highlight that falls inside one paragraph. */
interface Mark {
  id: string
  start: number
  end: number
  note: boolean
}

interface Pos {
  chapter: number
  block: number
  sent: number
}

type Sleep = { kind: 'off' } | { kind: 'time'; until: number } | { kind: 'section'; chapter: number }

const RATES = [0.75, 0.85, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]
const fmtRate = (r: number) => (Number.isInteger(r) ? r.toFixed(1) : String(Number(r.toFixed(2))))

function fmtMinutes(sec: number) {
  if (sec < 60) return 'under a minute'
  const m = Math.round(sec / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return `${h} h ${m % 60} min`
}

/** One paragraph, split into tappable words grouped by sentence. Re-renders only when its own highlight changes. */
const Block = memo(function Block({
  text,
  index,
  info,
  heading,
  activeSent,
  activeWord,
  pickedStart,
  harakat,
  marks,
  flash,
}: {
  text: string
  index: number
  info: BlockInfo
  heading: boolean
  activeSent: number
  activeWord: number
  pickedStart: number
  harakat: boolean
  marks?: Mark[]
  flash?: string // "start:end" of a search result to flash, or undefined
}) {
  const [fs, fe] = flash ? flash.split(':').map(Number) : [-1, -1]
  const rtl = RTL_LANGS.has(info.lang)
  // Vowel marks are hidden only on screen; the voice still reads the fully voweled text.
  const show = (s: string) => (harakat || !rtl ? s : stripArabicMarks(s))
  const parts: React.ReactNode[] = []
  let cursor = 0
  let wi = 0
  info.sents.forEach((s, si) => {
    if (s.start > cursor) parts.push(show(text.slice(cursor, s.start)))
    const inner: React.ReactNode[] = []
    let c = s.start
    while (wi < info.words.length && info.words[wi].start < s.end) {
      const w = info.words[wi]
      if (w.start > c) {
        const gap = show(text.slice(c, w.start))
        // Colour the space between two words of the same highlight, so it reads as one stroke.
        const inMark = marks?.some((k) => c > k.start && w.start < k.end)
        inner.push(inMark ? <span key={'g' + c} className="hl">{gap}</span> : gap)
      }
      const m = marks?.find((k) => w.start < k.end && w.end > k.start)
      const last = m && !info.words.some((x) => x.start > w.start && x.start < m.end)
      const cls =
        `w${w.start === activeWord && si === activeSent ? ' now' : ''}${w.start === pickedStart ? ' picked' : ''}` +
        `${m ? ' hl' : ''}${m && last && m.note ? ' hl-note' : ''}${w.start < fe && w.end > fs ? ' flash' : ''}`
      inner.push(
        <span key={w.start} className={cls} data-b={index} data-s={w.start} data-e={w.end} data-h={m?.id}>
          {show(text.slice(w.start, w.end))}
        </span>,
      )
      c = w.end
      wi++
    }
    if (c < s.end) inner.push(show(text.slice(c, s.end)))
    parts.push(
      <span key={'s' + si} className={`s${si === activeSent ? ' on' : ''}`} data-sb={index} data-si={si}>
        {inner}
      </span>,
    )
    cursor = s.end
  })
  if (cursor < text.length) parts.push(show(text.slice(cursor)))
  const Tag = heading ? 'h2' : 'p'
  return (
    <Tag className={heading ? 'h text-[1.35em]' : undefined} dir={rtl ? 'rtl' : 'auto'} lang={info.lang} data-block={index}>
      {parts}
    </Tag>
  )
})

function Toggle({ checked, onChange, title, hint }: { checked: boolean; onChange: (v: boolean) => void; title: string; hint: string }) {
  return (
    <label className="mb-5 flex items-center justify-between gap-4">
      <span>
        <span className="block font-semibold">{title}</span>
        <span className="text-sm text-ink-3">{hint}</span>
      </span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-5 w-5 shrink-0 accent-[var(--moss)]" />
    </label>
  )
}

export default function Reader({ id }: { id: string }) {
  const [meta, setMeta] = useState<DocMeta | null>(null)
  const [content, setContent] = useState<DocContent | null>(null)
  const [missing, setMissing] = useState(false)
  const [chapter, setChapter] = useState(0)
  const [hl, setHl] = useState<Spot>({ chapter: 0, block: 0, sent: -1, word: -1 })
  const [highlights, setHighlights] = useState<Highlight[]>([])
  const [openHl, setOpenHl] = useState<Highlight | null>(null)
  const [selection, setSelection] = useState<{ startBlock: number; start: number; endBlock: number; end: number; text: string } | null>(null)
  const [panelTab, setPanelTab] = useState<PanelTab>('contents')
  const [flash, setFlash] = useState<{ chapter: number; block: number; start: number; end: number } | null>(null)
  const [viewPage, setViewPage] = useState<{ page: number; label?: string } | null>(null)
  const [hasOriginal, setHasOriginal] = useState(false)
  // The original PDF is here, or can come from sync when a page is opened.
  const canShowOriginal = !!meta && meta.kind === 'pdf' && (hasOriginal || !!getSyncCode())
  const [playing, setPlaying] = useState(false)
  const [picked, setPicked] = useState<Picked | null>(null)
  const [tocOpen, setTocOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sleepOpen, setSleepOpen] = useState(false)
  const [sleep, setSleepState] = useState<Sleep>({ kind: 'off' })
  const [now, setNow] = useState(Date.now())
  const [away, setAway] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [voicesVersion, setVoicesVersion] = useState(0)
  const [newFrom, setNewFrom] = useState('')
  const [newTo, setNewTo] = useState('')
  const [settings, updateSettings] = useSettings()

  const speaker = useRef(new SentenceSpeaker())
  const pos = useRef<Pos>({ chapter: 0, block: 0, sent: 0 })
  const lastWord = useRef<number | null>(null)
  const playingRef = useRef(false)
  const repeated = useRef(false)
  const lastSpoken = useRef<Pos | null>(null)
  const sleepRef = useRef<Sleep>({ kind: 'off' })
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const metaRef = useRef<DocMeta | null>(null)
  metaRef.current = meta
  const contentRef = useRef<DocContent | null>(null)
  contentRef.current = content
  const infoCache = useRef(new Map<string, BlockInfo>())
  const userScrolledAt = useRef(0)
  const saveTimer = useRef<number | null>(null)
  const tapTimer = useRef<number | null>(null)
  const lastTap = useRef<{ b: number; s: number; t: number } | null>(null)
  const tappedWord = useRef<{ b: number; start: number; end: number } | null>(null)
  const wakeLock = useRef<{ release: () => Promise<void> } | null>(null)
  const warnedLangs = useRef(new Set<string>())
  const lastOwnSave = useRef(0) // when this device last moved the reading position
  const [elsewhere, setElsewhere] = useState<DocMeta['position'] | null>(null)

  const setSleep = (s: Sleep) => {
    sleepRef.current = s
    setSleepState(s)
  }

  // ---------- Load ----------
  useEffect(() => {
    getDoc(id).then((d) => {
      if (!d) return setMissing(true)
      setMeta(d.meta)
      setContent(d.content)
      lastOwnSave.current = d.meta.positionAt ?? d.meta.addedAt
      const p = d.meta.position
      const ch = Math.min(p.chapter, d.content.chapters.length - 1)
      setChapter(ch)
      pos.current = { chapter: ch, block: p.block, sent: 0 }
      setHl({ chapter: ch, block: p.block, sent: -1, word: -1 })
      updateDocMeta(id, { openedAt: Date.now() }, 'opened')
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
  const hasArabic = chapterLangs.some((l) => RTL_LANGS.has(l))

  // ---------- Highlights ----------
  useEffect(() => {
    const load = () => listHighlights(id).then(setHighlights)
    load()
    const off = onLocalChange((k) => k === 'highlights' && load())
    window.addEventListener('qari:synced', load)
    getFile(id).then((f) => setHasOriginal(!!f))
    return () => {
      off()
      window.removeEventListener('qari:synced', load)
    }
  }, [id])

  // Each paragraph gets only the highlight pieces that fall inside it (stable arrays, so untouched paragraphs don't re-render).
  const blockMarks = useMemo(() => {
    const out: (Mark[] | undefined)[] = []
    for (const h of highlights) {
      if (h.chapter !== chapter) continue
      for (let b = h.startBlock; b <= h.endBlock; b++) {
        const len = chapterData?.blocks[b]?.length ?? 0
        ;(out[b] ||= []).push({ id: h.id, start: b === h.startBlock ? h.start : 0, end: b === h.endBlock ? h.end : len, note: !!h.note.trim() })
      }
    }
    return out
  }, [highlights, chapter, chapterData])

  // Text selected by the reader (long-press on a phone, drag on a laptop), snapped to whole words.
  useEffect(() => {
    const onSel = () => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || !sel.rangeCount) return setSelection(null)
      const range = sel.getRangeAt(0)
      const main = document.querySelector('main.prose-read')
      if (!main || !main.contains(range.commonAncestorContainer)) return setSelection(null)
      const ws = [...main.querySelectorAll<HTMLElement>('.w')].filter((el) => range.intersectsNode(el))
      if (!ws.length) return setSelection(null)
      const a = ws[0]
      const z = ws[ws.length - 1]
      const startBlock = Number(a.dataset.b)
      const endBlock = Number(z.dataset.b)
      const start = Number(a.dataset.s)
      const end = Number(z.dataset.e)
      const blocks = contentRef.current?.chapters[chapter]?.blocks || []
      const text =
        startBlock === endBlock
          ? blocks[startBlock].slice(start, end)
          : [blocks[startBlock].slice(start), ...blocks.slice(startBlock + 1, endBlock), blocks[endBlock].slice(0, end)].join('\n\n')
      setSelection({ startBlock, start, endBlock, end, text })
    }
    document.addEventListener('selectionchange', onSel)
    return () => document.removeEventListener('selectionchange', onSel)
  }, [chapter])

  const makeHighlight = async (withNote: boolean) => {
    if (!selection || !meta) return
    const pages = chapterData?.pages
    // Start page of the first paragraph; for a quote spanning paragraphs, the last page of the final one.
    const p1 = pages?.[selection.startBlock]?.split('–')[0]
    const p2 = selection.endBlock !== selection.startBlock ? pages?.[selection.endBlock]?.split('–').pop() : undefined
    const now = Date.now()
    const h: Highlight = {
      id: now.toString(36) + Math.random().toString(36).slice(2, 6),
      docId: meta.id,
      chapter,
      ...selection,
      text: selection.text.trim(),
      note: '',
      page: p1 ? (p2 && p2 !== p1 ? `${p1}–${p2}` : p1) : undefined,
      createdAt: now,
      updatedAt: now,
    }
    await saveHighlight(h)
    window.getSelection()?.removeAllRanges()
    setSelection(null)
    if (withNote) setOpenHl(h)
  }

  const copySelection = async () => {
    if (!selection || !meta) return
    const p = chapterData?.pages?.[selection.startBlock]
    try {
      await navigator.clipboard.writeText(quoteLine(meta, { text: selection.text, page: p?.split('–')[0] } as Highlight))
      setNotice('Quote copied with its citation.')
    } catch {
      /* clipboard blocked */
    }
    window.getSelection()?.removeAllRanges()
    setSelection(null)
  }

  const blockStarts = useMemo(() => {
    const out: number[] = []
    let n = 0
    for (const t of chapterData?.blocks || []) {
      out.push(n)
      n += t.length
    }
    out.push(n)
    return out
  }, [chapterData])

  // ---------- Position saving ----------
  const persist = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      const m = metaRef.current
      const doc = contentRef.current
      if (!m || !doc) return
      lastOwnSave.current = Date.now()
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

  /** The sentence after (c, b, s), skipping empty paragraphs and crossing into the next section. */
  const nextPos = useCallback(
    (c: number, b: number, s: number): Pos | null => {
      const doc = contentRef.current
      if (!doc) return null
      const info = infoFor(c, b)
      if (info && s + 1 < info.sents.length) return { chapter: c, block: b, sent: s + 1 }
      let nc = c
      let nb = b + 1
      while (nc < doc.chapters.length) {
        while (nb < doc.chapters[nc].blocks.length) {
          if (infoFor(nc, nb)?.sents.length) return { chapter: nc, block: nb, sent: 0 }
          nb++
        }
        nc++
        nb = 0
      }
      return null
    },
    [infoFor],
  )

  const stopAt = (p: Pos, msg?: string) => {
    setPlayingState(false)
    pos.current = p
    lastWord.current = null
    setChapter(p.chapter)
    setHl({ ...p, word: -1 })
    persist()
    if (msg) setNotice(msg)
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
      lastSpoken.current = { chapter: c, block: b, sent: s }
      const start = fromOffset !== undefined && fromOffset > span.start && fromOffset < span.end ? fromOffset : span.start
      const st = settingsRef.current
      const spoken = speechText(doc.chapters[c].blocks[b].slice(start, span.end), st)
      lastWord.current = start
      setChapter((prev) => (prev === c ? prev : c))
      setHl({ chapter: c, block: b, sent: s, word: -1 })
      persist()
      if (!/[\p{L}\p{N}]/u.test(spoken.text)) {
        // Nothing left to say once citations are skipped.
        advance(c, b, s)
        return
      }
      const voice = pickVoice(info.lang, st.voices[info.lang])
      if (!voice && !warnedLangs.current.has(info.lang)) {
        warnedLangs.current.add(info.lang)
        setNotice(`This device has no ${LANG_NAMES[info.lang] || info.lang} voice installed, so it may be read in the wrong accent or skipped. See Settings for how to add one.`)
      }
      speaker.current.speak({
        text: spoken.text,
        lang: info.lang,
        voice,
        rate: rateFor(st, info.lang),
        onWord: (ws) => {
          const at = start + (spoken.map[ws] ?? ws)
          lastWord.current = at
          setHl({ chapter: c, block: b, sent: s, word: at })
        },
        onEnd: () => {
          lastWord.current = null
          if (playingRef.current) sentenceDone(c, b, s)
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
      const next = nextPos(c, b, s)
      if (!next) {
        setPlayingState(false)
        setHl((h) => ({ ...h, sent: -1, word: -1 }))
        setNotice('You’ve reached the end.')
        return
      }
      const sl = sleepRef.current
      if (sl.kind === 'section' && next.chapter !== sl.chapter) {
        setSleep({ kind: 'off' })
        return stopAt(next, 'Sleep timer: stopped at the end of the section.')
      }
      speakAt(next.chapter, next.block, next.sent)
    },
    [nextPos, speakAt],
  )

  /** What happens when a sentence finishes: repeat it, pause, stop for the sleep timer, or go on. */
  const sentenceDone = (c: number, b: number, s: number) => {
    const st = settingsRef.current
    if (st.afterSentence === 'repeat' && !repeated.current) {
      repeated.current = true
      speakAt(c, b, s)
      return
    }
    repeated.current = false
    const sl = sleepRef.current
    if (sl.kind === 'time' && Date.now() >= sl.until) {
      setSleep({ kind: 'off' })
      return stopAt(nextPos(c, b, s) || { chapter: c, block: b, sent: s }, 'Sleep timer: playback stopped.')
    }
    if (st.afterSentence === 'pause') {
      const next = nextPos(c, b, s)
      if (next) return stopAt(next)
    }
    advance(c, b, s)
  }

  const play = useCallback(() => {
    if (!speechSupported()) {
      setNotice('This browser can’t speak text aloud. Try Chrome, Edge or Safari.')
      return
    }
    setPlayingState(true)
    repeated.current = false
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

  const repeatSentence = useCallback(() => {
    lastWord.current = null
    repeated.current = true // don't double up when "repeat once" is on
    userScrolledAt.current = 0
    // While playing, replay the current sentence; when stopped, replay the one just heard.
    const p = (!playingRef.current && lastSpoken.current) || pos.current
    setPlayingState(true)
    speakAt(p.chapter, p.block, Math.max(0, p.sent))
  }, [speakAt])

  const step = useCallback(
    (dir: 1 | -1) => {
      const doc = contentRef.current
      if (!doc) return
      let { chapter: c, block: b, sent: s } = pos.current
      lastWord.current = null
      repeated.current = false
      if (dir === 1) {
        const next = nextPos(c, b, s)
        if (next) ({ chapter: c, block: b, sent: s } = next)
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
    [infoFor, nextPos, persist, speakAt],
  )

  const jumpTo = useCallback(
    (b: number, at?: number) => {
      const info = infoFor(chapter, b)
      if (!info?.sents.length) return
      const si = at === undefined ? 0 : Math.max(0, info.sents.findIndex((s) => at >= s.start && at < s.end))
      pos.current = { chapter, block: b, sent: si }
      lastWord.current = at ?? null
      repeated.current = false
      userScrolledAt.current = 0
      if (playingRef.current || at !== undefined) play()
      else {
        setHl({ chapter, block: b, sent: si, word: -1 })
        persist()
      }
    },
    [chapter, infoFor, persist, play],
  )

  // Restart the current sentence from the current word when speed, voice or speech rules change mid-playback.
  const restartKey = JSON.stringify([settings.rate, settings.rates, settings.voices, settings.skipCitations, settings.pronunciations])
  const firstRestart = useRef(true)
  useEffect(() => {
    if (firstRestart.current) {
      firstRestart.current = false
      return
    }
    if (playingRef.current) {
      const p = pos.current
      speakAt(p.chapter, p.block, p.sent, lastWord.current ?? undefined)
    }
  }, [restartKey, speakAt])

  // ---------- Sleep timer clock ----------
  useEffect(() => {
    if (sleep.kind !== 'time') return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [sleep.kind])

  // ---------- Auto-scroll and "Back to reading" ----------
  const activeEl = () => document.querySelector(`[data-sb="${hl.block}"][data-si="${hl.sent}"]`)
  const scrollToActive = (smooth = true) => {
    const el = activeEl()
    if (!el) return
    const r = el.getBoundingClientRect()
    window.scrollTo({ top: window.scrollY + r.top - window.innerHeight * 0.33, behavior: smooth ? 'smooth' : 'auto' })
  }

  useEffect(() => {
    if (hl.sent < 0 || hl.chapter !== chapter || !settings.autoScroll) return
    if (Date.now() - userScrolledAt.current < 5000) return
    const el = activeEl()
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.top < 90 || r.bottom > window.innerHeight - 190) scrollToActive()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hl.block, hl.sent, hl.chapter, chapter, settings.autoScroll])

  useEffect(() => {
    const check = () => {
      const el = hl.sent >= 0 && hl.chapter === chapter ? activeEl() : null
      if (!el) return setAway(hl.chapter !== chapter && hl.sent >= 0)
      const r = el.getBoundingClientRect()
      setAway(r.bottom < 70 || r.top > window.innerHeight - 170)
    }
    check()
    const mark = () => (userScrolledAt.current = Date.now())
    window.addEventListener('scroll', check, { passive: true })
    window.addEventListener('wheel', mark, { passive: true })
    window.addEventListener('touchmove', mark, { passive: true })
    return () => {
      window.removeEventListener('scroll', check)
      window.removeEventListener('wheel', mark)
      window.removeEventListener('touchmove', mark)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hl.block, hl.sent, hl.chapter, chapter])

  const backToReading = () => {
    userScrolledAt.current = 0
    if (hl.chapter !== chapter) {
      setChapter(hl.chapter)
      requestAnimationFrame(() => scrollToActive(false))
    } else scrollToActive()
  }

  // ---------- Reading on another device ----------
  useEffect(() => {
    const onSynced = async () => {
      const d = await getDoc(id)
      if (!d) return
      contentRef.current = d.content
      const p = d.meta.position
      const cur = pos.current
      if ((d.meta.positionAt ?? 0) > lastOwnSave.current + 500 && !playingRef.current && (p.chapter !== cur.chapter || Math.abs(p.block - cur.block) > 1)) {
        setElsewhere(p)
      }
    }
    window.addEventListener('qari:synced', onSynced)
    return () => window.removeEventListener('qari:synced', onSynced)
  }, [id])

  const goElsewhere = () => {
    if (!elsewhere) return
    const p = elsewhere
    setElsewhere(null)
    pos.current = { chapter: p.chapter, block: p.block, sent: 0 }
    lastWord.current = null
    setChapter(p.chapter)
    setHl({ chapter: p.chapter, block: p.block, sent: 0, word: -1 })
    requestAnimationFrame(() => {
      document.querySelector(`[data-block="${p.block}"]`)?.scrollIntoView({ block: 'center' })
    })
    persist()
  }

  // ---------- Keyboard & lock-screen controls ----------
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (picked || tocOpen || settingsOpen || sleepOpen) return
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return
      if (e.code === 'Space') {
        e.preventDefault()
        toggle()
      } else if (e.key === 'ArrowRight') step(1)
      else if (e.key === 'ArrowLeft') step(-1)
      else if (e.key === 'r') repeatSentence()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [toggle, step, repeatSentence, picked, tocOpen, settingsOpen, sleepOpen])

  useEffect(() => {
    if (!('mediaSession' in navigator) || !meta) return
    navigator.mediaSession.metadata = new MediaMetadata({ title: meta.title, artist: meta.author || 'Qari' })
    navigator.mediaSession.setActionHandler('play', play)
    navigator.mediaSession.setActionHandler('pause', pause)
    navigator.mediaSession.setActionHandler('nexttrack', () => step(1))
    navigator.mediaSession.setActionHandler('previoustrack', () => step(-1))
  }, [meta, play, pause, step])

  // ---------- Tap a word: once to look it up, twice to read from there ----------
  const onTextClick = (e: MouseEvent) => {
    const pg = (e.target as HTMLElement).closest('[data-page]') as HTMLElement | null
    if (pg && canShowOriginal) {
      setViewPage({ page: Number(pg.dataset.page), label: pg.dataset.label })
      return
    }
    const el = (e.target as HTMLElement).closest('.w') as HTMLElement | null
    if (!el || !content) return
    if (selection && e.detail < 2) return // finishing a text selection, not a tap
    const b = Number(el.dataset.b)
    const start = Number(el.dataset.s)
    const t = Date.now()
    const prev = lastTap.current
    if (prev && prev.b === b && prev.s === start && t - prev.t < 320) {
      if (tapTimer.current) clearTimeout(tapTimer.current)
      lastTap.current = null
      window.getSelection()?.removeAllRanges()
      jumpTo(b, start)
      return
    }
    lastTap.current = { b, s: start, t }
    if (tapTimer.current) clearTimeout(tapTimer.current)
    tapTimer.current = window.setTimeout(() => {
      const info = infoFor(chapter, b)
      if (!info) return
      if (playingRef.current) pause()
      const hid = el.dataset.h
      const h = hid ? highlights.find((x) => x.id === hid) : undefined
      if (h) {
        tappedWord.current = { b, start, end: Number(el.dataset.e) }
        setOpenHl(h)
        return
      }
      const text = content.chapters[chapter].blocks[b]
      const sent = info.sents.find((s) => start >= s.start && start < s.end) || { start: 0, end: text.length }
      setPicked({ word: text.slice(start, Number(el.dataset.e)), lang: info.lang, sentence: text.slice(sent.start, sent.end).trim(), block: b, start })
    }, 300)
  }

  const readFromHere = (p: Picked) => {
    setPicked(null)
    jumpTo(p.block, p.start)
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

  /** Moves the reading place to a spot (a search result or a highlight) and briefly flashes it. */
  const goTo = (c: number, b: number, start: number, end: number) => {
    pause()
    setTocOpen(false)
    setOpenHl(null)
    const info = infoFor(c, b)
    const si = Math.max(0, info?.sents.findIndex((s) => start >= s.start && start < s.end) ?? 0)
    lastWord.current = start
    pos.current = { chapter: c, block: b, sent: si }
    setChapter(c)
    setHl({ chapter: c, block: b, sent: si, word: -1 })
    setFlash({ chapter: c, block: b, start, end })
    userScrolledAt.current = Date.now() // don't let follow-along fight the jump
    persist()
    requestAnimationFrame(() =>
      requestAnimationFrame(() => document.querySelector(`[data-b="${b}"][data-s="${start}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })),
    )
    setTimeout(() => setFlash(null), 2400)
  }

  const openPanel = (t: PanelTab) => {
    setPanelTab(t)
    setTocOpen(true)
  }

  const onHit = (h: SearchHit) => goTo(h.chapter, h.block, h.start, h.end)
  const onPanelHighlight = (h: Highlight) => {
    goTo(h.chapter, h.startBlock, h.start, h.startBlock === h.endBlock ? h.end : h.start + 1)
    setOpenHl(null)
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

  // Progress and time left in this section, at the current speed.
  const curLang = (hl.chapter === chapter ? blockInfos[hl.block]?.lang : undefined) || meta.lang
  const curRate = rateFor(settings, curLang)
  const atBlock = hl.chapter === chapter ? hl.block : 0
  const atChar = blockStarts[atBlock] + (hl.chapter === chapter && hl.sent >= 0 ? (blockInfos[atBlock]?.sents[hl.sent]?.start ?? 0) : 0)
  const total = blockStarts[blockStarts.length - 1] || 1
  const fraction = Math.min(1, atChar / total)
  const secsLeft = (total - atChar) / ((CHARS_PER_SEC[meta.lang] || 14) * rateFor(settings, meta.lang))
  const sleepLabel =
    sleep.kind === 'time'
      ? (() => {
          const s = Math.max(0, Math.round((sleep.until - now) / 1000))
          return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
        })()
      : sleep.kind === 'section'
        ? 'End of section'
        : null

  const seek = (e: MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    const target = f * total
    let b = blockStarts.findIndex((n, i) => n <= target && blockStarts[i + 1] > target)
    if (b < 0) b = blockInfos.length - 1
    while (b < blockInfos.length - 1 && !blockInfos[b]?.sents.length) b++
    pos.current = { chapter, block: b, sent: 0 }
    lastWord.current = null
    userScrolledAt.current = 0
    if (playingRef.current) speakAt(chapter, b, 0)
    else {
      setHl({ chapter, block: b, sent: 0, word: -1 })
      persist()
      requestAnimationFrame(() => document.querySelector(`[data-block="${b}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }))
    }
  }

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-30 border-b border-line/70 bg-paper/90 pt-[env(safe-area-inset-top)] backdrop-blur">
        <div className="mx-auto flex h-14 max-w-3xl items-center gap-1 px-2">
          <IconButton icon="back" label="Library" onClick={() => go('')} />
          <button type="button" onClick={() => openPanel('contents')} className="min-w-0 flex-1 rounded-lg px-1 text-left">
            <div className="truncate text-[0.95rem] font-semibold" dir="auto">
              {meta.title}
            </div>
            <div className="truncate text-xs text-ink-3" dir="auto">
              {chapterData.title}
            </div>
          </button>
          <IconButton icon="search" label="Search this book" onClick={() => openPanel('search')} />
          <span className="relative">
            <IconButton icon="list" label={highlights.length ? `Contents and ${highlights.length} notes` : 'Contents and notes'} onClick={() => openPanel(highlights.length ? 'notes' : 'contents')} />
            {highlights.length > 0 && (
              <span className="pointer-events-none absolute top-1.5 right-1 min-w-4 rounded-full bg-mark px-1 text-center text-[0.65rem] leading-4 font-semibold text-ink">
                {highlights.length}
              </span>
            )}
          </span>
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

      {elsewhere && (
        <div className="mx-auto mt-3 flex max-w-[38rem] items-center gap-3 rounded-xl border border-moss/50 bg-wash px-4 py-3 text-sm" role="status">
          <span className="flex-1">You read further on another device{content.chapters[elsewhere.chapter] ? `, in “${content.chapters[elsewhere.chapter].title}”` : ''}.</span>
          <button type="button" className="shrink-0 font-semibold text-moss underline" onClick={goElsewhere}>
            Go there
          </button>
          <button type="button" className="shrink-0 text-ink-3" onClick={() => setElsewhere(null)} aria-label="Stay here">
            <Icon name="close" size={16} />
          </button>
        </div>
      )}

      <main
        className="prose-read mx-auto max-w-[38rem] px-5 pt-6 pb-56"
        style={{ fontSize: settings.fontSize }}
        onClick={onTextClick}
        onMouseDown={(e) => e.detail > 1 && e.preventDefault()} // a double-click reads from the word instead of selecting it
      >
        {chapterData.blocks.map((text, b) => {
          // A page marker where a new printed page starts (PDFs), so you can cite and check the original.
          const pi = chapterData.pageIdx?.[b]
          const newPage = pi !== undefined && (b === 0 || chapterData.pageIdx![b - 1] !== pi)
          const label = chapterData.pages?.[b]?.split('–')[0]
          return (
            <div key={b} className="relative">
              {newPage && label && (
                <div
                  className={`pg select-none ${canShowOriginal ? 'cursor-pointer' : ''}`}
                  data-page={pi}
                  data-label={label}
                  title={canShowOriginal ? 'Show the original page' : undefined}
                  aria-label={`Page ${label}`}
                >
                  <span>p. {label}</span>
                </div>
              )}
              <Block
                text={text}
                index={b}
                info={blockInfos[b]}
                heading={headingSet.has(b)}
                activeSent={hl.chapter === chapter && hl.block === b ? hl.sent : -1}
                activeWord={hl.chapter === chapter && hl.block === b ? hl.word : -1}
                pickedStart={picked && picked.block === b ? picked.start : -1}
                harakat={settings.showHarakat}
                marks={blockMarks[b]}
                flash={flash && flash.chapter === chapter && flash.block === b ? `${flash.start}:${flash.end}` : undefined}
              />
            </div>
          )
        })}
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
        {selection && (
          <div className="mb-2 flex justify-center">
            <div className="sheet-in flex items-center gap-1 rounded-full border border-line bg-paper p-1 shadow-[0_4px_18px_rgb(0_0_0/0.14)]" role="toolbar" aria-label="Selected text">
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => makeHighlight(false)}
                className="inline-flex h-9 items-center gap-1.5 rounded-full bg-mark px-3.5 text-sm font-semibold text-ink"
              >
                <Icon name="highlight" size={16} /> Highlight
              </button>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => makeHighlight(true)}
                className="inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-sm font-semibold hover:bg-paper-2"
              >
                <Icon name="note" size={16} /> Add note
              </button>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={copySelection}
                className="inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-sm hover:bg-paper-2"
              >
                <Icon name="paste" size={16} /> Copy quote
              </button>
            </div>
          </div>
        )}
        {away && !selection && (
          <div className="mb-2 flex justify-center">
            <button
              type="button"
              onClick={backToReading}
              className="sheet-in inline-flex h-9 items-center gap-1.5 rounded-full border border-line bg-paper px-4 text-sm font-semibold text-moss shadow-[0_4px_18px_rgb(0_0_0/0.10)]"
            >
              <Icon name="read" size={16} /> Back to reading
            </button>
          </div>
        )}
        <div className="mx-auto max-w-md rounded-[28px] border border-line bg-paper/95 px-2 pt-2 pb-1.5 shadow-[0_6px_30px_rgb(0_0_0/0.10)] backdrop-blur">
          <div className="flex items-center justify-between gap-3 px-3 text-xs text-ink-3">
            <span className="tabular-nums" aria-live="off">
              {fmtMinutes(secsLeft)} left in section
            </span>
            <button
              type="button"
              onClick={() => setSleepOpen(true)}
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 tabular-nums ${sleepLabel ? 'bg-wash font-semibold text-ink' : 'hover:bg-paper-2'}`}
              aria-label={sleepLabel ? `Sleep timer: ${sleepLabel}` : 'Sleep timer'}
            >
              <Icon name="moon" size={14} /> {sleepLabel || 'Sleep'}
            </button>
          </div>
          <div
            className="group mx-3 mt-1.5 mb-1 cursor-pointer py-1.5"
            onClick={seek}
            role="slider"
            aria-label="Position in section"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(fraction * 100)}
            tabIndex={-1}
          >
            <div className="h-1 overflow-hidden rounded-full bg-line group-hover:h-1.5">
              <div className="h-full rounded-full bg-moss" style={{ width: `${fraction * 100}%` }} />
            </div>
          </div>
          <div className="flex items-center justify-between gap-1">
            <button
              type="button"
              onClick={() => {
                const i = RATES.findIndex((r) => r >= curRate - 0.01)
                updateSettings({ rates: { ...settings.rates, [curLang]: RATES[(i + 1) % RATES.length] } })
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                setSettingsOpen(true)
              }}
              className="h-11 min-w-14 rounded-full px-2 text-sm font-semibold tabular-nums text-ink-2 hover:bg-paper-2"
              aria-label={`${LANG_NAMES[curLang] || curLang} speed ${fmtRate(curRate)}×, tap to change`}
            >
              {chapterLangs.length > 1 && <span className="mr-1 text-[0.7rem] font-semibold uppercase text-ink-3">{curLang}</span>}
              {fmtRate(curRate)}×
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
            <IconButton
              icon="repeat"
              label="Repeat this sentence"
              onClick={repeatSentence}
              className={settings.afterSentence !== 'continue' ? 'text-moss' : ''}
            />
          </div>
        </div>
      </div>

      <BookPanel
        open={tocOpen}
        tab={panelTab}
        onTab={setPanelTab}
        onClose={() => setTocOpen(false)}
        meta={meta}
        content={content}
        chapter={chapter}
        highlights={highlights}
        onChapter={goChapter}
        onHighlight={onPanelHighlight}
        onHit={onHit}
      />

      <Sheet open={sleepOpen} onClose={() => setSleepOpen(false)} title="Sleep timer">
        <div className="grid grid-cols-2 gap-2 pb-2">
          {[15, 30, 45, 60].map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setSleep({ kind: 'time', until: Date.now() + m * 60000 })
                setNow(Date.now())
                setSleepOpen(false)
              }}
              className="h-12 rounded-xl border border-line hover:bg-paper-2"
            >
              {m} minutes
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setSleep({ kind: 'section', chapter: hl.chapter })
              setSleepOpen(false)
            }}
            className={`h-12 rounded-xl border hover:bg-paper-2 ${sleep.kind === 'section' ? 'border-moss bg-wash font-semibold' : 'border-line'}`}
          >
            End of section
          </button>
          <button
            type="button"
            onClick={() => {
              setSleep({ kind: 'off' })
              setSleepOpen(false)
            }}
            className={`h-12 rounded-xl border hover:bg-paper-2 ${sleep.kind === 'off' ? 'border-moss bg-wash font-semibold' : 'border-line'}`}
          >
            Off
          </button>
        </div>
        <p className="pb-2 text-sm text-ink-3">Playback stops at the end of the sentence when the time is up.</p>
      </Sheet>

      <Sheet open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Reading settings" wide>
        <section className="mb-6">
          <h3 className="mb-1 font-semibold">Speed</h3>
          <p className="mb-3 text-sm text-ink-3">Each language keeps its own speed.</p>
          {chapterLangs.map((lang) => {
            const r = rateFor(settings, lang)
            return (
              <div key={lang} className="mb-3">
                <div className="mb-1 flex items-baseline justify-between text-sm">
                  <label htmlFor={'r-' + lang} className="text-ink-2">
                    {LANG_NAMES[lang] || lang}
                  </label>
                  <span className="tabular-nums text-ink-2">{r.toFixed(2)}×</span>
                </div>
                <input
                  id={'r-' + lang}
                  type="range"
                  min={0.5}
                  max={3}
                  step={0.05}
                  value={r}
                  onChange={(e) => updateSettings({ rates: { ...settings.rates, [lang]: Number(e.target.value) } })}
                  className="w-full"
                />
              </div>
            )
          })}
          <p className="text-xs text-ink-3">Some device voices top out around 2×; going higher won’t speed them up further.</p>
        </section>

        <section className="mb-6">
          <h3 className="mb-1 font-semibold">After each sentence</h3>
          <p className="mb-2 text-sm text-ink-3">For listening practice and shadowing. The repeat button replays a sentence any time.</p>
          <div className="grid grid-cols-3 gap-2">
            {(
              [
                ['continue', 'Keep going'],
                ['pause', 'Pause'],
                ['repeat', 'Repeat once'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => updateSettings({ afterSentence: k })}
                className={`h-11 rounded-xl border text-sm ${settings.afterSentence === k ? 'border-moss bg-wash font-semibold' : 'border-line'}`}
              >
                {label}
              </button>
            ))}
          </div>
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
                  <div className="flex gap-2">
                    <select
                      id={'v-' + lang}
                      value={chosen?.voiceURI}
                      onChange={(e) => updateSettings({ voices: { ...settings.voices, [lang]: e.target.value } })}
                      className="h-11 min-w-0 flex-1 rounded-xl border border-line bg-paper-2 px-3"
                    >
                      {list.map((v) => (
                        <option key={v.voiceURI} value={v.voiceURI}>
                          {v.name} ({v.lang}){v.localService ? '' : ' · online'}
                        </option>
                      ))}
                    </select>
                    <IconButton icon="speaker" label={`Hear the ${LANG_NAMES[lang] || lang} voice`} onClick={() => speakWord(SAMPLES[lang] || SAMPLES.en, lang, chosen?.voiceURI, rateFor(settings, lang))} className="border border-line" />
                  </div>
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

        <Toggle
          checked={settings.skipCitations}
          onChange={(v) => updateSettings({ skipCitations: v })}
          title="Skip citations and links"
          hint="Don’t read “(Smith, 2019)”, “[12]” or web addresses aloud. They stay on the page."
        />

        <section className="mb-6">
          <h3 className="mb-1 font-semibold">Pronunciations</h3>
          <p className="mb-2 text-sm text-ink-3">Teach the voice names and terms it gets wrong. Applies to every book.</p>
          {settings.pronunciations.length > 0 && (
            <ul className="mb-2 divide-y divide-line rounded-xl border border-line">
              {settings.pronunciations.map((p, i) => (
                <li key={i} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                  <span className="min-w-0 flex-1 truncate" dir="auto">
                    <span className="font-semibold">{p.from}</span> <span className="text-ink-3">says</span> {p.to}
                  </span>
                  <IconButton icon="speaker" label={`Hear ${p.from}`} size={17} onClick={() => speakWord(p.to, meta.lang, settings.voices[meta.lang])} />
                  <IconButton
                    icon="trash"
                    label={`Remove ${p.from}`}
                    size={17}
                    onClick={() => updateSettings({ pronunciations: settings.pronunciations.filter((_, j) => j !== i) })}
                  />
                </li>
              ))}
            </ul>
          )}
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (!newFrom.trim() || !newTo.trim()) return
              updateSettings({ pronunciations: [...settings.pronunciations, { from: newFrom.trim(), to: newTo.trim() }] })
              setNewFrom('')
              setNewTo('')
            }}
          >
            <input value={newFrom} onChange={(e) => setNewFrom(e.target.value)} placeholder="Word" dir="auto" aria-label="Word as written" className="h-11 min-w-0 flex-1 rounded-xl border border-line bg-paper-2 px-3" />
            <input value={newTo} onChange={(e) => setNewTo(e.target.value)} placeholder="Say it as" dir="auto" aria-label="Say it as" className="h-11 min-w-0 flex-1 rounded-xl border border-line bg-paper-2 px-3" />
            <button type="submit" disabled={!newFrom.trim() || !newTo.trim()} className="h-11 rounded-xl bg-moss px-4 font-semibold text-moss-ink disabled:opacity-40">
              Add
            </button>
          </form>
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
          <h3 className="mb-2 font-semibold">Arabic</h3>
          <div className="mb-4 grid grid-cols-3 gap-2">
            {(Object.entries(ARABIC_FONTS) as [ArabicFont, (typeof ARABIC_FONTS)[ArabicFont]][]).map(([k, f]) => (
              <button
                key={k}
                type="button"
                onClick={() => updateSettings({ arabicFont: k })}
                aria-label={f.label}
                className={`flex flex-col items-center rounded-xl border px-1 py-2 ${settings.arabicFont === k ? 'border-moss bg-wash' : 'border-line'}`}
              >
                <span lang="ar" dir="rtl" className="text-xl leading-tight" style={{ fontFamily: f.family }}>
                  {settings.showHarakat ? 'ثَبَتَ تُجّار' : 'ثبت تجار'}
                </span>
                <span className={`mt-1 text-xs ${settings.arabicFont === k ? 'font-semibold' : 'text-ink-2'}`}>{f.label}</span>
              </button>
            ))}
          </div>
          <Toggle
            checked={settings.showHarakat}
            onChange={(v) => updateSettings({ showHarakat: v })}
            title="Show vowel marks"
            hint={hasArabic ? 'Turn off to practise reading unvoweled text. The voice still reads it fully voweled.' : 'Applies to Arabic text.'}
          />
        </section>

        <Toggle
          checked={settings.autoScroll}
          onChange={(v) => updateSettings({ autoScroll: v })}
          title="Follow along"
          hint="Scroll to keep the spoken sentence in view."
        />
        <p className="pb-2 text-xs text-ink-3">Tip: tap a word to look it up, double-tap it to start reading from there.</p>
      </Sheet>

      <LookupSheet
        picked={picked}
        source={meta.title}
        voiceURI={picked ? settings.voices[picked.lang] : undefined}
        onClose={() => setPicked(null)}
        onReadFromHere={readFromHere}
      />

      <HighlightSheet
        highlight={openHl}
        meta={meta}
        onClose={() => setOpenHl(null)}
        canShowPage={canShowOriginal && chapterData.pageIdx !== undefined}
        onShowPage={() => {
          const h = openHl
          if (!h) return
          setOpenHl(null)
          setViewPage({ page: content.chapters[h.chapter]?.pageIdx?.[h.startBlock] ?? 0, label: h.page?.split('–')[0] })
        }}
        onLookUp={() => {
          const h = openHl
          if (!h) return
          setOpenHl(null)
          // The word that was tapped to open this highlight, or else its first word.
          const t = tappedWord.current
          const b = t && t.b >= h.startBlock && t.b <= h.endBlock ? t.b : h.startBlock
          const info = infoFor(h.chapter, b)
          const text = content.chapters[h.chapter].blocks[b]
          const w = (t && t.b === b ? t : null) || info?.words.find((x) => x.start >= h.start) || { start: h.start, end: h.start + 1 }
          const sent = info?.sents.find((s) => w.start >= s.start && w.start < s.end) || { start: 0, end: text.length }
          setPicked({ word: text.slice(w.start, w.end), lang: info?.lang || meta.lang, sentence: text.slice(sent.start, sent.end).trim(), block: b, start: w.start })
        }}
      />

      {viewPage && <PageViewer docId={meta.id} page={viewPage.page} label={viewPage.label} onClose={() => setViewPage(null)} />}
    </div>
  )
}

