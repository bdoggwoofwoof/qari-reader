/// <reference types="node" />
import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'

/**
 * Fetches a web page and returns just the article (title, author, body HTML), like a browser's reader view.
 *   GET /api/article?url=https://…
 * The page is fetched by this function, not your browser, because most sites don't allow other sites to read them.
 */

const MAX_BYTES = 6 * 1024 * 1024
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'

function reply(status: number, body: unknown) {
  return Response.json(body, { status, headers: { 'Cache-Control': status === 200 ? 'private, max-age=600' : 'no-store' } })
}

/** Refuses addresses that point inside a network rather than at the public web. */
function isPrivateHost(host: string) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (process.env.QARI_ALLOW_LOCAL === '1') return false // local tests only
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.') && !h.includes(':')) return true
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
  }
  if (h.includes(':')) return h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80') || h === '::'
  return false
}

function charsetOf(contentType: string, head: string) {
  const fromHeader = contentType.match(/charset=["']?([\w-]+)/i)?.[1]
  if (fromHeader) return fromHeader
  return head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] || 'utf-8'
}

async function readLimited(res: Response) {
  const reader = res.body?.getReader()
  if (!reader) return new Uint8Array()
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > MAX_BYTES) {
      await reader.cancel()
      throw new Error('too-large')
    }
    parts.push(value)
  }
  const out = new Uint8Array(size)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

export default {
  async fetch(request: Request) {
    const raw = new URL(request.url).searchParams.get('url') || ''
    let target: URL
    try {
      target = new URL(raw.trim())
    } catch {
      return reply(400, { error: 'That doesn’t look like a web address.' })
    }
    if (!/^https?:$/.test(target.protocol) || isPrivateHost(target.hostname)) return reply(400, { error: 'Only public web pages (http or https) can be added.' })

    let res: Response
    let url = target
    try {
      // Follow redirects by hand so each hop is checked too.
      for (let hop = 0; ; hop++) {
        res = await fetch(url, {
          redirect: 'manual',
          signal: AbortSignal.timeout(15000),
          headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'Accept-Language': 'en,ar;q=0.8,fr;q=0.6,de;q=0.5' },
        })
        const loc = res.headers.get('location')
        if (res.status >= 300 && res.status < 400 && loc) {
          if (hop >= 5) return reply(502, { error: 'That page redirects too many times.' })
          url = new URL(loc, url)
          if (!/^https?:$/.test(url.protocol) || isPrivateHost(url.hostname)) return reply(400, { error: 'That link leads somewhere that can’t be added.' })
          continue
        }
        break
      }
    } catch {
      return reply(502, { error: 'The site didn’t respond. Check the link, or try again in a moment.' })
    }
    if (res!.status === 401 || res!.status === 403) return reply(502, { error: 'The site blocked the request (it may need a login or block apps). Copy the article text and use Paste text instead.' })
    if (!res!.ok) return reply(502, { error: `The site answered with an error (${res!.status}).` })
    const type = res!.headers.get('content-type') || ''
    if (/application\/pdf/i.test(type)) return reply(415, { error: 'That link is a PDF. Download it, then add the file.' })
    if (type && !/html|xml/i.test(type)) return reply(415, { error: 'That link isn’t a web page with text.' })

    let bytes: Uint8Array
    try {
      bytes = await readLimited(res!)
    } catch {
      return reply(413, { error: 'That page is too large to add.' })
    }
    const head = new TextDecoder('latin1').decode(bytes.slice(0, 4096))
    let html: string
    try {
      html = new TextDecoder(charsetOf(type, head)).decode(bytes)
    } catch {
      html = new TextDecoder('utf-8').decode(bytes)
    }

    const { document } = parseHTML(html)
    const lang = document.documentElement?.getAttribute('lang') || undefined
    const article = new Readability(document as unknown as Document, { charThreshold: 200 }).parse()
    if (!article?.content || (article.textContent || '').trim().length < 200) {
      return reply(422, { error: 'No article text was found on that page. If the text loads only after you sign in or scroll, copy it and use Paste text instead.' })
    }
    return reply(200, {
      url: url.href,
      title: article.title || url.hostname,
      byline: article.byline || undefined,
      siteName: article.siteName || url.hostname.replace(/^www\./, ''),
      lang: article.lang || lang,
      dir: article.dir || undefined,
      html: article.content,
    })
  },
}
