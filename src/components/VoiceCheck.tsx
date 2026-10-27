import { useEffect, useState } from 'react'
import { useSettings } from '../lib/settings'
import { getVoices, onlyBasic, onVoicesChanged, pickVoice, platform, SAMPLES, speakWord, voicesFor } from '../lib/tts'
import { isEngineVoice, usable, useVoiceState } from '../lib/voices'
import VoicePicker, { voiceLabel } from './VoicePicker'
import { LANG_NAMES, type Lang } from '../types'
import { Icon, IconButton, Sheet } from './ui'

const CHECK_LANGS: Lang[] = ['en', 'ar', 'fr', 'de']

/** Shows which reading languages this device can speak, with a sample for each. */
export default function VoiceCheck({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [settings, updateSettings] = useSettings()
  const [, setV] = useState(0)
  const [picker, setPickerState] = useState(false)
  const [order, setOrder] = useState<Lang[]>(CHECK_LANGS)
  useVoiceState()
  const plat = platform()

  useEffect(() => {
    getVoices().then(() => setV((n) => n + 1))
    return onVoicesChanged(() => setV((n) => n + 1))
  }, [])

  const close = () => {
    if (!settings.voiceCheckDone) updateSettings({ voiceCheckDone: true })
    onClose()
  }

  const good = (l: Lang) => {
    const id = settings.voices[l]
    return (isEngineVoice(id) && usable(id)) || (voicesFor(l).length > 0 && !onlyBasic(l))
  }
  const needs = CHECK_LANGS.filter((l) => !good(l))
  // Languages that still need a voice come first; the order stays put while the picker is open.
  const setPicker = (on: boolean) => {
    if (on) setOrder([...needs, ...CHECK_LANGS.filter((l) => !needs.includes(l))])
    setPickerState(on)
  }

  return (
    <>
      <Sheet open={open && !picker} onClose={close} title="Voices" wide>
        <p className="mb-4 text-ink-2">The voice Qari reads each language with. Tap the speaker to hear it.</p>
        <ul className="divide-y divide-line border-y border-line">
          {CHECK_LANGS.map((lang) => {
            const id = settings.voices[lang]
            const engine = isEngineVoice(id) && usable(id)
            const any = engine || voicesFor(lang).length > 0
            const ok = good(lang)
            return (
              <li key={lang} className="flex items-center gap-3 py-3">
                <span
                  className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${!any ? 'bg-paper-2 text-danger' : ok ? 'bg-wash text-moss' : 'bg-paper-2 text-ink-3'}`}
                  aria-hidden="true"
                >
                  {!any ? '!' : ok ? '✓' : '~'}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">{LANG_NAMES[lang]}</div>
                  <div className="truncate text-sm text-ink-3">{any ? voiceLabel(lang, id) : 'No voice yet'}</div>
                </div>
                {any && (
                  <IconButton
                    icon="speaker"
                    label={`Hear ${LANG_NAMES[lang]}`}
                    onClick={() => speakWord(SAMPLES[lang], lang, engine ? id : pickVoice(lang, id)?.voiceURI, 1)}
                    className="border border-line"
                  />
                )}
              </li>
            )
          })}
        </ul>
        {needs.length > 0 && (
          <div className="mt-4 rounded-xl bg-paper-2 px-4 py-3 text-sm">
            <p className="font-semibold">Get natural voices for {needs.map((l) => LANG_NAMES[l]).join(', ')}</p>
            <p className="mt-1 text-ink-2">
              Qari voices are free and download once (about 60 MB each). They sound natural, work offline and keep reading when your screen locks. {plat === 'ios' ? 'iPhone doesn’t let web apps use the Enhanced voices from Settings, so this is the way to get good voices on your phone.' : ''}
            </p>
            <button type="button" onClick={() => setPicker(true)} className="mt-2 inline-flex h-10 items-center gap-1.5 rounded-full bg-moss px-4 font-semibold text-moss-ink">
              <Icon name="download" size={16} /> Choose voices
            </button>
          </div>
        )}
        <p className="mt-4 text-sm text-ink-3">
          You can change voices any time here or under Reading settings.{' '}
          <button type="button" className="text-moss underline underline-offset-2" onClick={() => setPicker(true)}>
            All voices
          </button>
        </p>
        <button type="button" onClick={close} className="mt-4 mb-2 inline-flex h-11 w-full items-center justify-center gap-2 rounded-full bg-moss font-semibold text-moss-ink">
          <Icon name="check" size={18} /> Done
        </button>
      </Sheet>
      <VoicePicker open={open && picker} onClose={() => setPicker(false)} langs={order} />
    </>
  )
}
