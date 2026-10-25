import { useEffect, type ReactNode } from 'react'

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
  moon: <path d="M19 14.5A7.5 7.5 0 019.5 5a7.5 7.5 0 109.5 9.5z" />,
  repeat: <path d="M17 3l3 3-3 3M4 12V9a3 3 0 013-3h13M7 21l-3-3 3-3M20 12v3a3 3 0 01-3 3H4" />,
  pencil: <path d="M14 5l5 5M4 20l4-1 11-11-4-4L4 15z" />,
  search: <path d="M11 18a7 7 0 110-14 7 7 0 010 14zM20 20l-4-4" />,
  page: <path d="M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 16h5" />,
  highlight: <path d="M4 20h7M14 4l6 6-8 8H6v-6z" />,
  note: <path d="M5 4h14v12l-4 4H5zM15 20v-4h4M8 9h8M8 13h5" />,
  folder: <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />,
  cloud: <path d="M7 18h10a4 4 0 00.6-7.96A6 6 0 006.2 9.1 4.5 4.5 0 007 18z" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  trash: <path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" />,
  bookmark: <path d="M7 4h10v16l-5-4-5 4z" />,
  bookmarkFilled: <path d="M7 4h10v16l-5-4-5 4z" fill="currentColor" />,
  speaker: <path d="M5 9v6h4l5 4V5L9 9zM17 9a4 4 0 010 6" />,
  words: <path d="M5 5h9a3 3 0 013 3v11a2 2 0 00-2-2H5zM17 8h2v11" />,
  download: <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
  external: <path d="M14 5h5v5M19 5l-8 8M17 14v5H5V7h5" />,
  paste: <path d="M9 4h6v3H9zM7 5H5v15h14V5h-2" />,
  read: <path d="M5 12h3l2-5 4 10 2-5h3" />,
}

export function Icon({ name, size = 20, className = '' }: { name: keyof typeof paths | string; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
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
}: {
  icon: string
  label: string
  onClick?: () => void
  className?: string
  size?: number
  disabled?: boolean
}) {
  return (
    <button
      type="button"
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

/** Bottom sheet on phones, centered panel on wider screens. */
export function Sheet({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-ink/25" onClick={onClose} />
      <div
        className={`sheet-in safe-b relative max-h-[85dvh] w-full overflow-y-auto rounded-t-2xl border border-line bg-paper px-5 pt-4 shadow-[0_-8px_40px_rgb(0_0_0/0.12)] sm:rounded-2xl sm:pb-5 ${wide ? 'sm:max-w-xl' : 'sm:max-w-md'}`}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-line sm:hidden" />
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">{title}</h2>
          <IconButton icon="close" label="Close" onClick={onClose} className="-mr-2" />
        </div>
        {children}
      </div>
    </div>
  )
}
