import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { stripArabicMarks, type Span } from '../lib/lang'
import { useSettings } from '../lib/settings'
import { RTL_LANGS, type DocContent, type Lang } from '../types'
import { Icon, IconButton } from './ui'

interface BlockInfo {
  lang: Lang
  sents: Span[]
  words: Span[]
}

interface Item {
  c: number
  b: number
  start: number
  end: number
  text: string
  rtl: boolean
  pause: number // how much longer to show it: 1 = normal
  sent: number // sentence index inside the block
}

const MIN_WPM = 100
const MAX_WPM = 1000

/** Letters before the focus letter, by word length — a little left of centre, where the eye naturally lands. */
function focusIndex(letters: number) {
  if (letters <= 1) return 0
  if (letters <= 5) return 1
  if (letters <= 9) return 2
  if (letters <= 13) return 3
  return 4
}

const graphemes = (() => {
  const seg = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null
  return (s: string) => (seg ? [...seg.segment(s)].map((g) => g.segment) : [...s])
})()

/** Splits a word around its focus letter. */
function split(word: string) {
  const gs = graphemes(word)
  const letterAt = gs.map((g, i) => (/\p{L}|\p{N}/u.test(g) ? i : -1)).filter((i) => i >= 0)
  if (!letterAt.length) return { before: '', focus: word, after: '' }
  const i = letterAt[Math.min(focusIndex(letterAt.length), letterAt.length - 1)]
  return { before: gs.slice(0, i).join(''), focus: gs[i], after: gs.slice(i + 1).join('') }
}

function pauseFor(word: string, sentEnd: boolean, blockEnd: boolean) {
  let p = 1
  const letters = word.replace(/[^\p{L}\p{N}]/gu, '').length
  if (letters > 8) p += 0.25
  if (letters > 12) p += 0.25
  if (blockEnd) p += 1.6
  else if (sentEnd || /[.!?؟…]["'”’»)]*$/.test(word)) p += 1.2
  else if (/[,;:،؛—–]["'”’»)]*$/.test(word)) p += 0.5
  return p
}

/**
 * Speed reading: one word at a time in the same spot, with a red focus letter to keep your eye still.
 * Starts where you are, and puts your place back where you stopped.
 */
export default function SpeedReader({
  content,
  start,
  infoFor,
  onClose,
}: {
  content: DocContent
  start: { chapter: number; block: number; offset: number }
  infoFor: (c: number, b: number) => BlockInfo | null | undefined
  onClose: (at: { chapter: number; block: number; start: number; end: number }) => void
}) {
  const [settings, updateSettings] = useSettings()
  const wpm = settings.speedWpm || 300
  const [items, setItems] = useState<Item[]>([])
  const [loadedTo, setLoadedTo] = useState(start.chapter - 1)
  const [i, setI] = useState(0)
  const [playing, setPlaying] = useState(false)
  const timer = useRef<number | null>(null)
  const wake = useRef<{ release: () => Promise<void> } | null>(null)

  /** Words of one chapter (from a block and offset in the first one). */
  const chapterItems = useCallback(
    (c: number, fromBlock = 0, fromOffset = 0) => {
      const out: Item[] = []
      const ch = content.chapters[c]
      if (!ch) return out
      for (let b = fromBlock; b < ch.blocks.length; b++) {
        const info = infoFor(c, b)
        if (!info) continue
        const text = ch.blocks[b]
        const rtl = RTL_LANGS.has(info.lang)
        const ws = info.words.filter((w) => b !== fromBlock || w.end > fromOffset)
        ws.forEach((w, k) => {
          const sent = Math.max(0, info.sents.findIndex((s) => w.start >= s.start && w.start < s.end))
          const nextW = ws[k + 1]
          const sentEnd = !nextW || info.sents[sent]?.end <= nextW.start
          // Keep closing punctuation with the word, so pauses land where the sentence does.
          let end = w.end
          while (end < text.length && /[.,;:!?؟،؛…"'”’»)\]]/.test(text[end])) end++
          let word = text.slice(w.start, end)
          if (rtl && !settings.showHarakat) word = stripArabicMarks(word)
          out.push({ c, b, start: w.start, end: w.end, text: word, rtl, sent, pause: pauseFor(word, sentEnd, k === ws.length - 1) })
        })
      }
      return out
    },
    [content, infoFor, settings.showHarakat],
  )

  // Load the starting chapter, then the next ones as you get near the end.
  useEffect(() => {
    if (loadedTo >= start.chapter) return
    setItems(chapterItems(start.chapter, start.block, start.offset))
    setLoadedTo(start.chapter)
  }, [chapterItems, loadedTo, start])
  useEffect(() => {
    if (!items.length || i < items.length - 50 || loadedTo >= content.chapters.length - 1) return
    let c = loadedTo + 1
    let more = chapterItems(c)
    while (!more.length && c < content.chapters.length - 1) more = chapterItems(++c)
    setItems((old) => [...old, ...more])
    setLoadedTo(c)
  }, [i, items.length, loadedTo, chapterItems, content.chapters.length])

  const cur = items[Math.min(i, items.length - 1)]
  const atEnd = items.length > 0 && i >= items.length - 1 && loadedTo >= content.chapters.length - 1

  // The clock: each word stays up for its share of a minute, longer at commas and full stops.
  useEffect(() => {
    if (!playing || !cur) return
    if (atEnd) {
      timer.current = window.setTimeout(() => setPlaying(false), (60000 / wpm) * cur.pause)
      return () => clearTimeout(timer.current!)
    }
    timer.current = window.setTimeout(() => setI((n) => n + 1), (60000 / wpm) * cur.pause)
    return () => clearTimeout(timer.current!)
  }, [playing, i, cur, wpm, atEnd])

  // Keep the screen on while words are flashing.
  useEffect(() => {
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }
    if (playing && nav.wakeLock) nav.wakeLock.request('screen').then((w) => (wake.current = w), () => {})
    return () => {
      wake.current?.release().catch(() => {})
      wake.current = null
    }
  }, [playing])

  const close = useCallback(() => {
    setPlaying(false)
    if (cur) onClose({ chapter: cur.c, block: cur.b, start: cur.start, end: cur.end })
    else onClose({ chapter: start.chapter, block: start.block, start: start.offset, end: start.offset })
  }, [cur, onClose, start])

  /** Back to the start of this sentence, or the previous one if you're already at the start. */
  const back = useCallback(() => {
    if (!cur) return
    let k = i
    while (k > 0 && items[k - 1].b === cur.b && items[k - 1].sent === cur.sent) k--
    if (k === i && k > 0) {
      const prev = items[k - 1]
      k--
      while (k > 0 && items[k - 1].b === prev.b && items[k - 1].sent === prev.sent) k--
    }
    setI(k)
  }, [cur, i, items])

  const forward = useCallback(() => {
    if (!cur) return
    let k = i
    while (k < items.length - 1 && items[k].b === cur.b && items[k].sent === cur.sent) k++
    setI(k)
  }, [cur, i, items])

  const setWpm = useCallback((n: number) => updateSettings({ speedWpm: Math.max(MIN_WPM, Math.min(MAX_WPM, Math.round(n / 25) * 25)) }), [updateSettings])

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === ' ') setPlaying((p) => !p)
      else if (e.key === 'Escape') close()
      else if (e.key === 'ArrowLeft') back()
      else if (e.key === 'ArrowRight') forward()
      else if (e.key === 'ArrowUp') setWpm(wpm + 25)
      else if (e.key === 'ArrowDown') setWpm(wpm - 25)
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [back, close, forward, setWpm, wpm])

  // The sentence around the word, small, so you can glance at context when paused.
  const context = useMemo(() => {
    if (!cur) return null
    const info = infoFor(cur.c, cur.b)
    const s = info?.sents[cur.sent]
    if (!s) return null
    const text = content.chapters[cur.c].blocks[cur.b]
    const show = (t: string) => (cur.rtl && !settings.showHarakat ? stripArabicMarks(t) : t)
    return { before: show(text.slice(s.start, cur.start)), word: show(text.slice(cur.start, cur.end)), after: show(text.slice(cur.end, s.end)), rtl: cur.rtl }
  }, [cur, infoFor, content, settings.showHarakat])

  const left = items.slice(i).filter((it) => it.c === cur?.c).reduce((t, it) => t + it.pause, 0) * (60 / wpm)
  const parts = cur ? split(cur.text) : null
  const section = cur ? content.chapters[cur.c]?.title : ''

  return (
    <div className="fixed inset-0 z-[90] flex flex-col bg-paper text-ink" role="dialog" aria-modal="true" aria-label="Speed reading">
      <header className="flex items-center gap-2 px-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <IconButton icon="close" label="Back to the page" onClick={close} />
        <div className="min-w-0 flex-1 truncate text-center text-sm text-ink-3" dir="auto">
          {section}
        </div>
        <span className="w-11" />
      </header>

      <button
        type="button"
        className="relative flex flex-1 flex-col items-center justify-center px-4 outline-none"
        onClick={() => setPlaying((p) => !p)}
        aria-label={playing ? 'Pause' : 'Play'}
      >
        {/* Guide marks above and below the focus letter. */}
        <div className="relative w-full max-w-xl">
          <div className="absolute inset-x-0 -top-7 border-t border-line" aria-hidden="true">
            <span className="absolute left-1/2 top-0 h-3 w-px -translate-x-1/2 bg-ink-3" />
          </div>
          <div className="absolute inset-x-0 -bottom-7 border-b border-line" aria-hidden="true">
            <span className="absolute bottom-0 left-1/2 h-3 w-px -translate-x-1/2 bg-ink-3" />
          </div>
          {parts && cur ? (
            cur.rtl ? (
              <div className="font-arabic text-center text-[clamp(2rem,9vw,3.25rem)] leading-tight whitespace-nowrap" dir="rtl" lang="ar" aria-live="off">
                {parts.before}
                <span className="text-[#d9342b]">{parts.focus}</span>
                {parts.after}
              </div>
            ) : (
              <div
                className="font-read grid grid-cols-[1fr_auto_1fr] text-[clamp(2rem,9vw,3.25rem)] leading-tight whitespace-nowrap"
                style={{ fontVariationSettings: "'opsz' 40" }}
                aria-live="off"
              >
                <span className="text-right">{parts.before}</span>
                <span className="font-semibold text-[#d9342b]">{parts.focus}</span>
                <span className="text-left">{parts.after}</span>
              </div>
            )
          ) : (
            <div className="text-center text-ink-3">Nothing to read here.</div>
          )}
        </div>
        {context && !playing && (
          <p className="mt-16 max-w-xl text-center text-[0.95rem] leading-relaxed text-ink-3" dir={context.rtl ? 'rtl' : 'auto'}>
            {context.before}
            <mark className="rounded bg-wash px-0.5 text-ink">{context.word}</mark>
            {context.after}
          </p>
        )}
        {!playing && i === 0 && <p className="mt-6 text-sm text-ink-3">Keep your eyes on the red letter. Tap anywhere to start or pause.</p>}
      </button>

      <footer className="mx-auto w-full max-w-md px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="mb-2 flex justify-between text-xs tabular-nums text-ink-3">
          <span>{left < 60 ? 'under a minute' : `${Math.round(left / 60)} min`} left in section</span>
          <span>{atEnd && !playing ? 'The end' : ''}</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <IconButton icon="minus" label="Slower" onClick={() => setWpm(wpm - 25)} className="border border-line" />
            <span className="w-16 text-center text-sm font-semibold tabular-nums" aria-live="polite">
              {wpm}
              <span className="block text-[0.65rem] font-normal text-ink-3">words/min</span>
            </span>
            <IconButton icon="plus" label="Faster" onClick={() => setWpm(wpm + 25)} className="border border-line" />
          </div>
          <div className="flex items-center gap-1">
            <IconButton icon="prev" label="Back a sentence" onClick={back} />
            <button
              type="button"
              onClick={() => setPlaying((p) => !p)}
              aria-label={playing ? 'Pause' : 'Play'}
              className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-moss text-moss-ink hover:opacity-90"
            >
              <Icon name={playing ? 'pause' : 'play'} size={26} />
            </button>
            <IconButton icon="next" label="Next sentence" onClick={forward} />
          </div>
        </div>
      </footer>
    </div>
  )
}
