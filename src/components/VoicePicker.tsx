import { useEffect, useState } from 'react'
import { useSettings } from '../lib/settings'
import { getVoices, onVoicesChanged, pickVoice, SAMPLES, speakWord, voicesFor, voiceTier } from '../lib/tts'
import { AZURE_VOICES, downloadQariVoice, engineVoice, isEngineVoice, QARI_VOICES, removeQariVoice, usable, useVoiceState } from '../lib/voices'
import { LANG_NAMES, type Lang } from '../types'
import { Icon, IconButton, Sheet } from './ui'

/** What a language is read with right now, for labels: "Kareem · Qari voice", "Samantha · this device". */
export function voiceLabel(lang: Lang, chosen?: string) {
  if (isEngineVoice(chosen) && usable(chosen)) {
    const v = engineVoice(chosen)!
    return `${v.name} · ${v.engine === 'qari' ? 'Qari voice' : 'Azure'}`
  }
  const d = pickVoice(lang, chosen)
  return d ? `${d.name}${voiceTier(d) < 2 ? ' · basic' : ''}` : 'No voice'
}

function Row({
  selected,
  title,
  note,
  onUse,
  onHear,
  children,
}: {
  selected: boolean
  title: string
  note: string
  onUse?: () => void
  onHear?: () => void
  children?: React.ReactNode
}) {
  return (
    <li className="flex items-center gap-2 py-2.5">
      <button
        type="button"
        onClick={onUse}
        disabled={!onUse}
        aria-pressed={selected}
        className="flex min-w-0 flex-1 items-center gap-3 text-left disabled:cursor-default"
      >
        <span
          className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${selected ? 'border-moss bg-moss text-moss-ink' : onUse ? 'border-line' : 'border-transparent'}`}
          aria-hidden="true"
        >
          {selected && <Icon name="check" size={13} />}
        </span>
        <span className="min-w-0">
          <span className="block font-semibold">{title}</span>
          <span className="block text-sm text-ink-3">{note}</span>
        </span>
      </button>
      {children}
      {onHear && <IconButton icon="speaker" label={`Hear ${title}`} onClick={onHear} className="border border-line" />}
    </li>
  )
}

/** Choose the voice for each language: Qari voices (download once, free, offline), Azure voices, or this device's. */
export default function VoicePicker({ open, onClose, langs }: { open: boolean; onClose: () => void; langs: Lang[] }) {
  const [settings, updateSettings] = useSettings()
  const vs = useVoiceState()
  const [, setV] = useState(0)
  const [lang, setLang] = useState<Lang>(langs[0] || 'en')
  const [showDevice, setShowDevice] = useState(false)
  const [azureHelp, setAzureHelp] = useState(false)

  useEffect(() => {
    getVoices().then(() => setV((n) => n + 1))
    return onVoicesChanged(() => setV((n) => n + 1))
  }, [])
  useEffect(() => {
    if (open && langs.length && !langs.includes(lang)) setLang(langs[0])
  }, [open, langs, lang])

  const chosen = settings.voices[lang]
  // What's actually used: an engine voice you picked (if it's ready), else the best device voice.
  const inUse = isEngineVoice(chosen) && usable(chosen) ? chosen : pickVoice(lang, chosen)?.voiceURI
  const use = (id: string) => updateSettings({ voices: { ...settings.voices, [lang]: id } })
  const hear = (id: string) => speakWord(SAMPLES[lang] || SAMPLES.en, lang, id, settings.rates[lang] ?? settings.rate)

  const qari = QARI_VOICES.filter((v) => v.lang === lang)
  const azure = AZURE_VOICES.filter((v) => v.lang === lang)
  const device = voicesFor(lang, { all: true }).filter((v) => voiceTier(v) > 0)

  return (
    <Sheet open={open} onClose={onClose} title="Voices" wide>
      {langs.length > 1 && (
        <div className="-mx-1 mb-4 flex gap-2 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Language">
          {langs.map((l) => (
            <button
              key={l}
              type="button"
              role="tab"
              aria-selected={l === lang}
              onClick={() => setLang(l)}
              className={`h-9 shrink-0 rounded-full border px-3 text-sm ${l === lang ? 'border-moss bg-wash font-semibold' : 'border-line'}`}
            >
              {LANG_NAMES[l] || l}
            </button>
          ))}
        </div>
      )}

      <section className="mb-5">
        <h3 className="font-semibold">Qari voices</h3>
        <p className="mb-1 text-sm text-ink-3">Free, natural-sounding, and they work offline once downloaded. They also keep reading when your screen locks.</p>
        {qari.length === 0 ? (
          <p className="py-2 text-sm text-ink-3">None for {LANG_NAMES[lang] || lang} yet.</p>
        ) : (
          <ul className="divide-y divide-line border-y border-line">
            {qari.map((v) => {
              const key = v.id.slice(5)
              const have = vs.downloaded.has(key)
              const p = vs.downloading.get(key)
              const failed = vs.failed.get(key)
              return (
                <Row
                  key={v.id}
                  selected={inUse === v.id}
                  title={v.name}
                  note={failed || (p !== undefined ? `Downloading… ${Math.round(p * 100)}%` : have ? v.note : `${v.note} · ${v.mb} MB`)}
                  onUse={have ? () => use(v.id) : undefined}
                  onHear={have ? () => hear(v.id) : undefined}
                >
                  {!have && p === undefined && (
                    <button
                      type="button"
                      onClick={() => downloadQariVoice(v.id).then(() => use(v.id), () => {})}
                      className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-line px-3 text-sm hover:bg-paper-2"
                    >
                      <Icon name="download" size={15} /> Get
                    </button>
                  )}
                  {p !== undefined && (
                    <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-line" aria-hidden="true">
                      <span className="block h-full bg-moss transition-[width]" style={{ width: `${Math.round(p * 100)}%` }} />
                    </span>
                  )}
                  {have && inUse !== v.id && <IconButton icon="trash" label={`Remove ${v.name}`} onClick={() => removeQariVoice(v.id)} />}
                </Row>
              )
            })}
          </ul>
        )}
        <p className="mt-1 text-xs text-ink-3">The first Qari voice also downloads the voice engine (about 35 MB), once for all languages.</p>
      </section>

      <section className="mb-5">
        <h3 className="font-semibold">Azure voices</h3>
        {vs.azure ? (
          <>
            <p className="mb-1 text-sm text-ink-3">Microsoft’s voices, through your own Azure account. Each sentence is kept after it’s read, so going back doesn’t use your allowance again.</p>
            <ul className="divide-y divide-line border-y border-line">
              {azure.map((v) => (
                <Row key={v.id} selected={inUse === v.id} title={v.name} note={v.note} onUse={() => use(v.id)} onHear={() => hear(v.id)} />
              ))}
            </ul>
          </>
        ) : (
          <>
            <p className="text-sm text-ink-3">
              {lang === 'ar' ? 'Includes Lebanese, Syrian, Jordanian, Egyptian and Iraqi voices. ' : ''}Needs a free Azure account and a key added to Qari’s Vercel project.{' '}
              <button type="button" className="text-moss underline underline-offset-2" onClick={() => setAzureHelp((v) => !v)}>
                {azureHelp ? 'Hide steps' : 'How to set it up'}
              </button>
            </p>
            {azureHelp && (
              <ol className="mt-2 list-decimal space-y-1 rounded-xl bg-paper-2 py-3 pr-3 pl-8 text-sm text-ink-2">
                <li>At portal.azure.com, create a free account, then create a “Speech” resource with the Free (F0) price tier. The free tier stops at its monthly amount instead of charging.</li>
                <li>Open the resource’s “Keys and Endpoint” page and copy Key 1 and the Location/Region (like eastus).</li>
                <li>In Vercel, open the qari-reader project › Settings › Environment Variables and add AZURE_SPEECH_KEY and AZURE_SPEECH_REGION. If you haven’t yet, also add QARI_ACCESS_CODE: a passphrase of 20 or more characters.</li>
                <li>Redeploy, then enter the same passphrase under Reading settings › Claude access code. Azure voices then appear here.</li>
              </ol>
            )}
          </>
        )}
      </section>

      <section className="mb-2">
        <button type="button" className="flex w-full items-center justify-between font-semibold" onClick={() => setShowDevice((v) => !v)} aria-expanded={showDevice}>
          This device’s voices <span className="text-sm font-normal text-ink-3">{showDevice ? 'Hide' : `${device.length}`}</span>
        </button>
        {showDevice && (
          <>
            <p className="mb-1 text-sm text-ink-3">On iPhone, web apps only get Apple’s basic voices, not the Enhanced or Premium ones you download in Settings.</p>
            <ul className="divide-y divide-line border-y border-line">
              {device.map((d) => (
                <Row
                  key={d.voiceURI}
                  selected={inUse === d.voiceURI}
                  title={d.name}
                  note={`${d.lang}${voiceTier(d) < 2 ? ' · basic' : ''}${d.localService ? '' : ' · online'}`}
                  onUse={() => use(d.voiceURI)}
                  onHear={() => hear(d.voiceURI)}
                />
              ))}
            </ul>
          </>
        )}
      </section>
    </Sheet>
  )
}
