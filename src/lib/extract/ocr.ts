import { createWorker, type Worker } from 'tesseract.js'
import type { Chapter } from '../../types'
import type { Extracted } from './pdf'

/** Reading languages that text recognition supports, mapped to Tesseract's language codes. */
export const OCR_LANGS: Record<string, string> = { en: 'eng', ar: 'ara', fr: 'fra', de: 'deu' }

export type OcrSource = Blob | (() => Promise<HTMLCanvasElement>)

interface OcrPara {
  text: string
  heading: boolean
  page: number
}

const abs = (p: string) => new URL(p, location.href).href

async function makeWorker(lang: string, onLoad: (p: number) => void): Promise<Worker> {
  return createWorker(OCR_LANGS[lang] || 'eng', 1 /* LSTM only: matches the bundled "best_int" data */, {
    workerPath: abs('/ocr/worker.min.js'),
    corePath: abs('/ocr/core/'),
    langPath: abs('/ocr/lang'),
    gzip: true,
    logger: (m: { status: string; progress: number }) => {
      if (/load|initializ/i.test(m.status)) onLoad(m.progress)
    },
  })
}

/** Draws a photo onto a canvas, upright and at most ~3000 px on its long side (enough for OCR, fast on phones). */
async function toCanvas(blob: Blob): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' })
  const scale = Math.min(1, 3000 / Math.max(bmp.width, bmp.height))
  const c = document.createElement('canvas')
  c.width = Math.round(bmp.width * scale)
  c.height = Math.round(bmp.height * scale)
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.drawImage(bmp, 0, 0, c.width, c.height)
  bmp.close()
  return c
}

type TLine = { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number }; rowAttributes?: { row_height?: number } }
type TBlock = { paragraphs: { lines: TLine[] }[] }

/** The value below which `q` of the numbers fall (0.5 = median). Robust on pages with only a few lines. */
const pct = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor((s.length - 1) * q)] || 0
}

/** Removes invisible direction marks and puts Arabic punctuation back where the recognizer used Latin marks. */
function tidy(text: string, rtl: boolean) {
  let t = text.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').normalize('NFKC')
  if (rtl) {
    t = t
      .replace(/(?<=[\u0600-\u06ff])\s*,/g, '،')
      .replace(/(?<=[\u0600-\u06ff])\s*;/g, '؛')
      .replace(/(?<=[\u0600-\u06ff])\s*\?/g, '؟')
  }
  return t.replace(/\s+/g, ' ').trim()
}

/**
 * Rebuilds paragraphs from the recognized lines, the way the PDF reader does: a bigger gap, a change in
 * text size, or a short line that ends a sentence starts a new paragraph. Larger text becomes a heading.
 */
function paragraphsOf(blocks: TBlock[] | null, page: number, rtl: boolean): OcrPara[] {
  type L = { text: string; top: number; bottom: number; left: number; right: number; size: number; block: number }
  const lines: L[] = []
  ;(blocks || []).forEach((b, bi) => {
    for (const p of b.paragraphs)
      for (const l of p.lines) {
        const text = tidy(l.text, rtl)
        if (!text) continue
        if (/^[\d\s\-–—.|·•()[\]]+$/.test(text) && text.length < 8) continue // page numbers, rules
        if (l.confidence < 30 && text.length < 6) continue // specks and smudges
        const size = l.rowAttributes?.row_height || l.bbox.y1 - l.bbox.y0
        lines.push({ text, top: l.bbox.y0, bottom: l.bbox.y1, left: l.bbox.x0, right: l.bbox.x1, size, block: bi })
      }
  })
  if (!lines.length) return []
  // Typical body-text size and line spacing: the smaller common values, so headings and paragraph gaps stand out.
  const body = pct(lines.map((l) => l.size), 0.4)
  const gaps: number[] = []
  for (let i = 1; i < lines.length; i++) {
    const g = lines[i].top - lines[i - 1].top
    if (g > 0 && g < body * 3 && Math.abs(lines[i].size - body) < body * 0.25) gaps.push(g)
  }
  const step = pct(gaps, 0.3) || body * 1.5
  // Margins: where full lines start and end.
  const textLeft = pct(lines.map((l) => l.left), 0.1)
  const textRight = pct(lines.map((l) => l.right), 0.9)
  const width = Math.max(1, textRight - textLeft)
  const big = (l: L) => l.size > body * 1.3

  const out: OcrPara[] = []
  let cur: L[] = []
  const flush = () => {
    if (!cur.length) return
    let text = ''
    for (const l of cur) {
      if (!text) text = l.text
      else if (!rtl && /[A-Za-zÀ-ÿ]-$/.test(text) && /^[a-zà-ÿ]/.test(l.text)) text = text.slice(0, -1) + l.text // re-join hyphenated words
      else text += ' ' + l.text
    }
    const heading = cur.every(big) && text.length < 120 && !/[.,;:،؛]$/.test(text)
    if (text.length >= 2) out.push({ text, heading, page })
    cur = []
  }
  for (const l of lines) {
    const prev = cur[cur.length - 1]
    if (prev) {
      const dy = l.top - prev.top
      const sizeChange = big(l) !== big(prev)
      const bigGap = dy > step * 1.45 || dy < -body // also a jump back up to a new column
      // A line that stops well short of the margin and ends a sentence closes its paragraph.
      const short = rtl ? prev.left > textLeft + width * 0.2 : prev.right < textRight - width * 0.2
      const ended = short && /[.!?:"”»؟]$/.test(prev.text)
      if (sizeChange || bigGap || ended) flush()
    }
    cur.push(l)
  }
  flush()
  return out
}

/**
 * Recognizes text in photos or rendered PDF pages, on the device.
 * Returns sections like the other importers, with a page number for each paragraph.
 */
export async function ocrPages(
  sources: OcrSource[],
  lang: string,
  onProgress: (p: number, label: string) => void,
  pageLabels?: (i: number) => string,
): Promise<Extracted> {
  const rtl = lang === 'ar'
  onProgress(0, 'Getting text recognition ready')
  const worker = await makeWorker(lang, (p) => onProgress(p * 0.08, 'Getting text recognition ready (first time only)'))
  const paras: OcrPara[] = []
  try {
    for (let i = 0; i < sources.length; i++) {
      onProgress(0.08 + (0.92 * i) / sources.length, `Reading page ${i + 1} of ${sources.length}`)
      const src = sources[i]
      const canvas = typeof src === 'function' ? await src() : await toCanvas(src)
      const { data } = await worker.recognize(canvas, {}, { blocks: true, text: false })
      for (const p of paragraphsOf(data.blocks as unknown as TBlock[], i, rtl)) {
        const prev = paras[paras.length - 1]
        // A paragraph that continues onto the next page: join it back together (Latin scripts only).
        if (prev && prev.page !== p.page && !rtl && !prev.heading && !p.heading && !/[.!?:"”]$/.test(prev.text) && /^[a-zà-ÿ(,;]/.test(p.text)) {
          prev.text = /[A-Za-z]-$/.test(prev.text) ? prev.text.slice(0, -1) + p.text : prev.text + ' ' + p.text
        } else paras.push(p)
      }
      canvas.width = canvas.height = 0
    }
  } finally {
    await worker.terminate()
  }
  onProgress(1, 'Done')
  if (!paras.length) throw new Error('No text could be read. Try a sharper, well-lit photo taken straight on, with the page filling the frame.')

  const label = pageLabels || ((i: number) => String(i + 1))
  const toChapter = (title: string, ps: OcrPara[]): Chapter => ({
    title,
    blocks: ps.map((p) => p.text),
    headings: ps.flatMap((p, i) => (p.heading ? [i] : [])),
    pages: ps.map((p) => label(p.page)),
    pageIdx: ps.map((p) => p.page),
  })
  // Sections at detected headings when there are a few, otherwise ten pages per section.
  const headIdx = paras.flatMap((p, i) => (p.heading && !paras[i - 1]?.heading ? [i] : []))
  let chapters: Chapter[]
  if (headIdx.length >= 2 && headIdx.length <= paras.length / 3) {
    const starts = headIdx[0] > 0 ? [0, ...headIdx] : headIdx
    chapters = starts.map((st, k) => {
      const ps = paras.slice(st, starts[k + 1] ?? paras.length)
      return toChapter(ps[0].heading ? ps[0].text.slice(0, 120) : 'Beginning', ps)
    })
  } else {
    const n = sources.length
    chapters = Array.from({ length: Math.ceil(n / 10) }, (_, k) => {
      const ps = paras.filter((p) => p.page >= k * 10 && p.page < (k + 1) * 10)
      return toChapter(n <= 10 ? 'Scanned pages' : `Pages ${label(k * 10)}–${label(Math.min(n, (k + 1) * 10) - 1)}`, ps)
    }).filter((c) => c.blocks.length)
  }
  const first = paras.find((p) => p.text.length > 3)?.text || 'Scan'
  return { title: first.length > 70 ? first.slice(0, 67).replace(/\s\S*$/, '') + '…' : first, lang, chapters }
}
