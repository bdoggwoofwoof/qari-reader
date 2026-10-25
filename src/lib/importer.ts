import type { DocContent, DocMeta } from '../types'
import { baseLang, detectLang } from './lang'
import type { Extracted } from './extract/pdf'

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function finish(ex: Extracted, kind: DocMeta['kind'], fallbackTitle: string): { meta: DocMeta; content: DocContent } {
  const id = uid()
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
  const title = ex.title && !/^untitled|^microsoft word|\.docx?$/i.test(ex.title) ? ex.title : fallbackTitle
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
    },
    content: { id, chapters: ex.chapters },
  }
}

export async function importFile(file: File, onProgress?: (p: number) => void) {
  const name = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim()
  const ext = file.name.split('.').pop()?.toLowerCase()
  const data = await file.arrayBuffer()
  if (ext === 'pdf' || file.type === 'application/pdf') {
    const { extractPdf } = await import('./extract/pdf')
    return finish(await extractPdf(data, onProgress), 'pdf', name)
  }
  if (ext === 'epub' || file.type === 'application/epub+zip') {
    const { extractEpub } = await import('./extract/epub')
    return finish(await extractEpub(data, onProgress), 'epub', name)
  }
  if (ext === 'txt' || ext === 'md' || file.type.startsWith('text/')) {
    return importText(new TextDecoder().decode(data), name)
  }
  throw new Error(`“${file.name}” isn’t a PDF, EPUB or text file.`)
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
