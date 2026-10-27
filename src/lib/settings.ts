import { useCallback, useEffect, useState } from 'react'
import type { Settings } from '../types'

const KEY = 'qari.settings'
const DEFAULTS: Settings = {
  rate: 1,
  voices: {},
  fontSize: 19,
  theme: 'light',
  autoScroll: true,
  arabicFont: 'readex',
  rates: {},
  afterSentence: 'continue',
  showHarakat: true,
  skipCitations: true,
  pronunciations: [],
  voiceCheckDone: false,
  learning: ['ar', 'fr', 'de'],
  ankiDecks: {},
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS
  } catch {
    return DEFAULTS
  }
}

const listeners = new Set<(s: Settings) => void>()
let current = load()

/** Settings that follow you between devices. Voices and the voice check stay per device. */
export const SYNCED_KEYS = ['rate', 'rates', 'fontSize', 'theme', 'autoScroll', 'arabicFont', 'afterSentence', 'showHarakat', 'skipCitations', 'pronunciations', 'learning', 'ankiDecks', 'translateCode', 'readFont', 'bionic', 'speedWpm'] as const
export type SyncedSettings = Pick<Settings, (typeof SYNCED_KEYS)[number]> & { updatedAt?: number }

const settingsListeners = new Set<() => void>()
export function onSettingsChange(cb: () => void) {
  settingsListeners.add(cb)
  return () => {
    settingsListeners.delete(cb)
  }
}

function commit(next: Settings, notify: boolean) {
  current = next
  try {
    localStorage.setItem(KEY, JSON.stringify(current))
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((l) => l(current))
  if (notify) settingsListeners.forEach((l) => l())
}

export function getSettings() {
  return current
}

export function syncedSettings(): SyncedSettings {
  const out: Record<string, unknown> = { updatedAt: current.updatedAt }
  for (const k of SYNCED_KEYS) out[k] = current[k]
  return out as SyncedSettings
}

/** Applies settings that arrived from another device, without counting as a new local change. */
export function applySyncedSettings(s: SyncedSettings) {
  const next: Settings = { ...current }
  for (const k of SYNCED_KEYS) if (s[k] !== undefined) (next as unknown as Record<string, unknown>)[k] = s[k]
  next.updatedAt = s.updatedAt
  commit(next, false)
}

export function useSettings() {
  const [s, setS] = useState(current)
  useEffect(() => {
    listeners.add(setS)
    return () => {
      listeners.delete(setS)
    }
  }, [])
  const update = useCallback((patch: Partial<Settings>) => {
    const synced = Object.keys(patch).some((k) => (SYNCED_KEYS as readonly string[]).includes(k))
    commit({ ...current, ...patch, ...(synced ? { updatedAt: Date.now() } : {}) }, synced)
  }, [])
  return [s, update] as const
}

export function rateFor(s: Settings, lang: string) {
  return s.rates[lang] ?? s.rate
}
