import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/literata/opsz.css'
import '@fontsource-variable/literata/opsz-italic.css'
import '@fontsource-variable/instrument-sans/index.css'
import '@fontsource-variable/readex-pro/index.css'
import '@fontsource-variable/noto-sans-arabic/index.css'
import '@fontsource-variable/noto-naskh-arabic/index.css'
import './index.css'
import App from './App'
import { initSync } from './lib/sync'

initSync()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
