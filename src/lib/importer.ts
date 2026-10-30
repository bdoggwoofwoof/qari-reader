import type { DocContent, DocMeta } from '../types'
import { baseLang, detectLang } from './lang'
import { getDoc, saveDoc } from './db'
import { mapPosition } from './remap'
import type { Extracted } from './extract/pdf'

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

export type Progress = (p: number, label?: string) => void

/** File names like "scan0003", "document (2)" or "ar" say nothing: use the document's first heading instead. */
export function betterTitle(ex: Pick<Extracted, 'chapters'>, fileName: string) {
  const generic = fileName.trim().length <= 4 || /^(scan|document|doc|file|untitled|img|image|download|print|new|copy)[\s_-]*\(?\d*\)?$/i.test(fileName.trim()) || /^[\d\s_()-]+$/.test(fileName)
  if (!generic) return fileName
  const c = ex.chapters[0]
  const first = c?.headings?.find((i) => i < 5)
  const heading = first !== undefined ? c.blocks[first]?.trim() : undefined
  return heading && heading.length >= 3 && heading.length <= 120 ? heading : fileName
}

function finish(ex: Extracted, kind: DocMeta['kind'], fallbackTitle: string, extra: Partial<DocMeta> = {}): { meta: DocMeta; content: DocContent } {
  const id = extra.id || uid()
  const sample = ex.chapters
    .flatMap((c) => c.blocks)
    .join(' ')
    .slice(0, 30000)
  const detected = detectLang(sample, ex.lang ? baseLang(ex.lang) : 'en')
  // Trust the file's own language tag unless the text plainly says otherwise (e.g. tagged "en" but written in Arabic).
  const lang = ex.lang && (detected === baseLang(ex.lang) || !['ar', 'fa', 'he', 'ru', 'el'].includes(detected)) ? baseLang(ex.lang) : detected
  const charsBefore: number[] = []
  let total = 0
  for (const c of ex.chapters) {
    charsBefore.push(total)
    total += c.blocks.reduce((n, b) => n + b.length, 0)
  }
  const now = Date.now()
  const title = ex.title && !/^untitled|^microsoft word|\.docx?$/i.test(ex.title) ? ex.title : betterTitle(ex, fallbackTitle)
  return {
    meta: {
      id,
      title,
      author: ex.author,
      kind,
      lang,
      addedAt: now,
      openedAt: now,
      position: { chapter: 0, block: 0, offset: 0 },
      chapterCount: ex.chapters.length,
      charCount: total,
      charsBefore,
      ...extra,
    },
    content: { id, chapters: ex.chapters },
  }
}

const nameOf = (file: File) => file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim()

export function isImage(file: File) {
  return file.type.startsWith('image/') || /\.(jpe?g|png|heic|heif|webp|gif|bmp|tiff?)$/i.test(file.name)
}

/** PDFs, EPUBs, Word files, saved web pages and text files. Scanned PDFs throw NeedsOcrError (see importScannedPdf). */
export async function importFile(file: File, onProgress?: Progress, onPreview?: (first: { meta: DocMeta; content: DocContent }) => void) {
  const name = nameOf(file)
  const ext = file.name.split('.').pop()?.toLowerCase()
  const data = await file.arrayBuffer()
  if (ext === 'pdf' || file.type === 'application/pdf') {
    const { extractPdf } = await import('./extract/pdf')
    // A long PDF opens with its first pages (same id), and the full book replaces them when it's ready.
    const id = uid()
    const preview = onPreview && ((part: Extracted) => onPreview(finish(part, 'pdf', name, { id, importing: true })))
    return finish(await extractPdf(data, onProgress, preview), 'pdf', name, { id })
  }
  if (ext === 'epub' || file.type === 'application/epub+zip') {
    const { extractEpub } = await import('./extract/epub')
    return finish(await extractEpub(data, onProgress), 'epub', name)
  }
  if (ext === 'docx' || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const { extractDocx } = await import('./extract/docx')
    return finish(await extractDocx(data, name), 'docx', name)
  }
  if (ext === 'doc') throw new Error('Older Word (.doc) files can’t be read. Open it in Word or Pages and save it as .docx, then add that.')
  if (ext === 'html' || ext === 'htm' || file.type === 'text/html') {
    return importHtml(new TextDecoder().decode(data), name)
  }
  if (ext === 'txt' || ext === 'md' || file.type.startsWith('text/')) {
    return importText(new TextDecoder().decode(data), name)
  }
  throw new Error(`“${file.name}” isn’t a file Qari can read. It reads PDF, EPUB, Word (.docx), web pages, text, and photos of pages.`)
}

/** Photos of pages (one document, in the order given), read with text recognition. */
export async function importScans(files: File[], lang: string, onProgress: Progress) {
  const { ocrPages } = await import('./extract/ocr')
  const ex = await ocrPages(files, lang, onProgress)
  return finish({ ...ex, lang }, 'scan', 'Scanned pages')
}

/** A PDF made of page images, read with text recognition. Keeps the PDF's printed page numbers. */
export async function importScannedPdf(file: File, lang: string, onProgress: Progress) {
  const { pdfPagesForOcr } = await import('./extract/pdf')
  const { ocrPages } = await import('./extract/ocr')
  const { sources, label, close } = await pdfPagesForOcr(await file.arrayBuffer())
  try {
    const ex = await ocrPages(sources, lang, onProgress, label)
    return finish({ ...ex, title: undefined, lang }, 'pdf', nameOf(file))
  } finally {
    await close()
  }
}

/** HTML (a saved web page, or an article fetched by link) → sections at its headings. */
async function htmlToExtracted(html: string, fallbackTitle: string): Promise<Extracted> {
  const { chapterBlocks, splitAtHeadings } = await import('./extract/html')
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const { blocks, headings } = chapterBlocks(doc.body)
  if (!blocks.length) throw new Error('No readable text was found.')
  const title = doc.querySelector('title')?.textContent?.trim() || undefined
  return { title, lang: doc.documentElement.getAttribute('lang') || undefined, chapters: splitAtHeadings(blocks, headings, title || fallbackTitle) }
}

export async function importHtml(html: string, name: string) {
  return finish(await htmlToExtracted(html, name), 'web', name)
}

/** An article from the web, fetched through Qari's server function (sites don't let other sites read them directly). */
export async function importArticle(url: string) {
  let r: Response
  try {
    r = await fetch(`/api/article?url=${encodeURIComponent(url)}`)
  } catch {
    throw new Error('You’re offline, so the page can’t be fetched.')
  }
  const j = await r.json().catch(() => ({ error: 'The page couldn’t be read.' }))
  if (!r.ok) throw new Error(j.error || 'The page couldn’t be read.')
  const ex = await htmlToExtracted(j.html, j.title)
  return finish({ ...ex, title: j.title, author: j.byline || j.siteName, lang: j.lang || ex.lang }, 'web', j.title, { source: j.url })
}

export function importText(text: string, title?: string) {
  const blocks = text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n|\n(?=\s{2,}|\t)/)
    .map((b) => b.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const t = title || blocks[0]?.slice(0, 60) || 'Pasted text'
  return finish({ chapters: [{ title: t, blocks }] }, 'text', t)
}

/** The first web address in some shared or pasted text, if any. */
export function findUrl(text: string) {
  return text.match(/https?:\/\/[^\s<>"'“”]+[^\s<>"'“”.,;:!?)\]]/i)?.[0] || null
}

/** Turns the errors that libraries and the browser throw into something a reader can act on. */
export function friendlyError(e: unknown): string {
  const name = (e as { name?: string })?.name || ''
  const msg = e instanceof Error ? e.message : String(e)
  if (name === 'PasswordException' || /password/i.test(msg))
    return 'This PDF is password-protected. Open it, remove the password (or print it to a new PDF), then add that file.'
  if (name === 'InvalidPDFException' || /invalid pdf/i.test(msg)) return 'This file isn’t a readable PDF. It may be damaged or only partly downloaded.'
  if (/corrupted zip|end of central directory|end of data reached|is this a zip file/i.test(msg))
    return 'This file seems damaged, or isn’t really an EPUB or Word file. Try downloading it again.'
  if (name === 'QuotaExceededError' || /quota/i.test(msg))
    return 'This device has run out of space for Qari. Remove some books (PDFs take the most room) and try again.'
  return msg
}

/**
 * The rest of a long PDF has been read: replace the first-pages version, keeping what happened meanwhile
 * (your place, a new title or folder). If you removed the book in the meantime, nothing is saved.
 */
export async function completeLongImport(meta: DocMeta, content: DocContent) {
  const cur = await getDoc(meta.id)
  if (!cur) return
  const position = mapPosition(cur.content, content, cur.meta.position)
  const { importing: _, ...rest } = { ...meta, title: cur.meta.title, author: cur.meta.author, folder: cur.meta.folder, openedAt: cur.meta.openedAt, positionAt: cur.meta.positionAt, position }
  void _
  await saveDoc({ ...rest, updatedAt: Date.now() }, content)
  window.dispatchEvent(new CustomEvent('qari:docready', { detail: meta.id }))
}
