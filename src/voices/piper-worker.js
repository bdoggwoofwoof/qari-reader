/* Qari's built-in voices: Piper (https://github.com/rhasspy/piper) running on the device.
 * A classic worker, copied as-is to /voices/piper-worker.js at build time (see vite.config.ts).
 *
 * Messages in:
 *   { type: 'download', voice }          fetch and keep a voice's model (progress messages while it downloads)
 *   { type: 'speak', id, voice, text }   synthesize one sentence → { type: 'audio', id, wav, groups }
 *   { type: 'remove', voice }            forget a downloaded voice
 *   { type: 'stored' }                   → { type: 'stored', voices }
 * Everything is served by Qari itself except the voice models, which come from Hugging Face once and are kept.
 */
/* global importScripts, createPiperPhonemize, ort */

const BASE = self.location.href.replace(/[^/]*$/, '') // /voices/
const MODELS = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/'
const CACHE = 'qari-voice-models'

importScripts(BASE + 'piper_phonemize.js', BASE + 'ort/ort.wasm.min.js')
ort.env.wasm.wasmPaths = BASE + 'ort/'
ort.env.wasm.numThreads = 1

function modelUrl(voice) {
  const [region, name, quality] = voice.split('-')
  return `${MODELS}${region.split('_')[0]}/${region}/${name}/${quality}/${voice}.onnx`
}

/** Fetches from the cache, or downloads (reporting progress) and keeps it. */
async function cached(url, onProgress) {
  const cache = await caches.open(CACHE)
  const hit = await cache.match(url)
  if (hit) return hit.arrayBuffer()
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Download failed (${res.status})`)
  const total = Number(res.headers.get('Content-Length')) || 0
  const reader = res.body.getReader()
  const parts = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    loaded += value.length
    if (onProgress) onProgress(loaded, total)
  }
  const blob = new Blob(parts)
  await cache.put(url, new Response(blob, { headers: { 'Content-Type': 'application/octet-stream' } }))
  return blob.arrayBuffer()
}

// The phonemizer (espeak-ng) and its 18 MB of language data, loaded once.
let phonemizer = null
function loadPhonemizer() {
  if (!phonemizer)
    phonemizer = (async () => {
      const [wasm, data] = await Promise.all([
        fetch(BASE + 'piper_phonemize.wasm').then((r) => r.arrayBuffer()),
        fetch(BASE + 'piper_phonemize.data').then((r) => r.arrayBuffer()),
      ])
      return { module: await WebAssembly.compile(wasm), data }
    })()
  return phonemizer
}

/** Text → phoneme ids, using the voice's own espeak language. */
async function phonemize(text, espeakVoice) {
  const { module, data } = await loadPhonemizer()
  return new Promise((resolve, reject) => {
    let out = null
    createPiperPhonemize({
      noInitialRun: true,
      print: (line) => {
        try {
          out = JSON.parse(line).phoneme_ids
          resolve(out)
        } catch {
          /* not our output */
        }
      },
      printErr: (msg) => {
        if (!out) reject(new Error(msg))
      },
      getPreloadedPackage: () => data.slice(0),
      instantiateWasm: (imports, done) => {
        WebAssembly.instantiate(module, imports).then((inst) => done(inst, module))
        return {}
      },
      locateFile: (f) => BASE + f,
    }).then((m) => {
      try {
        m.callMain(['-l', espeakVoice, '--input', JSON.stringify([{ text }]), '--espeak_data', '/espeak-ng-data'])
      } catch (e) {
        if (!(e && e.name === 'ExitStatus')) return reject(e)
      }
      setTimeout(() => out || reject(new Error('No phonemes')), 50)
    }, reject)
  })
}

const sessions = new Map() // voice → Promise<{ session, config }>
function loadVoice(voice, onProgress) {
  if (!sessions.has(voice)) {
    const p = (async () => {
      const url = modelUrl(voice)
      const config = JSON.parse(new TextDecoder().decode(await cached(url + '.json')))
      const model = await cached(url, onProgress)
      const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] })
      return { session, config }
    })()
    sessions.set(voice, p)
    p.catch(() => sessions.delete(voice))
  }
  return sessions.get(voice)
}

function wav(pcm, rate) {
  const view = new DataView(new ArrayBuffer(44 + pcm.length * 2))
  const str = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)))
  str(0, 'RIFF')
  view.setUint32(4, 36 + pcm.length * 2, true)
  str(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  str(36, 'data')
  view.setUint32(40, pcm.length * 2, true)
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true)
  return view.buffer
}

async function speak(voice, text) {
  const { session, config } = await loadVoice(voice)
  const ids = await phonemize(text, config.espeak.voice)
  const feeds = {
    input: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor('float32', Float32Array.from([config.inference.noise_scale, config.inference.length_scale, config.inference.noise_w]), [3]),
  }
  if (config.num_speakers > 1) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([0n]), [1])
  const { output } = await session.run(feeds)
  // Phoneme counts between spaces: lets the reader time each word's highlight to how long it takes to say.
  const space = (config.phoneme_id_map[' '] || [3])[0]
  const groups = []
  let n = 0
  for (const id of ids) {
    if (id === space) {
      if (n) groups.push(n)
      n = 0
    } else n++
  }
  if (n) groups.push(n)
  return { wav: wav(output.data, config.audio.sample_rate), groups }
}

async function stored() {
  const cache = await caches.open(CACHE)
  const keys = await cache.keys()
  return keys.map((r) => r.url).filter((u) => u.endsWith('.onnx')).map((u) => u.split('/').pop().replace(/\.onnx$/, ''))
}

self.onmessage = async (e) => {
  const m = e.data
  try {
    if (m.type === 'download') {
      let last = 0
      await loadVoice(m.voice, (loaded, total) => {
        const now = Date.now()
        if (now - last > 200) {
          last = now
          self.postMessage({ type: 'progress', voice: m.voice, loaded, total })
        }
      })
      await loadPhonemizer()
      self.postMessage({ type: 'ready', voice: m.voice })
    } else if (m.type === 'speak') {
      const out = await speak(m.voice, m.text)
      self.postMessage({ type: 'audio', id: m.id, wav: out.wav, groups: out.groups }, [out.wav])
    } else if (m.type === 'remove') {
      sessions.delete(m.voice)
      const cache = await caches.open(CACHE)
      await cache.delete(modelUrl(m.voice))
      await cache.delete(modelUrl(m.voice) + '.json')
      self.postMessage({ type: 'removed', voice: m.voice })
    } else if (m.type === 'stored') {
      self.postMessage({ type: 'stored', voices: await stored() })
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, voice: m.voice, message: String((err && err.message) || err) })
  }
}
