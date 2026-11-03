import { useEffect, useId, useRef, useState, type ReactNode } from 'react'

const paths: Record<string, ReactNode> = {
  play: <path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none" />,
  pause: (
    <>
      <rect x="6.5" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" />
      <rect x="13.5" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" />
    </>
  ),
  back: <path d="M15 5l-7 7 7 7" />,
  prev: <path d="M18 6l-7 6 7 6M7 6v12" />,
  next: <path d="M6 6l7 6-7 6M17 6v12" />,
  list: <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />,
  sliders: <path d="M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  sun: <path d="M12 16a4 4 0 100-8 4 4 0 000 8zM12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />,
  moon: <path d="M19 14.5A7.5 7.5 0 019.5 5a7.5 7.5 0 109.5 9.5z" />,
  repeat: <path d="M17 3l3 3-3 3M4 12V9a3 3 0 013-3h13M7 21l-3-3 3-3M20 12v3a3 3 0 01-3 3H4" />,
  pencil: <path d="M14 5l5 5M4 20l4-1 11-11-4-4L4 15z" />,
  search: <path d="M11 18a7 7 0 110-14 7 7 0 010 14zM20 20l-4-4" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  translate: <path d="M4 5h8M8 3v2M6 5c0 4 3 7 6 8M10 5c0 4-3 7-6 8M13 20l4-9 4 9M14.5 17h5" />,
  anki: <path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6-4.5-4.2 6.1-.7z" />,
  camera: <path d="M4 8h3l2-3h6l2 3h3v11H4zM12 17a4 4 0 100-8 4 4 0 000 8z" />,
  link: <path d="M10 14a4 4 0 005.66 0l3-3a4 4 0 00-5.66-5.66l-1 1M14 10a4 4 0 00-5.66 0l-3 3a4 4 0 005.66 5.66l1-1" />,
  page: <path d="M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 16h5" />,
  highlight: <path d="M4 20h7M14 4l6 6-8 8H6v-6z" />,
  note: <path d="M5 4h14v12l-4 4H5zM15 20v-4h4M8 9h8M8 13h5" />,
  folder: <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />,
  cloud: <path d="M7 18h10a4 4 0 00.6-7.96A6 6 0 006.2 9.1 4.5 4.5 0 007 18z" />,
  rise: <path d="M4 17l6-6 4 4 6-7M15 8h5v5" />,
  bolt: <path d="M13 3L5 14h6l-1 7 8-11h-6z" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  trash: <path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" />,
  bookmark: <path d="M7 4h10v16l-5-4-5 4z" />,
  bookmarkFilled: <path d="M7 4h10v16l-5-4-5 4z" fill="currentColor" />,
  speaker: <path d="M5 9v6h4l5 4V5L9 9zM17 9a4 4 0 010 6" />,
  words: <path d="M5 5h9a3 3 0 013 3v11a2 2 0 00-2-2H5zM17 8h2v11" />,
  download: <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
  chevron: <path d="M7 10l5 5 5-5" />,
  upload: <path d="M12 15V4M7 9l5-5 5 5M5 20h14" />,
  more: <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="3" />,
  external: <path d="M14 5h5v5M19 5l-8 8M17 14v5H5V7h5" />,
  paste: <path d="M9 4h6v3H9zM7 5H5v15h14V5h-2" />,
  read: <path d="M5 12h3l2-5 4 10 2-5h3" />,
}

export function Icon({ name, size = 20, className = '' }: { name: keyof typeof paths | string; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      {paths[name]}
    </svg>
  )
}

export function IconButton({
  icon,
  label,
  onClick,
  className = '',
  size = 20,
  disabled,
  tour,
}: {
  icon: string
  label: string
  onClick?: () => void
  className?: string
  size?: number
  disabled?: boolean
  tour?: string
}) {
  return (
    <button
      type="button"
      data-tour={tour}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-ink-2 hover:bg-paper-2 hover:text-ink disabled:opacity-35 ${className}`}
    >
      <Icon name={icon} size={size} />
    </button>
  )
}

/** Bottom sheet on phones, centered panel on wider screens. Focus moves in, stays in, and returns on close. */
export function Sheet({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean }) {
  const titleId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (!open) return
    const before = document.activeElement as HTMLElement | null
    // Focus the panel, so Tab starts inside it and screen readers announce the dialog.
    requestAnimationFrame(() => {
      const el = panel.current
      if (!el || el.contains(document.activeElement)) return
      el.focus({ preventScroll: true })
    })
    const k = (e: KeyboardEvent) => {
      const el = panel.current
      if (!el) return
      // Only the topmost sheet answers keys.
      const sheets = document.querySelectorAll('[data-sheet]')
      if (sheets[sheets.length - 1] !== el) return
      if (e.key === 'Escape') close.current()
      if (e.key === 'Tab') {
        const f = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null)
        if (!f.length) return
        const i = f.indexOf(document.activeElement as HTMLElement)
        if (e.shiftKey && i <= 0) {
          e.preventDefault()
          f[f.length - 1].focus()
        } else if (!e.shiftKey && (i === f.length - 1 || i === -1)) {
          e.preventDefault()
          f[0].focus()
        }
      }
    }
    window.addEventListener('keydown', k)
    return () => {
      window.removeEventListener('keydown', k)
      if (before && document.contains(before)) before.focus({ preventScroll: true })
    }
  }, [open])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <button type="button" aria-label="Close" tabIndex={-1} className="absolute inset-0 bg-ink/25" onClick={onClose} />
      <div
        ref={panel}
        data-sheet=""
        tabIndex={-1}
        className={`sheet-in safe-b relative max-h-[85dvh] w-full overflow-y-auto rounded-t-2xl border border-line bg-paper px-5 pt-4 shadow-sheet outline-none sm:rounded-2xl sm:pb-5 ${wide ? 'sm:max-w-xl' : 'sm:max-w-md'}`}
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 id={titleId} className="text-lg font-semibold">
            {title}
          </h2>
          <IconButton icon="close" label="Close" onClick={onClose} className="-mr-2" />
        </div>
        {children}
      </div>
    </div>
  )
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/* ----- Shared controls. Use these instead of restyling buttons in each file. ----- */

type ButtonKind = 'primary' | 'secondary' | 'quiet' | 'danger'
const KIND: Record<ButtonKind, string> = {
  primary: 'bg-moss font-semibold text-moss-ink hover:opacity-90',
  secondary: 'border border-edge bg-paper hover:bg-paper-2',
  quiet: 'text-ink-2 hover:bg-paper-2 hover:text-ink',
  danger: 'border border-edge bg-paper text-danger hover:bg-paper-2',
}

/** A labelled button. 44px tall by default; `compact` is 36px for inline use (rows, chips). */
export function Button({
  kind = 'secondary',
  compact,
  icon,
  children,
  className = '',
  type = 'button',
  ...rest
}: { kind?: ButtonKind; compact?: boolean; icon?: string; children: ReactNode; className?: string } & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'>) {
  return (
    <button
      type={type}
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full text-sm disabled:opacity-40 ${compact ? 'h-9 px-3' : 'h-11 px-4'} ${KIND[kind]} ${className}`}
      {...rest}
    >
      {icon && <Icon name={icon} size={compact ? 16 : 18} />}
      {children}
    </button>
  )
}

/** One choice out of a few (2–4 short options, or a grid like speeds). */
export function Choices<T extends string | number>({
  value,
  options,
  onChange,
  cols,
  label,
}: {
  value: T
  options: readonly (readonly [T, ReactNode])[]
  onChange: (v: T) => void
  cols?: number
  label: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className="grid gap-2" style={{ gridTemplateColumns: `repeat(${cols || options.length}, minmax(0, 1fr))` }}>
      {options.map(([k, text]) => (
        <button
          key={String(k)}
          type="button"
          role="radio"
          aria-checked={value === k}
          onClick={() => onChange(k)}
          className={`h-11 rounded-xl border text-sm ${value === k ? 'border-moss bg-wash font-semibold' : 'border-edge hover:bg-paper-2'}`}
        >
          {text}
        </button>
      ))}
    </div>
  )
}

/** Tabs that switch a view in place (a segmented control). */
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: readonly (readonly [T, ReactNode])[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="grid gap-1 rounded-xl bg-paper-2 p-1" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map(([k, text]) => (
        <button
          key={k}
          type="button"
          role="tab"
          aria-selected={value === k}
          onClick={() => onChange(k)}
          className={`h-9 rounded-xl text-sm ${value === k ? 'bg-paper font-semibold shadow-float' : 'text-ink-2 hover:text-ink'}`}
        >
          {text}
        </button>
      ))}
    </div>
  )
}

/** A chip you can switch on and off (several can be on). */
export function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`h-9 rounded-full border px-3 text-sm ${on ? 'border-moss bg-wash font-semibold' : 'border-edge text-ink-2 hover:bg-paper-2'}`}
    >
      {children}
    </button>
  )
}

/** An on/off setting: title, one-line explanation, and a checkbox. The whole row is the target. */
export function Toggle({ checked, onChange, title, hint }: { checked: boolean; onChange: (v: boolean) => void; title: string; hint?: ReactNode }) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center justify-between gap-4 py-2">
      <span>
        <span className="block font-semibold">{title}</span>
        {hint && <span className="block text-sm text-ink-3">{hint}</span>}
      </span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-5 w-5 shrink-0 accent-[var(--moss)]" />
    </label>
  )
}

/** A titled group inside a sheet. */
export function Section({ title, hint, children, aside }: { title: ReactNode; hint?: ReactNode; children?: ReactNode; aside?: ReactNode }) {
  return (
    <section className="border-t border-line py-4 first-of-type:border-t-0 first-of-type:pt-1">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold">{title}</h3>
          {hint && <p className="text-sm text-ink-3">{hint}</p>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  )
}

/** A tappable row with an icon, a title and a line of explanation: the one pattern for lists of actions. */
export function ActionRow({ icon, title, note, onClick, danger, trailing }: { icon: string; title: ReactNode; note?: ReactNode; onClick: () => void; danger?: boolean; trailing?: ReactNode }) {
  return (
    <li>
      <button type="button" onClick={onClick} className={`flex min-h-14 w-full items-center gap-3 py-2.5 text-left hover:bg-paper-2 ${danger ? 'text-danger' : ''}`}>
        <span className={`inline-flex h-9 w-9 shrink-0 items-center justify-center ${danger ? '' : 'text-ink-2'}`}>
          <Icon name={icon} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-semibold">{title}</span>
          {note && <span className={`block text-sm ${danger ? 'opacity-80' : 'text-ink-3'}`}>{note}</span>}
        </span>
        {trailing}
      </button>
    </li>
  )
}

/** A list of ActionRows with hairlines between. */
export function ActionList({ children }: { children: ReactNode }) {
  return <ul className="-mx-1 mb-2 divide-y divide-line px-1">{children}</ul>
}

/** "Are you sure?" as a sheet, replacing the browser's confirm(). `ask()` resolves true or false. */
type Ask = { title: string; body?: string; yes: string; danger?: boolean }
let askHandler: ((a: Ask) => Promise<boolean>) | null = null
export function ask(a: Ask): Promise<boolean> {
  return askHandler ? askHandler(a) : Promise.resolve(window.confirm(a.title))
}
export function ConfirmHost() {
  const [q, setQ] = useState<(Ask & { done: (v: boolean) => void }) | null>(null)
  useEffect(() => {
    askHandler = (a) => new Promise((done) => setQ({ ...a, done }))
    return () => {
      askHandler = null
    }
  }, [])
  const answer = (v: boolean) => {
    q?.done(v)
    setQ(null)
  }
  return (
    <Sheet open={!!q} onClose={() => answer(false)} title={q?.title}>
      {q?.body && <p className="mb-4 text-ink-2">{q.body}</p>}
      <div className="flex justify-end gap-2 pb-2">
        <Button onClick={() => answer(false)}>Cancel</Button>
        <Button kind={q?.danger ? 'danger' : 'primary'} onClick={() => answer(true)}>
          {q?.yes}
        </Button>
      </div>
    </Sheet>
  )
}
