import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { go } from '../App'
import { getDoc, saveDoc } from '../lib/db'
import { importText } from '../lib/importer'
import { useSettings } from '../lib/settings'
import { endTour, setTourStep, useTour } from '../lib/tour'

type Target = string | (() => Element | null)
interface Step {
  where: 'library' | 'reader'
  target?: Target
  title: string
  body: string
}

const words = () => document.querySelectorAll('main.prose-read p')[1] || document.querySelector('main.prose-read p')

const STEPS: Step[] = [
  { where: 'library', title: 'Welcome to Qari', body: 'Qari reads your books, articles and class readings aloud, and lets you look up any word as you listen. Five quick things to know.' },
  { where: 'library', target: '[data-tour=add]', title: 'Add something to read', body: 'PDFs, EPUBs, Word files, web links, pasted text, or photos of printed pages.' },
  { where: 'library', target: '[data-tour=menu]', title: 'Sync, voices and backup', body: 'Keep your phone and laptop in step (encrypted), check which languages this device can read aloud, switch to dark mode, or download a backup.' },
  { where: 'reader', target: words, title: 'Tap any word', body: 'Tap a word to see what it means: reading pauses and carries on when you close it. Double-tap to read from that word. Select a few words to highlight, add a note or translate.' },
  { where: 'reader', target: '[data-tour=play]', title: 'Play, speed and skip', body: 'The sentence being read is tinted and each word lights up as it’s spoken. Tap the speed on the left to change it; each language keeps its own.' },
  { where: 'reader', target: '[data-tour=speedread]', title: 'Speed read', body: 'One word at a time in the same spot, with a red letter to keep your eye still. Set how many words a minute; when you close it, your place is where you stopped.' },
  { where: 'reader', target: '[aria-label="Reading settings"]', title: 'Everything else is up here', body: 'Search, contents and notes, and reading settings (voices, text size, Arabic font, and dyslexia-friendly fonts and bold word starts). Take this tour again from the ⋯ menu in your library.' },
]

const SAMPLE = `This is a short sample so you can try Qari. Press play and listen: the sentence being read is tinted, and each word lights up as it is spoken.

Tap any word to look it up. Reading pauses while you look, and you can save the word with this sentence to review later. Double-tap a word to start reading from there.

Select a few words to highlight them, add a note, copy them as a quote, or translate them.

Qari reads other languages too. When a paragraph is in Arabic, it switches to an Arabic voice and reads right to left on its own:

القراءة غذاء العقل، والكتاب خير صديق.

You can remove this sample from your library whenever you like.`

async function openSample() {
  let id: string | null = null
  try {
    id = localStorage.getItem('qari.tourDoc')
  } catch {
    /* storage unavailable */
  }
  if (!id || !(await getDoc(id))) {
    const { meta, content } = importText(SAMPLE, 'Welcome to Qari (sample)')
    await saveDoc(meta, content)
    id = meta.id
    try {
      localStorage.setItem('qari.tourDoc', id)
    } catch {
      /* storage unavailable */
    }
  }
  go('read/' + id)
}

function find(t: Target) {
  return typeof t === 'string' ? document.querySelector(t) : t()
}

export default function Tour() {
  const { active, step } = useTour()
  const [, updateSettings] = useSettings()
  const [rect, setRect] = useState<DOMRect | null>(null)
  const [missing, setMissing] = useState(false)
  const dir = useRef(1)
  const card = useRef<HTMLDivElement>(null)
  const s = STEPS[step]

  // Move to the screen this step is on.
  useEffect(() => {
    if (!active || !s) return
    const inReader = location.hash.startsWith('#/read/')
    if (s.where === 'reader' && !inReader) openSample()
    if (s.where === 'library' && location.hash.replace(/^#\/?/, '') !== '') go('')
  }, [active, step, s])

  // Follow the highlighted control as the page scrolls, opens or resizes.
  useLayoutEffect(() => {
    setRect(null)
    setMissing(false)
    if (!active || !s?.target) return
    let frame = 0
    let scrolled = false
    const started = performance.now()
    const tick = () => {
      const el = find(s.target!)
      if (el) {
        const r = el.getBoundingClientRect()
        if (!scrolled) {
          scrolled = true
          if (r.top < 60 || r.bottom > innerHeight - 60) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
        }
        setRect((old) => (old && old.top === r.top && old.left === r.left && old.width === r.width && old.height === r.height ? old : r))
      } else if (performance.now() - started > 5000) {
        setMissing(true)
        return
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [active, step, s])

  // A control that isn't on screen (say, a narrow phone hides it) is skipped.
  useEffect(() => {
    if (!missing) return
    const next = step + dir.current
    if (next < 0 || next >= STEPS.length) finish()
    else setTourStep(next)
  }, [missing])

  useEffect(() => {
    if (active) card.current?.focus()
  }, [active, step])

  const finish = () => {
    updateSettings({ tourDone: true })
    endTour()
    go('')
  }
  const move = (d: number) => {
    dir.current = d
    const next = step + d
    if (next >= STEPS.length) finish()
    else if (next >= 0) setTourStep(next)
  }

  useEffect(() => {
    if (!active) return
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish()
      else if (e.key === 'ArrowRight') move(1)
      else if (e.key === 'ArrowLeft') move(-1)
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  })

  if (!active || !s) return null
  const waiting = !!s.target && !rect
  const pad = 6
  const vw = window.innerWidth
  const vh = window.innerHeight
  const w = Math.min(360, vw - 32)
  let pos: React.CSSProperties = { left: (vw - w) / 2, top: '50%', transform: 'translateY(-50%)' }
  if (rect) {
    const left = Math.min(Math.max(rect.left + rect.width / 2 - w / 2, 16), vw - 16 - w)
    pos = rect.top + rect.height / 2 < vh / 2 ? { left, top: Math.min(rect.bottom + pad + 12, vh - 220) } : { left, bottom: Math.min(vh - rect.top + pad + 12, vh - 220) }
  }
  const last = step === STEPS.length - 1

  return (
    <div className="fixed inset-0 z-[100]" role="dialog" aria-modal="true" aria-label="Tour">
      {/* Blocks the app underneath; the tour only shows. */}
      <div className={`absolute inset-0 ${rect ? '' : 'bg-black/55'}`} onClick={(e) => e.stopPropagation()} />
      {rect && (
        <div
          className="pointer-events-none absolute rounded-2xl ring-2 ring-white/90 transition-all duration-300 ease-out"
          style={{
            left: rect.left - pad,
            top: rect.top - pad,
            width: rect.width + pad * 2,
            height: rect.height + pad * 2,
            boxShadow: '0 0 0 9999px rgb(0 0 0 / 0.55)',
          }}
        >
          <span className="absolute inset-0 animate-ping rounded-2xl ring-2 ring-white/50 [animation-duration:1.8s]" />
        </div>
      )}
      {!waiting && (
        <div
          ref={card}
          tabIndex={-1}
          className="sheet-in absolute rounded-2xl bg-paper p-4 text-ink shadow-[0_8px_30px_rgb(0_0_0/0.3)] outline-none"
          style={{ ...pos, width: w }}
        >
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="font-semibold">{s.title}</h2>
            <span className="shrink-0 text-xs tabular-nums text-ink-3">
              {step + 1} of {STEPS.length}
            </span>
          </div>
          <p className="mt-1.5 text-[0.95rem] leading-relaxed text-ink-2">{s.body}</p>
          <div className="mt-4 flex items-center gap-2">
            {!last && (
              <button type="button" onClick={finish} className="mr-auto h-10 text-sm text-ink-3 underline-offset-2 hover:underline">
                Skip tour
              </button>
            )}
            {last && <span className="mr-auto" />}
            {step > 0 && (
              <button type="button" onClick={() => move(-1)} className="h-10 rounded-full border border-line px-4 text-sm">
                Back
              </button>
            )}
            <button type="button" onClick={() => move(1)} className="h-10 rounded-full bg-moss px-5 text-sm font-semibold text-moss-ink hover:opacity-90">
              {last ? 'Done' : STEPS[step + 1]?.where === 'reader' && s.where === 'library' ? 'Open a sample' : step === 0 ? 'Show me' : 'Next'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
