import { getSettings } from './settings'
import type { Lang } from '../types'
import { baseLang, words, type Span } from './lang'
import { engineVoiceFor, isEngineVoice, synth, usable } from './voices'

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

// Joke voices (Bubbles, Zarvox…) and the robotic Eloquence voices (Eddy, Flo, Grandma…) that Apple ships in every language.
const NOVELTY = /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|deranged|hysterical|pipe organ|fred|junior|kathy|ralph|eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley)\b/

/**
 * How good a voice sounds: 0 = never offered, 1 = basic (robotic), 2 = good, 3 = very good.
 * Very good: Apple Enhanced/Premium and Siri voices, Microsoft Natural voices (Edge). Good: Google's voices in Chrome, Android network voices.
 */
export function voiceTier(v: SpeechSynthesisVoice): 0 | 1 | 2 | 3 {
  const name = v.name.toLowerCase()
  const uri = (v.voiceURI || '').toLowerCase()
  if (/eloquence|speech\.synthesis\.voice\.|espeak|novelty/.test(uri) || /espeak|novelty/.test(name)) return 0
  if (NOVELTY.test(name.replace(/\(.*?\)/g, ''))) return 0
  if (/premium|enhanced|natural|neural|siri/.test(name) || /\.(premium|enhanced)\.|siri/.test(uri)) return 3
  if (/compact/.test(uri)) return 1
  if (/^google\b/.test(name) || /network/.test(uri) || /network/.test(name)) return 2
  return 1
}

/** Higher is better, within a tier: prefer the usual region for each language. */
function voiceScore(v: SpeechSynthesisVoice, lang: Lang) {
  let s = voiceTier(v) * 100
  const tag = v.lang.toLowerCase().replace('_', '-')
  if (/premium/.test(v.name.toLowerCase() + v.voiceURI.toLowerCase())) s += 20 // Apple: Premium beats Enhanced
  if (v.localService) s += 3
  if (v.default) s += 2
  const pref: Record<string, string[]> = {
    en: ['en-us', 'en-gb'],
    ar: ['ar-lb', 'ar-sy', 'ar-jo', 'ar-sa', 'ar-eg', 'ar-ae'],
    fr: ['fr-fr', 'fr-ca'],
    de: ['de-de'],
    es: ['es-es', 'es-mx', 'es-us'],
    pt: ['pt-br', 'pt-pt'],
  }
  const p = pref[lang]?.indexOf(tag) ?? -1
  if (p >= 0) s += 8 - p
  return s
}

/**
 * Voices for a language, best first. Normally only the good ones; if a device has none for this language,
 * just its single best basic voice so it can still read. `all` lists everything except the joke voices.
 */
export function voicesFor(lang: Lang, opts: { all?: boolean } = {}) {
  // Voices can arrive after the page loads without a voiceschanged event (older iOS): ask again.
  if (!voiceCache.length && speechSupported()) voiceCache = speechSynthesis.getVoices()
  const list = voiceCache
    .filter((v) => baseLang(v.lang) === lang && voiceTier(v) > 0)
    .sort((a, b) => voiceScore(b, lang) - voiceScore(a, lang))
  if (opts.all) return list
  const good = list.filter((v) => voiceTier(v) >= 2)
  return good.length ? good : list.slice(0, 1)
}

/** True when the best this device can do for a language is a basic voice. */
export function onlyBasic(lang: Lang) {
  const best = voicesFor(lang)[0]
  return !!best && voiceTier(best) < 2
}

export function platform() {
  const ua = navigator.userAgent
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in document)) return 'ios'
  if (/Android/.test(ua)) return 'android'
  if (/Windows/.test(ua)) return 'windows'
  if (/Macintosh/.test(ua)) return 'mac'
  return 'other'
}

const HOW_TO: Record<string, string> = {
  ios: 'Settings › Accessibility › Spoken Content › Voices, choose the language, and download an “Enhanced” or “Premium” voice.',
  mac: 'System Settings › Accessibility › Spoken Content › System voice › Manage Voices, and download an “Enhanced” or “Premium” voice for the language. Or open Qari in Microsoft Edge for its free “Natural” voices.',
  android: 'Settings › System › Languages › Text-to-speech output › Speech Services by Google › Install voice data.',
  windows: 'Open Qari in Microsoft Edge: its free “Natural” voices sound far better and appear here automatically.',
  other: 'Add a text-to-speech voice for this language in your system settings, or open Qari in Chrome, Edge or Safari.',
}

/** Where to get a better voice on this kind of device. */
export function betterVoiceHint() {
  return HOW_TO[platform()]
}

export function pickVoice(lang: Lang, preferredURI?: string): SpeechSynthesisVoice | undefined {
  const list = voicesFor(lang, { all: getSettings().showAllVoices })
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

export const CHARS_PER_SEC: Record<string, number> = { en: 15, ar: 12, fr: 15, de: 14, es: 15 }

export const SAMPLES: Record<string, string> = {
  en: 'This is how your reading will sound.',
  ar: 'هكذا ستبدو قراءتك.',
  fr: 'Voici comment votre lecture va sonner.',
  de: 'So wird Ihre Lektüre klingen.',
  es: 'Así sonará tu lectura.',
  it: 'Ecco come suonerà la tua lettura.',
  pt: 'É assim que a sua leitura vai soar.',
}

export class SentenceSpeaker {
  private utt: SpeechSynthesisUtterance | null = null
  private timer: number | null = null
  private estTimer: number | null = null
  private watchdog: number | null = null
  private token = 0

  speak(o: SpeakOptions, retry = 0) {
    this.stop()
    const token = ++this.token
    const u = new SpeechSynthesisUtterance(o.text)
    u.lang = o.voice?.lang || o.lang
    if (o.voice) u.voice = o.voice
    u.rate = o.rate
    const voiceKey = o.voice?.voiceURI || 'default:' + o.lang
    const wordSpans = words(o.text, o.lang)
    let gotBoundary = false
    let started = false

    // Some voices (Chrome's Google voices, some Android ones) go quiet without ever firing onend.
    // If nothing has happened for twice the expected time, treat the sentence as finished.
    const cps = (CHARS_PER_SEC[o.lang] || 14) * o.rate
    const armWatchdog = (fromChar: number) => {
      if (this.watchdog) clearTimeout(this.watchdog)
      const ms = ((o.text.length - fromChar) / cps) * 2000 + (started ? 3000 : 8000)
      this.watchdog = window.setTimeout(() => {
        if (token !== this.token) return
        this.stop()
        // In the background the browser may simply have paused speech: keep the place rather than skip ahead.
        if (document.hidden) o.onError('Reading paused while Qari was in the background.')
        else o.onEnd()
      }, ms)
    }
    armWatchdog(0)

    const startEstimate = () => {
      // Voice gives no word timing: move the highlight at an estimated reading pace.
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
      started = true
      armWatchdog(0)
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
      armWatchdog(idx)
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
      if (e.error === 'interrupted' || e.error === 'canceled') {
        // Our own stop() detaches these handlers first, so this came from outside: another sound, a call,
        // or iOS dropping an utterance queued right after cancel(). Retry once if it never started.
        if (!started && retry < 1) return this.speak(o, retry + 1)
        return o.onError('Reading was interrupted. Tap play to carry on.')
      }
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
    if (this.watchdog) clearTimeout(this.watchdog)
    this.timer = this.estTimer = this.watchdog = null
  }

  stop() {
    this.token++
    this.clearTimers()
    if (this.utt) this.utt.onend = this.utt.onboundary = this.utt.onerror = null
    this.utt = null
    if (speechSupported()) speechSynthesis.cancel()
  }
}

// ---------- Qari and Azure voices: real audio files ----------

/** One audio element for the whole app: once it has played after a tap, iPhone lets it keep playing sentence after sentence, even with the screen locked. */
const audioEl: HTMLAudioElement | null = typeof Audio !== 'undefined' ? new Audio() : null
if (audioEl) {
  audioEl.preload = 'auto'
  ;(audioEl as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true
}
// A 0.1 s silent WAV, played straight from a tap to unlock audio on iPhone before the first sentence is ready.
const SILENCE =
  'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQQAAAAAAA=='
let primed = false

/** Call from the Play tap itself (not after an await). */
export function primeAudio() {
  if (!audioEl || primed || !audioEl.paused) return
  primed = true
  audioEl.src = SILENCE
  audioEl.play().catch(() => (primed = false))
}

/** How long each word takes, roughly: phoneme counts from the voice when it gives them, else letters plus pauses at punctuation. */
function wordWeights(text: string, spans: Span[], groups?: number[]) {
  const tokens = [...text.matchAll(/\S+/g)].map((m) => ({ start: m.index!, end: m.index! + m[0].length }))
  if (groups && groups.length === tokens.length) {
    const per = new Map<number, number>()
    tokens.forEach((t, k) => {
      const inside = spans.filter((w) => w.start >= t.start && w.start < t.end)
      inside.forEach((w) => per.set(w.start, groups[k] / inside.length))
    })
    if (spans.every((w) => per.has(w.start))) return spans.map((w) => per.get(w.start)!)
  }
  return spans.map((w, k) => {
    const next = spans[k + 1]?.start ?? text.length
    const gap = text.slice(w.end, next)
    return w.end - w.start + 1 + (/[.!?؟…]/.test(gap) ? 6 : /[,;:،؛—–]/.test(gap) ? 3 : 0)
  })
}

export interface AudioSpeakOptions extends SpeakOptions {
  voiceId: string
}

/** Plays a sentence from a Qari or Azure voice and moves the word highlight along with it. */
export class AudioSpeaker {
  private token = 0
  private frame = 0
  active = false

  async speak(o: AudioSpeakOptions) {
    this.stop()
    const token = ++this.token
    const el = audioEl
    if (!el) return o.onError('This browser can’t play audio.')
    let res
    try {
      res = await synth(o.voiceId, o.text)
    } catch (e) {
      if (token === this.token) o.onError(e instanceof Error ? e.message : String(e))
      return
    }
    if (token !== this.token) return
    const spans = words(o.text, o.lang)
    const weights = wordWeights(o.text, spans, res.groups)
    const total = weights.reduce((x, y) => x + y, 0) || 1
    let shown = -1
    const tick = () => {
      if (token !== this.token) return
      const d = el.duration
      if (d && isFinite(d)) {
        // A little of the audio at each end is silence.
        const f = Math.max(0, Math.min(1, (el.currentTime - 0.08) / Math.max(0.1, d - 0.25)))
        let acc = 0
        let k = 0
        while (k < weights.length - 1 && acc + weights[k] <= f * total) acc += weights[k++]
        if (k !== shown && spans[k]) {
          shown = k
          o.onWord(spans[k].start, spans[k].end)
        }
      }
      if (!el.paused) this.frame = requestAnimationFrame(tick)
    }
    el.onplaying = () => {
      if (token !== this.token) return
      cancelAnimationFrame(this.frame)
      this.frame = requestAnimationFrame(tick)
    }
    el.ontimeupdate = () => token === this.token && tick() // keeps going when the screen is off and frames stop
    el.onended = () => {
      if (token !== this.token) return
      this.active = false
      o.onEnd()
    }
    el.onerror = () => {
      if (token !== this.token) return
      this.active = false
      o.onError('Couldn’t play that sentence.')
    }
    el.src = res.url
    el.playbackRate = o.rate
    this.active = true
    try {
      await el.play()
    } catch (e) {
      if (token !== this.token) return
      this.active = false
      o.onError((e as Error)?.name === 'NotAllowedError' ? 'Tap play to start audio.' : 'Couldn’t play that sentence.')
    }
  }

  /** Gets the next sentences ready while this one plays. */
  prefetch(voiceId: string, text: string) {
    synth(voiceId, text).catch(() => {})
  }

  stop() {
    this.token++
    this.active = false
    cancelAnimationFrame(this.frame)
    if (audioEl && !audioEl.paused && audioEl.src !== SILENCE) audioEl.pause()
  }
}

/** The reader's speaker: device voices through speech synthesis, Qari and Azure voices as audio. */
export class Speaker {
  private device = new SentenceSpeaker()
  private audio = new AudioSpeaker()

  /** With a voiceId, reads with that Qari/Azure voice; if it fails, says why once (onFallback) and reads with the device voice. */
  speak(o: SpeakOptions & { voiceId?: string; onFallback?: (msg: string) => void }) {
    this.stop()
    if (!o.voiceId) return this.device.speak(o)
    this.audio.speak({
      ...o,
      voiceId: o.voiceId,
      onError: (msg) => {
        if (/Tap play/.test(msg)) return o.onError(msg)
        o.onFallback?.(msg)
        this.device.speak(o)
      },
    })
  }
  prefetch(voiceId: string, text: string) {
    this.audio.prefetch(voiceId, text)
  }
  /** Audio is playing (device speech has its own checks). */
  busy() {
    return this.audio.active
  }
  stop() {
    this.device.stop()
    this.audio.stop()
  }
}

const wordAudio: HTMLAudioElement | null = typeof Audio !== 'undefined' ? new Audio() : null

/** Speaks a single word (for the lookup panel). */
/** Speaks a single word (for the lookup panel). */
export function speakWord(text: string, lang: Lang, voiceURI?: string, rate = 0.85) {
  // A Qari or Azure voice: the same voice you read with.
  const engine = isEngineVoice(voiceURI) ? (usable(voiceURI) ? voiceURI : undefined) : voiceURI === undefined ? engineVoiceFor(lang) : undefined
  if (engine && wordAudio) {
    synth(engine, text).then(
      (r) => {
        wordAudio.src = r.url
        wordAudio.playbackRate = rate
        wordAudio.play().catch(() => {})
      },
      () => speakWord(text, lang, '', rate),
    )
    return
  }
  if (!speechSupported()) return
  speechSynthesis.cancel()
  const u = new SpeechSynthesisUtterance(text)
  const v = pickVoice(lang, voiceURI)
  if (v) u.voice = v
  u.lang = v?.lang || lang
  u.rate = rate
  speechSynthesis.speak(u)
}
