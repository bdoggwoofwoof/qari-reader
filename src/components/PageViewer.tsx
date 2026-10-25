import { useEffect, useRef, useState } from 'react'
import { getFile } from '../lib/db'
import { fetchOriginal } from '../lib/sync'
import { Icon, IconButton } from './ui'

type PdfHandle = Awaited<ReturnType<typeof import('../lib/extract/pdf').openPdf>>

/** The original PDF page, as printed, for tables, figures and checking a quote. */
export default function PageViewer({ docId, page, label, onClose }: { docId: string; page: number; label?: string; onClose: () => void }) {
  const [pdf, setPdf] = useState<PdfHandle | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading')
  const [index, setIndex] = useState(page)
  const [zoom, setZoom] = useState(1)
  const canvas = useRef<HTMLCanvasElement>(null)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    let handle: PdfHandle | null = null
    ;(async () => {
      try {
        let file = await getFile(docId)
        if (!file) {
          const blob = await fetchOriginal(docId)
          if (blob) file = { id: docId, type: blob.type, data: blob }
        }
        if (!file) return live && setState('missing')
        const { openPdf } = await import('../lib/extract/pdf')
        handle = await openPdf(await file.data.arrayBuffer())
        if (!live) return handle.close()
        setPdf(handle)
        setState('ready')
      } catch {
        if (live) setState('error')
      }
    })()
    return () => {
      live = false
      handle?.close()
    }
  }, [docId])

  useEffect(() => {
    if (!pdf || !canvas.current || !box.current) return
    let cancelled = false
    let task: { cancel: () => void; promise: Promise<void> } | null = null
    ;(async () => {
      const p = await pdf.doc.getPage(index + 1)
      if (cancelled) return
      const base = p.getViewport({ scale: 1 })
      const width = box.current!.clientWidth * zoom
      const dpr = Math.min(window.devicePixelRatio || 1, 3)
      const vp = p.getViewport({ scale: (width / base.width) * dpr })
      const c = canvas.current!
      c.width = vp.width
      c.height = vp.height
      c.style.width = `${vp.width / dpr}px`
      c.style.height = `${vp.height / dpr}px`
      task = p.render({ canvas: c, canvasContext: c.getContext('2d')!, viewport: vp }) as unknown as typeof task
      await task!.promise.catch(() => {})
    })()
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [pdf, index, zoom])

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight' && pdf) setIndex((i) => Math.min(pdf.doc.numPages - 1, i + 1))
      else if (e.key === 'ArrowLeft') setIndex((i) => Math.max(0, i - 1))
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [pdf, onClose])

  const total = pdf?.doc.numPages ?? 0

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-paper" role="dialog" aria-modal="true" aria-label="Original page">
      <div className="flex h-14 shrink-0 items-center gap-1 border-b border-line px-2 pt-[env(safe-area-inset-top)]">
        <IconButton icon="close" label="Close" onClick={onClose} />
        <div className="flex-1 text-[0.95rem] font-semibold">
          Original page{index === page && label ? ` · p. ${label}` : total ? ` · ${index + 1} of ${total}` : ''}
        </div>
        <button type="button" onClick={() => setZoom((z) => (z === 1 ? 2 : 1))} className="h-9 rounded-full border border-line px-3 text-sm" disabled={state !== 'ready'}>
          {zoom === 1 ? 'Zoom in' : 'Fit width'}
        </button>
        <IconButton icon="prev" label="Previous page" onClick={() => setIndex((i) => Math.max(0, i - 1))} disabled={index === 0} />
        <IconButton icon="next" label="Next page" onClick={() => setIndex((i) => Math.min(total - 1, i + 1))} disabled={!total || index >= total - 1} />
      </div>
      <div ref={box} className="min-h-0 flex-1 overflow-auto bg-paper-2 p-3">
        {state === 'loading' && <p className="p-8 text-center text-ink-3">Opening the PDF…</p>}
        {state === 'missing' && (
          <div className="mx-auto max-w-sm p-8 text-center">
            <Icon name="page" size={28} className="mx-auto text-ink-3" />
            <p className="mt-3 font-read text-lg">The original PDF isn’t on this device.</p>
            <p className="mt-2 text-sm text-ink-2">It’s kept on the device where you added the book. With sync on, it comes across the next time that device syncs.</p>
          </div>
        )}
        {state === 'error' && <p className="p-8 text-center text-danger">This page couldn’t be shown.</p>}
        <canvas ref={canvas} className={`mx-auto block bg-white shadow-[0_2px_14px_rgb(0_0_0/0.12)] ${state === 'ready' ? '' : 'hidden'}`} />
      </div>
    </div>
  )
}
