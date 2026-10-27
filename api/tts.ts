/// <reference types="node" />
import { timingSafeEqual } from 'node:crypto'

/**
 * Optional Azure voices (Microsoft's neural voices, including Lebanese, Syrian and Jordanian Arabic).
 * Off unless these are set in Vercel → Settings → Environment Variables:
 *   AZURE_SPEECH_KEY     – key from an Azure "Speech" resource (the Free F0 tier stops at its monthly allowance, so it never bills)
 *   AZURE_SPEECH_REGION  – that resource's region, e.g. eastus
 *   QARI_ACCESS_CODE     – the same 20+ character passphrase used for Claude translation; enter it in Qari's reading settings
 *
 *   GET  /api/tts → { azure: boolean }
 *   POST /api/tts { text, voice } with header X-Qari-Code → audio/mpeg
 * Uses Azure's REST endpoint (plain HTTPS, fast to start). The app times the word highlight from the audio's length.
 */

const MIN_CODE = 20
const VOICE = /^[a-z]{2,3}-[A-Z]{2,4}-[A-Za-z]+(Multilingual)?Neural$/

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

const escapeXml = (t: string) => t.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!)

async function synthesize(text: string, voice: string): Promise<Response> {
  const region = process.env.AZURE_SPEECH_REGION!.trim().toLowerCase()
  if (!/^[a-z0-9]+$/.test(region)) throw new Error('bad region')
  const lang = voice.split('-').slice(0, 2).join('-')
  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}"><voice name="${voice}">${escapeXml(text)}</voice></speak>`
  return fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': process.env.AZURE_SPEECH_KEY!.trim(),
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'qari-reader',
    },
    body: ssml,
    signal: AbortSignal.timeout(20000),
  })
}

export default {
  async fetch(request: Request) {
    const configured = !!process.env.AZURE_SPEECH_KEY && !!process.env.AZURE_SPEECH_REGION && !!process.env.QARI_ACCESS_CODE
    const strong = (process.env.QARI_ACCESS_CODE || '').length >= MIN_CODE
    if (request.method === 'GET') return json(200, { azure: configured && strong })
    if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' })
    if (!configured) return json(503, { error: 'Azure voices aren’t set up on this deployment.' })
    if (!strong) return json(503, { error: `QARI_ACCESS_CODE must be at least ${MIN_CODE} characters. Set a longer one in Vercel.` })
    if (!codeMatches(request.headers.get('x-qari-code') || '')) return json(401, { error: 'Wrong access code.' })

    let body: { text?: string; voice?: string }
    try {
      body = await request.json()
    } catch {
      return json(400, { error: 'Bad request.' })
    }
    const text = (body.text || '').trim()
    const voice = body.voice || ''
    if (!text) return json(400, { error: 'Nothing to read.' })
    if (text.length > 1500) return json(413, { error: 'Too long for one request.' })
    if (!VOICE.test(voice)) return json(400, { error: 'Unknown voice.' })

    let res: Response
    try {
      res = await synthesize(text, voice)
    } catch {
      return json(504, { error: 'Azure didn’t answer in time.' })
    }
    if (res.ok) return new Response(await res.arrayBuffer(), { headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' } })
    // The Free (F0) tier answers 429 once this month's allowance is used up (or when too many requests come at once).
    if (res.status === 429) return json(429, { error: 'Azure’s free monthly amount is used up, or too many requests came at once.' })
    if (res.status === 401 || res.status === 403) return json(502, { error: 'Azure didn’t accept the key or region. Check AZURE_SPEECH_KEY and AZURE_SPEECH_REGION in Vercel.' })
    return json(502, { error: `Azure couldn’t read that sentence (${res.status}).` })
  },
}
