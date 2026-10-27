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
  lang: Lang
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
  return {
    before: gs.slice(0, i).join(''),
    focus: gs[i],
    after: gs.slice(i + 1).join(''),
  }
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
  voicePlaying,
  voiceSpot,
  onVoicePlay,
  onVoicePause,
  onLookup,
  seek,
  onProgress,
}: {
  content: DocContent
  start: { chapter: number; block: number; offset: number }
  infoFor: (c: number, b: number) => BlockInfo | null | undefined
  onClose: (at: { chapter: number; block: number; start: number; end: number }) => void
  /** The voice, when "Read aloud" is on: it sets the pace and the word shown follows it. */
  voicePlaying: boolean
  voiceSpot: { chapter: number; block: number; sent: number; word: number }
  onVoicePlay: (chapter: number, block: number, offset: number) => void
  onVoicePause: () => void
  onLookup: (w: { chapter: number; block: number; start: number; end: number }) => void
  seek: { chapter: number; block: number; start: number; n: number } | null // "read from here" in a lookup
  onProgress: (at: { chapter: number; block: number; start: number }) => void // keeps the book's placemark on the word shown
}) {
  const [settings, updateSettings] = useSettings()
  const wpm = settings.speedWpm || 300
  const voiceOn = !!settings.speedVoice
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
          const sent = Math.max(
            0,
            info.sents.findIndex((s) => w.start >= s.start && w.start < s.end),
          )
          const nextW = ws[k + 1]
          const sentEnd = !nextW || info.sents[sent]?.end <= nextW.start
          // Keep closing punctuation with the word, so pauses land where the sentence does.
          let end = w.end
          while (end < text.length && /[.,;:!?؟،؛…"'”’»)\]]/.test(text[end])) end++
          let word = text.slice(w.start, end)
          if (rtl && !settings.showHarakat) word = stripArabicMarks(word)
          out.push({
            c,
            b,
            start: w.start,
            end: w.end,
            text: word,
            rtl,
            lang: info.lang,
            sent,
            pause: pauseFor(word, sentEnd, k === ws.length - 1),
          })
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

  const isPlaying = voiceOn ? voicePlaying : playing

  // One placemark for the book: the reader's place follows the word on screen.
  const progressRef = useRef(onProgress)
  progressRef.current = onProgress
  useEffect(() => {
    if (cur && !voiceOn) progressRef.current({ chapter: cur.c, block: cur.b, start: cur.start })
  }, [cur, voiceOn])

  // With the voice on, show whatever word it's saying.
  useEffect(() => {
    if (!voiceOn || !voicePlaying) return
    const { chapter: c, block: b, sent, word } = voiceSpot
    const k = items.findIndex((it) => it.c === c && it.b === b && (word >= 0 ? it.start === word : it.sent === sent))
    if (k >= 0) setI(k)
  }, [voiceOn, voicePlaying, voiceSpot, items])

  const goToItem = useCallback(
    (k: number) => {
      setI(k)
      const it = items[k]
      if (voiceOn && voicePlaying && it) onVoicePlay(it.c, it.b, it.start)
    },
    [items, voiceOn, voicePlaying, onVoicePlay],
  )

  const toggle = useCallback(() => {
    if (!voiceOn) return setPlaying((p) => !p)
    if (voicePlaying) onVoicePause()
    else if (cur) onVoicePlay(cur.c, cur.b, cur.start)
  }, [voiceOn, voicePlaying, cur, onVoicePause, onVoicePlay])

  const setVoiceOn = (on: boolean) => {
    setPlaying(false)
    onVoicePause()
    updateSettings({ speedVoice: on })
  }

  // A word picked in a lookup's "Read from here".
  useEffect(() => {
    if (!seek) return
    const k = items.findIndex((it) => it.c === seek.chapter && it.b === seek.block && it.start >= seek.start)
    if (k >= 0) setI(k)
  }, [seek]) // eslint-disable-line react-hooks/exhaustive-deps

  // The clock: each word stays up for its share of a minute, longer at commas and full stops.
  useEffect(() => {
    if (voiceOn || !playing || !cur) return
    if (atEnd) {
      timer.current = window.setTimeout(() => setPlaying(false), (60000 / wpm) * cur.pause)
      return () => clearTimeout(timer.current!)
    }
    timer.current = window.setTimeout(() => setI((n) => n + 1), (60000 / wpm) * cur.pause)
    return () => clearTimeout(timer.current!)
  }, [voiceOn, playing, i, cur, wpm, atEnd])

  // Keep the screen on while words are flashing.
  useEffect(() => {
    const nav = navigator as Navigator & {
      wakeLock?: {
        request: (t: 'screen') => Promise<{ release: () => Promise<void> }>
      }
    }
    if (isPlaying && nav.wakeLock)
      nav.wakeLock.request('screen').then(
        (w) => (wake.current = w),
        () => {},
      )
    return () => {
      wake.current?.release().catch(() => {})
      wake.current = null
    }
  }, [isPlaying])

  const close = useCallback(() => {
    setPlaying(false)
    onVoicePause()
    if (cur) onClose({ chapter: cur.c, block: cur.b, start: cur.start, end: cur.end })
    else
      onClose({
        chapter: start.chapter,
        block: start.block,
        start: start.offset,
        end: start.offset,
      })
  }, [cur, onClose, start, onVoicePause])

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
    goToItem(k)
  }, [cur, i, items, goToItem])

  const forward = useCallback(() => {
    if (!cur) return
    let k = i
    while (k < items.length - 1 && items[k].b === cur.b && items[k].sent === cur.sent) k++
    goToItem(k)
  }, [cur, i, items, goToItem])

  const setWpm = useCallback(
    (n: number) =>
      updateSettings({
        speedWpm: Math.max(MIN_WPM, Math.min(MAX_WPM, Math.round(n / 25) * 25)),
      }),
    [updateSettings],
  )

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      // A lookup or another sheet is open on top: its keys are its own.
      if (document.querySelectorAll('[role=dialog]').length > 1) return
      if (e.key === ' ') toggle()
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
  }, [back, close, forward, setWpm, wpm, toggle])

  // When paused: the sentence before and this one, every word tappable for a lookup.
  const context = useMemo(() => {
    if (!cur) return null
    const info = infoFor(cur.c, cur.b)
    const s = info?.sents[cur.sent]
    if (!info || !s) return null
    const pieces: {
      c: number
      b: number
      text: string
      words: Span[]
      from: number
      to: number
    }[] = []
    const text = content.chapters[cur.c].blocks[cur.b]
    if (cur.sent > 0)
      pieces.push({
        c: cur.c,
        b: cur.b,
        text,
        words: info.words,
        from: info.sents[cur.sent - 1].start,
        to: s.start,
      })
    else if (cur.b > 0) {
      const pi = infoFor(cur.c, cur.b - 1)
      const ps = pi?.sents[pi.sents.length - 1]
      if (pi && ps && pi.lang === info.lang)
        pieces.push({
          c: cur.c,
          b: cur.b - 1,
          text: content.chapters[cur.c].blocks[cur.b - 1],
          words: pi.words,
          from: ps.start,
          to: ps.end,
        })
    }
    pieces.push({
      c: cur.c,
      b: cur.b,
      text,
      words: info.words,
      from: s.start,
      to: s.end,
    })
    return { pieces, rtl: cur.rtl }
  }, [cur, infoFor, content])

  const showText = (t: string, rtl: boolean) => (rtl && !settings.showHarakat ? stripArabicMarks(t) : t)
  const lookupCur = () => cur && onLookup({ chapter: cur.c, block: cur.b, start: cur.start, end: cur.end })

  // Speed controls: words a minute on their own, or the voice's speed for this language.
  const RATES = [0.75, 0.85, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]
  const lang = cur?.lang || 'en'
  const rate = settings.rates[lang] ?? settings.rate
  const stepRate = (d: 1 | -1) => {
    const at = RATES.findIndex((r) => r >= rate - 0.001)
    const next = RATES[Math.max(0, Math.min(RATES.length - 1, (at < 0 ? RATES.length - 1 : at) + d))]
    updateSettings({ rates: { ...settings.rates, [lang]: next } })
  }

  const left =
    items
      .slice(i)
      .filter((it) => it.c === cur?.c)
      .reduce((t, it) => t + it.pause, 0) *
    (60 / wpm)
  const parts = cur ? split(cur.text) : null
  const section = cur ? content.chapters[cur.c]?.title : ''

  const lookupHint = !isPlaying && cur

  return (
    <div className="fixed inset-0 z-[35] flex flex-col bg-paper text-ink" role="dialog" aria-modal="true" aria-label="Speed reading">
      <header className="flex items-center gap-2 px-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <IconButton icon="close" label="Back to the page" onClick={close} />
        <div className="min-w-0 flex-1 truncate text-center text-sm text-ink-3" dir="auto">
          {section}
        </div>
        <button
          type="button"
          onClick={() => setVoiceOn(!voiceOn)}
          aria-pressed={voiceOn}
          className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm ${voiceOn ? 'border-moss bg-wash font-semibold text-ink' : 'border-line text-ink-2'}`}
        >
          <Icon name="speaker" size={16} /> Read aloud
        </button>
      </header>

      {/* Tap anywhere to play or pause. While paused, tap a word to look it up. */}
      <div className="relative flex flex-1 cursor-pointer flex-col items-center justify-center px-4" onClick={toggle} role="presentation">
        {/* Guide marks above and below the focus letter. */}
        <div className="relative w-full max-w-xl">
          <div className="absolute inset-x-0 -top-7 border-t border-line" aria-hidden="true">
            <span className="absolute left-1/2 top-0 h-3 w-px -translate-x-1/2 bg-ink-3" />
          </div>
          <div className="absolute inset-x-0 -bottom-7 border-b border-line" aria-hidden="true">
            <span className="absolute bottom-0 left-1/2 h-3 w-px -translate-x-1/2 bg-ink-3" />
          </div>
          {parts && cur ? (
            <div
              onClick={(e) => {
                if (isPlaying) return
                e.stopPropagation()
                lookupCur()
              }}
              role={isPlaying ? undefined : 'button'}
              aria-label={isPlaying ? undefined : `Look up ${cur.text}`}
              tabIndex={isPlaying ? undefined : 0}
              onKeyDown={(e) => {
                if (!isPlaying && e.key === 'Enter') lookupCur()
              }}
            >
              {cur.rtl ? (
                <div className="font-arabic text-center text-[clamp(2rem,9vw,3.25rem)] leading-tight whitespace-nowrap" dir="rtl" lang="ar" aria-live="off">
                  {parts.before}
                  <span className="text-[#d9342b]">{parts.focus}</span>
                  {parts.after}
                </div>
              ) : (
                <div className="font-read grid grid-cols-[1fr_auto_1fr] text-[clamp(2rem,9vw,3.25rem)] leading-tight whitespace-nowrap" style={{ fontVariationSettings: "'opsz' 40" }} aria-live="off">
                  <span className="text-right">{parts.before}</span>
                  <span className="font-semibold text-[#d9342b]">{parts.focus}</span>
                  <span className="text-left">{parts.after}</span>
                </div>
              )}
            </div>
          ) : (
            <div className="text-center text-ink-3">Nothing to read here.</div>
          )}
        </div>

        {lookupHint && context && (
          <div className="mt-14 w-full max-w-xl" onClick={(e) => e.stopPropagation()} role="presentation">
            <p className="mb-2 text-center text-xs text-ink-3">Tap any word to look it up · tap the space around to keep reading</p>
            <p className="text-center text-[1.05rem] leading-[2.1]" dir={context.rtl ? 'rtl' : 'auto'} lang={cur.lang}>
              {context.pieces.map((pc, pi) => {
                const last = pi === context.pieces.length - 1
                const out: React.ReactNode[] = []
                let at = pc.from
                for (const w of pc.words) {
                  if (w.start < pc.from || w.start >= pc.to) continue
                  if (w.start > at) out.push(showText(pc.text.slice(at, w.start), context.rtl))
                  const isCur = pc.c === cur.c && pc.b === cur.b && w.start === cur.start
                  out.push(
                    <button
                      key={pc.b + ':' + w.start}
                      type="button"
                      onClick={() =>
                        onLookup({
                          chapter: pc.c,
                          block: pc.b,
                          start: w.start,
                          end: w.end,
                        })
                      }
                      className={`rounded underline decoration-line decoration-dotted underline-offset-4 hover:bg-paper-2 ${isCur ? 'bg-wash font-semibold text-ink' : last ? 'text-ink-2' : 'text-ink-3'}`}
                    >
                      {showText(pc.text.slice(w.start, w.end), context.rtl)}
                    </button>,
                  )
                  at = w.end
                }
                if (at < pc.to) out.push(showText(pc.text.slice(at, pc.to), context.rtl))
                return (
                  <span key={pi} className={last ? '' : 'opacity-80'}>
                    {out}{' '}
                  </span>
                )
              })}
            </p>
          </div>
        )}
        {!isPlaying && i === 0 && !voiceOn && <p className="mt-6 text-sm text-ink-3">Keep your eyes on the red letter. Tap anywhere to start or pause.</p>}
      </div>

      <footer className="mx-auto w-full max-w-md px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="mb-2 flex justify-between text-xs tabular-nums text-ink-3">
          <span>{voiceOn ? 'The voice sets the pace' : `${left < 60 ? 'under a minute' : `${Math.round(left / 60)} min`} left in section`}</span>
          <span>{atEnd && !isPlaying ? 'The end' : ''}</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <IconButton icon="minus" label="Slower" onClick={() => (voiceOn ? stepRate(-1) : setWpm(wpm - 25))} className="border border-line" />
            <span className="w-16 text-center text-sm font-semibold tabular-nums" aria-live="polite">
              {voiceOn ? `${Number.isInteger(rate) ? rate.toFixed(1) : Number(rate.toFixed(2))}×` : wpm}
              <span className="block text-[0.65rem] font-normal text-ink-3">{voiceOn ? 'voice speed' : 'words/min'}</span>
            </span>
            <IconButton icon="plus" label="Faster" onClick={() => (voiceOn ? stepRate(1) : setWpm(wpm + 25))} className="border border-line" />
          </div>
          <div className="flex items-center gap-1">
            <IconButton icon="prev" label="Back a sentence" onClick={back} />
            <button
              type="button"
              onClick={toggle}
              aria-label={isPlaying ? 'Pause' : 'Play'}
              className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-moss text-moss-ink hover:opacity-90"
            >
              <Icon name={isPlaying ? 'pause' : 'play'} size={26} />
            </button>
            <IconButton icon="next" label="Next sentence" onClick={forward} />
          </div>
        </div>
      </footer>
    </div>
  )
}
