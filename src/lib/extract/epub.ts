import JSZip from 'jszip'
import type { Chapter } from '../../types'
import type { Extracted } from './pdf'
import { chapterBlocks, norm, parseXml } from './html'

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
