import type { DocContent, DocMeta, Highlight } from '../types'

/** "p. 45", "pp. 45–46", or the section title when the book has no page numbers. */
export function pageRef(h: Pick<Highlight, 'page'>) {
  if (!h.page) return ''
  return h.page.includes('–') ? `pp. ${h.page}` : `p. ${h.page}`
}

/** The author's last name for an in-text citation, when the metadata has one. */
function authorLast(meta: DocMeta) {
  const a = meta.author?.split(/[;&,]| and /)[0]?.trim()
  if (!a) return ''
  const parts = a.split(/\s+/)
  return parts[parts.length - 1]
}

export function citation(meta: DocMeta, h: Pick<Highlight, 'page'>) {
  const bits = [authorLast(meta), pageRef(h)].filter(Boolean)
  return bits.length ? `(${bits.join(', ')})` : ''
}

export function quoteLine(meta: DocMeta, h: Highlight) {
  const cite = citation(meta, h)
  return `“${h.text.trim()}”${cite ? ' ' + cite : ''}`
}

/** All highlights of a book as Markdown, grouped by section, ready to paste into notes or a paper draft. */
export function exportMarkdown(meta: DocMeta, content: DocContent, list: Highlight[]) {
  const lines = [`# ${meta.title}`, meta.author ? `${meta.author}` : '', '']
  let lastChapter = -1
  for (const h of list) {
    if (h.chapter !== lastChapter) {
      lastChapter = h.chapter
      const t = content.chapters[h.chapter]?.title
      if (t) lines.push(`## ${t}`, '')
    }
    lines.push(`> ${quoteLine(meta, h)}`, '')
    if (h.note.trim()) lines.push(h.note.trim(), '')
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}
