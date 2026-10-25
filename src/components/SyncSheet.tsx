import qrcode from 'qrcode-generator'
import { useEffect, useMemo, useState } from 'react'
import { getSyncCode, startSync, stopSync, syncNow, useSyncStatus } from '../lib/sync'
import { formatCode, newSyncCode, normalizeCode } from '../lib/syncCrypto'
import { Icon, Sheet } from './ui'

function ago(t?: number) {
  if (!t) return 'not yet'
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  return h < 24 ? `${h} h ago` : new Date(t).toLocaleDateString()
}

export function joinLink(code: string) {
  return `${location.origin}${location.pathname}#/sync/${code}`
}

export default function SyncSheet({ open, onClose, joinCode }: { open: boolean; onClose: () => void; joinCode?: string }) {
  const status = useSyncStatus()
  const [code, setCode] = useState(getSyncCode())
  const [typed, setTyped] = useState(joinCode ? formatCode(joinCode) : '')
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [, tick] = useState(0)

  useEffect(() => {
    if (joinCode) setTyped(formatCode(joinCode))
  }, [joinCode])

  // Keep "synced 2 min ago" fresh while open.
  useEffect(() => {
    if (!open) return
    const t = setInterval(() => tick((n) => n + 1), 20_000)
    return () => clearInterval(t)
  }, [open])

  const qr = useMemo(() => {
    if (!code) return ''
    const q = qrcode(0, 'M')
    q.addData(joinLink(code))
    q.make()
    return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true })
  }, [code])

  const turnOn = async () => {
    const c = newSyncCode()
    setCode(c)
    await startSync(c)
  }

  const join = async () => {
    const c = normalizeCode(typed)
    if (!c) {
      setError('That code doesn’t look right. It’s 32 letters and numbers, in groups of four.')
      return
    }
    setError(null)
    setCode(c)
    await startSync(c)
    if (location.hash.startsWith('#/sync')) history.replaceState(null, '', location.pathname + '#/')
  }

  const turnOff = () => {
    if (!confirm('Stop syncing on this device? Your books stay here, and your other devices keep their copies.')) return
    stopSync()
    setCode(null)
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(joinLink(code!))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard blocked */
    }
  }

  const statusLine =
    status.state === 'syncing'
      ? 'Syncing…'
      : status.state === 'error'
        ? status.error || 'Sync failed.'
        : status.state === 'offline'
          ? 'Offline. Changes will sync when you’re back online.'
          : `Last synced ${ago(status.lastSync)}`

  return (
    <Sheet open={open} onClose={onClose} title="Sync" wide>
      {!code ? (
        <>
          <p className="text-ink-2">
            Keep your books, reading place, saved words and settings the same on your phone and laptop. Everything is encrypted on this device before it’s uploaded, so only your
            devices can read it.
          </p>
          {joinCode ? null : (
            <button type="button" onClick={turnOn} className="mt-4 h-11 w-full rounded-full bg-moss font-semibold text-moss-ink">
              Turn on sync
            </button>
          )}
          <form
            className="mt-6"
            onSubmit={(e) => {
              e.preventDefault()
              join()
            }}
          >
            <label htmlFor="sync-code" className="mb-1 block font-semibold">
              {joinCode ? 'Join your library' : 'Already syncing on another device?'}
            </label>
            <p className="mb-2 text-sm text-ink-3">{joinCode ? 'This code came from your other device.' : 'Scan its QR code with this device’s camera, or type its sync code.'}</p>
            <div className="flex gap-2">
              <input
                id="sync-code"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder="XXXX-XXXX-XXXX-…"
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                className="h-11 min-w-0 flex-1 rounded-xl border border-line bg-paper-2 px-3 font-mono text-sm tracking-wide uppercase outline-none focus:border-moss"
              />
              <button type="submit" disabled={!typed.trim()} className={`h-11 rounded-xl px-4 font-semibold disabled:opacity-40 ${joinCode ? 'bg-moss text-moss-ink' : 'border border-line'}`}>
                Join
              </button>
            </div>
            {error && <p className="mt-2 text-sm text-danger">{error}</p>}
          </form>
        </>
      ) : (
        <>
          <div className="flex items-center gap-2 rounded-xl bg-paper-2 px-3 py-2.5 text-sm" role="status">
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${status.state === 'error' ? 'bg-danger' : status.state === 'syncing' ? 'animate-pulse bg-mark' : status.state === 'offline' ? 'bg-ink-3' : 'bg-moss'}`}
              aria-hidden="true"
            />
            <span className="flex-1">{statusLine}</span>
            <button type="button" onClick={() => syncNow()} disabled={status.state === 'syncing'} className="shrink-0 font-semibold text-moss underline-offset-2 hover:underline disabled:opacity-40">
              Sync now
            </button>
          </div>

          <h3 className="mt-5 font-semibold">Add another device</h3>
          <p className="mt-1 text-sm text-ink-2">Point your phone’s camera at this code and open the link, then tap Join.</p>
          <div className="mt-3 flex flex-col items-center gap-3 sm:flex-row sm:items-start">
            <div className="w-44 shrink-0 rounded-xl bg-white p-2" aria-label="QR code with your sync link" role="img" dangerouslySetInnerHTML={{ __html: qr }} />
            <div className="min-w-0 flex-1 text-center sm:text-left">
              <p className="text-sm text-ink-3">Or type this code on the other device:</p>
              <p className="mt-1 font-mono text-[0.95rem] leading-relaxed font-semibold tracking-wide select-all">
                {formatCode(code).slice(0, 19)}
                <br />
                {formatCode(code).slice(20)}
              </p>
              <button type="button" onClick={copy} className="mt-2 inline-flex h-9 items-center gap-1.5 rounded-full border border-line px-3 text-sm hover:bg-paper-2">
                <Icon name="paste" size={16} /> {copied ? 'Link copied' : 'Copy join link'}
              </button>
            </div>
          </div>
          <p className="mt-4 text-sm text-ink-3">Keep this code private: anyone who has it can read your synced library.</p>
          <button type="button" onClick={turnOff} className="mt-4 mb-2 h-11 w-full rounded-full border border-line text-sm font-semibold text-danger hover:bg-paper-2">
            Turn off sync on this device
          </button>
        </>
      )}
    </Sheet>
  )
}
