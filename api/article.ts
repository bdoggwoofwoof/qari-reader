/// <reference types="node" />
import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { isIP } from 'node:net'
import { Agent, fetch as undiciFetch } from 'undici'

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

// ---------- Refusing private addresses ----------
/**
 * Fetching a link someone pasted, without letting it reach anything private (this server, its cloud's
 * metadata service, other internal machines). The address a name resolves to is checked, and the connection
 * is made to that checked address, so a name can't resolve one way for the check and another way to connect.
 */

function v4Private(ip: string) {
  const [a, b] = ip.split('.').map(Number)
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || ip.startsWith('192.0.0.'))) ||
    (a === 198 && (b === 18 || b === 19))
  )
}

/** Expands an IPv6 address into its eight 16-bit groups (handles "::" and a trailing dotted IPv4). */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/%.*$/, '')
  const dotted = s.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) {
    const [a, b, c, d] = dotted[1].split('.').map(Number)
    s = s.slice(0, -dotted[1].length) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16)
  }
  const [head, tail] = s.split('::')
  const h = head ? head.split(':') : []
  const t = tail !== undefined && tail ? tail.split(':') : []
  const fill = s.includes('::') ? 8 - h.length - t.length : 0
  const groups = [...h, ...Array(fill).fill('0'), ...t].map((g) => parseInt(g, 16))
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null
}

export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip.replace(/%.*$/, ''))
  if (kind === 4) return v4Private(ip)
  if (kind !== 6) return true
  const g = v6Groups(ip)
  if (!g) return true
  const embedded = () => [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join('.')
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    // ::ffff:a.b.c.d (IPv4-mapped), ::a.b.c.d (IPv4-compatible), ::1 and ::
    return g[5] === 0 && g[6] === 0 ? true : v4Private(embedded())
  }
  if (g[0] === 0x64 && g[1] === 0xff9b) return true // NAT64
  if (g[0] === 0x2002) return true // 6to4 can wrap any IPv4 address
  return (g[0] & 0xfe00) === 0xfc00 || g[0] >= 0xfe80 // unique local, link/site-local, multicast
}

/** Names that never belong to the public web. */
export function isPrivateName(host: string) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')
  if (isIP(h)) return isPrivateAddress(h)
  return h === 'localhost' || !h.includes('.') || /\.(localhost|local|internal|home\.arpa|lan)$/.test(h)
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void

function safeLookup(hostname: string, options: { all?: boolean }, cb: LookupCb) {
  dnsLookup(hostname, { all: true }, (err, addresses) => {
    if (err) return cb(err, '')
    const bad = addresses.find((a) => isPrivateAddress(a.address))
    if (bad || !addresses.length) {
      const e = new Error(`Refusing private address for ${hostname}`) as NodeJS.ErrnoException
      e.code = 'EPRIVATE'
      return cb(e, '')
    }
    if (options.all) cb(null, addresses)
    else cb(null, addresses[0].address, addresses[0].family)
  })
}

const agent = new Agent({ connect: { lookup: safeLookup as never } })

export class PrivateAddressError extends Error {}

/** fetch() for a user-supplied public http(s) URL: private addresses are refused at connect time. */
export async function fetchPublic(url: URL, init: { signal: AbortSignal; headers: Record<string, string> }) {
  if (!/^https?:$/.test(url.protocol) || isPrivateName(url.hostname)) throw new PrivateAddressError()
  try {
    return (await undiciFetch(url, { ...init, redirect: 'manual', dispatcher: agent })) as unknown as Response
  } catch (e) {
    if ((e as { cause?: { code?: string } }).cause?.code === 'EPRIVATE') throw new PrivateAddressError()
    throw e
  }
}

/** Refuses addresses that point inside a network rather than at the public web (QARI_ALLOW_LOCAL=1 for local tests). */
function isPrivateHost(host: string) {
  if (process.env.QARI_ALLOW_LOCAL === '1') return false
  return isPrivateName(host)
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
    const signal = AbortSignal.timeout(20000) // for the whole request, redirects included
    const get = (u: URL, init: { signal: AbortSignal; headers: Record<string, string> }) =>
      process.env.QARI_ALLOW_LOCAL === '1' ? fetch(u, { ...init, redirect: 'manual' }) : fetchPublic(u, init)
    try {
      // Follow redirects by hand so each hop is checked too.
      for (let hop = 0; ; hop++) {
        res = await get(url, {
          signal,
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
    } catch (e) {
      if (e instanceof PrivateAddressError) return reply(400, { error: 'Only public web pages (http or https) can be added.' })
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
