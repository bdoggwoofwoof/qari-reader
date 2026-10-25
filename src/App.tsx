import { useEffect, useState } from 'react'
import Library, { type Shared } from './components/Library'
import Reader from './components/Reader'
import Words from './components/Words'
import Tour from './components/Tour'
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
    // iPhone reads this when you tap Add to Home Screen, so the home-screen icon matches the theme in use then.
    document.querySelector('link[rel="apple-touch-icon"]')?.setAttribute('href', settings.theme === 'dark' ? '/apple-touch-icon.png' : '/apple-touch-icon-light.png')
  }, [settings.theme])

  useEffect(() => {
    const f = ARABIC_FONTS[settings.arabicFont] || ARABIC_FONTS.readex
    const st = document.documentElement.style
    st.setProperty('--arabic-face', f.family)
    st.setProperty('--arabic-size', f.size)
    st.setProperty('--arabic-leading', f.leading)
  }, [settings.arabicFont])

  const screen =
    route[0] === 'read' && route[1] ? (
      <Reader key={route[1]} id={route[1]} />
    ) : route[0] === 'words' ? (
      <Words />
    ) : route[0] === 'sync' && route[1] ? (
      <Library key="join" joinCode={route[1].toUpperCase()} />
    ) : (
      <Library shared={shared} />
    )
  return (
    <>
      {screen}
      <Tour />
    </>
  )
}
