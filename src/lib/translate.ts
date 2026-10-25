import type { Lang } from '../types'
import { getSettings } from './settings'

export interface Translation {
  text: string
  notes?: string
  engine: 'claude' | 'mymemory'
}

const cache = new Map<string, Promise<Translation>>()

function decodeEntities(s: string) {
  const t = document.createElement('textarea')
  t.innerHTML = s
  return t.value
}

/** Cuts text to at most `max` bytes of UTF-8 at a word boundary (MyMemory's limit is 500 bytes). */
function clipBytes(s: string, max: number) {
  const enc = new TextEncoder()
  if (enc.encode(s).length <= max) return s
  let out = ''
  for (const part of s.split(/(\s+)/)) {
    if (enc.encode(out + part).length > max - 3) break
    out += part
  }
  return out.trim() + '…'
}

/** Free machine translation, straight from this device (about 5,000 characters a day per device). */
async function viaMyMemory(text: string, from: Lang, to: Lang): Promise<Translation> {
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(clipBytes(text, 500))}&langpair=${from}|${to}`
  let r: Response
  try {
    r = await fetch(url)
  } catch {
    throw new Error('The translation service couldn’t be reached. Check your connection.')
  }
  const j = await r.json().catch(() => null)
  const out: string | undefined = j?.responseData?.translatedText
  if (!r.ok || j?.responseStatus !== 200 || !out) {
    if (/LIMIT|QUOTA|USED ALL/i.test(`${j?.responseDetails || ''} ${out || ''}`)) throw new Error('The free translation limit for today is used up. It resets tomorrow.')
    throw new Error('The text couldn’t be translated right now.')
  }
  if (/MYMEMORY WARNING/i.test(out)) throw new Error('The free translation limit for today is used up. It resets tomorrow.')
  return { text: decodeEntities(out), engine: 'mymemory' }
}

/** Claude, through this app's own server function (only when set up on your Vercel deployment). */
async function viaClaude(text: string, from: Lang, to: Lang, context: string | undefined, code: string): Promise<Translation | null> {
  try {
    const r = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Qari-Code': code },
      body: JSON.stringify({ text: text.slice(0, 2000), from, to, context: context?.slice(0, 1000) }),
    })
    if (!r.ok) return null // not set up, wrong code, or busy: fall back to the free service
    const j = await r.json()
    return j?.translation ? { text: j.translation, notes: j.notes || undefined, engine: 'claude' } : null
  } catch {
    return null
  }
}

/**
 * Translates a word, phrase or sentence. `context` is the sentence a word or phrase came from,
 * which Claude uses to give the meaning in context.
 */
export function translate(text: string, from: Lang, to: Lang = 'en', context?: string): Promise<Translation> {
  const code = getSettings().translateCode?.trim()
  const key = [code ? 'c' : 'm', from, to, text, context || ''].join('\u0000')
  let p = cache.get(key)
  if (!p) {
    p = (async () => {
      if (!navigator.onLine) throw new Error('You’re offline, so translation isn’t available.')
      if (code) {
        const c = await viaClaude(text, from, to, context, code)
        if (c) return c
      }
      return viaMyMemory(text, from, to)
    })()
    p.catch(() => cache.delete(key))
    cache.set(key, p)
  }
  return p
}

/** Whether the server has the optional Claude translation set up. */
export async function claudeStatus(): Promise<{ available: boolean }> {
  try {
    const r = await fetch('/api/translate')
    if (!r.ok) return { available: false }
    return { available: !!(await r.json()).claude }
  } catch {
    return { available: false }
  }
}
