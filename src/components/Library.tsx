import { useCallback, useEffect, useRef, useState } from 'react'
import { go } from '../App'
import { deleteDoc, exportLibrary, importLibrary, listDocs, saveDoc, saveFile, storageIsPersistent, updateDocMeta } from '../lib/db'
import { platform } from '../lib/tts'
import { useSettings } from '../lib/settings'
import { startTour, useTour } from '../lib/tour'
import VoiceCheck from './VoiceCheck'
import SyncSheet from './SyncSheet'
import { useSyncStatus } from '../lib/sync'
import { completeLongImport, findUrl, friendlyError, importArticle, importFile, importScannedPdf, importScans, importText, isImage } from '../lib/importer'
import { NeedsOcrError } from '../lib/extract/errors'
import { LANG_NAMES, type DocContent, type DocMeta } from '../types'
import { ActionList, ActionRow, ask, Button, Icon, IconButton, Sheet } from './ui'

function touredThisSession() {
  try {
    return !!sessionStorage.getItem('qari.toured')
  } catch {
    return false
  }
}

function downloadBackup(blob: Blob) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `qari-backup-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10000)
}

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

const NO_FOLDER = '\u0000none'

const OCR_CHOICES: [string, string, string][] = [
  ['en', 'English', 'English'],
  ['ar', 'Arabic', 'العربية'],
  ['fr', 'French', 'Français'],
  ['de', 'German', 'Deutsch'],
]

function kindLabel(d: DocMeta) {
  if (d.kind === 'web') {
    try {
      return d.source ? new URL(d.source).hostname.replace(/^www\./, '') : 'Web page'
    } catch {
      return 'Web page'
    }
  }
  return { pdf: 'PDF', epub: 'EPUB', text: 'Text', docx: 'Word', scan: 'Scan' }[d.kind] || d.kind
}

export interface Shared {
  title?: string
  text?: string
  url?: string
}

export default function Library({ joinCode, shared }: { joinCode?: string; shared?: Shared }) {
  const [docs, setDocs] = useState<DocMeta[] | null>(null)
  const [busy, setBusy] = useState<{ name: string; p: number; label?: string } | null>(null)
  const [ocrAsk, setOcrAsk] = useState<{ images: File[]; pdfs: File[] } | null>(null)
  const [ocrLang, setOcrLang] = useState(() => {
    try {
      return localStorage.getItem('qari.ocrLang') || 'en'
    } catch {
      return 'en'
    }
  })
  const [linkOpen, setLinkOpen] = useState(false)
  const [link, setLink] = useState('')
  const [linkError, setLinkError] = useState<string | null>(null)
  const scanInput = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [dragging, setDragging] = useState(false)
  const [query, setQuery] = useState('')
  const [renaming, setRenaming] = useState<DocMeta | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [bookMenu, setBookMenu] = useState<DocMeta | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const restoreInput = useRef<HTMLInputElement>(null)
  const [atRisk, setAtRisk] = useState(false)
  const [riskWhy, setRiskWhy] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newFolder, setNewFolder] = useState('')
  const [folder, setFolder] = useState<string | null>(() => {
    try {
      return localStorage.getItem('qari.folder')
    } catch {
      return null
    }
  })
  const [settings, updateSettings] = useSettings()
  const dark = settings.theme === 'dark'
  const toggleTheme = () => {
    try {
      if (!dark) localStorage.setItem('qari.lightTheme', settings.theme)
    } catch {
      /* storage unavailable */
    }
    let back: 'light' | 'sepia' = 'light'
    try {
      if (localStorage.getItem('qari.lightTheme') === 'sepia') back = 'sepia'
    } catch {
      /* storage unavailable */
    }
    updateSettings({ theme: dark ? back : 'dark' })
  }
  const [addOpen, setAddOpen] = useState(false)
  const [syncOpen, setSyncOpen] = useState(!!joinCode)
  const tour = useTour()
  const firstRun = !settings.tourDone && !joinCode && !shared
  // The voice check waits for a later visit when the tour has just run, so a new user isn't shown two in a row.
  const [voicesOpen, setVoicesOpen] = useState(() => !settings.voiceCheckDone && !joinCode && !firstRun && !tour.active && !touredThisSession())
  const sync = useSyncStatus()
  const input = useRef<HTMLInputElement>(null)

  const refresh = useCallback(() => listDocs().then(setDocs), [])

  // First launch on a new device with nothing in it: show people around, then check voices.
  useEffect(() => {
    if (firstRun && docs && docs.length === 0 && !tour.active) {
      updateSettings({ tourDone: true })
      try {
        sessionStorage.setItem('qari.toured', '1')
      } catch {
        /* storage unavailable */
      }
      startTour()
    }
  }, [firstRun, docs, tour.active, updateSettings])

  // The library lives only in this browser. Warn once if the browser may clear it (Safari does after a week
  // or so without a visit unless Qari is on the Home Screen) and nothing else keeps a copy.
  useEffect(() => {
    if (sync.state !== 'off' || !docs?.length) return
    try {
      if (localStorage.getItem('qari.storageWarned')) return
    } catch {
      return
    }
    const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true
    storageIsPersistent().then((p) => setAtRisk(!standalone && (platform() === 'ios' || p === false)))
  }, [sync.state, docs?.length])
  const dismissRisk = () => {
    setAtRisk(false)
    try {
      localStorage.setItem('qari.storageWarned', '1')
    } catch {
      /* storage unavailable */
    }
  }

  const backUp = async () => {
    setMenuOpen(false)
    setBusy({ name: 'your library', p: 0.5, label: 'Preparing a backup of' })
    try {
      downloadBackup(await exportLibrary())
      setNotice('Backup downloaded. Keep it somewhere safe, like iCloud Drive or Google Drive.')
      dismissRisk()
    } catch (e) {
      setError(`Backup: ${friendlyError(e)}`)
    } finally {
      setBusy(null)
    }
  }

  const chooseBackup = () => restoreInput.current?.click()

  const runMenu = (key: 'sync' | 'voices' | 'theme' | 'backup' | 'restore' | 'tour') => {
    setMenuOpen(false)
    if (key === 'sync') setSyncOpen(true)
    else if (key === 'voices') setVoicesOpen(true)
    else if (key === 'theme') toggleTheme()
    else if (key === 'backup') backUp()
    else if (key === 'restore') chooseBackup()
    else startTour()
  }

  const restore = async (file: File) => {
    setBusy({ name: file.name, p: 0.5, label: 'Restoring from' })
    try {
      const { books, words } = await importLibrary(file)
      await refresh()
      setNotice(books || words ? `Restored ${books} ${books === 1 ? 'book' : 'books'} and ${words} saved ${words === 1 ? 'word' : 'words'}.` : 'Everything in that backup is already in your library.')
    } catch (e) {
      setError(`Restore: ${friendlyError(e)}`)
    } finally {
      setBusy(null)
    }
  }
  useEffect(() => {
    refresh()
    window.addEventListener('qari:synced', refresh)
    return () => window.removeEventListener('qari:synced', refresh)
  }, [refresh])

  // Keep the screen on during long imports (text recognition can take a few minutes on a phone).
  useEffect(() => {
    if (!busy || !('wakeLock' in navigator)) return
    let lock: { release: () => Promise<void> } | null = null
    ;(navigator as unknown as { wakeLock: { request: (t: string) => Promise<{ release: () => Promise<void> }> } }).wakeLock
      .request('screen')
      .then((l) => (lock = l))
      .catch(() => {})
    return () => {
      lock?.release().catch(() => {})
    }
  }, [!!busy]) // eslint-disable-line react-hooks/exhaustive-deps

  // Something shared to Qari from another app (Android): a link opens "Add a web link", text opens "Paste text".
  useEffect(() => {
    if (!shared) return
    const u = shared.url || findUrl(shared.text || '') || findUrl(shared.title || '')
    if (u) {
      setLink(u)
      setLinkOpen(true)
    } else if (shared.text) {
      setPasteText(shared.text)
      setPasteOpen(true)
    }
  }, [shared])

  /** Saves an imported document (into the open folder, if any), keeping the original PDF for the page view and sync. */
  const store = async (meta: DocMeta, content: Parameters<typeof saveDoc>[1], file?: File) => {
    if (folder && folder !== NO_FOLDER) meta.folder = folder
    if (meta.kind === 'pdf' && file) await saveFile(meta.id, new Blob([await file.arrayBuffer()], { type: 'application/pdf' }))
    await saveDoc(meta, content)
    return meta.id
  }

  const fail = (name: string, e: unknown) => setError(`${name}: ${friendlyError(e)}`)

  const handleFiles = async (files: FileList | File[]) => {
    setError(null)
    const list = Array.from(files)
    const images = list.filter(isImage)
    const scannedPdfs: File[] = []
    let lastId: string | null = null
    let added = 0
    for (const f of list.filter((x) => !isImage(x))) {
      setBusy({ name: f.name, p: 0 })
      // One long PDF: open it as soon as its first pages are read; the rest arrives while you start reading.
      let early: Promise<string> | null = null
      let earlyId: string | null = null
      try {
        const onPreview =
          list.length === 1
            ? (first: { meta: DocMeta; content: DocContent }) => {
                earlyId = first.meta.id
                early = store(first.meta, first.content, f).then((id) => {
                  setBusy(null)
                  go('read/' + id)
                  return id
                })
              }
            : undefined
        const { meta, content } = await importFile(
          f,
          (p) => {
            if (earlyId) window.dispatchEvent(new CustomEvent('qari:importprogress', { detail: { id: earlyId, p } }))
            else setBusy({ name: f.name, p })
          },
          onPreview,
        )
        if (early) {
          await early
          await completeLongImport(meta, content)
          refresh()
          return
        }
        lastId = await store(meta, content, f)
        added++
      } catch (e) {
        if (earlyId) {
          // The first pages are open but the rest failed: keep what was read and say so in the book.
          await updateDocMeta(earlyId, { importing: false, importFailed: true })
          window.dispatchEvent(new CustomEvent('qari:docready', { detail: earlyId }))
          return
        }
        if (e instanceof NeedsOcrError) scannedPdfs.push(f)
        else fail(f.name, e)
      }
    }
    setBusy(null)
    await refresh()
    // Photos and scanned PDFs need their text recognized: ask which language first.
    if (images.length || scannedPdfs.length) return setOcrAsk({ images, pdfs: scannedPdfs })
    if (lastId && added === 1) go('read/' + lastId)
  }

  const runOcr = async () => {
    const job = ocrAsk
    if (!job) return
    setOcrAsk(null)
    try {
      localStorage.setItem('qari.ocrLang', ocrLang)
    } catch {
      /* ignore */
    }
    let lastId: string | null = null
    let count = 0
    if (job.images.length) {
      const name = job.images.length === 1 ? job.images[0].name : `${job.images.length} photos`
      setBusy({ name, p: 0 })
      try {
        const { meta, content } = await importScans(job.images, ocrLang, (p, label) => setBusy({ name, p, label }))
        lastId = await store(meta, content)
        count++
      } catch (e) {
        fail(name, e)
      }
    }
    for (const f of job.pdfs) {
      setBusy({ name: f.name, p: 0 })
      try {
        const { meta, content } = await importScannedPdf(f, ocrLang, (p, label) => setBusy({ name: f.name, p, label }))
        lastId = await store(meta, content, f)
        count++
      } catch (e) {
        fail(f.name, e)
      }
    }
    setBusy(null)
    await refresh()
    if (lastId && count === 1) go('read/' + lastId)
  }

  const addLink = async () => {
    const raw = link.trim()
    const url = findUrl(raw) || (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(raw) ? 'https://' + raw : null)
    if (!url) return setLinkError('That doesn’t look like a web address. It should start with https://')
    setLinkError(null)
    setLinkOpen(false)
    const name = (() => {
      try {
        return new URL(url).hostname.replace(/^www\./, '')
      } catch {
        return url
      }
    })()
    setBusy({ name, p: 0.35, label: 'Fetching the article from' })
    try {
      const { meta, content } = await importArticle(url)
      const id = await store(meta, content)
      setLink('')
      setBusy(null)
      go('read/' + id)
    } catch (e) {
      setBusy(null)
      setLink(url)
      setLinkError(e instanceof Error ? e.message : String(e))
      setLinkOpen(true)
    }
  }

  const pasteLink = async () => {
    try {
      const t = await navigator.clipboard.readText()
      setLink(findUrl(t) || t.trim())
      setLinkError(null)
    } catch {
      setLinkError('Couldn’t read the clipboard. Long-press the box and choose Paste.')
    }
  }

  const savePaste = async () => {
    if (!pasteText.trim()) return
    const { meta, content } = importText(pasteText)
    if (folder && folder !== NO_FOLDER) meta.folder = folder
    await saveDoc(meta, content)
    setPasteText('')
    setPasteOpen(false)
    go('read/' + meta.id)
  }

  const remove = async (d: DocMeta) => {
    if (
      !(await ask({
        title: `Remove “${d.title}”?`,
        body: 'It’s removed from this device and, if sync is on, from your other devices. Its highlights and notes go with it; saved words stay.',
        yes: 'Remove',
        danger: true,
      }))
    )
      return
    await deleteDoc(d.id)
    refresh()
  }

  const saveTitle = async () => {
    if (!renaming || !newTitle.trim()) return
    await updateDocMeta(renaming.id, { title: newTitle.trim(), folder: newFolder.trim() || undefined })
    setRenaming(null)
    refresh()
  }

  const pickFolder = (f: string | null) => {
    setFolder(f)
    try {
      if (f) localStorage.setItem('qari.folder', f)
      else localStorage.removeItem('qari.folder')
    } catch {
      /* ignore */
    }
  }

  const folders = [...new Set((docs || []).map((d) => d.folder).filter((f): f is string => !!f))].sort((a, b) => a.localeCompare(b))
  const unfiled = (docs || []).some((d) => !d.folder)
  const activeFolder = folder && (folder === NO_FOLDER ? unfiled : folders.includes(folder)) ? folder : null

  const empty = docs !== null && docs.length === 0
  const q = query.trim().toLocaleLowerCase()
  const shown = (docs || []).filter(
    (d) =>
      (!activeFolder || (activeFolder === NO_FOLDER ? !d.folder : d.folder === activeFolder)) &&
      (!q || d.title.toLocaleLowerCase().includes(q) || (d.author || '').toLocaleLowerCase().includes(q) || (d.folder || '').toLocaleLowerCase().includes(q)),
  )
  // The book in progress you opened last leads the library, unless you're searching or in a folder.
  const current = !q && !activeFolder && docs && docs.length > 1 ? docs.find((d) => !d.importing && progress(d) > 0.005 && progress(d) < 0.995) : undefined
  const listed = current ? shown.filter((d) => d !== current) : shown

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
      <header className="mx-auto flex max-w-3xl items-center justify-between px-5 pt-[max(1rem,env(safe-area-inset-top))] pb-2 sm:px-6">
        <div className="flex items-baseline gap-3">
          <span className="font-arabic text-3xl leading-none text-moss" lang="ar">
            قارئ
          </span>
          <h1 className="text-lg font-semibold tracking-tight max-[420px]:sr-only">Qari</h1>
        </div>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => go('words')} data-tour="words" className="inline-flex h-11 items-center gap-1.5 rounded-full px-3 text-sm font-semibold text-ink-2 hover:bg-paper-2">
            <Icon name="words" size={18} /> <span className="max-[400px]:hidden">Saved words</span>
            <span className="min-[401px]:hidden">Words</span>
          </button>
          <span className="relative" data-tour="menu">
            <IconButton icon="more" label={sync.state === 'error' ? 'More: sync needs attention' : 'More: sync, voices, theme, backup'} onClick={() => setMenuOpen(true)} />
            {sync.state !== 'off' && (
              <span
                className={`pointer-events-none absolute top-2.5 right-2.5 h-2 w-2 rounded-full ring-2 ring-paper ${sync.state === 'error' ? 'bg-danger' : sync.state === 'syncing' ? 'animate-pulse bg-mark' : sync.state === 'offline' ? 'bg-ink-3' : 'bg-moss'}`}
                aria-hidden="true"
              />
            )}
          </span>
          <Button kind="primary" icon="plus" onClick={() => setAddOpen(true)} data-tour="add" className="ml-1">
            Add
          </Button>
        </div>
        <input
          ref={input}
          type="file"
          accept=".pdf,.epub,.docx,.txt,.md,.html,.htm,application/pdf,application/epub+zip,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/html,image/*"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) handleFiles(e.target.files)
            e.target.value = ''
          }}
        />
        <input
          ref={scanInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          aria-label="Photos of pages"
          onChange={(e) => {
            if (e.target.files?.length) handleFiles(e.target.files)
            e.target.value = ''
          }}
        />
        <input
          ref={restoreInput}
          type="file"
          accept=".json,application/json"
          hidden
          aria-label="Qari backup file"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) restore(f)
            e.target.value = ''
          }}
        />
      </header>

      <main className="mx-auto max-w-3xl px-5 pb-16 sm:px-6">
        {busy && (
          <div className="mt-4 rounded-xl border border-edge bg-paper-2 px-4 py-3 text-sm" role="status">
            <div className="flex justify-between gap-3">
              <span className="truncate">
                {busy.label || 'Reading'} {busy.label ? <span className="text-ink-3">· {busy.name}</span> : busy.name}
              </span>
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

        {notice && (
          <div className="mt-4 flex items-start justify-between gap-3 rounded-xl border border-line bg-wash px-4 py-3 text-sm" role="status">
            <span>{notice}</span>
            <button type="button" className="shrink-0 underline" onClick={() => setNotice(null)}>
              OK
            </button>
          </div>
        )}
        {atRisk && !busy && sync.state === 'off' && !!docs?.length && (
          <div className="mt-3 rounded-xl bg-paper-2 py-1 pr-1 pl-4 text-sm" role="note">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1">
                Your library is only on this device.{' '}
                <button type="button" className="text-ink-3 underline underline-offset-2" onClick={() => setRiskWhy((v) => !v)} aria-expanded={riskWhy}>
                  {riskWhy ? 'Less' : 'Why?'}
                </button>
              </span>
              <Button kind="quiet" compact onClick={() => setSyncOpen(true)} className="font-semibold text-moss">
                Turn on sync
              </Button>
              <IconButton icon="close" label="Not now" size={16} onClick={dismissRisk} />
            </div>
            {riskWhy && (
              <p className="pr-3 pb-2 text-ink-2">
                {platform() === 'ios'
                  ? 'Safari can clear it if you don’t open Qari for a while. Add Qari to your Home Screen (Share › Add to Home Screen), turn on sync, or '
                  : 'The browser can clear it when the device runs low on space. Turn on sync, install Qari as an app, or '}
                <button type="button" className="text-moss underline underline-offset-2" onClick={backUp}>
                  download a backup
                </button>
                .
              </p>
            )}
          </div>
        )}

        {empty && !busy && (
          <button
            type="button"
            onClick={() => input.current?.click()}
            className={`mt-10 flex w-full flex-col items-center rounded-xl border-2 border-dashed px-6 py-16 text-center ${dragging ? 'border-moss bg-wash' : 'border-line'}`}
          >
            <span className="font-arabic text-7xl leading-tight text-moss sm:text-8xl" lang="ar">
              اقرأ
            </span>
            <span className="mt-4 font-read text-2xl">Add something to read</span>
            <span className="mt-2 max-w-sm text-ink-2">
              Choose a PDF, EPUB or Word file, or drop it here. You can also scan pages or add a web link.{' '}
              {sync.state === 'off' ? 'It stays on this device unless you turn on sync.' : 'It syncs to your other devices.'}
            </span>
          </button>
        )}

        {docs && docs.length > 2 && (
          <label className="mt-4 flex h-11 items-center gap-2 rounded-full border border-line bg-paper-2 px-4 focus-within:border-moss">
            <Icon name="search" size={18} className="text-ink-3" />
            <span className="sr-only">Search your library</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search titles and authors"
              dir="auto"
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-ink-3"
            />
            {query && (
              <button type="button" onClick={() => setQuery('')} className="text-sm text-ink-3 underline">
                Clear
              </button>
            )}
          </label>
        )}
        {folders.length > 0 && (
          <div className="-mx-5 mt-4 flex gap-2 overflow-x-auto px-5 pb-1 sm:mx-0 sm:flex-wrap sm:px-0" role="group" aria-label="Folders">
            {[[null, 'All'] as const, ...folders.map((f) => [f, f] as const), ...(unfiled ? [[NO_FOLDER, 'No folder'] as const] : [])].map(([key, label]) => (
              <button
                key={key ?? 'all'}
                type="button"
                onClick={() => pickFolder(key)}
                aria-pressed={activeFolder === key}
                className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm ${activeFolder === key ? 'border-moss bg-wash font-semibold' : 'border-line'}`}
              >
                {key && key !== NO_FOLDER && <Icon name="folder" size={15} className="text-moss" />}
                {label}
                <span className="text-xs text-ink-3 tabular-nums">{(docs || []).filter((d) => (key === null ? true : key === NO_FOLDER ? !d.folder : d.folder === key)).length}</span>
              </button>
            ))}
          </div>
        )}
        {docs && docs.length > 0 && shown.length === 0 && (
          <p className="mt-6 text-center text-ink-2">{q ? `Nothing ${activeFolder && activeFolder !== NO_FOLDER ? `in ${activeFolder} ` : ''}matches “${query}”.` : 'This folder is empty.'}</p>
        )}

        {current && (
          <section className="mt-5" aria-labelledby="continue-h">
            <h2 id="continue-h" className="mb-1 text-sm font-semibold text-ink-2">
              Continue reading
            </h2>
            <div className="flex items-center gap-3 border-y border-line">
              <a href={`#/read/${current.id}`} className="min-w-0 flex-1 py-4">
                <div className="truncate font-read text-xl leading-snug" dir="auto">
                  {current.title}
                </div>
                <div className="mt-1 text-sm text-ink-3">
                  {Math.round(progress(current) * 100)}% read · opened {ago(current.openedAt)}
                </div>
                <div className="mt-2.5 h-[3px] w-full overflow-hidden rounded-full bg-line" aria-hidden="true">
                  <div className="h-full bg-moss" style={{ width: `${progress(current) * 100}%` }} />
                </div>
              </a>
              <a
                href={`#/read/${current.id}`}
                className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full bg-moss px-4 text-sm font-semibold text-moss-ink hover:opacity-90"
                aria-label={`Resume ${current.title}`}
              >
                <Icon name="play" size={16} /> Resume
              </a>
            </div>
          </section>
        )}

        {listed.length > 0 && (
          <>
            {current && <h2 className="mt-6 mb-1 text-sm font-semibold text-ink-2">Library</h2>}
            <ul className={`${current ? '' : 'mt-4 '}divide-y divide-line border-y border-line`}>
              {listed.map((d) => {
                const p = progress(d)
                return (
                  <li key={d.id} className="group relative flex items-center gap-2">
                    <a href={`#/read/${d.id}`} className="min-w-0 flex-1 py-4 pr-2">
                      <div className="truncate font-read text-xl leading-snug" dir="auto">
                        {d.title}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-x-3 text-sm text-ink-3">
                        {d.folder && !activeFolder && (
                          <span className="inline-flex items-center gap-1 text-moss">
                            <Icon name="folder" size={13} /> {d.folder}
                          </span>
                        )}
                        {d.author && <span className="truncate">{d.author}</span>}
                        <span>{LANG_NAMES[d.lang] || d.lang}</span>
                        <span>{kindLabel(d)}</span>
                        {d.vocab && settings.learning.includes(d.lang) && d.vocab.unique > 0 && (
                          <span className="text-moss" title={`${d.vocab.fresh} of ${d.vocab.unique} different words are new to you`}>
                            {d.vocab.fresh === 0 ? 'No new words' : `${d.vocab.fresh} new ${d.vocab.fresh === 1 ? 'word' : 'words'} (${Math.round((d.vocab.fresh / d.vocab.unique) * 100)}%)`}
                          </span>
                        )}
                        <span>{p > 0.995 ? 'Finished' : p > 0.005 ? `${Math.round(p * 100)}% read · opened ${ago(d.openedAt)}` : 'Not started'}</span>
                      </div>
                      <div className="mt-2.5 h-[3px] w-full overflow-hidden rounded-full bg-line" aria-label={`${Math.round(p * 100)}% read`}>
                        <div className="h-full bg-moss" style={{ width: `${Math.max(p * 100, 1.5)}%` }} />
                      </div>
                    </a>
                    <IconButton icon="more" label={`Options for ${d.title}`} onClick={() => setBookMenu(d)} className="text-ink-2" />
                  </li>
                )
              })}
            </ul>
          </>
        )}
        {docs && docs.length > 0 && <p className="mt-4 text-center text-sm text-ink-3">Drop PDFs, EPUBs, Word files or photos of pages anywhere here to add them.</p>}
        {empty && (
          <p className="mt-3 text-center text-sm">
            <button type="button" onClick={chooseBackup} className="text-moss underline underline-offset-2">
              Restore from a backup
            </button>
          </p>
        )}
      </main>

      <Sheet open={addOpen} onClose={() => setAddOpen(false)} title="Add to your library">
        <ActionList>
          {(
            [
              ['plus', 'Choose a file', 'PDF, EPUB, Word, web page or text file', () => input.current?.click()],
              ['camera', 'Scan pages', 'Take photos of a book or handout, or pick them from your photos', () => scanInput.current?.click()],
              [
                'link',
                'Add a web link',
                'An article or blog post, without the menus and ads',
                () => {
                  setLinkError(null)
                  setLinkOpen(true)
                },
              ],
              ['paste', 'Paste text', 'An article, an email, a message in French', () => setPasteOpen(true)],
            ] as const
          ).map(([icon, title, note, run]) => (
            <ActionRow
              key={title}
              icon={icon}
              title={title}
              note={note}
              onClick={() => {
                setAddOpen(false)
                run()
              }}
            />
          ))}
        </ActionList>
      </Sheet>

      <Sheet open={linkOpen} onClose={() => setLinkOpen(false)} title="Add a web link">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            addLink()
          }}
        >
          <div className="flex gap-2">
            <input
              value={link}
              onChange={(e) => {
                setLink(e.target.value)
                setLinkError(null)
              }}
              type="text"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
              aria-label="Web address"
              placeholder="https://"
              className="h-11 min-w-0 flex-1 rounded-xl border border-edge bg-paper-2 px-3 outline-none focus:border-moss"
            />
            <Button onClick={pasteLink}>Paste</Button>
          </div>
          {linkError && (
            <p className="mt-2 text-sm text-danger" role="alert">
              {linkError}
            </p>
          )}
          <Button type="submit" kind="primary" disabled={!link.trim()} className="mt-3 w-full">
            Add article
          </Button>
          <p className="mt-3 mb-2 text-sm text-ink-3">Works with most news sites, blogs and journals. Pages behind a login can’t be fetched; copy their text and use Paste text instead.</p>
        </form>
      </Sheet>

      <Sheet open={!!ocrAsk} onClose={() => setOcrAsk(null)} title="What language is the text in?">
        <p className="mb-3 text-sm text-ink-2">
          {ocrAsk && ocrAsk.pdfs.length > 0 && !ocrAsk.images.length
            ? `${ocrAsk.pdfs.length === 1 ? 'This PDF is' : 'These PDFs are'} scanned page images, so the text has to be recognized first.`
            : `Qari will read the text in ${ocrAsk?.images.length === 1 ? 'this photo' : `these ${ocrAsk?.images.length} photos`}${ocrAsk?.pdfs.length ? ' and the scanned PDFs' : ''}.`}{' '}
          It happens on this device; nothing is uploaded.
        </p>
        <div className="grid grid-cols-2 gap-2">
          {OCR_CHOICES.map(([code, name, native]) => (
            <button
              key={code}
              type="button"
              onClick={() => setOcrLang(code)}
              aria-pressed={ocrLang === code}
              className={`flex h-14 flex-col items-center justify-center rounded-xl border ${ocrLang === code ? 'border-moss bg-wash font-semibold' : 'border-line'}`}
            >
              <span lang={code} dir={code === 'ar' ? 'rtl' : 'ltr'} className={code === 'ar' ? 'font-arabic text-lg leading-tight' : ''}>
                {native}
              </span>
              {native !== name && <span className="text-xs text-ink-3">{name}</span>}
            </button>
          ))}
        </div>
        <Button kind="primary" onClick={runOcr} className="mt-4 w-full">
          Read the text
        </Button>
        <p className="mt-3 mb-2 text-xs text-ink-3">
          The first time takes a moment to download the {OCR_CHOICES.find((c) => c.at(0) === ocrLang)?.at(1)} reader (1–3 MB); after that it works offline. Best results: flat pages, good light, the
          page filling the photo.
        </p>
      </Sheet>

      <SyncSheet open={syncOpen} onClose={() => setSyncOpen(false)} joinCode={joinCode} />

      <VoiceCheck open={voicesOpen} onClose={() => setVoicesOpen(false)} />

      <Sheet open={menuOpen} onClose={() => setMenuOpen(false)} title="Qari">
        <ActionList>
          {(
            [
              ['sync', 'cloud', 'Sync between devices', sync.state === 'off' ? 'Off · keep your phone and laptop the same' : `On · ${sync.state === 'error' ? 'needs attention' : sync.state}`],
              ['voices', 'speaker', 'Voices on this device', 'Check each language and pick a voice'],
              ['theme', dark ? 'sun' : 'moon', dark ? 'Light mode' : 'Dark mode', 'Sepia and text size are in reading settings'],
              ['backup', 'download', 'Download a backup', 'Every book, note and saved word in one file'],
              ['restore', 'upload', 'Restore from a backup', 'Adds anything missing; keeps what’s here'],
              ['tour', 'read', 'Take the tour', 'A quick look at where everything is'],
            ] as const
          ).map(([key, icon, title, hint]) => (
            <ActionRow key={key} icon={icon} title={title} note={hint} onClick={() => runMenu(key)} />
          ))}
        </ActionList>
      </Sheet>

      <Sheet open={!!bookMenu} onClose={() => setBookMenu(null)} title={<span dir="auto">{bookMenu?.title}</span>}>
        <ActionList>
          <ActionRow
            icon="pencil"
            title="Rename or move to a folder"
            onClick={() => {
              const d = bookMenu!
              setBookMenu(null)
              setRenaming(d)
              setNewTitle(d.title)
              setNewFolder(d.folder || '')
            }}
          />
          <ActionRow
            icon="trash"
            title="Remove from library"
            danger
            onClick={() => {
              const d = bookMenu!
              setBookMenu(null)
              remove(d)
            }}
          />
        </ActionList>
      </Sheet>

      <Sheet open={!!renaming} onClose={() => setRenaming(null)} title="Edit details">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            saveTitle()
          }}
        >
          <label htmlFor="ed-title" className="mb-1 block text-sm font-semibold">
            Title
          </label>
          <input
            id="ed-title"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            dir="auto"
            autoFocus
            className="h-11 w-full rounded-xl border border-edge bg-paper-2 px-3 font-read text-lg outline-none focus:border-moss"
          />
          <label htmlFor="ed-folder" className="mt-4 mb-1 block text-sm font-semibold">
            Folder
          </label>
          <input
            id="ed-folder"
            value={newFolder}
            onChange={(e) => setNewFolder(e.target.value)}
            list="folder-list"
            dir="auto"
            placeholder="e.g. COUN 6301, Arabic, Fun reading"
            className="h-11 w-full rounded-xl border border-edge bg-paper-2 px-3 outline-none focus:border-moss"
          />
          <datalist id="folder-list">
            {folders.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
          {folders.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {folders.map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setNewFolder(f)}
                  className={`h-9 rounded-full border px-3 text-sm ${newFolder === f ? 'border-moss bg-wash font-semibold' : 'border-line'}`}
                >
                  {f}
                </button>
              ))}
              {newFolder && (
                <button type="button" onClick={() => setNewFolder('')} className="h-9 rounded-full px-3 text-sm text-ink-3 underline">
                  No folder
                </button>
              )}
            </div>
          )}
          <Button type="submit" kind="primary" disabled={!newTitle.trim()} className="mt-4 mb-2 w-full">
            Save
          </Button>
        </form>
      </Sheet>

      <Sheet open={pasteOpen} onClose={() => setPasteOpen(false)} title="Paste text" wide>
        <textarea
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
          dir="auto"
          placeholder="Paste an article, a chapter, a text message in French…"
          className="h-56 w-full resize-y rounded-xl border border-edge bg-paper-2 p-3 font-read text-base outline-none focus:border-moss"
        />
        <Button disabled={!pasteText.trim()} onClick={savePaste} kind="primary" className="mt-3 w-full">
          Read it
        </Button>
      </Sheet>
    </div>
  )
}
