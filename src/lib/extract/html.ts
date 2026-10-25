// Turns HTML (EPUB chapters, web articles, saved pages) into readable paragraphs.

export function parseXml(text: string, type: DOMParserSupportedType = 'application/xhtml+xml') {
  const doc = new DOMParser().parseFromString(text, type)
  if (doc.getElementsByTagName('parsererror').length && type !== 'text/html') {
    return new DOMParser().parseFromString(text, 'text/html')
  }
  return doc
}

const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'pre', 'dd', 'dt', 'figcaption', 'td', 'th', 'caption'])
const CONTAINER_TAGS = new Set(['div', 'section', 'article', 'body', 'main', 'aside', 'header', 'footer', 'ul', 'ol', 'dl', 'table', 'tbody', 'thead', 'tr', 'figure', 'nav'])
const SKIP_TAGS = new Set(['script', 'style', 'head', 'svg', 'math', 'rt', 'rp', 'img', 'audio', 'video'])

export const norm = (s: string) => s.normalize('NFC').replace(/[­​]/g, '').replace(/\s+/g, ' ').trim()

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
export function chapterBlocks(body: Element): { blocks: string[]; headings: number[] } {
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

/**
 * Splits one long run of paragraphs into sections at its headings (Word documents, web articles, saved pages).
 * A run of consecutive headings starts one section, titled by its last heading.
 */
export function splitAtHeadings(blocks: string[], headings: number[], fallbackTitle: string): import('../../types').Chapter[] {
  if (!blocks.length) return []
  const heads = new Set(headings)
  const starts = headings.filter((i) => !heads.has(i - 1))
  // Few headings, or one every paragraph or two: keep it as a single section.
  if (starts.length < 2 || starts.length > blocks.length / 2) {
    return [{ title: headings.length ? blocks[headings[0]].slice(0, 120) : fallbackTitle, blocks, headings }]
  }
  const all = starts[0] > 0 ? [0, ...starts] : starts
  return all.map((st, k) => {
    const end = all[k + 1] ?? blocks.length
    let t = st
    while (heads.has(t + 1) && t + 1 < end) t++
    return {
      title: heads.has(st) ? blocks[t].slice(0, 120) : 'Beginning',
      blocks: blocks.slice(st, end),
      headings: headings.filter((h) => h >= st && h < end).map((h) => h - st),
    }
  })
}
