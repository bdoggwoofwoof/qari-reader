import { useEffect, useState } from 'react'
import { useSettings } from '../lib/settings'
import { getVoices, onVoicesChanged, pickVoice, SAMPLES, speakWord, voicesFor } from '../lib/tts'
import { LANG_NAMES, type Lang } from '../types'
import { Icon, IconButton, Sheet } from './ui'

const CHECK_LANGS: Lang[] = ['en', 'ar', 'fr', 'de']

function platform() {
  const ua = navigator.userAgent
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && 'ontouchend' in document)) return 'ios'
  if (/Android/.test(ua)) return 'android'
  if (/Windows/.test(ua)) return 'windows'
  if (/Macintosh/.test(ua)) return 'mac'
  return 'other'
}

const HOW_TO: Record<string, string> = {
  ios: 'Settings › Accessibility › Spoken Content › Voices, choose the language, and download an “Enhanced” or “Premium” voice.',
  mac: 'System Settings › Accessibility › Spoken Content › System voice › Manage Voices, and download a voice for the language.',
  android: 'Settings › System › Languages › Text-to-speech output › Speech Services by Google › Install voice data.',
  windows: 'Settings › Time & language › Speech › Add voices. In Microsoft Edge, the “Natural” online voices also appear here automatically.',
  other: 'Add a text-to-speech voice for this language in your system settings, or open Qari in Chrome, Edge or Safari.',
}

/** Shows which reading languages this device can speak, with a sample for each. */
export default function VoiceCheck({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [settings, updateSettings] = useSettings()
  const [, setV] = useState(0)

  useEffect(() => {
    getVoices().then(() => setV((n) => n + 1))
    return onVoicesChanged(() => setV((n) => n + 1))
  }, [])

  const close = () => {
    if (!settings.voiceCheckDone) updateSettings({ voiceCheckDone: true })
    onClose()
  }

  const plat = platform()
  const missing = CHECK_LANGS.filter((l) => !voicesFor(l).length)

  return (
    <Sheet open={open} onClose={close} title="Voices on this device" wide>
      <p className="mb-4 text-ink-2">Qari reads with the voices built into your phone or computer. Here’s what this device has.</p>
      <ul className="divide-y divide-line border-y border-line">
        {CHECK_LANGS.map((lang) => {
          const list = voicesFor(lang)
          const best = pickVoice(lang, settings.voices[lang])
          return (
            <li key={lang} className="flex items-center gap-3 py-3">
              <span
                className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${list.length ? 'bg-wash text-moss' : 'bg-paper-2 text-danger'}`}
                aria-hidden="true"
              >
                {list.length ? '✓' : '!'}
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{LANG_NAMES[lang]}</div>
                <div className="truncate text-sm text-ink-3">
                  {best ? `${best.name}${list.length > 1 ? ` · ${list.length} voices` : ''}` : 'No voice installed'}
                </div>
              </div>
              {best && <IconButton icon="speaker" label={`Hear ${LANG_NAMES[lang]}`} onClick={() => speakWord(SAMPLES[lang], lang, best.voiceURI, 1)} className="border border-line" />}
            </li>
          )
        })}
      </ul>
      {missing.length > 0 && (
        <div className="mt-4 rounded-xl bg-paper-2 px-4 py-3 text-sm">
          <p className="font-semibold">To add {missing.map((l) => LANG_NAMES[l]).join(', ')}:</p>
          <p className="mt-1 text-ink-2">{HOW_TO[plat]}</p>
          <p className="mt-1 text-ink-2">Then reopen Qari.</p>
        </div>
      )}
      <p className="mt-4 text-sm text-ink-3">You can choose a different voice for each language under Reading settings while reading.</p>
      <button type="button" onClick={close} className="mt-4 mb-2 inline-flex h-11 w-full items-center justify-center gap-2 rounded-full bg-moss font-semibold text-moss-ink">
        <Icon name="read" size={18} /> Start reading
      </button>
    </Sheet>
  )
}
