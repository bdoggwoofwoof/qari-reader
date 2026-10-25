import { useCallback, useEffect, useState } from 'react'
import type { Settings } from '../types'

const KEY = 'qari.settings'
const DEFAULTS: Settings = { rate: 1, voices: {}, fontSize: 19, theme: 'light', autoScroll: true, arabicFont: 'readex' }

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

export function useSettings() {
  const [s, setS] = useState(current)
  useEffect(() => {
    listeners.add(setS)
    return () => {
      listeners.delete(setS)
    }
  }, [])
  const update = useCallback((patch: Partial<Settings>) => {
    current = { ...current, ...patch }
    try {
      localStorage.setItem(KEY, JSON.stringify(current))
    } catch {
      /* storage unavailable */
    }
    listeners.forEach((l) => l(current))
  }, [])
  return [s, update] as const
}
