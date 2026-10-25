import JSZip from 'jszip'
import type { Chapter } from '../../types'
import type { Extracted } from './pdf'

function resolve(base: string, href: string) {
  const clean = decodeURIComponent(href.split('#')[0])
  if (clean.startsWith('/')) return clean.slice(1)
  const parts = base.split('/').slice(0, -1)
  for (const seg of clean.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg && seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}

function parseXml(text: string, type: DOMParserSupportedType = 'application/xhtml+xml') {
  const doc = new DOMParser().parseFromString(text, type)
  if (doc.getElementsByTagName('parsererror').length && type !== 'text/html') {
    return new DOMParser().parseFromString(text, 'text/html')
  }
  return doc
}

const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'pre', 'dd', 'dt', 'figcaption', 'td', 'th', 'caption'])
const CONTAINER_TAGS = new Set(['div', 'section', 'article', 'body', 'main', 'aside', 'header', 'footer', 'ul', 'ol', 'dl', 'table', 'tbody', 'thead', 'tr', 'figure', 'nav'])
const SKIP_TAGS = new Set(['script', 'style', 'head', 'svg', 'math', 'rt', 'rp', 'img', 'audio', 'video'])

const norm = (s: string) => s.normalize('NFC').replace(/[­​]/g, '').replace(/\s+/g, ' ').trim()

function isNoteRef(el: Element) {
  const type = (el.getAttribute('epub:type') || el.getAttributeNS('http://www.idpf.org/2007/ops', 'type') || el.getAttribute('role') || '').toLowerCase()
  if (/noteref|doc-noteref/.test(type)) return true
  // <sup><a href="#fn3">3</a></sup>
  if (el.tagName.toLowerCase() === 'sup' && /^\s*[\d*†‡]+\s*$/.test(el.textContent || '')) return true
  return false
}

function isFootnote(el: Element) {
  const type = (el.getAttribute('epub:type') || el.getAttributeNS('http://www.idpf.org/2007/ops', 'type') || el.getAttribute('role') || '').toLowerCase()
  return /footnote|endnote|rearnote|doc-footnote|doc-endnote|pagebreak|doc-pagebreak/.test(type)
}

/** Walks an XHTML chapter and returns readable paragraphs, marking which ones are headings. */
function chapterBlocks(body: Element): { blocks: string[]; headings: number[] } {
  const blocks: string[] = []
  const headings: number[] = []

  const inlineText = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || ''
    if (node.nodeType !== Node.ELEMENT_NODE) return ''
    const el = node as Element
    const tag = el.tagName.toLowerCase()
    if (SKIP_TAGS.has(tag) || isNoteRef(el) || isFootnote(el)) return ''
    if (tag === 'br') return ' '
    let s = ''
    for (const c of Array.from(el.childNodes)) s += inlineText(c)
    return s
  }

  const walk = (el: Element) => {
    const tag = el.tagName.toLowerCase()
    if (SKIP_TAGS.has(tag) || isFootnote(el)) return
    const hasBlockChild = Array.from(el.children).some((c) => BLOCK_TAGS.has(c.tagName.toLowerCase()) || CONTAINER_TAGS.has(c.tagName.toLowerCase()))
    if (BLOCK_TAGS.has(tag) && !hasBlockChild) {
      const t = norm(inlineText(el))
      if (t) {
        if (/^h[1-6]$/.test(tag)) headings.push(blocks.length)
        blocks.push(t)
      }
      return
    }
    // Mixed container: loose text directly inside a div is its own paragraph.
    let loose = ''
    const flushLoose = () => {
      const t = norm(loose)
      if (t) blocks.push(t)
      loose = ''
    }
    for (const c of Array.from(el.childNodes)) {
      if (c.nodeType === Node.ELEMENT_NODE) {
        const ct = (c as Element).tagName.toLowerCase()
        if (BLOCK_TAGS.has(ct) || CONTAINER_TAGS.has(ct)) {
          flushLoose()
          walk(c as Element)
          continue
        }
      }
      loose += inlineText(c)
    }
    flushLoose()
  }

  walk(body)
  return { blocks, headings }
}

async function tocTitles(zip: JSZip, opfPath: string, opf: Document, manifest: Map<string, { href: string; type: string; props: string }>) {
  const titles = new Map<string, string>()
  const add = (base: string, href: string, label: string) => {
    const path = resolve(base, href)
    if (!titles.has(path) && label) titles.set(path, norm(label))
  }
  // EPUB 3 navigation document
  for (const item of manifest.values()) {
    if (!item.props.includes('nav')) continue
    const path = resolve(opfPath, item.href)
    const text = await zip.file(path)?.async('text')
    if (!text) continue
    const nav = parseXml(text)
    const navs = Array.from(nav.getElementsByTagName('nav'))
    const toc = navs.find((n) => /toc/.test(n.getAttribute('epub:type') || n.getAttribute('type') || '')) || navs[0]
    if (toc) for (const a of Array.from(toc.getElementsByTagName('a'))) add(path, a.getAttribute('href') || '', a.textContent || '')
  }
  // EPUB 2 NCX
  const spine = opf.getElementsByTagName('spine')[0]
  const ncxId = spine?.getAttribute('toc')
  const ncx = ncxId ? manifest.get(ncxId) : [...manifest.values()].find((m) => m.type === 'application/x-dtbncx+xml')
  if (ncx) {
    const path = resolve(opfPath, ncx.href)
    const text = await zip.file(path)?.async('text')
    if (text) {
      const doc = parseXml(text, 'application/xml')
      for (const np of Array.from(doc.getElementsByTagName('navPoint'))) {
        const label = np.getElementsByTagName('text')[0]?.textContent || ''
        const src = np.getElementsByTagName('content')[0]?.getAttribute('src') || ''
        add(path, src, label)
      }
    }
  }
  return titles
}

export async function extractEpub(data: ArrayBuffer, onProgress?: (p: number) => void): Promise<Extracted> {
  const zip = await JSZip.loadAsync(data)
  const container = await zip.file('META-INF/container.xml')?.async('text')
  if (!container) throw new Error("This doesn't look like a valid EPUB file (no container.xml).")
  const opfPath = parseXml(container, 'application/xml').getElementsByTagName('rootfile')[0]?.getAttribute('full-path')
  if (!opfPath) throw new Error('This EPUB is missing its package file.')
  const opfText = await zip.file(opfPath)?.async('text')
  if (!opfText) throw new Error('This EPUB is missing its package file.')
  const opf = parseXml(opfText, 'application/xml')

  const meta = (tag: string) => {
    const el = opf.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', tag)[0] || opf.getElementsByTagName('dc:' + tag)[0]
    return el?.textContent?.trim() || undefined
  }

  const manifest = new Map<string, { href: string; type: string; props: string }>()
  for (const item of Array.from(opf.getElementsByTagName('item'))) {
    manifest.set(item.getAttribute('id') || '', {
      href: item.getAttribute('href') || '',
      type: item.getAttribute('media-type') || '',
      props: item.getAttribute('properties') || '',
    })
  }
  const encFile = zip.file('META-INF/encryption.xml')
  if (encFile) {
    // Font obfuscation also uses this file; it's only DRM when the chapter files themselves are encrypted.
    const enc = await encFile.async('text')
    if (/CipherReference[^>]+URI="[^"]+\.x?html?"/i.test(enc)) {
      throw new Error('This EPUB is DRM-protected (for example, bought from Kindle, Apple Books or Kobo), so its text can’t be read. DRM-free EPUBs work.')
    }
  }

  const spineIds = Array.from(opf.getElementsByTagName('itemref'))
    .filter((r) => r.getAttribute('linear') !== 'no')
    .map((r) => r.getAttribute('idref') || '')
  const titles = await tocTitles(zip, opfPath, opf, manifest)

  const chapters: Chapter[] = []
  for (let i = 0; i < spineIds.length; i++) {
    onProgress?.((i + 1) / spineIds.length)
    const item = manifest.get(spineIds[i])
    if (!item) continue
    const path = resolve(opfPath, item.href)
    const text = await zip.file(path)?.async('text')
    if (!text) continue
    const doc = parseXml(text, item.type.includes('html') && !item.type.includes('xhtml') ? 'text/html' : 'application/xhtml+xml')
    const body = doc.getElementsByTagName('body')[0]
    if (!body) continue
    const { blocks, headings } = chapterBlocks(body)
    const words = blocks.join(' ').split(/\s+/).length
    if (!blocks.length || words < 3) continue
    const title = titles.get(path) || (headings.length ? blocks[headings[0]] : '') || `Section ${chapters.length + 1}`
    chapters.push({ title: title.slice(0, 120), blocks, headings })
  }
  if (!chapters.length) throw new Error('No readable text was found in this EPUB.')

  return { title: meta('title'), author: meta('creator'), lang: meta('language'), chapters }
}
