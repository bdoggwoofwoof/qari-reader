import { useEffect, useState } from 'react'
import { getSettings, onSettingsChange } from './settings'
import type { Lang } from '../types'

/**
 * Voices that don't come from the device:
 *  - "qari:<piper id>"   Qari's built-in voices (Piper), downloaded once and run on the device. Free, offline.
 *  - "azure:<name>"      Microsoft's neural voices through /api/tts, when Azure is set up on the deployment.
 * They're stored in settings.voices[lang] like a device voice's URI, so the rest of the app needn't care.
 */

export interface EngineVoice {
  id: string
  engine: 'qari' | 'azure'
  lang: Lang
  name: string
  note: string // accent or style, shown under the name
  mb?: number // download size, for Qari voices
}

const q = (lang: Lang, key: string, name: string, note: string, mb = 63): EngineVoice => ({ id: 'qari:' + key, engine: 'qari', lang, name, note, mb })
const a = (lang: Lang, key: string, name: string, note: string): EngineVoice => ({ id: 'azure:' + key, engine: 'azure', lang, name, note })

/** Qari voices worth offering (Piper "medium" quality: clear, and quick enough on a phone). */
export const QARI_VOICES: EngineVoice[] = [
  q('en', 'en_US-lessac-medium', 'Lessac', 'American English, warm and even'),
  q('en', 'en_US-amy-medium', 'Amy', 'American English, brighter'),
  q('en', 'en_US-ryan-medium', 'Ryan', 'American English, male'),
  q('en', 'en_GB-alba-medium', 'Alba', 'British English (Scottish)'),
  q('en', 'en_GB-cori-medium', 'Cori', 'British English'),
  q('ar', 'ar_JO-kareem-medium', 'Kareem', 'Arabic (Fusha with a Jordanian accent). Reads best with vowel marks'),
  q('fr', 'fr_FR-siwis-medium', 'Siwis', 'French, female'),
  q('fr', 'fr_FR-tom-medium', 'Tom', 'French, male'),
  q('fr', 'fr_FR-upmc-medium', 'UPMC', 'French, two speakers'),
  q('de', 'de_DE-thorsten-medium', 'Thorsten', 'German, male'),
  q('de', 'de_DE-ramona-low', 'Ramona', 'German, female', 63),
  q('es', 'es_ES-davefx-medium', 'Davefx', 'Spanish (Spain)'),
  q('es', 'es_MX-ald-medium', 'Ald', 'Spanish (Mexico)'),
  q('it', 'it_IT-paola-medium', 'Paola', 'Italian'),
  q('pt', 'pt_BR-faber-medium', 'Faber', 'Portuguese (Brazil)'),
  q('nl', 'nl_NL-mls-medium', 'MLS', 'Dutch'),
  q('fa', 'fa_IR-gyro-medium', 'Gyro', 'Persian'),
  q('ru', 'ru_RU-irina-medium', 'Irina', 'Russian'),
  q('tr', 'tr_TR-fahrettin-medium', 'Fahrettin', 'Turkish'),
]

/** Azure voices worth offering. Regional Arabic voices read Arabic text with that country's accent. */
export const AZURE_VOICES: EngineVoice[] = [
  a('ar', 'ar-LB-LaylaNeural', 'Layla', 'Lebanon'),
  a('ar', 'ar-LB-RamiNeural', 'Rami', 'Lebanon'),
  a('ar', 'ar-SY-AmanyNeural', 'Amany', 'Syria'),
  a('ar', 'ar-SY-LaithNeural', 'Laith', 'Syria'),
  a('ar', 'ar-JO-SanaNeural', 'Sana', 'Jordan'),
  a('ar', 'ar-JO-TaimNeural', 'Taim', 'Jordan'),
  a('ar', 'ar-EG-SalmaNeural', 'Salma', 'Egypt'),
  a('ar', 'ar-IQ-RanaNeural', 'Rana', 'Iraq'),
  a('ar', 'ar-SA-ZariyahNeural', 'Zariyah', 'Saudi Arabia (Fusha)'),
  a('en', 'en-US-AvaMultilingualNeural', 'Ava', 'American English'),
  a('en', 'en-US-AndrewMultilingualNeural', 'Andrew', 'American English'),
  a('en', 'en-US-EmmaMultilingualNeural', 'Emma', 'American English'),
  a('en', 'en-GB-SoniaNeural', 'Sonia', 'British English'),
  a('fr', 'fr-FR-VivienneMultilingualNeural', 'Vivienne', 'France'),
  a('fr', 'fr-FR-RemyMultilingualNeural', 'Rémy', 'France'),
  a('fr', 'fr-FR-DeniseNeural', 'Denise', 'France'),
  a('de', 'de-DE-SeraphinaMultilingualNeural', 'Seraphina', 'Germany'),
  a('de', 'de-DE-FlorianMultilingualNeural', 'Florian', 'Germany'),
  a('de', 'de-DE-KatjaNeural', 'Katja', 'Germany'),
  a('es', 'es-ES-ElviraNeural', 'Elvira', 'Spain'),
  a('es', 'es-MX-DaliaNeural', 'Dalia', 'Mexico'),
  a('it', 'it-IT-ElsaNeural', 'Elsa', 'Italy'),
  a('pt', 'pt-BR-FranciscaNeural', 'Francisca', 'Brazil'),
  a('nl', 'nl-NL-ColetteNeural', 'Colette', 'Netherlands'),
  a('fa', 'fa-IR-DilaraNeural', 'Dilara', 'Iran'),
  a('ru', 'ru-RU-SvetlanaNeural', 'Svetlana', 'Russia'),
  a('tr', 'tr-TR-EmelNeural', 'Emel', 'Turkey'),
]

export const ENGINE_VOICES = [...QARI_VOICES, ...AZURE_VOICES]
export const isEngineVoice = (id?: string) => !!id && (id.startsWith('qari:') || id.startsWith('azure:'))
export const engineVoice = (id?: string) => ENGINE_VOICES.find((v) => v.id === id)

// ---------- State: which Qari voices are downloaded, what's downloading, whether Azure is available ----------

interface VoiceState {
  downloaded: Set<string> // piper keys
  downloading: Map<string, number> // piper key → 0..1
  failed: Map<string, string>
  azure: boolean // Azure is set up on the deployment and you've entered the access code
}
let state: VoiceState = { downloaded: new Set(), downloading: new Map(), failed: new Map(), azure: false }
const listeners = new Set<() => void>()
const set = (patch: Partial<VoiceState>) => {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}
export const voiceState = () => state

export function useVoiceState() {
  const [s, setS] = useState(state)
  useEffect(() => {
    const l = () => setS(state)
    listeners.add(l)
    l()
    return () => {
      listeners.delete(l)
    }
  }, [])
  return s
}

// ---------- Qari voices: a worker runs Piper ----------

let worker: Worker | null = null
let seq = 0
const waiting = new Map<number, { resolve: (v: { wav: ArrayBuffer; groups: number[] }) => void; reject: (e: Error) => void }>()
const downloads = new Map<string, { resolve: () => void; reject: (e: Error) => void }[]>()

function getWorker() {
  if (worker) return worker
  worker = new Worker('/voices/piper-worker.js')
  worker.onmessage = (e) => {
    const m = e.data
    if (m.type === 'audio') {
      waiting.get(m.id)?.resolve({ wav: m.wav, groups: m.groups })
      waiting.delete(m.id)
    } else if (m.type === 'progress') {
      const d = new Map(state.downloading)
      d.set(m.voice, m.total ? m.loaded / m.total : 0)
      set({ downloading: d })
    } else if (m.type === 'ready') {
      const d = new Map(state.downloading)
      d.delete(m.voice)
      const f = new Map(state.failed)
      f.delete(m.voice)
      set({ downloading: d, failed: f, downloaded: new Set([...state.downloaded, m.voice]) })
      downloads.get(m.voice)?.forEach((p) => p.resolve())
      downloads.delete(m.voice)
    } else if (m.type === 'removed') {
      const s = new Set(state.downloaded)
      s.delete(m.voice)
      set({ downloaded: s })
    } else if (m.type === 'error') {
      if (m.id !== undefined && waiting.has(m.id)) {
        waiting.get(m.id)!.reject(new Error(m.message))
        waiting.delete(m.id)
      } else if (m.voice) {
        const d = new Map(state.downloading)
        d.delete(m.voice)
        const f = new Map(state.failed)
        f.set(m.voice, /fetch|network|Download/i.test(m.message) ? 'Couldn’t download. Check your connection and try again.' : m.message)
        set({ downloading: d, failed: f })
        downloads.get(m.voice)?.forEach((p) => p.reject(new Error(m.message)))
        downloads.delete(m.voice)
      }
    }
  }
  return worker
}

/** Downloads a Qari voice (about 60 MB, once) and the voice engine (about 35 MB, once for all voices). */
export function downloadQariVoice(id: string): Promise<void> {
  const key = id.replace(/^qari:/, '')
  if (state.downloaded.has(key)) return Promise.resolve()
  // Ask the browser to keep these files even when space runs low.
  navigator.storage?.persist?.().catch(() => {})
  return new Promise((resolve, reject) => {
    const list = downloads.get(key) || []
    list.push({ resolve, reject })
    downloads.set(key, list)
    if (list.length === 1) {
      const d = new Map(state.downloading)
      d.set(key, 0)
      set({ downloading: d })
      getWorker().postMessage({ type: 'download', voice: key })
    }
  })
}

export function removeQariVoice(id: string) {
  getWorker().postMessage({ type: 'remove', voice: id.replace(/^qari:/, '') })
}

async function piperSpeak(key: string, text: string) {
  const id = ++seq
  return new Promise<{ wav: ArrayBuffer; groups: number[] }>((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    getWorker().postMessage({ type: 'speak', id, voice: key, text })
  })
}

// ---------- Azure ----------

let azureChecked = false
/** Asks the deployment whether Azure is set up. Needs the access code from reading settings to actually use it. */
export async function checkAzure() {
  try {
    const r = await fetch('/api/tts')
    const j = r.ok ? await r.json() : { azure: false }
    azureChecked = true
    set({ azure: !!j.azure && !!getSettings().translateCode })
  } catch {
    /* offline: try again next time */
  }
}
export const azureKnown = () => azureChecked

async function sha(text: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Azure audio for a sentence, kept on the device so reading it again (or going back) costs nothing. */
async function azureSpeak(name: string, text: string): Promise<Blob> {
  const key = `https://qari.local/azure/${name}/${await sha(text)}`
  let cache: Cache | null = null
  try {
    cache = await caches.open('qari-azure-audio')
    const hit = await cache.match(key)
    if (hit) return hit.blob()
  } catch {
    /* no cache storage: just fetch */
  }
  const r = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Qari-Code': getSettings().translateCode || '' },
    body: JSON.stringify({ text, voice: name }),
  })
  if (!r.ok) {
    const j = await r.json().catch(() => ({}))
    throw new Error(j.error || `Azure voice failed (${r.status})`)
  }
  const blob = await r.blob()
  cache?.put(key, new Response(blob, { headers: { 'Content-Type': 'audio/mpeg' } })).catch(() => {})
  return blob
}

// ---------- One entry point ----------

/** Can this voice be used right now on this device? */
export function usable(id?: string) {
  if (!id) return false
  if (id.startsWith('qari:')) return state.downloaded.has(id.slice(5))
  if (id.startsWith('azure:')) return state.azure
  return false
}

/** The engine voice chosen for a language, if it can be used right now. */
export function engineVoiceFor(lang: Lang): string | undefined {
  const id = getSettings().voices[lang]
  return isEngineVoice(id) && usable(id) ? id : undefined
}

export interface Synth {
  url: string
  groups?: number[] // phoneme counts per space-separated word (Qari voices), for timing the highlight
}

const memo = new Map<string, Promise<Synth>>()
/** Audio for one sentence. Recent ones are kept, so prefetching the next sentences makes playback seamless. */
export function synth(id: string, text: string): Promise<Synth> {
  const k = id + '\n' + text
  const hit = memo.get(k)
  if (hit) {
    memo.delete(k)
    memo.set(k, hit) // most recently used
    return hit
  }
  const p: Promise<Synth> = (async () => {
    if (id.startsWith('qari:')) {
      const { wav, groups } = await piperSpeak(id.slice(5), text)
      return { url: URL.createObjectURL(new Blob([wav], { type: 'audio/wav' })), groups }
    }
    return { url: URL.createObjectURL(await azureSpeak(id.slice(6), text)) }
  })()
  memo.set(k, p)
  p.catch(() => memo.delete(k))
  while (memo.size > 12) {
    const [oldKey, old] = memo.entries().next().value!
    memo.delete(oldKey)
    old.then((s) => setTimeout(() => URL.revokeObjectURL(s.url), 60000)).catch(() => {})
  }
  return p
}

/** At startup: learn which Qari voices are downloaded and whether Azure is available. */
export async function initVoices() {
  checkAzure()
  let code = getSettings().translateCode
  onSettingsChange(() => {
    if (getSettings().translateCode === code) return
    code = getSettings().translateCode
    checkAzure()
  })
  try {
    const cache = await caches.open('qari-voice-models')
    const keys = await cache.keys()
    const have = keys.map((r) => r.url).filter((u) => u.endsWith('.onnx')).map((u) => u.split('/').pop()!.replace(/\.onnx$/, ''))
    set({ downloaded: new Set(have) })
  } catch {
    /* no cache storage */
  }
}
