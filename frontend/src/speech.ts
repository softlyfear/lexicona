import { useSyncExternalStore } from 'react'

export type SpeechPreferences = {
  enLocale: string
  enVoiceURI: string | null
  ruVoiceURI: string | null
  rate: 1 | 0.75
  autoPrompt: boolean
}
const defaults: SpeechPreferences = {
  enLocale: 'en-US',
  enVoiceURI: null,
  ruVoiceURI: null,
  rate: 1,
  autoPrompt: true,
}
type Snapshot = {
  preferences: SpeechPreferences
  voices: SpeechSynthesisVoice[]
  voiceState: 'loading' | 'ready' | 'unavailable'
  status: string
  storageError: boolean
}
const initial: Snapshot = {
  preferences: defaults,
  voices: [],
  voiceState: 'loading',
  status: '',
  storageError: false,
}
let snapshot = initial
const listeners = new Set<() => void>()
let owner: string | null = null
let generation = 0
let utterance: SpeechSynthesisUtterance | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let voiceTimer: ReturnType<typeof setTimeout> | null = null
let pending: (() => void) | null = null
const notify = (patch: Partial<Snapshot>) => {
  snapshot = { ...snapshot, ...patch }
  listeners.forEach((listener) => listener())
}
const synthesis = () =>
  typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null
const primary = (lang: string) => lang.toLowerCase().split('-')[0]

export function selectVoice(
  voices: SpeechSynthesisVoice[],
  lang: 'en' | 'ru',
  preferences: SpeechPreferences,
) {
  const candidates = voices.filter((voice) => primary(voice.lang) === lang)
  const uri = lang === 'en' ? preferences.enVoiceURI : preferences.ruVoiceURI
  const locale = lang === 'en' ? preferences.enLocale : 'ru-RU'
  return (
    candidates.find((voice) => uri && voice.voiceURI === uri) ??
    candidates.find((voice) => voice.lang.toLowerCase() === locale.toLowerCase()) ??
    candidates.find((voice) => voice.default) ??
    candidates[0] ??
    null
  )
}
function refreshVoices() {
  try {
    const voices = synthesis()?.getVoices() ?? []
    notify({
      voices,
      voiceState: voices.length
        ? 'ready'
        : snapshot.voiceState === 'ready'
          ? 'unavailable'
          : snapshot.voiceState,
    })
    if (voices.length && pending) {
      const resume = pending
      pending = null
      resume()
    }
  } catch {
    notify({ voices: [], voiceState: 'unavailable' })
  }
}
export function speechGeneration() {
  return generation
}
export function cancelSpeech() {
  generation++
  pending = null
  if (timer) clearTimeout(timer)
  timer = null
  utterance = null
  try {
    synthesis()?.cancel()
  } catch {
    /* Browser implementation failed to cancel. */
  }
  if (snapshot.status) notify({ status: '' })
}
export function setSpeechOwner(id: string | null) {
  cancelSpeech()
  if (voiceTimer) clearTimeout(voiceTimer)
  synthesis()?.removeEventListener('voiceschanged', refreshVoices)
  owner = id
  let preferences = defaults
  let storageError = false
  if (id) {
    try {
      const raw = localStorage.getItem(`lexicona:speech:v1:${id}`)
      if (raw) {
        const v: unknown = JSON.parse(raw)
        if (typeof v !== 'object' || v === null) throw new Error('invalid')
        const p = v as Record<string, unknown>
        if (
          p.version !== 1 ||
          typeof p.enLocale !== 'string' ||
          !/^en(?:-[a-z0-9]+)*$/iu.test(p.enLocale) ||
          !(p.enVoiceURI === null || typeof p.enVoiceURI === 'string') ||
          !(p.ruVoiceURI === null || typeof p.ruVoiceURI === 'string') ||
          !(p.rate === 1 || p.rate === 0.75) ||
          typeof p.autoPrompt !== 'boolean'
        )
          throw new Error('invalid')
        preferences = {
          enLocale: p.enLocale,
          enVoiceURI: p.enVoiceURI,
          ruVoiceURI: p.ruVoiceURI,
          rate: p.rate,
          autoPrompt: p.autoPrompt,
        }
      }
    } catch {
      storageError = true
    }
  }
  notify({
    ...initial,
    preferences,
    storageError,
    voiceState: synthesis() ? 'loading' : 'unavailable',
  })
  if (!id || !synthesis()) return
  synthesis()?.addEventListener('voiceschanged', refreshVoices)
  refreshVoices()
  voiceTimer = setTimeout(() => {
    if (!snapshot.voices.length) notify({ voiceState: 'unavailable' })
  }, 2000)
}
export function updateSpeechPreferences(patch: Partial<SpeechPreferences>) {
  cancelSpeech()
  const preferences = { ...snapshot.preferences, ...patch }
  notify({ preferences })
  try {
    if (owner)
      localStorage.setItem(
        `lexicona:speech:v1:${owner}`,
        JSON.stringify({ version: 1, ...preferences }),
      )
  } catch {
    notify({ storageError: true })
  }
}
export function speak(text: string, lang: 'en' | 'ru') {
  cancelSpeech()
  const token = generation
  const engine = synthesis()
  if (!engine || typeof SpeechSynthesisUtterance === 'undefined') {
    notify({ status: 'Озвучивание недоступно в этом браузере.' })
    return
  }
  const start = () => {
    if (token !== generation) return
    if (timer) clearTimeout(timer)
    timer = null
    const voice = selectVoice(snapshot.voices, lang, snapshot.preferences)
    if (!voice) {
      notify({ status: `Подходящий ${lang.toUpperCase()} голос не найден. Попробуйте ещё раз.` })
      return
    }
    try {
      const current = new SpeechSynthesisUtterance(text)
      utterance = current
      current.voice = voice
      current.lang = voice.lang
      current.rate = snapshot.preferences.rate
      current.volume = 1
      current.pitch = 1
      current.onstart = () => {
        if (generation === token) notify({ status: 'Воспроизводится…' })
      }
      current.onend = () => {
        if (generation === token) {
          if (timer) clearTimeout(timer)
          timer = null
          utterance = null
          generation++
          notify({ status: 'Воспроизведение завершено.' })
        }
      }
      current.onerror = () => {
        if (generation === token) {
          if (timer) clearTimeout(timer)
          timer = null
          utterance = null
          generation++
          notify({ status: 'Не удалось воспроизвести речь. Попробуйте вручную ещё раз.' })
        }
      }
      notify({ status: 'Ожидание воспроизведения…' })
      timer = setTimeout(
        () => {
          if (generation === token && utterance === current) {
            cancelSpeech()
            notify({ status: 'Воспроизведение не завершилось. Попробуйте ещё раз.' })
          }
        },
        Math.min(600000, Math.max(20000, (15 + [...text].length / (8 * current.rate)) * 1000)),
      )
      engine.speak(current)
    } catch {
      if (generation === token) {
        cancelSpeech()
        notify({ status: 'Не удалось запустить речь. Попробуйте ещё раз.' })
      }
    }
  }
  refreshVoices()
  if (snapshot.voices.length || snapshot.voiceState === 'unavailable') start()
  else {
    notify({ status: 'Ожидание голосов…' })
    pending = start
    timer = setTimeout(() => {
      if (token === generation) {
        pending = null
        timer = null
        notify({
          voiceState: 'unavailable',
          status: `Подходящий ${lang.toUpperCase()} голос не найден. Попробуйте ещё раз.`,
        })
      }
    }, 2000)
  }
}
export function useSpeech() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => snapshot,
    () => initial,
  )
}
