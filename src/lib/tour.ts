import { useSyncExternalStore } from 'react'

/** Whether the guided tour is running, and which step it's on. Lives outside React so it survives moving between screens. */
let state = { active: false, step: 0 }
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export function startTour() {
  state = { active: true, step: 0 }
  emit()
}
export function setTourStep(step: number) {
  state = { active: true, step }
  emit()
}
export function endTour() {
  state = { active: false, step: 0 }
  emit()
}
export function useTour() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => state,
  )
}
