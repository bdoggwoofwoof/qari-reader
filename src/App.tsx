import { useEffect, useState } from 'react'
import Library from './components/Library'
import Reader from './components/Reader'
import Words from './components/Words'
import { useSettings } from './lib/settings'

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

export default function App() {
  const route = useHashRoute()
  const [settings] = useSettings()

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme
    const meta = document.querySelector('meta[name="theme-color"]')
    meta?.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--paper').trim())
  }, [settings.theme])

  if (route[0] === 'read' && route[1]) return <Reader key={route[1]} id={route[1]} />
  if (route[0] === 'words') return <Words />
  return <Library />
}
