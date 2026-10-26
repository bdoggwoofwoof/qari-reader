import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { Chapter } from '../../types'
import { NeedsOcrError } from './errors'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

interface Line {
  text: string
  x: number
  y: number // from top of page
  size: number
  width: number
  rtl?: boolean // Arabic, Persian or Hebrew line: x is still its left edge
}

interface PageLines {
  lines: Line[]
  height: number
}

export interface Extracted {
  title?: string
  author?: string
  lang?: string
  chapters: Chapter[]
}

type TextItem = { str: string; transform: number[]; width: number; height: number; hasEOL: boolean }

function median(nums: number[]) {
  if (!nums.length) return 0
  const s = [...nums].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

const clean = (s: string) =>
  s
    .normalize('NFKC') // turns Arabic presentation forms and ligatures (ﬁ) back into normal letters
    .replace(/[­​]/g, '')
    .replace(/\s+/g, ' ')

const RTL_CHAR = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/g
const LTR_CHAR = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF0-9]/g

/** A line is right-to-left when most of its letters are Arabic or Hebrew script. */
export function isRtlLine(text: string) {
  const r = text.match(RTL_CHAR)?.length || 0
  return r > 0 && r >= (text.match(LTR_CHAR)?.length || 0)
}

/**
 * PDFs store right-to-left lines as pieces in visual (left-to-right) order, each piece already in reading order.
 * Read the pieces from right to left, but keep runs of Latin words and numbers inside the line left to right.
 */
export function rtlOrder<T extends { text: string; x: number }>(parts: T[]): T[] {
  const sorted = [...parts].sort((a, b) => b.x - a.x)
  const strongLtr = (p: T) => /[A-Za-z\u00C0-\u024F0-9]/.test(p.text) && !/[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/.test(p.text)
  const neutral = (p: T) => !/[\p{L}\p{N}]/u.test(p.text)
  const out: T[] = []
  let i = 0
  while (i < sorted.length) {
    if (!strongLtr(sorted[i])) {
      out.push(sorted[i++])
      continue
    }
    // Extend over neutrals (spaces, dots) only when another Latin piece follows.
    let j = i
    let k = i + 1
    while (k < sorted.length && (strongLtr(sorted[k]) || neutral(sorted[k]))) {
      if (strongLtr(sorted[k])) j = k
      k++
    }
    out.push(...sorted.slice(i, j + 1).reverse())
    i = j + 1
  }
  return out
}

async function pageLines(page: pdfjs.PDFPageProxy): Promise<PageLines> {
  const viewport = page.getViewport({ scale: 1 })
  const content = await page.getTextContent()
  const items = (content.items as unknown[]).filter((i): i is TextItem => typeof (i as TextItem).str === 'string')

  const lines: Line[] = []
  let cur: { parts: { text: string; x: number; end: number; size: number }[]; y: number; size: number } | null = null
  let breakNext = false

  const flush = () => {
    if (!cur || !cur.parts.length) return
    // Drop tiny footnote-marker numbers that sit raised inside a line ("word¹").
    const main = median(cur.parts.map((p) => p.size))
    const rtl = isRtlLine(cur.parts.map((p) => p.text).join(''))
    const parts = rtl ? rtlOrder(cur.parts) : cur.parts
    let text = ''
    let prev: { x: number; end: number } | null = null
    for (const p of parts) {
      if (/^\d{1,3}[a-z]?$/.test(p.text.trim()) && p.size < main * 0.75) continue
      if (prev && text && !/\s$/.test(text) && !/^\s/.test(p.text)) {
        const gap = rtl ? Math.min(Math.abs(prev.x - p.end), Math.abs(p.x - prev.end)) : Math.abs(p.x - prev.end)
        if (gap > main * 0.18) text += ' '
      }
      text += p.text
      prev = p
    }
    text = clean(text).trim()
    if (text) {
      const xs = cur.parts.map((p) => p.x)
      const ends = cur.parts.map((p) => p.end)
      lines.push({ text, x: Math.min(...xs), y: cur.y, size: main, width: Math.max(...ends) - Math.min(...xs), rtl })
    }
    cur = null
  }

  for (const it of items) {
    const [a, b, , , e, f] = it.transform
    const size = Math.hypot(a, b) || it.height || 10
    const y = viewport.height - f
    if (!it.str) {
      if (it.hasEOL) breakNext = true
      continue
    }
    if (!cur || breakNext || Math.abs(y - cur.y) > Math.max(cur.size, size) * 0.55) {
      flush()
      cur = { parts: [], y, size }
    }
    breakNext = it.hasEOL
    cur.parts.push({ text: it.str, x: e, end: e + it.width, size })
  }
  flush()
  return { lines, height: viewport.height }
}

/** Lines that repeat on many pages near the top or bottom are running headers/footers. */
function findRepeating(pages: PageLines[]) {
  const counts = new Map<string, number>()
  const key = (t: string) => t.replace(/\d+/g, '#').toLowerCase()
  for (const p of pages) {
    const seen = new Set<string>()
    for (const l of p.lines) {
      if (l.y < p.height * 0.1 || l.y > p.height * 0.9) seen.add(key(l.text))
    }
    for (const k of seen) counts.set(k, (counts.get(k) || 0) + 1)
  }
  const threshold = Math.max(3, pages.length * 0.3)
  const repeating = new Set<string>()
  for (const [k, c] of counts) if (c >= threshold) repeating.add(k)
  return (l: Line, p: PageLines) =>
    (l.y < p.height * 0.1 || l.y > p.height * 0.9) && (repeating.has(key(l.text)) || /^[-–—\s]*\d{1,4}[-–—\s]*$|^page \d+/i.test(l.text))
}

interface Block {
  text: string
  heading: boolean
  page: number
  pageEnd?: number // set when a paragraph runs onto the next page
}

function pageBlocks(p: PageLines, pageIndex: number, isNoise: (l: Line, p: PageLines) => boolean, bodySize: number, docGap: number): Block[] {
  const lines = p.lines.filter((l) => !isNoise(l, p))
  // Footnotes: small text in the lower part of the page.
  const body = lines.filter((l) => !(l.size < bodySize * 0.84 && l.y > p.height * 0.62))
  if (!body.length) return []

  // Normal line spacing, measured across the whole document so short pages aren't fooled.
  const lineGap = docGap || bodySize * 1.3
  const leftX = median(body.filter((l) => Math.abs(l.size - bodySize) < bodySize * 0.15).map((l) => l.x))
  const rightX = median(body.filter((l) => Math.abs(l.size - bodySize) < bodySize * 0.15).map((l) => l.x + l.width))
  const fullWidth = Math.max(...body.map((l) => l.width))

  const blocks: Block[] = []
  let buf: Line[] = []
  const push = () => {
    if (!buf.length) return
    let text = ''
    for (const l of buf) {
      if (!text) text = l.text
      else if (/[A-Za-zÀ-ÿ]-$/.test(text) && /^[a-zà-ÿ]/.test(l.text)) text = text.slice(0, -1) + l.text
      else text += ' ' + l.text
    }
    const size = median(buf.map((l) => l.size))
    const heading = size > bodySize * 1.2 && text.length < 160
    blocks.push({ text: text.trim(), heading, page: pageIndex })
    buf = []
  }

  for (let i = 0; i < body.length; i++) {
    const l = body[i]
    const prev = body[i - 1]
    if (prev) {
      const gap = l.y - prev.y
      const sizeChange = Math.abs(l.size - prev.size) > bodySize * 0.18
      const bigGap = gap > lineGap * 1.45 || gap < -lineGap // also a column jump back up
      const indented = l.rtl
        ? l.x + l.width < rightX - bodySize * 1.2 && l.x + l.width > rightX - bodySize * 6 && Math.abs(prev.x + prev.width - rightX) < bodySize
        : l.x > leftX + bodySize * 1.2 && l.x < leftX + bodySize * 6 && Math.abs(prev.x - leftX) < bodySize
      const prevShortEnd = prev.width < fullWidth * 0.72 && /[.!?:"”'’؟。)]$/.test(prev.text)
      if (bigGap || sizeChange || indented || prevShortEnd) push()
    }
    buf.push(l)
  }
  push()
  return blocks
}

async function outlineChapters(doc: pdfjs.PDFDocumentProxy): Promise<{ title: string; page: number }[]> {
  try {
    const outline = await doc.getOutline()
    if (!outline?.length) return []
    const out: { title: string; page: number }[] = []
    for (const item of outline) {
      try {
        let dest = item.dest
        if (typeof dest === 'string') dest = await doc.getDestination(dest)
        if (!Array.isArray(dest) || !dest[0]) continue
        const ref = dest[0]
        const page = typeof ref === 'number' ? ref : await doc.getPageIndex(ref)
        out.push({ title: clean(item.title).trim() || 'Section', page })
      } catch {
        /* unresolvable entry */
      }
    }
    out.sort((a, b) => a.page - b.page)
    return out.length >= 2 ? out : []
  } catch {
    return []
  }
}

/** Opens a PDF for viewing pages (the worker is already configured above). */
export async function openPdf(data: ArrayBuffer) {
  const task = pdfjs.getDocument({ data: new Uint8Array(data) })
  return { doc: await task.promise, close: () => task.destroy() }
}

export async function extractPdf(data: ArrayBuffer, onProgress?: (p: number) => void): Promise<Extracted> {
  const task = pdfjs.getDocument({ data: new Uint8Array(data) })
  const doc = await task.promise
  const pages: PageLines[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    pages.push(await pageLines(page))
    page.cleanup()
    onProgress?.(i / doc.numPages)
  }

  const totalChars = pages.reduce((n, p) => n + p.lines.reduce((m, l) => m + l.text.length, 0), 0)
  if (totalChars < doc.numPages * 20) {
    const n = doc.numPages
    await task.destroy()
    throw new NeedsOcrError(n)
  }

  // Body text size = the size most characters are set in.
  const sizeChars = new Map<number, number>()
  for (const p of pages) for (const l of p.lines) sizeChars.set(Math.round(l.size * 2) / 2, (sizeChars.get(Math.round(l.size * 2) / 2) || 0) + l.text.length)
  const bodySize = [...sizeChars.entries()].sort((a, b) => b[1] - a[1])[0][0]

  const isNoise = findRepeating(pages)
  const gaps: number[] = []
  for (const p of pages) {
    const ls = p.lines.filter((l) => Math.abs(l.size - bodySize) < bodySize * 0.15 && !isNoise(l, p))
    for (let i = 1; i < ls.length; i++) {
      const g = ls[i].y - ls[i - 1].y
      if (g > 0 && g < bodySize * 4) gaps.push(g)
    }
  }
  const docGap = median(gaps)
  const blocks: Block[] = []
  pages.forEach((p, i) => {
    for (const b of pageBlocks(p, i, isNoise, bodySize, docGap)) {
      const prev = blocks[blocks.length - 1]
      // A paragraph that runs over a page break: join it back together.
      if (prev && b.page !== prev.page && !prev.heading && !b.heading && !/[.!?:"”؟]$/.test(prev.text) && /^[a-zà-ÿ(,;]/.test(b.text)) {
        prev.text = /[A-Za-z]-$/.test(prev.text) ? prev.text.slice(0, -1) + b.text : prev.text + ' ' + b.text
        prev.pageEnd = b.page
      } else {
        blocks.push(b)
      }
    }
  })

  // Printed page numbers ("xii", "45") when the PDF defines them, so highlights cite the page you'd quote.
  let labels: string[] | null = null
  try {
    labels = await doc.getPageLabels()
  } catch {
    labels = null
  }
  const label = (i: number) => labels?.[i]?.trim() || String(i + 1)
  const toChapter = (title: string, bs: Block[]): Chapter => ({
    title,
    blocks: bs.map((b) => b.text),
    headings: bs.flatMap((b, i) => (b.heading ? [i] : [])),
    pages: bs.map((b) => (b.pageEnd !== undefined && b.pageEnd !== b.page ? `${label(b.page)}–${label(b.pageEnd)}` : label(b.page))),
    pageIdx: bs.map((b) => b.page),
  })

  // Split into chapters: the PDF's own outline, else its headings, else groups of ten pages.
  const outline = await outlineChapters(doc)
  const headingIdx = blocks.flatMap((b, i) => (b.heading ? [i] : []))
  if (!outline.length && headingIdx.length >= 2 && headingIdx.length <= 400) {
    // A run of headings ("Part I", "Chapter 1") starts one section, titled by its last heading.
    const runStarts = headingIdx.filter((i) => !blocks[i - 1]?.heading)
    const starts = runStarts[0] > 0 ? [0, ...runStarts] : runStarts
    const chapters: Chapter[] = starts.map((st, k) => {
      const bs = blocks.slice(st, starts[k + 1] ?? blocks.length)
      let t = 0
      while (bs[t + 1]?.heading) t++
      return toChapter(bs[0].heading ? bs[t].text.slice(0, 120) : 'Beginning', bs)
    })
    return finishMeta(doc, task, chapters)
  }
  const bounds =
    outline.length > 0
      ? outline.map((o, i) => ({ title: o.title, from: i === 0 ? 0 : o.page, to: outline[i + 1]?.page ?? Infinity }))
      : Array.from({ length: Math.ceil(doc.numPages / 10) }, (_, i) => ({
          title: i * 10 === Math.min((i + 1) * 10, doc.numPages) - 1 ? `Page ${label(i * 10)}` : `Pages ${label(i * 10)}–${label(Math.min((i + 1) * 10, doc.numPages) - 1)}`,
          from: i * 10,
          to: (i + 1) * 10,
        }))

  const chapters: Chapter[] = bounds
    .map((bd) => {
      const bs = blocks.filter((b) => b.page >= bd.from && b.page < bd.to)
      return toChapter(bd.title, bs)
    })
    .filter((c) => c.blocks.length > 0)

  return finishMeta(doc, task, chapters)
}

async function finishMeta(doc: pdfjs.PDFDocumentProxy, task: pdfjs.PDFDocumentLoadingTask, chapters: Chapter[]): Promise<Extracted> {
  let title: string | undefined
  let author: string | undefined
  let lang: string | undefined
  try {
    const meta = await doc.getMetadata()
    const info = meta.info as { Title?: string; Author?: string; Language?: string }
    title = info.Title?.trim() || undefined
    author = info.Author?.trim() || undefined
    lang = info.Language || undefined
  } catch {
    /* no metadata */
  }
  await task.destroy()
  return { title, author, lang, chapters }
}

/**
 * Prepares each page of a scanned PDF for text recognition: a function per page that renders it
 * at about 300 dpi when called, so only one page is in memory at a time.
 */
export async function pdfPagesForOcr(data: ArrayBuffer) {
  const { doc, close } = await openPdf(data)
  let labels: string[] | null = null
  try {
    labels = await doc.getPageLabels()
  } catch {
    labels = null
  }
  const sources = Array.from({ length: doc.numPages }, (_, i) => async () => {
    const page = await doc.getPage(i + 1)
    const base = page.getViewport({ scale: 1 })
    const scale = Math.min(300 / 72, 3200 / Math.max(base.width, base.height))
    const vp = page.getViewport({ scale })
    const c = document.createElement('canvas')
    c.width = Math.round(vp.width)
    c.height = Math.round(vp.height)
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, c.width, c.height)
    await page.render({ canvas: c, canvasContext: ctx, viewport: vp }).promise
    page.cleanup()
    return c
  })
  return { sources, label: (i: number) => labels?.[i]?.trim() || String(i + 1), close }
}
