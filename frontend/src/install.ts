import { useSyncExternalStore } from 'react'

type InstallPrompt = Event & { prompt: () => Promise<unknown> }
type InstallState = { prompt: InstallPrompt | null; installed: boolean }
let state: InstallState = { prompt: null, installed: false }
const subscribers = new Set<() => void>()

function update(next: InstallState) {
  state = next
  subscribers.forEach((listener) => listener())
}

export function listenForInstall() {
  function onPrompt(event: Event) {
    event.preventDefault()
    update({ prompt: event as InstallPrompt, installed: false })
  }
  function onInstalled() {
    update({ prompt: null, installed: true })
  }
  window.addEventListener('beforeinstallprompt', onPrompt)
  window.addEventListener('appinstalled', onInstalled)
  return () => {
    window.removeEventListener('beforeinstallprompt', onPrompt)
    window.removeEventListener('appinstalled', onInstalled)
    update({ prompt: null, installed: false })
  }
}

export function useInstallState() {
  return useSyncExternalStore(
    (listener) => {
      subscribers.add(listener)
      return () => subscribers.delete(listener)
    },
    () => state,
  )
}

export async function requestInstall() {
  const prompt = state.prompt
  if (!prompt) return
  update({ ...state, prompt: null })
  await prompt.prompt()
}

export function isStandalone() {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}
