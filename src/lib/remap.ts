import type { DocContent, Position } from '../types'

/**
 * Finds the same spot in a new version of a book (a long PDF that opened with its first pages, now complete).
 * Looks for the text at the old spot, nearby first; falls back to the same chapter and paragraph numbers.
 */
export function mapPosition(old: DocContent, next: DocContent, p: Position): Position {
  const text = old.chapters[p.chapter]?.blocks[p.block]
  if (!text) return clamp(next, p)
  // The words at the spot itself (offset = where they start), then the paragraph's opening (offset 0).
  const snippets = [{ text: text.slice(p.offset, p.offset + 80).trim() }, { text: text.slice(p.offset, p.offset + 40).trim() }, { text: text.slice(0, 60).trim() }].filter((s) => s.text.length >= 12)
  const order = next.chapters.map((_, i) => i).sort((a, b) => Math.abs(a - p.chapter) - Math.abs(b - p.chapter))
  for (const snip of snippets) {
    for (const c of order) {
      const blocks = next.chapters[c].blocks
      for (let b = 0; b < blocks.length; b++) {
        const at = blocks[b].indexOf(snip.text)
        if (at >= 0) return { chapter: c, block: b, offset: at } // for the paragraph-opening match, its start
      }
    }
  }
  return clamp(next, p)
}

function clamp(next: DocContent, p: Position): Position {
  const chapter = Math.min(p.chapter, Math.max(0, next.chapters.length - 1))
  const block = Math.min(p.block, Math.max(0, (next.chapters[chapter]?.blocks.length ?? 1) - 1))
  return { chapter, block, offset: block === p.block ? p.offset : 0 }
}
