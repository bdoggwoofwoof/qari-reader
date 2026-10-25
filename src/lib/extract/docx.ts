import JSZip from 'jszip'
import { norm, parseXml, splitAtHeadings } from './html'
import type { Extracted } from './pdf'

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

/** Reads a Word (.docx) file: paragraphs and headings, skipping deleted text, field codes and footnote marks. */
export async function extractDocx(data: ArrayBuffer, fallbackTitle: string): Promise<Extracted> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(data)
  } catch {
    throw new Error('This doesn’t look like a Word (.docx) file. Older .doc files need to be saved as .docx first.')
  }
  const xml = await zip.file('word/document.xml')?.async('text')
  if (!xml) throw new Error('This Word file has no document body.')
  const doc = parseXml(xml, 'application/xml')

  // Which paragraph styles are headings (built-in "Heading 1" in any language, or anything with an outline level).
  const headingStyles = new Set<string>()
  const stylesXml = await zip.file('word/styles.xml')?.async('text')
  if (stylesXml) {
    const styles = parseXml(stylesXml, 'application/xml')
    for (const st of Array.from(styles.getElementsByTagNameNS(W, 'style'))) {
      const id = st.getAttributeNS(W, 'styleId') || st.getAttribute('w:styleId') || ''
      const name = st.getElementsByTagNameNS(W, 'name')[0]?.getAttributeNS(W, 'val') || ''
      const outline = st.getElementsByTagNameNS(W, 'outlineLvl')[0]
      if (/^(heading|title|berschrift|titre|titel|encabezado|titolo)/i.test(name) || /^(heading|title)\d*$/i.test(id) || outline) headingStyles.add(id)
    }
  }

  const blocks: string[] = []
  const headings: number[] = []
  const body = doc.getElementsByTagNameNS(W, 'body')[0]
  if (!body) throw new Error('This Word file has no document body.')

  const textOf = (p: Element) => {
    let s = ''
    const visit = (n: Element) => {
      const tag = n.localName
      if (tag === 'del' || tag === 'instrText' || tag === 'delText' || tag === 'footnoteReference' || tag === 'endnoteReference' || tag === 'commentReference') return
      if (tag === 't') s += n.textContent || ''
      else if (tag === 'tab' || tag === 'br' || tag === 'cr') s += ' '
      else if (tag === 'noBreakHyphen') s += '-'
      for (const c of Array.from(n.children)) visit(c)
    }
    visit(p)
    return norm(s)
  }

  for (const p of Array.from(body.getElementsByTagNameNS(W, 'p'))) {
    // Paragraphs inside text boxes appear twice in Word's XML (fallback copy); keep only the main one.
    let up = p.parentElement
    let dup = false
    while (up && !dup) {
      dup = up.localName === 'Fallback'
      up = up.parentElement
    }
    if (dup) continue
    const text = textOf(p)
    if (!text) continue
    const pPr = p.getElementsByTagNameNS(W, 'pPr')[0]
    const style = pPr?.getElementsByTagNameNS(W, 'pStyle')[0]?.getAttributeNS(W, 'val') || ''
    const outline = pPr?.getElementsByTagNameNS(W, 'outlineLvl')[0]
    if ((headingStyles.has(style) || outline) && text.length < 200) headings.push(blocks.length)
    blocks.push(text)
  }
  if (!blocks.length) throw new Error('No readable text was found in this Word file.')

  let title: string | undefined
  let author: string | undefined
  let lang: string | undefined
  const core = await zip.file('docProps/core.xml')?.async('text')
  if (core) {
    const c = parseXml(core, 'application/xml')
    title = c.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'title')[0]?.textContent?.trim() || undefined
    author = c.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'creator')[0]?.textContent?.trim() || undefined
    lang = c.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'language')[0]?.textContent?.trim() || undefined
  }
  return { title, author, lang, chapters: splitAtHeadings(blocks, headings, title || fallbackTitle) }
}
