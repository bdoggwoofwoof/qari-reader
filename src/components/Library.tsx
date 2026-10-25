import { useCallback, useEffect, useRef, useState } from 'react'
import { go } from '../App'
import { deleteDoc, listDocs, saveDoc } from '../lib/db'
import { importFile, importText } from '../lib/importer'
import { LANG_NAMES, type DocMeta } from '../types'
import { Icon, IconButton, Sheet } from './ui'

function progress(d: DocMeta) {
  if (d.progress !== undefined) return d.progress
  if (!d.charCount) return 0
  return Math.min(1, (d.charsBefore[d.position.chapter] ?? 0) / d.charCount)
}

function ago(t: number) {
  const m = Math.round((Date.now() - t) / 60000)
  if (m < 2) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  return d === 1 ? 'yesterday' : `${d} days ago`
}

export default function Library() {
  const [docs, setDocs] = useState<DocMeta[] | null>(null)
  const [busy, setBusy] = useState<{ name: string; p: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  const refresh = useCallback(() => listDocs().then(setDocs), [])
  useEffect(() => {
    refresh()
  }, [refresh])

  const handleFiles = async (files: FileList | File[]) => {
    setError(null)
    let lastId: string | null = null
    const list = Array.from(files)
    for (const f of list) {
      setBusy({ name: f.name, p: 0 })
      try {
        const { meta, content } = await importFile(f, (p) => setBusy({ name: f.name, p }))
        await saveDoc(meta, content)
        lastId = meta.id
      } catch (e) {
        setError(`${f.name}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    setBusy(null)
    await refresh()
    if (lastId && list.length === 1) go('read/' + lastId)
  }

  const savePaste = async () => {
    if (!pasteText.trim()) return
    const { meta, content } = importText(pasteText)
    await saveDoc(meta, content)
    setPasteText('')
    setPasteOpen(false)
    go('read/' + meta.id)
  }

  const remove = async (d: DocMeta) => {
    if (!confirm(`Remove “${d.title}” from your library?`)) return
    await deleteDoc(d.id)
    refresh()
  }

  const empty = docs !== null && docs.length === 0

  return (
    <div
      className="min-h-full"
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files)
      }}
    >
      <header className="mx-auto flex max-w-3xl items-center justify-between px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-2 sm:px-6">
        <div className="flex items-baseline gap-3">
          <span className="font-arabic text-3xl leading-none text-moss" lang="ar">
            قارئ
          </span>
          <h1 className="text-lg font-semibold tracking-tight">Qari</h1>
        </div>
        <div className="flex items-center gap-1">
          <IconButton icon="words" label="Saved words" onClick={() => go('words')} />
          <IconButton icon="paste" label="Paste text" onClick={() => setPasteOpen(true)} />
          <button
            type="button"
            onClick={() => input.current?.click()}
            className="ml-1 inline-flex h-10 items-center gap-1.5 rounded-full bg-moss px-4 text-sm font-semibold text-moss-ink hover:opacity-90"
          >
            <Icon name="plus" size={18} /> Add
          </button>
        </div>
        <input
          ref={input}
          type="file"
          accept=".pdf,.epub,.txt,application/pdf,application/epub+zip,text/plain"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) handleFiles(e.target.files)
            e.target.value = ''
          }}
        />
      </header>

      <main className="mx-auto max-w-3xl px-4 pb-16 sm:px-6">
        {busy && (
          <div className="mt-4 rounded-xl border border-line bg-paper-2 px-4 py-3 text-sm" role="status">
            <div className="flex justify-between gap-3">
              <span className="truncate">Reading {busy.name}</span>
              <span className="tabular-nums text-ink-2">{Math.round(busy.p * 100)}%</span>
            </div>
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-line">
              <div className="h-full bg-moss transition-[width]" style={{ width: `${busy.p * 100}%` }} />
            </div>
          </div>
        )}
        {error && (
          <div className="mt-4 flex items-start justify-between gap-3 rounded-xl border border-danger/40 px-4 py-3 text-sm text-danger" role="alert">
            <span>{error}</span>
            <button type="button" className="shrink-0 underline" onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        )}

        {empty && !busy && (
          <button
            type="button"
            onClick={() => input.current?.click()}
            className={`mt-10 flex w-full flex-col items-center rounded-3xl border-2 border-dashed px-6 py-16 text-center ${dragging ? 'border-moss bg-wash' : 'border-line'}`}
          >
            <span className="font-arabic text-7xl leading-tight text-moss sm:text-8xl" lang="ar">
              اقرأ
            </span>
            <span className="mt-4 font-read text-2xl">Add something to read</span>
            <span className="mt-2 max-w-sm text-ink-2">Choose a PDF or EPUB, or drop it here. It stays on this device.</span>
          </button>
        )}

        {docs && docs.length > 0 && (
          <ul className="mt-4 divide-y divide-line border-y border-line">
            {docs.map((d) => {
              const p = progress(d)
              return (
                <li key={d.id} className="group relative flex items-center gap-2">
                  <a href={`#/read/${d.id}`} className="min-w-0 flex-1 py-4 pr-2">
                    <div className="truncate font-read text-xl leading-snug" dir="auto">
                      {d.title}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 text-sm text-ink-3">
                      {d.author && <span className="truncate">{d.author}</span>}
                      <span>{LANG_NAMES[d.lang] || d.lang}</span>
                      <span>{d.kind.toUpperCase()}</span>
                      <span>Opened {ago(d.openedAt)}</span>
                    </div>
                    <div className="mt-2.5 h-[3px] w-full max-w-xs overflow-hidden rounded-full bg-line" aria-label={`${Math.round(p * 100)}% read`}>
                      <div className="h-full bg-moss" style={{ width: `${Math.max(p * 100, 1.5)}%` }} />
                    </div>
                  </a>
                  <IconButton icon="trash" label={`Remove ${d.title}`} onClick={() => remove(d)} className="opacity-60 group-hover:opacity-100" />
                </li>
              )
            })}
          </ul>
        )}
        {docs && docs.length > 0 && <p className="mt-4 text-center text-sm text-ink-3">Drop PDFs or EPUBs anywhere on this page to add them.</p>}
      </main>

      <Sheet open={pasteOpen} onClose={() => setPasteOpen(false)} title="Paste text" wide>
        <textarea
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
          dir="auto"
          placeholder="Paste an article, a chapter, a text message in French…"
          className="h-56 w-full resize-y rounded-xl border border-line bg-paper-2 p-3 font-read text-base outline-none focus:border-moss"
        />
        <button
          type="button"
          disabled={!pasteText.trim()}
          onClick={savePaste}
          className="mt-3 h-11 w-full rounded-full bg-moss font-semibold text-moss-ink disabled:opacity-40"
        >
          Read it
        </button>
      </Sheet>
    </div>
  )
}
