import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/literata/opsz.css'
import '@fontsource-variable/literata/opsz-italic.css'
import '@fontsource-variable/instrument-sans/index.css'
import '@fontsource-variable/readex-pro/index.css'
import '@fontsource-variable/noto-sans-arabic/index.css'
import '@fontsource-variable/noto-naskh-arabic/index.css'
import '@fontsource/opendyslexic/400.css'
import '@fontsource/opendyslexic/700.css'
import '@fontsource-variable/lexend/wght.css'
import '@fontsource-variable/atkinson-hyperlegible-next/wght.css'
import './index.css'
import App from './App'
import { initSync } from './lib/sync'
import { initVoices } from './lib/voices'

initSync()
initVoices()

// After a new version is deployed, an open tab can ask for code files that no longer exist (when you first
// import a PDF, say). Reload once to pick up the new version instead of showing "Failed to fetch module".
window.addEventListener('vite:preloadError', (e) => {
  try {
    const last = Number(sessionStorage.getItem('qari.reloadedAt') || 0)
    if (Date.now() - last < 30000) return // already tried: let the error show
    sessionStorage.setItem('qari.reloadedAt', String(Date.now()))
  } catch {
    /* storage unavailable: reload anyway */
  }
  e.preventDefault()
  location.reload()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
