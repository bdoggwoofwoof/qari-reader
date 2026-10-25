/// <reference types="node" />
import { timingSafeEqual } from 'node:crypto'

/**
 * Optional, better translation with Claude: meaning in context, idioms, and which variety of Arabic.
 * Off unless both are set in Vercel → Settings → Environment Variables:
 *   ANTHROPIC_API_KEY   – your Anthropic API key (usage is billed to it; a lookup costs a fraction of a cent)
 *   QARI_ACCESS_CODE    – any passphrase; enter the same one in Qari's reading settings
 * Without them, Qari uses the free MyMemory service from the device instead.
 *
 *   GET  /api/translate → { claude: boolean }
 *   POST /api/translate { text, from, to, context? } with header X-Qari-Code → { translation, notes }
 */

const MODEL = process.env.QARI_TRANSLATE_MODEL || 'claude-haiku-5-5'
const NAMES: Record<string, string> = {
  en: 'English', ar: 'Arabic', fr: 'French', de: 'German', es: 'Spanish', it: 'Italian', pt: 'Portuguese',
  tr: 'Turkish', fa: 'Persian', ur: 'Urdu', he: 'Hebrew', ru: 'Russian', nl: 'Dutch', el: 'Greek',
}

function json(status: number, body: unknown) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

function codeMatches(given: string) {
  const want = process.env.QARI_ACCESS_CODE || ''
  if (!want || !given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(want)
  return a.length === b.length && timingSafeEqual(a, b)
}

export default {
  async fetch(request: Request) {
    const configured = !!process.env.ANTHROPIC_API_KEY && !!process.env.QARI_ACCESS_CODE
    if (request.method === 'GET') return json(200, { claude: configured })
    if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' })
    if (!configured) return json(503, { error: 'Claude translation isn’t set up on this deployment.' })
    if (!codeMatches(request.headers.get('x-qari-code') || '')) return json(401, { error: 'Wrong access code.' })

    let body: { text?: string; from?: string; to?: string; context?: string }
    try {
      body = await request.json()
    } catch {
      return json(400, { error: 'Bad request.' })
    }
    const text = (body.text || '').trim().slice(0, 2000)
    if (!text) return json(400, { error: 'Nothing to translate.' })
    const from = NAMES[body.from || ''] || 'the source language'
    const to = NAMES[body.to || 'en'] || 'English'
    const context = (body.context || '').trim().slice(0, 1000)
    const single = text.split(/\s+/).length <= 6 && context && context !== text

    const system = [
      `You help a language learner reading ${from}. Reply with JSON only, no code fences: {"translation": string, "notes": string}.`,
      `"translation": a natural ${to} translation${single ? ' of the word or phrase as it is used in the given sentence' : ''}.`,
      `"notes": at most two short sentences, or "" if nothing useful. For a word or phrase: the dictionary form (for Arabic also the root), and the literal meaning if it is an idiom.`,
      `For Arabic, say whether it is Modern Standard Arabic or a dialect (e.g. Levantine/Shami, Egyptian, Gulf, Iraqi) when that is clear.`,
    ].join(' ')
    const user = single ? `Word or phrase: ${text}\nSentence: ${context}` : text

    let r: Response
    try {
      r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: AbortSignal.timeout(20000),
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY!,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model: MODEL, max_tokens: 500, system, messages: [{ role: 'user', content: user }] }),
      })
    } catch {
      return json(502, { error: 'Claude didn’t respond.' })
    }
    if (!r.ok) return json(502, { error: `Claude returned an error (${r.status}).` })
    const data = (await r.json()) as { content?: { type: string; text?: string }[] }
    const out = data.content?.find((c) => c.type === 'text')?.text || ''
    try {
      const parsed = JSON.parse(out.replace(/^```(?:json)?\s*|\s*```$/g, ''))
      return json(200, { translation: String(parsed.translation || '').trim(), notes: String(parsed.notes || '').trim() })
    } catch {
      return json(200, { translation: out.trim(), notes: '' })
    }
  },
}
