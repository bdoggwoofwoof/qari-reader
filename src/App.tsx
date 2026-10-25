import { useEffect, useState } from 'react'
import Library, { type Shared } from './components/Library'
import Reader from './components/Reader'
import Words from './components/Words'
import { useSettings } from './lib/settings'
import { ARABIC_FONTS } from './types'

function useHashRoute() {
  const [hash, setHash] = useState(() => window.location.hash)
  useEffect(() => {
    const h = () => setHash(window.location.hash)
    window.addEventListener('hashchange', h)
    return () => window.removeEventListener('hashchange', h)
  }, [])
  return hash.replace(/^#\/?/, '').split('/')
}

export function go(path: string) {
  window.location.hash = '/' + path
}

// Android "Share → Qari" opens the app with ?url=…&text=…&title=… (see share_target in vite.config.ts).
const shared: Shared | undefined = (() => {
  const q = new URLSearchParams(location.search)
  if (!q.has('url') && !q.has('text')) return undefined
  history.replaceState(null, '', location.pathname + location.hash)
  return { title: q.get('title') || undefined, text: q.get('text') || undefined, url: q.get('url') || undefined }
})()

export default function App() {
  const route = useHashRoute()
  const [settings] = useSettings()

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme
    const meta = document.querySelector('meta[name="theme-color"]')
    meta?.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--paper').trim())
  }, [settings.theme])

  useEffect(() => {
    const f = ARABIC_FONTS[settings.arabicFont] || ARABIC_FONTS.readex
    const st = document.documentElement.style
    st.setProperty('--arabic-face', f.family)
    st.setProperty('--arabic-size', f.size)
    st.setProperty('--arabic-leading', f.leading)
  }, [settings.arabicFont])

  if (route[0] === 'read' && route[1]) return <Reader key={route[1]} id={route[1]} />
  if (route[0] === 'words') return <Words />
  if (route[0] === 'sync' && route[1]) return <Library key="join" joinCode={route[1].toUpperCase()} />
  return <Library shared={shared} />
}
