import { useEffect, useMemo, useRef, useState } from 'react'
import { exportMarkdown, pageRef } from '../lib/quotes'
import { searchBook, type SearchHit } from '../lib/search'
import type { DocContent, DocMeta, Highlight } from '../types'
import { Icon, Sheet } from './ui'

export type PanelTab = 'contents' | 'notes' | 'search'

export default function BookPanel({
  open,
  tab,
  onTab,
  onClose,
  meta,
  content,
  chapter,
  highlights,
  onChapter,
  onHighlight,
  onHit,
}: {
  open: boolean
  tab: PanelTab
  onTab: (t: PanelTab) => void
  onClose: () => void
  meta: DocMeta
  content: DocContent
  chapter: number
  highlights: Highlight[]
  onChapter: (c: number) => void
  onHighlight: (h: Highlight) => void
  onHit: (h: SearchHit) => void
}) {
  const [query, setQuery] = useState('')
  const [done, setDone] = useState('')
  const [copied, setCopied] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  // Search a moment after typing stops, so long books stay responsive.
  useEffect(() => {
    const t = setTimeout(() => setDone(query), 250)
    return () => clearTimeout(t)
  }, [query])
  const hits = useMemo(() => (tab === 'search' ? searchBook(content.chapters, done) : []), [content, done, tab])

  useEffect(() => {
    if (open && tab === 'search') setTimeout(() => input.current?.focus(), 50)
  }, [open, tab])

  const md = () => exportMarkdown(meta, content, highlights)
  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(md())
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard blocked */
    }
  }
  const download = () => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([md()], { type: 'text/markdown;charset=utf-8' }))
    a.download = `${meta.title.replace(/[^\p{L}\p{N} _-]+/gu, '').slice(0, 60) || 'notes'} - highlights.md`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  const tabs: [PanelTab, string][] = [
    ['contents', 'Contents'],
    ['notes', highlights.length ? `Notes (${highlights.length})` : 'Notes'],
    ['search', 'Search'],
  ]

  return (
    <Sheet open={open} onClose={onClose} title={<span className="truncate" dir="auto">{meta.title}</span>} wide>
      <div className="mb-3 grid grid-cols-3 gap-1 rounded-xl bg-paper-2 p-1" role="tablist">
        {tabs.map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={tab === k}
            onClick={() => onTab(k)}
            className={`h-9 rounded-lg text-sm ${tab === k ? 'bg-paper font-semibold shadow-[0_1px_3px_rgb(0_0_0/0.08)]' : 'text-ink-2'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'contents' && (
        <ol className="-mx-2 pb-2">
          {content.chapters.map((c, i) => (
            <li key={i}>
              <button
                type="button"
                onClick={() => onChapter(i)}
                dir="auto"
                className={`flex w-full items-baseline gap-3 rounded-lg px-2 py-2.5 text-left font-read hover:bg-paper-2 ${i === chapter ? 'bg-wash font-semibold' : ''}`}
              >
                <span className="min-w-0 flex-1">{c.title}</span>
                {c.pages?.[0] && <span className="shrink-0 font-ui text-xs text-ink-3 tabular-nums">p. {c.pages[0].split('–')[0]}</span>}
              </button>
            </li>
          ))}
        </ol>
      )}

      {tab === 'notes' &&
        (highlights.length === 0 ? (
          <div className="py-8 text-center">
            <p className="font-read text-lg">No highlights yet.</p>
            <p className="mx-auto mt-2 max-w-sm text-sm text-ink-2">Select some text while reading, then choose Highlight or Add note. Each one keeps its page number for citing.</p>
          </div>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap gap-2">
              <button type="button" onClick={copyAll} className="inline-flex h-9 items-center gap-1.5 rounded-full border border-line px-3 text-sm hover:bg-paper-2">
                <Icon name="paste" size={16} /> {copied ? 'Copied' : 'Copy all'}
              </button>
              <button type="button" onClick={download} className="inline-flex h-9 items-center gap-1.5 rounded-full border border-line px-3 text-sm hover:bg-paper-2">
                <Icon name="download" size={16} /> Download notes
              </button>
            </div>
            <ul className="divide-y divide-line border-y border-line pb-1">
              {highlights.map((h, i) => (
                <li key={h.id}>
                  {(i === 0 || highlights[i - 1].chapter !== h.chapter) && (
                    <div className="pt-3 text-xs font-semibold text-ink-3" dir="auto">
                      {content.chapters[h.chapter]?.title}
                    </div>
                  )}
                  <button type="button" onClick={() => onHighlight(h)} className="block w-full py-3 text-left">
                    <span className="block border-l-4 border-mark pl-3 font-read text-[0.98rem] leading-snug" dir="auto">
                      {h.text.length > 280 ? h.text.slice(0, 280) + '…' : h.text}
                    </span>
                    {h.note.trim() && (
                      <span className="mt-1.5 flex gap-1.5 pl-4 text-sm text-ink-2" dir="auto">
                        <Icon name="note" size={15} className="mt-0.5 shrink-0 text-moss" />
                        {h.note}
                      </span>
                    )}
                    {pageRef(h) && <span className="mt-1 block pl-4 text-xs text-ink-3">{pageRef(h)}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </>
        ))}

      {tab === 'search' && (
        <div className="pb-2">
          <label className="flex h-11 items-center gap-2 rounded-full border border-line bg-paper-2 px-4 focus-within:border-moss">
            <Icon name="search" size={18} className="text-ink-3" />
            <span className="sr-only">Search this book</span>
            <input
              ref={input}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search this book"
              dir="auto"
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-ink-3"
            />
          </label>
          {done.trim().length >= 2 && (
            <p className="mt-3 text-sm text-ink-3">
              {hits.length === 0 ? `No matches for “${done}”.` : `${hits.length === 200 ? '200+' : hits.length} ${hits.length === 1 ? 'match' : 'matches'}`}
            </p>
          )}
          <ul className="mt-1 divide-y divide-line">
            {hits.map((h, i) => (
              <li key={i}>
                <button type="button" onClick={() => onHit(h)} className="block w-full py-2.5 text-left">
                  <span className="mb-0.5 flex justify-between gap-3 text-xs text-ink-3">
                    <span className="truncate" dir="auto">
                      {content.chapters[h.chapter]?.title}
                    </span>
                    {h.page && <span className="shrink-0 tabular-nums">{pageRef(h)}</span>}
                  </span>
                  <span className="block font-read text-[0.95rem] leading-snug text-ink-2" dir="auto">
                    {h.before}
                    <mark className="rounded-sm bg-mark px-0.5 text-ink">{h.match}</mark>
                    {h.after}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Sheet>
  )
}
