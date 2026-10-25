import { useEffect, useState } from 'react'
import { deleteHighlight, saveHighlight } from '../lib/db'
import { pageRef, quoteLine } from '../lib/quotes'
import type { DocMeta, Highlight } from '../types'
import { Icon, Sheet } from './ui'

export default function HighlightSheet({
  highlight,
  meta,
  onClose,
  onLookUp,
  onShowPage,
  canShowPage,
}: {
  highlight: Highlight | null
  meta: DocMeta
  onClose: () => void
  onLookUp?: () => void
  onShowPage?: () => void
  canShowPage: boolean
}) {
  const [note, setNote] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setNote(highlight?.note || '')
    setCopied(false)
  }, [highlight])

  if (!highlight) return null

  const save = async () => {
    if (note !== highlight.note) await saveHighlight({ ...highlight, note, updatedAt: Date.now() })
  }
  const close = async () => {
    await save()
    onClose()
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(quoteLine(meta, { ...highlight, note }) + (note.trim() ? `\n\n${note.trim()}` : ''))
      setCopied(true)
    } catch {
      /* clipboard blocked */
    }
  }
  const remove = async () => {
    await deleteHighlight(highlight.id)
    onClose()
  }

  return (
    <Sheet open onClose={close} title={pageRef(highlight) ? `Highlight · ${pageRef(highlight)}` : 'Highlight'} wide>
      <blockquote dir="auto" className="border-l-4 border-mark pl-3 font-read text-[1.02rem] leading-relaxed">
        {highlight.text}
      </blockquote>
      <label htmlFor="hl-note" className="mt-4 mb-1 block text-sm font-semibold">
        Note
      </label>
      <textarea
        id="hl-note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onBlur={save}
        dir="auto"
        placeholder="Why this matters, a question for class, how it connects…"
        className="h-28 w-full resize-y rounded-xl border border-line bg-paper-2 p-3 text-[0.95rem] outline-none focus:border-moss"
      />
      <div className="mt-3 mb-2 flex flex-wrap gap-2">
        <button type="button" onClick={copy} className="inline-flex h-9 items-center gap-1.5 rounded-full border border-line px-3 text-sm hover:bg-paper-2">
          <Icon name="paste" size={16} /> {copied ? 'Copied' : 'Copy quote'}
        </button>
        {onLookUp && (
          <button type="button" onClick={onLookUp} className="inline-flex h-9 items-center gap-1.5 rounded-full border border-line px-3 text-sm hover:bg-paper-2">
            <Icon name="search" size={16} /> Look up word
          </button>
        )}
        {canShowPage && onShowPage && (
          <button type="button" onClick={onShowPage} className="inline-flex h-9 items-center gap-1.5 rounded-full border border-line px-3 text-sm hover:bg-paper-2">
            <Icon name="page" size={16} /> Show page
          </button>
        )}
        <button type="button" onClick={remove} className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-sm text-danger hover:bg-paper-2">
          <Icon name="trash" size={16} /> Remove
        </button>
      </div>
    </Sheet>
  )
}
