import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { defineConfig, type Plugin } from 'vite'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Copies the text-recognition engine and its language data into public/ocr, so OCR runs entirely
 * from this app (works offline, no third-party CDN sees your pages). Files come from npm packages.
 */
function ocrAssets(): Plugin {
  const files: [string, string][] = [
    ['tesseract.js/dist/worker.min.js', 'worker.min.js'],
    ['tesseract.js-core/tesseract-core-lstm.wasm.js', 'core/tesseract-core-lstm.wasm.js'],
    ['tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'core/tesseract-core-simd-lstm.wasm.js'],
    ['tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js', 'core/tesseract-core-relaxedsimd-lstm.wasm.js'],
    ...['eng', 'ara', 'fra', 'deu'].map((l) => [`@tesseract.js-data/${l}/4.0.0_best_int/${l}.traineddata.gz`, `lang/${l}.traineddata.gz`] as [string, string]),
  ]
  const copy = () => {
    for (const [from, to] of files) {
      const src = join('node_modules', from)
      const dest = join('public', 'ocr', to)
      if (!existsSync(src)) throw new Error(`OCR asset missing: ${src} (run npm install)`)
      if (existsSync(dest) && statSync(dest).size === statSync(src).size) continue
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(src, dest)
    }
  }
  return { name: 'qari-ocr-assets', buildStart: copy, configureServer: copy }
}

export default defineConfig({
  plugins: [
    ocrAssets(),
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon*.png', 'apple-touch-icon*.png', 'icon-*-light.png'],
      manifest: {
        name: 'Qari Reader',
        short_name: 'Qari',
        description: 'Read PDFs, EPUBs, Word files, web articles and scanned pages aloud, and look up any word as you listen.',
        theme_color: '#1f2a24',
        background_color: '#000000',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        // Android: "Share → Qari" from the browser or any app sends the link (or text) here.
        share_target: { action: '/', method: 'GET', params: { title: 'title', text: 'text', url: 'url' } },
      },
      workbox: {
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,woff2}'],
        // The OCR engine is big; it's downloaded the first time you scan, then kept for offline use.
        globIgnores: ['ocr/**'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/ocr/'),
            handler: 'CacheFirst',
            options: { cacheName: 'qari-ocr', expiration: { maxEntries: 20 } },
          },
        ],
      },
    }),
  ],
})
