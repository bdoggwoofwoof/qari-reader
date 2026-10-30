import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { go } from '../App'
import { getDoc, getFile, listHighlights, onLocalChange, savePosition, saveHighlight, updateDocMeta } from '../lib/db'
import { quoteLine } from '../lib/quotes'
import { mapPosition } from '../lib/remap'
import { getSyncCode } from '../lib/sync'
import type { SearchHit } from '../lib/search'
import BookPanel, { type PanelTab } from './BookPanel'
import HighlightSheet from './HighlightSheet'
import PageViewer from './PageViewer'
import SpeedReader from './SpeedReader'
import { detectLang, isMostlyArabic, sentences, stripArabicMarks, words, type Span } from '../lib/lang'
import { rateFor, useSettings } from '../lib/settings'
import { speechText } from '../lib/speechText'
import { CHARS_PER_SEC, getVoices, SAMPLES, onlyBasic, onVoicesChanged, pickVoice, primeAudio, Speaker, speechSupported, speakWord } from '../lib/tts'
import { ARABIC_FONTS, LANG_NAMES, READ_FONTS, RTL_LANGS, type ArabicFont, type ReadFont, type DocContent, type DocMeta, type Highlight, type Lang } from '../types'
import LookupSheet, { type Picked } from './LookupSheet'
import { claudeStatus } from '../lib/translate'
import { engineVoiceFor, isEngineVoice, usable, useVoiceState } from '../lib/voices'
import VoicePicker, { voiceLabel } from './VoicePicker'
import { countNew, isKnown, isLearning, isTrackable, setKnown, useVocab, vocabKey } from '../lib/vocab'
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

type WakeSentinel = {
  release: () => Promise<void>
  addEventListener: (t: 'release', f: () => void) => void
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
  vocab,
  bionic,
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
  vocab?: Map<number, 'new' | 'learning'> // word start → status, in languages you're learning
  bionic?: boolean
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
        inner.push(
          inMark ? (
            <span key={'g' + c} className="hl">
              {gap}
            </span>
          ) : (
            gap
          ),
        )
      }
      const m = marks?.find((k) => w.start < k.end && w.end > k.start)
      const last = m && !info.words.some((x) => x.start > w.start && x.start < m.end)
      const cls =
        `w${w.start === activeWord && si === activeSent ? ' now' : ''}${w.start === pickedStart ? ' picked' : ''}` +
        `${m ? ' hl' : ''}${m && last && m.note ? ' hl-note' : ''}${w.start < fe && w.end > fs ? ' flash' : ''}` +
        `${vocab?.get(w.start) === 'new' ? ' nw' : vocab?.get(w.start) === 'learning' ? ' lw' : ''}`
      inner.push(
        <span key={w.start} className={cls} data-b={index} data-s={w.start} data-e={w.end} data-h={m?.id}>
          {bionic && !rtl ? bionicWord(text.slice(w.start, w.end)) : show(text.slice(w.start, w.end))}
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

/** Bionic reading: bold roughly the first half of a word (fewer letters in long words), so the eye lands on it and the brain fills in the rest. */
function bionicWord(word: string): React.ReactNode {
  const letters = [...word]
  const n = letters.filter((ch) => /\p{L}/u.test(ch)).length
  if (!n) return word
  const bold = n <= 3 ? 1 : n <= 5 ? 2 : Math.ceil(n * 0.42)
  let seen = 0
  let cut = 0
  while (cut < letters.length && seen < bold) {
    if (/\p{L}/u.test(letters[cut])) seen++
    cut++
  }
  // Keep accents and other combining marks with their letter.
  while (cut < letters.length && /\p{M}/u.test(letters[cut])) cut++
  return (
    <>
      <b className="bio">{letters.slice(0, cut).join('')}</b>
      {letters.slice(cut).join('')}
    </>
  )
}

/** A skip button: tap for a sentence, hold for a paragraph. */
function HoldButton({ icon, label, onTap, onHold }: { icon: string; label: string; onTap: () => void; onHold: () => void }) {
  const timer = useRef<number | null>(null)
  const held = useRef(false)
  const clear = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onPointerDown={() => {
        held.current = false
        clear()
        timer.current = window.setTimeout(() => {
          held.current = true
          navigator.vibrate?.(15)
          onHold()
        }, 450)
      }}
      onPointerUp={clear}
      onPointerLeave={clear}
      onPointerCancel={clear}
      onContextMenu={(e) => e.preventDefault()}
      onClick={() => {
        if (held.current) held.current = false
        else onTap()
      }}
      className="inline-flex h-11 w-11 shrink-0 touch-none select-none items-center justify-center rounded-full text-ink-2 [-webkit-touch-callout:none] hover:bg-paper-2 hover:text-ink"
    >
      <Icon name={icon} size={20} />
    </button>
  )
}

/**
 * Line focus: a clear band over the line being read, with the rest of the page dimmed.
 * Moves itself (no re-render) as the voice goes, the page scrolls or the window resizes.
 */
function LineFocus({ on }: { on: boolean }) {
  const band = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!on) return
    let frame = 0
    let last = ''
    const place = () => {
      const el = band.current
      const main = document.querySelector('main.prose-read')
      const target = (document.querySelector('main.prose-read .w.now') || document.querySelector('main.prose-read .s.on .w')) as HTMLElement | null
      if (el && main && target) {
        const m = main.getBoundingClientRect()
        // The word's first line box: a word that wraps uses its first line.
        const r = target.getClientRects()[0] || target.getBoundingClientRect()
        const pad = Math.max(4, r.height * 0.18)
        const key = `${Math.round(r.top)}:${Math.round(r.height)}:${Math.round(m.left)}:${Math.round(m.width)}`
        if (key !== last) {
          last = key
          el.style.opacity = '1'
          el.style.transform = `translateY(${r.top - pad}px)`
          el.style.height = `${r.height + pad * 2}px`
          el.style.left = `${m.left + 8}px`
          el.style.width = `${m.width - 16}px`
        }
      } else if (el && !target) {
        el.style.opacity = '0'
        last = ''
      }
      frame = requestAnimationFrame(place)
    }
    frame = requestAnimationFrame(place)
    return () => cancelAnimationFrame(frame)
  }, [on])
  if (!on) return null
  return (
    <div
      ref={band}
      aria-hidden="true"
      className="pointer-events-none fixed top-0 z-20 rounded-lg opacity-0 transition-[transform,height] duration-200 ease-out"
      style={{ boxShadow: '0 0 0 200vmax color-mix(in srgb, var(--paper) 72%, transparent)' }}
    />
  )
}

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
  const [hl, setHl] = useState<Spot>({
    chapter: 0,
    block: 0,
    sent: -1,
    word: -1,
  })
  const [highlights, setHighlights] = useState<Highlight[]>([])
  const [openHl, setOpenHl] = useState<Highlight | null>(null)
  const [selection, setSelection] = useState<{
    startBlock: number
    start: number
    endBlock: number
    end: number
    text: string
  } | null>(null)
  const [panelTab, setPanelTab] = useState<PanelTab>('contents')
  const [flash, setFlash] = useState<{
    chapter: number
    block: number
    start: number
    end: number
  } | null>(null)
  const [viewPage, setViewPage] = useState<{
    page: number
    label?: string
  } | null>(null)
  const [hasOriginal, setHasOriginal] = useState(false)
  const [claudeAvail, setClaudeAvail] = useState(false)
  // The original PDF is here, or can come from sync when a page is opened.
  const canShowOriginal = !!meta && meta.kind === 'pdf' && (hasOriginal || !!getSyncCode())
  const [playing, setPlaying] = useState(false)
  const [picked, setPicked] = useState<Picked | null>(null)
  const [tocOpen, setTocOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sleepOpen, setSleepOpen] = useState(false)
  const [speedOpen, setSpeedOpen] = useState(false)
  const [rsvp, setRsvp] = useState<{
    chapter: number
    block: number
    offset: number
  } | null>(null)
  const [rsvpSeek, setRsvpSeek] = useState<{
    chapter: number
    block: number
    start: number
    n: number
  } | null>(null)
  const rsvpLookupChapter = useRef(0)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerLang, setPickerLang] = useState<Lang>('en')
  useVoiceState() // re-render when a voice finishes downloading
  const [sleep, setSleepState] = useState<Sleep>({ kind: 'off' })
  const [now, setNow] = useState(Date.now())
  const [away, setAway] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [voicesVersion, setVoicesVersion] = useState(0)
  const [newFrom, setNewFrom] = useState('')
  const [newTo, setNewTo] = useState('')
  const [settings, updateSettings] = useSettings()

  const speaker = useRef(new Speaker())
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
  const markAt = useRef(0) // when the placemark last moved
  const handScrolledAt = useRef(0) // when you last scrolled by hand
  const chapterRef = useRef(0)
  // Placemark following your scrolling: not asked yet, asking, yes, or no (for this visit to the book).
  const [follow, setFollowState] = useState<'unknown' | 'asking' | 'on' | 'off'>('unknown')
  const followRef = useRef(follow)
  const setFollow = (f: typeof follow) => {
    followRef.current = f
    setFollowState(f)
  }
  chapterRef.current = chapter
  const lastTap = useRef<{ b: number; s: number; t: number } | null>(null)
  const tappedWord = useRef<{ b: number; start: number; end: number } | null>(null)
  const wakeLock = useRef<WakeSentinel | null>(null)
  const warnedLangs = useRef(new Set<string>())
  const lastOwnSave = useRef(0) // when this device last moved the reading position
  const resumeAfterLookup = useRef(false) // a word was tapped mid-playback: carry on when the lookup closes
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
      // Resume at the saved sentence, not just the top of its paragraph.
      metaRef.current = d.meta
      contentRef.current = d.content
      const sents = infoFor(ch, p.block)?.sents || []
      const si =
        p.offset > 0
          ? Math.max(
              0,
              sents.findIndex((s) => p.offset >= s.start && p.offset < s.end),
            )
          : 0
      setChapter(ch)
      pos.current = { chapter: ch, block: p.block, sent: si }
      // Saved mid-sentence (a tapped word, or where the speed reader stopped): start again from that word.
      lastWord.current = sents[si] && p.offset > sents[si].start ? p.offset : null
      // Show the placemark, unless the book has never been read.
      const fresh = ch === 0 && p.block === 0 && p.offset === 0 && !(d.meta.progress ?? 0)
      setHl({ chapter: ch, block: p.block, sent: fresh ? -1 : si, word: -1 })
      updateDocMeta(id, { openedAt: Date.now() }, 'opened')
      requestAnimationFrame(() => {
        const el = (si > 0 && document.querySelector(`[data-sb="${p.block}"][data-si="${si}"]`)) || document.querySelector(`[data-block="${p.block}"]`)
        el?.scrollIntoView({ block: 'start' })
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
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps -- infoFor is stable

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

  useEffect(() => {
    if (settingsOpen) claudeStatus().then((s) => setClaudeAvail(s.available))
  }, [settingsOpen])

  // ---------- New words (languages you're learning) ----------
  const learningLangs = useMemo(() => chapterLangs.filter((l) => settings.learning.includes(l)), [chapterLangs, settings.learning])
  const vocabVersion = useVocab(learningLangs)
  const blockVocab = useMemo(() => {
    void vocabVersion
    return blockInfos.map((info, b) => {
      if (!info || !settings.learning.includes(info.lang)) return undefined
      const text = chapterData!.blocks[b]
      const m = new Map<number, 'new' | 'learning'>()
      for (const w of info.words) {
        const word = text.slice(w.start, w.end)
        if (!isTrackable(word)) continue
        const k = vocabKey(word, info.lang)
        if (isLearning(info.lang, k)) m.set(w.start, 'learning')
        else if (!isKnown(info.lang, k)) m.set(w.start, 'new')
      }
      return m
    })
  }, [blockInfos, chapterData, settings.learning, vocabVersion])
  const sectionNew = useMemo(() => {
    const byLang = new Map<string, Set<string>>()
    blockVocab.forEach((m, b) => {
      if (!m) return
      const info = blockInfos[b]
      for (const [start, st] of m) {
        if (st !== 'new') continue
        const w = info.words.find((x) => x.start === start)!
        let set = byLang.get(info.lang)
        if (!set) byLang.set(info.lang, (set = new Set()))
        set.add(vocabKey(chapterData!.blocks[b].slice(w.start, w.end), info.lang))
      }
    })
    return byLang
  }, [blockVocab, blockInfos, chapterData])
  const sectionNewCount = [...sectionNew.values()].reduce((n, s) => n + s.size, 0)
  const markSectionKnown = async () => {
    for (const [lang, set] of sectionNew) await setKnown(lang, [...set])
  }

  // New-word count for the whole book, shown in the library.
  // Counting a whole book takes a moment on a phone, so it waits until reading is idle (and runs when you leave).
  const pendingCount = useRef<(() => void) | null>(null)
  useEffect(() => {
    if (!meta || !content || !settings.learning.includes(meta.lang)) return
    const run = () => {
      if (pendingCount.current !== run) return
      pendingCount.current = null
      const texts = content.chapters.flatMap((c) => c.blocks)
      const { unique, fresh } = countNew(texts, meta.lang, (s) => words(s, meta.lang))
      updateDocMeta(meta.id, { vocab: { unique, fresh, at: Date.now() } }, 'opened')
    }
    pendingCount.current = run
    const t = window.setTimeout(() => {
      if (!playingRef.current) run()
    }, 4000)
    return () => clearTimeout(t)
  }, [meta?.id, meta?.lang, content, settings.learning, vocabVersion]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => pendingCount.current?.(), [])

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
        ;(out[b] ||= []).push({
          id: h.id,
          start: b === h.startBlock ? h.start : 0,
          end: b === h.endBlock ? h.end : len,
          note: !!h.note.trim(),
        })
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
        startBlock === endBlock ? blocks[startBlock].slice(start, end) : [blocks[startBlock].slice(start), ...blocks.slice(startBlock + 1, endBlock), blocks[endBlock].slice(0, end)].join('\n\n')
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

  /** Several selected words: look them up (and translate them) as one phrase. */
  const lookUpSelection = () => {
    if (!selection || !content) return
    const b = selection.startBlock
    const info = infoFor(chapter, b)
    const text = content.chapters[chapter].blocks[b]
    if (!info) return
    resumeAfterLookup.current = playingRef.current
    if (playingRef.current) pause()
    const s1 = info.sents.find((s) => selection.start >= s.start && selection.start < s.end) || { start: 0, end: text.length }
    const s2 = info.sents.find((s) => selection.end > s.start && selection.end <= s.end) || s1
    window.getSelection()?.removeAllRanges()
    setSelection(null)
    setPicked({
      word: selection.text.trim(),
      lang: info.lang,
      sentence: text.slice(s1.start, s2.end).trim(),
      block: b,
      start: selection.start,
    })
  }

  const copySelection = async () => {
    if (!selection || !meta) return
    const p = chapterData?.pages?.[selection.startBlock]
    try {
      await navigator.clipboard.writeText(
        quoteLine(meta, {
          text: selection.text,
          page: p?.split('–')[0],
        } as Highlight),
      )
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
  const writePosition = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = null
    const m = metaRef.current
    const doc = contentRef.current
    if (!m || !doc) return
    lastOwnSave.current = Date.now()
    const { chapter: c, block: b, sent: s } = pos.current
    // The exact word when there is one (a tap, the speed reader, a pause mid-sentence), else the sentence.
    const sent = infoFor(c, b)?.sents[s]
    const lw = lastWord.current
    const offset = sent && lw !== null && lw >= sent.start && lw < sent.end ? lw : (sent?.start ?? 0)
    const inChapter = doc.chapters[c].blocks.slice(0, b).reduce((n, t) => n + t.length, 0) + offset
    const progress = m.charCount ? Math.min(1, ((m.charsBefore[c] ?? 0) + inChapter) / m.charCount) : 0
    savePosition(m.id, { chapter: c, block: b, offset }, progress)
  }, [infoFor])

  const persist = useCallback(() => {
    markAt.current = Date.now()
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(writePosition, 800)
  }, [writePosition])

  /**
   * Reading by scrolling (no voice), once you've said yes to "follow along": the placemark moves to the first
   * sentence at the top of the screen. Scrolling ahead to look for something never moves it unless you said yes.
   */
  const placeFromScroll = useCallback(() => {
    if (followRef.current !== 'on' || playingRef.current || handScrolledAt.current <= markAt.current) return false
    const headerBottom = document.querySelector('header')?.getBoundingClientRect().bottom ?? 0
    const first = [...document.querySelectorAll<HTMLElement>('main.prose-read [data-sb]')].find((el) => el.getBoundingClientRect().bottom > headerBottom + 8)
    if (!first) return false
    const info = infoFor(chapterRef.current, Number(first.dataset.sb))
    const si = Number(first.dataset.si)
    if (!info?.sents[si]) return false
    pos.current = { chapter: chapterRef.current, block: Number(first.dataset.sb), sent: si }
    lastWord.current = null
    markAt.current = Date.now()
    return true
  }, [infoFor])

  // Leaving the book (back to the library) right after scrolling: place the mark before the page goes away.
  useLayoutEffect(() => () => void (placeFromScroll() && writePosition()), [placeFromScroll, writePosition])

  // Closing the tab or switching apps inside the save delay: write the place now.
  useEffect(() => {
    const flush = () => (placeFromScroll() || saveTimer.current) && writePosition()
    const onHide = () => document.visibilityState === 'hidden' && flush()
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onHide)
      flush()
    }
  }, [writePosition, placeFromScroll])

  // ---------- Playback ----------
  /** Keeps the screen on while reading (iPhone stops speech when it locks). The browser drops the lock when the app is hidden. */
  const keepAwake = () => {
    if (!('wakeLock' in navigator) || wakeLock.current) return
    ;(
      navigator as unknown as {
        wakeLock: { request: (t: string) => Promise<WakeSentinel> }
      }
    ).wakeLock
      .request('screen')
      .then((l) => {
        if (!playingRef.current) return void l.release().catch(() => {})
        wakeLock.current = l
        l.addEventListener('release', () => {
          if (wakeLock.current === l) wakeLock.current = null
        })
      })
      .catch(() => {})
  }

  const setPlayingState = (v: boolean) => {
    playingRef.current = v
    setPlaying(v)
    if (v) keepAwake()
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
      const voiceId = engineVoiceFor(info.lang)
      if (!voice && !voiceId && !warnedLangs.current.has(info.lang)) {
        warnedLangs.current.add(info.lang)
        setNotice(`This device has no ${LANG_NAMES[info.lang] || info.lang} voice installed, so it may be read in the wrong accent or skipped. See Settings for how to add one.`)
      }
      if (voiceId) {
        // Get the next two sentences' audio ready while this one plays.
        let p: Pos | null = { chapter: c, block: b, sent: s }
        for (let k = 0; k < 2 && p; k++) {
          p = nextPos(p.chapter, p.block, p.sent)
          const ni = p && infoFor(p.chapter, p.block)
          const ns = p && ni?.sents[p.sent]
          if (!p || !ni || !ns || ni.lang !== info.lang) break
          const t = speechText(doc.chapters[p.chapter].blocks[p.block].slice(ns.start, ns.end), st).text
          if (/[\p{L}\p{N}]/u.test(t)) speaker.current.prefetch(voiceId, t)
        }
      }
      speaker.current.speak({
        text: spoken.text,
        lang: info.lang,
        voice,
        voiceId,
        onFallback: (msg) => {
          if (warnedLangs.current.has('fallback:' + info.lang)) return
          warnedLangs.current.add('fallback:' + info.lang)
          setNotice(`${msg} Reading with this device’s voice for now.`)
        },
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
    [infoFor, persist, nextPos],
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
      if (sl.kind === 'section' && next.chapter !== c) {
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
    primeAudio() // must happen in the tap itself, or iPhone won't play the voice's audio
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

  // Back from another app while reading: take the screen lock again, and wake the voice if the browser paused it.
  useEffect(() => {
    const onShow = () => {
      if (document.visibilityState !== 'visible' || !playingRef.current) return
      keepAwake()
      if (speechSynthesis.paused) speechSynthesis.resume()
      window.setTimeout(() => {
        if (playingRef.current && !speaker.current.busy() && !speechSynthesis.speaking && !speechSynthesis.pending) {
          const p = pos.current
          speakAt(p.chapter, p.block, p.sent, lastWord.current ?? undefined)
        }
      }, 400)
    }
    document.addEventListener('visibilitychange', onShow)
    return () => document.removeEventListener('visibilitychange', onShow)
  }, [speakAt]) // eslint-disable-line react-hooks/exhaustive-deps

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

  // ---------- A long PDF that opened with its first pages ----------
  const [importP, setImportP] = useState<number | null>(null)
  useEffect(() => {
    const onProgress = (e: Event) => {
      const d = (e as CustomEvent<{ id: string; p: number }>).detail
      if (d.id === id) setImportP(d.p)
    }
    const onReady = async (e: Event) => {
      if ((e as CustomEvent<string>).detail !== id) return
      const d = await getDoc(id)
      const old = contentRef.current
      if (!d || !old) return
      setImportP(null)
      // Keep your place: find the same words in the complete book.
      const { chapter: c, block: b, sent: s } = pos.current
      const sentStart = infoFor(c, b)?.sents[s]?.start ?? 0
      const at = mapPosition(old, d.content, { chapter: c, block: b, offset: lastWord.current ?? sentStart })
      infoCache.current.clear()
      contentRef.current = d.content
      metaRef.current = d.meta
      setContent(d.content)
      setMeta(d.meta)
      const info = infoFor(at.chapter, at.block)
      const si = Math.max(0, info?.sents.findIndex((x) => at.offset >= x.start && at.offset < x.end) ?? 0)
      pos.current = { chapter: at.chapter, block: at.block, sent: si }
      lastWord.current = at.offset > (info?.sents[si]?.start ?? 0) ? at.offset : null
      if (playingRef.current) speakAt(at.chapter, at.block, si, lastWord.current ?? undefined)
      else {
        setChapter(at.chapter)
        setHl((h) => (h.sent < 0 ? h : { chapter: at.chapter, block: at.block, sent: si, word: -1 }))
      }
      if (d.meta.importFailed) setNotice('Qari couldn’t read the rest of this PDF. The pages read so far are here; try adding it again.')
    }
    window.addEventListener('qari:importprogress', onProgress)
    window.addEventListener('qari:docready', onReady)
    return () => {
      window.removeEventListener('qari:importprogress', onProgress)
      window.removeEventListener('qari:docready', onReady)
    }
  }, [id, infoFor, speakAt])

  /** Hold the skip buttons (or Shift+arrow): a whole paragraph forward, or back to this paragraph's start, then the one before. */
  const stepParagraph = useCallback(
    (dir: 1 | -1) => {
      const doc = contentRef.current
      if (!doc) return
      let { chapter: c, block: b, sent: s } = pos.current
      const has = (cc: number, bb: number) => (infoFor(cc, bb)?.sents.length ?? 0) > 0
      if (dir === 1) {
        let nc = c
        let nb = b + 1
        while (nc < doc.chapters.length && !(nb < doc.chapters[nc].blocks.length && has(nc, nb))) {
          if (nb < doc.chapters[nc].blocks.length) nb++
          else {
            nc++
            nb = 0
          }
        }
        if (nc >= doc.chapters.length) return
        c = nc
        b = nb
        s = 0
      } else if (s > 0 || lastWord.current !== null) s = 0
      else {
        let pc = c
        let pb = b - 1
        while (pc >= 0 && !(pb >= 0 && has(pc, pb))) {
          if (pb >= 0) pb--
          else if (--pc >= 0) pb = doc.chapters[pc].blocks.length - 1
        }
        if (pc < 0) return
        c = pc
        b = pb
        s = 0
      }
      lastWord.current = null
      repeated.current = false
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

  const jumpTo = useCallback(
    (b: number, at?: number) => {
      const info = infoFor(chapter, b)
      if (!info?.sents.length) return
      const si =
        at === undefined
          ? 0
          : Math.max(
              0,
              info.sents.findIndex((s) => at >= s.start && at < s.end),
            )
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
    // Wait for the change to settle: dragging the speed slider shouldn't restart the voice at every step.
    const t = window.setTimeout(() => {
      if (!playingRef.current) return
      const p = pos.current
      speakAt(p.chapter, p.block, p.sent, lastWord.current ?? undefined)
    }, 350)
    return () => clearTimeout(t)
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
    window.scrollTo({
      top: window.scrollY + r.top - window.innerHeight * 0.33,
      behavior: smooth ? 'smooth' : 'auto',
    })
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
    const mark = () => (userScrolledAt.current = handScrolledAt.current = Date.now())
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

  // ---------- Reading by scrolling ----------
  // Steady, slow scrolling over a couple of paragraphs looks like reading: ask once whether the placemark should follow.
  // Fast flicks (looking for something, checking where the section ends) never ask and never move it.
  useEffect(() => {
    if (!chapterData || follow === 'off' || follow === 'asking') return
    const before: number[] = []
    chapterData.blocks.reduce((n, t, i) => ((before[i] = n), n + t.length), 0)
    let run: { block: number; chars: number; t0: number; last: number } | null = null
    let frame = 0
    let timer = 0
    const atTop = () => {
      const headerBottom = document.querySelector('header')?.getBoundingClientRect().bottom ?? 0
      const el = [...document.querySelectorAll<HTMLElement>('main.prose-read [data-block]')].find((e) => e.getBoundingClientRect().bottom > headerBottom + 8)
      if (!el) return null
      const b = Number(el.dataset.block)
      const r = el.getBoundingClientRect()
      const frac = Math.min(1, Math.max(0, (headerBottom - r.top) / Math.max(1, r.height)))
      return { block: b, chars: (before[b] ?? 0) + frac * (chapterData.blocks[b]?.length ?? 0) }
    }
    const onScroll = () => {
      if (Date.now() - handScrolledAt.current > 1000) return // the app scrolled, not you
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (playingRef.current) return void (run = null)
        if (followRef.current === 'on') {
          clearTimeout(timer)
          timer = window.setTimeout(() => {
            if (placeFromScroll()) {
              const p = pos.current
              setHl({ chapter: p.chapter, block: p.block, sent: p.sent, word: -1 })
              persist()
            }
          }, 500)
          return
        }
        const t = atTop()
        if (!t) return
        const now = performance.now()
        if (!run || t.chars < run.last - 40) return void (run = { block: t.block, chars: t.chars, t0: now, last: t.chars })
        run.last = t.chars
        const moved = t.chars - run.chars
        const secs = (now - run.t0) / 1000
        const pace = moved / Math.max(secs, 0.001) // characters a second; reading is roughly 15–40
        if (moved > 500 && pace > 55) return void (run = { block: t.block, chars: t.chars, t0: now, last: t.chars }) // skimming
        if (t.block - run.block >= 2 && moved >= 350 && secs >= 8 && pace <= 55) setFollow('asking')
      })
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(frame)
      clearTimeout(timer)
    }
  }, [chapterData, follow, placeFromScroll, persist])

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
      if (picked || tocOpen || settingsOpen || sleepOpen || speedOpen || viewPage || openHl) return
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return // Cmd+R, Alt+← and held keys belong to the browser
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return
      if (e.code === 'Space') {
        e.preventDefault()
        toggle()
      } else if (e.key === 'ArrowRight') (e.shiftKey ? stepParagraph : step)(1)
      else if (e.key === 'ArrowLeft') (e.shiftKey ? stepParagraph : step)(-1)
      else if (e.key === 'r') repeatSentence()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [toggle, step, stepParagraph, repeatSentence, picked, tocOpen, settingsOpen, sleepOpen, speedOpen, viewPage, openHl])

  useEffect(() => {
    if (!('mediaSession' in navigator) || !meta) return
    navigator.mediaSession.metadata = new MediaMetadata({
      title: meta.title,
      artist: meta.author || 'Qari',
    })
    navigator.mediaSession.setActionHandler('play', play)
    navigator.mediaSession.setActionHandler('pause', pause)
    navigator.mediaSession.setActionHandler('nexttrack', () => step(1))
    navigator.mediaSession.setActionHandler('previoustrack', () => step(-1))
  }, [meta, play, pause, step])

  // ---------- Tap a word: once to read from there, twice to look it up ----------
  /** Puts the reading place on a word: keeps reading from it if the voice is on, otherwise marks it so Play starts there. */
  const startFrom = (b: number, start: number) => {
    const info = infoFor(chapter, b)
    if (!info?.sents.length) return
    if (playingRef.current) return jumpTo(b, start)
    const si = Math.max(0, info.sents.findIndex((s) => start >= s.start && start < s.end))
    pos.current = { chapter, block: b, sent: si }
    lastWord.current = start
    repeated.current = false
    userScrolledAt.current = Date.now() // it's already on screen
    setHl({ chapter, block: b, sent: si, word: start })
    persist()
  }

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
      // Double tap: look the word up (or open its highlight). Reading pauses and carries on after.
      if (tapTimer.current) clearTimeout(tapTimer.current)
      tapTimer.current = null
      lastTap.current = null
      window.getSelection()?.removeAllRanges()
      setSelection(null)
      resumeAfterLookup.current = playingRef.current
      if (playingRef.current) pause()
      const info = infoFor(chapter, b)
      if (!info) return
      const hid = el.dataset.h
      const h = hid ? highlights.find((x) => x.id === hid) : undefined
      if (h) {
        tappedWord.current = { b, start, end: Number(el.dataset.e) }
        setOpenHl(h)
        return
      }
      const text = content.chapters[chapter].blocks[b]
      const sent = info.sents.find((s) => start >= s.start && start < s.end) || { start: 0, end: text.length }
      setPicked({
        word: text.slice(start, Number(el.dataset.e)),
        lang: info.lang,
        sentence: text.slice(sent.start, sent.end).trim(),
        block: b,
        start,
      })
      return
    }
    lastTap.current = { b, s: start, t }
    if (tapTimer.current) clearTimeout(tapTimer.current)
    // Wait a moment to see if a second tap is coming.
    tapTimer.current = window.setTimeout(() => {
      tapTimer.current = null
      startFrom(b, start)
    }, 300)
  }

  const readFromHere = (p: Picked) => {
    resumeAfterLookup.current = false
    setPicked(null)
    if (rsvp) {
      // In the speed reader: move it to that word.
      setRsvpSeek((old) => ({
        chapter: rsvpLookupChapter.current,
        block: p.block,
        start: p.start,
        n: (old?.n ?? 0) + 1,
      }))
      return
    }
    jumpTo(p.block, p.start)
  }

  /** Starts the voice at a word anywhere in the book (the speed reader's "Read aloud"). */
  const playFrom = (c: number, b: number, offset: number) => {
    const info = infoFor(c, b)
    if (!info?.sents.length) return
    pos.current = {
      chapter: c,
      block: b,
      sent: Math.max(
        0,
        info.sents.findIndex((s) => offset >= s.start && offset < s.end),
      ),
    }
    lastWord.current = offset
    repeated.current = false
    play()
  }

  /** A word tapped in the speed reader, which may be in another section than the page behind it. */
  const lookupFromSpeed = (w: { chapter: number; block: number; start: number; end: number }) => {
    pause()
    resumeAfterLookup.current = false
    const info = infoFor(w.chapter, w.block)
    const text = contentRef.current?.chapters[w.chapter]?.blocks[w.block]
    if (!info || text === undefined) return
    const sent = info.sents.find((s) => w.start >= s.start && w.start < s.end) || { start: 0, end: text.length }
    rsvpLookupChapter.current = w.chapter
    setPicked({
      word: text.slice(w.start, w.end),
      lang: info.lang,
      sentence: text.slice(sent.start, sent.end).trim(),
      block: w.block,
      start: w.start,
    })
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
    requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector(`[data-b="${b}"][data-s="${start}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })))
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

  void voicesVersion // re-render when the device's voices load
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
          <button type="button" onClick={() => openPanel('contents')} className="min-w-0 flex-1 rounded-lg px-1 text-left" aria-label={`Contents: ${meta.title}, ${chapterData.title}`}>
            <h1 className="truncate text-[0.95rem] font-semibold" dir="auto">
              {meta.title}
            </h1>
            <div className="flex items-center gap-0.5 text-xs text-ink-3">
              <span className="truncate" dir="auto">
                {chapterData.title}
              </span>
              <Icon name="chevron" size={14} className="shrink-0" />
            </div>
          </button>
          <IconButton icon="search" label="Search this book" onClick={() => openPanel('search')} />
          <span className="relative">
            <IconButton icon="list" label={highlights.length ? `Contents and ${highlights.length} notes` : 'Contents and notes'} onClick={() => openPanel(highlights.length ? 'notes' : 'contents')} />
            {highlights.length > 0 && (
              <span className="pointer-events-none absolute top-1.5 right-1 min-w-4 rounded-full bg-mark px-1 text-center text-[0.65rem] leading-4 font-semibold text-ink">{highlights.length}</span>
            )}
          </span>
          <IconButton icon="words" label="Saved words" onClick={() => go('words')} className="max-[359px]:hidden" />
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
          <span className="flex-1">
            You read further on another device
            {content.chapters[elsewhere.chapter] ? `, in “${content.chapters[elsewhere.chapter].title}”` : ''}.
          </span>
          <button type="button" className="shrink-0 font-semibold text-moss underline" onClick={goElsewhere}>
            Go there
          </button>
          <button type="button" className="shrink-0 text-ink-3" onClick={() => setElsewhere(null)} aria-label="Stay here">
            <Icon name="close" size={16} />
          </button>
        </div>
      )}

      <LineFocus on={!!settings.lineFocus} />
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
                  className={`pg select-none ${RTL_LANGS.has(blockInfos[b]?.lang) ? 'pg-rtl' : ''} ${canShowOriginal ? 'cursor-pointer' : ''}`}
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
                vocab={blockVocab[b]}
                bionic={!!settings.bionic}
                flash={flash && flash.chapter === chapter && flash.block === b ? `${flash.start}:${flash.end}` : undefined}
              />
            </div>
          )
        })}
        {sectionNewCount > 0 && (
          <div className="mt-10 rounded-2xl border border-line bg-paper-2 px-4 py-3 font-ui text-sm">
            <p className="text-ink-2">
              <span className="nw-chip rounded px-1 font-semibold text-ink">{sectionNewCount}</span> new {sectionNewCount === 1 ? 'word' : 'words'} in this section. Done with it? Mark the ones you
              didn’t look up as known, so next time only the words you still need stand out.
            </p>
            <button type="button" onClick={markSectionKnown} className="mt-2 h-9 rounded-full bg-moss px-4 font-semibold text-moss-ink">
              Mark {sectionNewCount} as known
            </button>
          </div>
        )}
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
      <section aria-label="Player" className="safe-b fixed inset-x-0 bottom-0 z-30 px-3 pt-2">
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
                <Icon name="note" size={16} /> Note
              </button>
              {selection.startBlock === selection.endBlock && (
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={lookUpSelection}
                  className="inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-sm font-semibold hover:bg-paper-2"
                >
                  <Icon name={selection.text.trim().split(/\s+/).length > 6 ? 'translate' : 'search'} size={16} /> {selection.text.trim().split(/\s+/).length > 6 ? 'Translate' : 'Look up'}
                </button>
              )}
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={copySelection}
                aria-label="Copy quote with citation"
                title="Copy quote with citation"
                className="inline-flex h-9 w-9 items-center justify-center rounded-full text-sm hover:bg-paper-2"
              >
                <Icon name="paste" size={16} />
              </button>
            </div>
          </div>
        )}
        {meta.importing && !selection && (
          <div className="mx-auto mb-2 flex max-w-md items-center gap-3 rounded-full border border-line bg-paper/95 px-4 py-1.5 text-xs text-ink-2 shadow-[0_4px_18px_rgb(0_0_0/0.08)]" role="status">
            <span className="shrink-0">Reading the rest of this PDF{importP !== null ? ` · ${Math.round(importP * 100)}%` : '…'}</span>
            <span className="h-1 flex-1 overflow-hidden rounded-full bg-line">
              <span className="block h-full bg-moss transition-[width]" style={{ width: `${Math.round((importP ?? 0) * 100)}%` }} />
            </span>
          </div>
        )}
        {follow === 'asking' && !selection && !playing && (
          <div className="sheet-in mx-auto mb-2 max-w-md rounded-2xl border border-line bg-paper px-4 py-3 shadow-[0_4px_18px_rgb(0_0_0/0.10)]" role="status">
            <p className="text-sm">
              <span className="font-semibold">Reading as you scroll?</span> Your placemark can follow the top of the screen, so you come back here next time.
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setFollow('on')
                  handScrolledAt.current = Date.now()
                  if (placeFromScroll()) {
                    const p = pos.current
                    setHl({ chapter: p.chapter, block: p.block, sent: p.sent, word: -1 })
                    persist()
                  }
                }}
                className="h-9 rounded-full bg-moss px-4 text-sm font-semibold text-moss-ink"
              >
                Follow my place
              </button>
              <button type="button" onClick={() => setFollow('off')} className="h-9 rounded-full border border-line px-4 text-sm">
                No, just looking
              </button>
            </div>
          </div>
        )}
        {follow === 'on' && !playing && !selection && (
          <div className="mb-2 flex justify-center">
            <button
              type="button"
              onClick={() => setFollow('off')}
              className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line bg-paper px-3 text-xs text-ink-2 shadow-[0_4px_18px_rgb(0_0_0/0.08)]"
              aria-label="Stop the placemark following your scrolling"
            >
              Placemark follows your scrolling <Icon name="close" size={13} />
            </button>
          </div>
        )}
        {away && !selection && follow !== 'asking' && follow !== 'on' && (
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
            <span className="min-w-0 truncate tabular-nums" aria-live="off">
              {fmtMinutes(secsLeft)} left
              <span className="max-[420px]:hidden"> in section</span>
            </span>
            <span className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  pause()
                  const p = pos.current
                  const sent = infoFor(p.chapter, p.block)?.sents[Math.max(0, p.sent)]
                  setRsvp({
                    chapter: p.chapter,
                    block: p.block,
                    offset: lastWord.current ?? sent?.start ?? 0,
                  })
                }}
                className="inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 hover:bg-paper-2"
                data-tour="speedread"
              >
                <Icon name="bolt" size={14} /> Speed read
              </button>
              <button
                type="button"
                onClick={() => setSleepOpen(true)}
                className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 tabular-nums ${sleepLabel ? 'bg-wash font-semibold text-ink' : 'hover:bg-paper-2'}`}
                aria-label={sleepLabel ? `Sleep timer: ${sleepLabel}` : 'Sleep timer'}
              >
                <Icon name="moon" size={14} /> {sleepLabel || 'Sleep'}
              </button>
            </span>
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
              onClick={() => setSpeedOpen(true)}
              className="h-11 min-w-14 rounded-full px-2 text-sm font-semibold tabular-nums text-ink-2 hover:bg-paper-2"
              data-tour="speed"
              aria-label={`${LANG_NAMES[curLang] || curLang} speed ${fmtRate(curRate)}×, tap to change`}
            >
              {chapterLangs.length > 1 && <span className="mr-1 text-[0.7rem] font-semibold uppercase text-ink-3">{curLang}</span>}
              {fmtRate(curRate)}×
            </button>
            <HoldButton icon="prev" label="Previous sentence (hold for the paragraph)" onTap={() => step(-1)} onHold={() => stepParagraph(-1)} />
            <button
              type="button"
              onClick={toggle}
              data-tour="play"
              aria-label={playing ? 'Pause' : 'Play'}
              className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-moss text-moss-ink hover:opacity-90"
            >
              <Icon name={playing ? 'pause' : 'play'} size={26} />
            </button>
            <HoldButton icon="next" label="Next sentence (hold for the next paragraph)" onTap={() => step(1)} onHold={() => stepParagraph(1)} />
            <IconButton icon="repeat" label="Repeat this sentence" onClick={repeatSentence} className={settings.afterSentence !== 'continue' ? 'text-moss' : ''} />
          </div>
        </div>
      </section>

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

      <Sheet open={speedOpen} onClose={() => setSpeedOpen(false)} title={`Speed · ${LANG_NAMES[curLang] || curLang}`}>
        <div className="grid grid-cols-3 gap-2 pb-2">
          {RATES.map((r) => {
            const on = Math.abs(r - curRate) < 0.01
            return (
              <button
                key={r}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  updateSettings({
                    rates: { ...settings.rates, [curLang]: r },
                  })
                  setSpeedOpen(false)
                }}
                className={`h-12 rounded-xl border font-semibold tabular-nums ${on ? 'border-moss bg-wash text-moss' : 'border-line hover:bg-paper-2'}`}
              >
                {fmtRate(r)}×
              </button>
            )
          })}
        </div>
        <p className="pb-2 text-sm text-ink-2">
          {!RATES.some((r) => Math.abs(r - curRate) < 0.01) && `Now ${fmtRate(curRate)}×. `}
          Each language keeps its own speed.{' '}
          <button
            type="button"
            className="text-moss underline underline-offset-2"
            onClick={() => {
              setSpeedOpen(false)
              setSettingsOpen(true)
            }}
          >
            Fine-tune in reading settings
          </button>
        </p>
      </Sheet>

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
                  onChange={(e) =>
                    updateSettings({
                      rates: {
                        ...settings.rates,
                        [lang]: Number(e.target.value),
                      },
                    })
                  }
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
            const id = settings.voices[lang]
            const basic = !(isEngineVoice(id) && usable(id)) && (onlyBasic(lang) || !pickVoice(lang, id))
            return (
              <div key={lang} className="mb-3 flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-ink-2">{LANG_NAMES[lang] || lang}</div>
                  <div className="truncate font-semibold">{voiceLabel(lang, id)}</div>
                  {basic && <div className="text-xs text-ink-3">Get a Qari voice for natural reading that works offline.</div>}
                </div>
                <IconButton
                  icon="speaker"
                  label={`Hear the ${LANG_NAMES[lang] || lang} voice`}
                  onClick={() => {
                    pause()
                    speakWord(SAMPLES[lang] || SAMPLES.en, lang, id, rateFor(settings, lang))
                  }}
                  className="border border-line"
                />
                <button
                  type="button"
                  onClick={() => {
                    setPickerLang(lang)
                    setPickerOpen(true)
                  }}
                  className={`h-10 shrink-0 rounded-full px-4 text-sm ${basic ? 'bg-moss font-semibold text-moss-ink' : 'border border-line'}`}
                >
                  {basic ? 'Better voice' : 'Change'}
                </button>
              </div>
            )
          })}
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
                  <IconButton
                    icon="speaker"
                    label={`Hear ${p.from}`}
                    size={17}
                    onClick={() => {
                      pause()
                      speakWord(p.to, meta.lang, settings.voices[meta.lang])
                    }}
                  />
                  <IconButton
                    icon="trash"
                    label={`Remove ${p.from}`}
                    size={17}
                    onClick={() =>
                      updateSettings({
                        pronunciations: settings.pronunciations.filter((_, j) => j !== i),
                      })
                    }
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
              updateSettings({
                pronunciations: [...settings.pronunciations, { from: newFrom.trim(), to: newTo.trim() }],
              })
              setNewFrom('')
              setNewTo('')
            }}
          >
            <input
              value={newFrom}
              onChange={(e) => setNewFrom(e.target.value)}
              placeholder="Word"
              dir="auto"
              aria-label="Word as written"
              className="h-11 min-w-0 flex-1 rounded-xl border border-line bg-paper-2 px-3"
            />
            <input
              value={newTo}
              onChange={(e) => setNewTo(e.target.value)}
              placeholder="Say it as"
              dir="auto"
              aria-label="Say it as"
              className="h-11 min-w-0 flex-1 rounded-xl border border-line bg-paper-2 px-3"
            />
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

        <section className="mb-6">
          <h3 className="mb-1 font-semibold">Languages you’re learning</h3>
          <p className="mb-2 text-sm text-ink-3">
            In these, words you haven’t marked known have a <span className="nw text-ink">dotted underline</span> and saved words are <span className="lw text-ink">underlined</span>.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(LANG_NAMES).map(([k, v]) => {
              const on = settings.learning.includes(k)
              return (
                <button
                  key={k}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    updateSettings({
                      learning: on ? settings.learning.filter((x) => x !== k) : [...settings.learning, k],
                    })
                  }
                  className={`h-8 rounded-full border px-3 text-sm ${on ? 'border-moss bg-wash font-semibold' : 'border-line text-ink-2'}`}
                >
                  {v}
                </button>
              )
            })}
          </div>
        </section>

        {(claudeAvail || settings.translateCode) && (
          <section className="mb-6">
            <label htmlFor="tr-code" className="mb-1 block font-semibold">
              Claude translation
            </label>
            <p className="mb-2 text-sm text-ink-3">
              Explains phrases in context and says whether Arabic is Shami, Egyptian or Fusha. Enter the access code you set in Vercel; leave it empty to use the free translator.
            </p>
            <input
              id="tr-code"
              type="password"
              autoComplete="off"
              value={settings.translateCode || ''}
              onChange={(e) => updateSettings({ translateCode: e.target.value })}
              placeholder="Access code"
              className="h-11 w-full rounded-xl border border-line bg-paper-2 px-3 outline-none focus:border-moss"
            />
          </section>
        )}

        <section className="mb-6 flex items-center justify-between gap-4">
          <h3 className="font-semibold">Text size</h3>
          <div className="flex items-center gap-1">
            <IconButton
              icon="minus"
              label="Smaller text"
              onClick={() =>
                updateSettings({
                  fontSize: Math.max(14, settings.fontSize - 1),
                })
              }
              className="border border-line"
            />
            <span className="w-10 text-center tabular-nums">{settings.fontSize}</span>
            <IconButton
              icon="plus"
              label="Larger text"
              onClick={() =>
                updateSettings({
                  fontSize: Math.min(32, settings.fontSize + 1),
                })
              }
              className="border border-line"
            />
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
          <h3 className="mb-1 font-semibold">Easier reading</h3>
          <p className="mb-3 text-sm text-ink-3">Fonts made for dyslexia, and bold word starts. They apply to every book; Arabic keeps its own font.</p>
          <div className="mb-4 grid grid-cols-2 gap-2">
            {(Object.entries(READ_FONTS) as [ReadFont, (typeof READ_FONTS)[ReadFont]][]).map(([k, f]) => {
              const on = (settings.readFont || 'literata') === k
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => updateSettings({ readFont: k })}
                  aria-pressed={on}
                  className={`flex flex-col items-start rounded-xl border px-3 py-2 text-left ${on ? 'border-moss bg-wash' : 'border-line'}`}
                >
                  <span className="text-lg leading-snug" style={{ fontFamily: f.family, letterSpacing: f.spacing }}>
                    Read along
                  </span>
                  <span className={`text-xs ${on ? 'font-semibold' : 'text-ink-2'}`}>
                    {f.label} <span className="font-normal text-ink-3">· {f.hint}</span>
                  </span>
                </button>
              )
            })}
          </div>
          <Toggle
            checked={!!settings.bionic}
            onChange={(v) => updateSettings({ bionic: v })}
            title="Bold word starts"
            hint="Bionic reading: the first part of each word is bold, so your eye has an anchor and moves faster. Not used for Arabic."
          />
          <Toggle
            checked={!!settings.lineFocus}
            onChange={(v) => updateSettings({ lineFocus: v })}
            title="Line focus"
            hint="Dims everything except the line being read, so it’s easier to keep your place when you’re tired. It follows the voice, or the word you tap."
          />
          <p className="-mt-2 text-sm text-ink-3">
            For speed reading, tap <span className="font-semibold text-ink-2">Speed read</span> above the play button: one word at a time, with a red letter to keep your eye still.
          </p>
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

        <Toggle checked={settings.autoScroll} onChange={(v) => updateSettings({ autoScroll: v })} title="Follow along" hint="Scroll to keep the spoken sentence in view." />
        <p className="pb-2 text-xs text-ink-3">Tip: tap a word to start reading from there, double-tap it to look it up.</p>
      </Sheet>

      <LookupSheet
        picked={picked}
        source={meta.title}
        voiceURI={picked ? settings.voices[picked.lang] : undefined}
        onClose={() => {
          setPicked(null)
          if (resumeAfterLookup.current) {
            resumeAfterLookup.current = false
            play()
          }
        }}
        onReadFromHere={readFromHere}
        learning={!!picked && settings.learning.includes(picked.lang)}
        translateTo={meta.lang === 'en' && picked?.lang === 'en' ? undefined : 'en'}
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
          setViewPage({
            page: content.chapters[h.chapter]?.pageIdx?.[h.startBlock] ?? 0,
            label: h.page?.split('–')[0],
          })
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
          const w = (t && t.b === b ? t : null) ||
            info?.words.find((x) => x.start >= h.start) || {
              start: h.start,
              end: h.start + 1,
            }
          const sent = info?.sents.find((s) => w.start >= s.start && w.start < s.end) || { start: 0, end: text.length }
          setPicked({
            word: text.slice(w.start, w.end),
            lang: info?.lang || meta.lang,
            sentence: text.slice(sent.start, sent.end).trim(),
            block: b,
            start: w.start,
          })
        }}
      />

      <VoicePicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        langs={[pickerLang, ...chapterLangs.filter((l) => l !== pickerLang), ...settings.learning.filter((l) => l !== pickerLang && !chapterLangs.includes(l))]}
      />
      {rsvp && content && (
        <SpeedReader
          content={content}
          start={rsvp}
          infoFor={infoFor}
          voicePlaying={playing}
          voiceSpot={hl}
          onVoicePlay={playFrom}
          onVoicePause={pause}
          onLookup={lookupFromSpeed}
          seek={rsvpSeek}
          onProgress={(at) => {
            const info = infoFor(at.chapter, at.block)
            if (!info) return
            pos.current = { chapter: at.chapter, block: at.block, sent: Math.max(0, info.sents.findIndex((x) => at.start >= x.start && at.start < x.end)) }
            lastWord.current = at.start
            persist()
          }}
          onClose={(at) => {
            setRsvp(null)
            setRsvpSeek(null)
            goTo(at.chapter, at.block, at.start, at.end)
          }}
        />
      )}
      {viewPage && <PageViewer docId={meta.id} page={viewPage.page} label={viewPage.label} onClose={() => setViewPage(null)} />}
    </div>
  )
}
