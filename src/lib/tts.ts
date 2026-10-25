import type { Lang } from '../types'
import { baseLang, words } from './lang'

export function speechSupported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

let voiceCache: SpeechSynthesisVoice[] = []

export function getVoices(): Promise<SpeechSynthesisVoice[]> {
  if (!speechSupported()) return Promise.resolve([])
  const now = speechSynthesis.getVoices()
  if (now.length) {
    voiceCache = now
    return Promise.resolve(now)
  }
  return new Promise((resolve) => {
    const done = () => {
      voiceCache = speechSynthesis.getVoices()
      resolve(voiceCache)
    }
    speechSynthesis.addEventListener('voiceschanged', done, { once: true })
    setTimeout(done, 1500)
  })
}

export function onVoicesChanged(cb: () => void) {
  if (!speechSupported()) return () => {}
  const h = () => {
    voiceCache = speechSynthesis.getVoices()
    cb()
  }
  speechSynthesis.addEventListener('voiceschanged', h)
  return () => speechSynthesis.removeEventListener('voiceschanged', h)
}

/** Higher is better: prefer the natural-sounding voices each platform ships. */
function voiceScore(v: SpeechSynthesisVoice, lang: Lang) {
  let s = 0
  const name = v.name.toLowerCase()
  const tag = v.lang.toLowerCase().replace('_', '-')
  if (/natural|neural|premium|enhanced|online/.test(name)) s += 50
  if (/siri/.test(name)) s += 45
  if (/google/.test(name)) s += 30
  if (/microsoft/.test(name)) s += 10
  if (/compact|eloquence|espeak|novelty|bad news|bells|bubbles|cellos|zarvox|whisper|wobble|trinoids|boing|jester|organ|superstar|albert|bahh|fred|junior|ralph|kathy|grandma|grandpa|rocko|shelley|flo|reed|sandy/.test(name)) s -= 60
  if (v.localService) s += 3
  if (v.default) s += 2
  // Regional preferences
  const pref: Record<string, string[]> = {
    en: ['en-us', 'en-gb'],
    ar: ['ar-sa', 'ar-eg', 'ar-ae', 'ar-jo', 'ar-lb', 'ar-sy'],
    fr: ['fr-fr', 'fr-ca'],
    de: ['de-de'],
    es: ['es-es', 'es-mx', 'es-us'],
    pt: ['pt-br', 'pt-pt'],
  }
  const p = pref[lang]?.indexOf(tag) ?? -1
  if (p >= 0) s += 8 - p
  return s
}

export function voicesFor(lang: Lang, all = voiceCache) {
  return all.filter((v) => baseLang(v.lang) === lang).sort((a, b) => voiceScore(b, lang) - voiceScore(a, lang))
}

export function pickVoice(lang: Lang, preferredURI?: string): SpeechSynthesisVoice | undefined {
  const list = voicesFor(lang)
  return list.find((v) => v.voiceURI === preferredURI) || list[0]
}

// ---------- Speaking one sentence ----------

export interface SpeakOptions {
  text: string
  lang: Lang
  voice?: SpeechSynthesisVoice
  rate: number
  onWord: (start: number, end: number) => void
  onEnd: () => void
  onError: (msg: string) => void
}

/** Remembers which voices report word timing, so the estimate can kick in at once for the others. */
const boundaryVoices = new Map<string, boolean>()

const CHARS_PER_SEC: Record<string, number> = { en: 15, ar: 12, fr: 15, de: 14, es: 15 }

export class SentenceSpeaker {
  private utt: SpeechSynthesisUtterance | null = null
  private timer: number | null = null
  private estTimer: number | null = null
  private token = 0

  speak(o: SpeakOptions) {
    this.stop()
    const token = ++this.token
    const u = new SpeechSynthesisUtterance(o.text)
    u.lang = o.voice?.lang || o.lang
    if (o.voice) u.voice = o.voice
    u.rate = o.rate
    const voiceKey = o.voice?.voiceURI || 'default:' + o.lang
    const wordSpans = words(o.text, o.lang)
    let gotBoundary = false

    const startEstimate = () => {
      // Voice gives no word timing: move the highlight at an estimated reading pace.
      const cps = (CHARS_PER_SEC[o.lang] || 14) * o.rate
      let i = 0
      const step = () => {
        if (token !== this.token || gotBoundary || i >= wordSpans.length) return
        const w = wordSpans[i]
        o.onWord(w.start, w.end)
        const next = wordSpans[i + 1]
        const chars = (next ? next.start : o.text.length) - w.start
        i++
        this.estTimer = window.setTimeout(step, Math.max(90, (chars / cps) * 1000))
      }
      step()
    }

    u.onstart = () => {
      if (token !== this.token) return
      if (boundaryVoices.get(voiceKey) === false) startEstimate()
      else
        this.timer = window.setTimeout(() => {
          if (!gotBoundary && token === this.token) {
            boundaryVoices.set(voiceKey, false)
            startEstimate()
          }
        }, 500)
    }
    u.onboundary = (e) => {
      if (token !== this.token || (e.name && e.name !== 'word')) return
      if (!gotBoundary) {
        gotBoundary = true
        boundaryVoices.set(voiceKey, true)
        if (this.estTimer) clearTimeout(this.estTimer)
      }
      const idx = e.charIndex
      const w = wordSpans.find((s) => idx >= s.start && idx < s.end) || wordSpans.find((s) => s.start >= idx)
      if (w) o.onWord(w.start, w.end)
    }
    u.onend = () => {
      if (token !== this.token) return
      this.clearTimers()
      this.utt = null
      o.onEnd()
    }
    u.onerror = (e) => {
      if (token !== this.token) return
      this.clearTimers()
      this.utt = null
      if (e.error === 'interrupted' || e.error === 'canceled') return
      o.onError(e.error === 'not-allowed' ? 'Tap play to start audio.' : `Speech error: ${e.error}`)
    }
    this.utt = u // keep a reference: Chrome drops events for garbage-collected utterances
    speechSynthesis.speak(u)
    // Chrome sometimes stays "paused" after another tab used speech.
    if (speechSynthesis.paused) speechSynthesis.resume()
  }

  private clearTimers() {
    if (this.timer) clearTimeout(this.timer)
    if (this.estTimer) clearTimeout(this.estTimer)
    this.timer = this.estTimer = null
  }

  stop() {
    this.token++
    this.clearTimers()
    if (this.utt) this.utt.onend = this.utt.onboundary = this.utt.onerror = null
    this.utt = null
    if (speechSupported()) speechSynthesis.cancel()
  }
}

/** Speaks a single word (for the lookup panel). */
export function speakWord(text: string, lang: Lang, voiceURI?: string, rate = 0.85) {
  if (!speechSupported()) return
  speechSynthesis.cancel()
  const u = new SpeechSynthesisUtterance(text)
  const v = pickVoice(lang, voiceURI)
  if (v) u.voice = v
  u.lang = v?.lang || lang
  u.rate = rate
  speechSynthesis.speak(u)
}
