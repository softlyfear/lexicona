import { useSyncExternalStore } from 'react'
import { api, ApiError, type ServerVoice } from './api'

export const SPEECH_RATES = [0.5, 0.75, 1, 1.25, 1.5] as const
export type SpeechRate = (typeof SPEECH_RATES)[number]
export type SpeechEngine = 'auto' | 'server' | 'browser'
export type SpeechPreferences = {
  enLocale: string
  enVoiceURI: string | null
  ruVoiceURI: string | null
  rate: SpeechRate
  autoPrompt: boolean
  speakEn: boolean
  speakRu: boolean
  engineEn: SpeechEngine
  engineRu: SpeechEngine
  serverEnUS: string | null
  serverEnGB: string | null
  serverRu: string | null
}
const defaults: SpeechPreferences = {
  enLocale: 'en-US',
  enVoiceURI: null,
  ruVoiceURI: null,
  rate: 1,
  autoPrompt: true,
  speakEn: true,
  speakRu: true,
  engineEn: 'auto',
  engineRu: 'auto',
  serverEnUS: null,
  serverEnGB: null,
  serverRu: null,
}
function isSpeechRate(value: unknown): value is SpeechRate {
  return typeof value === 'number' && (SPEECH_RATES as readonly number[]).includes(value)
}
function isSpeechEngine(value: unknown): value is SpeechEngine {
  return value === 'auto' || value === 'server' || value === 'browser'
}
type Snapshot = {
  preferences: SpeechPreferences
  voices: SpeechSynthesisVoice[]
  voiceState: 'loading' | 'ready' | 'unavailable'
  status: string
  notice: string
  storageError: boolean
  serverVoices: ServerVoice[]
  serverState: 'loading' | 'ready' | 'unavailable'
}
const initial: Snapshot = {
  preferences: defaults,
  voices: [],
  voiceState: 'loading',
  status: '',
  notice: '',
  storageError: false,
  serverVoices: [],
  serverState: 'loading',
}
let snapshot = initial
const listeners = new Set<() => void>()
let owner: string | null = null
let generation = 0
let utterance: SpeechSynthesisUtterance | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let voiceTimer: ReturnType<typeof setTimeout> | null = null
let pending: (() => void) | null = null
let metadataRequest: AbortController | null = null
let metadataTimer: ReturnType<typeof setTimeout> | null = null
let audioRequest: AbortController | null = null
let audio: HTMLAudioElement | null = null
let audioUrl: string | null = null
let readyFingerprint: string | null = null
const notify = (patch: Partial<Snapshot>) => {
  snapshot = { ...snapshot, ...patch }
  listeners.forEach((listener) => listener())
}
const problem = (message: string) => notify({ status: message, notice: message })
const synthesis = () =>
  typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null
const primary = (lang: string) => lang.toLowerCase().split('-')[0]

export function languageEngine(
  lang: 'en' | 'ru',
  preferences: SpeechPreferences = snapshot.preferences,
) {
  return lang === 'en' ? preferences.engineEn : preferences.engineRu
}

export function speechEnabled(
  lang: 'en' | 'ru',
  preferences: SpeechPreferences = snapshot.preferences,
) {
  return lang === 'en' ? preferences.speakEn : preferences.speakRu
}

export function hasServerLocale(
  voices: ServerVoice[],
  lang: 'en' | 'ru',
  preferences: SpeechPreferences,
) {
  const locale = lang === 'ru' ? 'ru-RU' : preferences.enLocale
  return voices.some((voice) => voice.language.toLowerCase() === locale.toLowerCase())
}

export function selectServerVoice(
  voices: ServerVoice[],
  lang: 'en' | 'ru',
  preferences: SpeechPreferences,
) {
  const locale = lang === 'ru' ? 'ru-RU' : preferences.enLocale
  const requested =
    lang === 'ru'
      ? preferences.serverRu
      : locale.toLowerCase() === 'en-gb'
        ? preferences.serverEnGB
        : preferences.serverEnUS
  const candidates = voices.filter((voice) => voice.language.toLowerCase() === locale.toLowerCase())
  return requested
    ? (candidates.find((voice) => voice.id === requested) ?? null)
    : (candidates[0] ?? null)
}

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
  readyFingerprint = null
  audioRequest?.abort()
  audioRequest = null
  if (audio) {
    audio.onended = null
    audio.onerror = null
    audio.onplaying = null
    audio.pause()
    audio.removeAttribute('src')
    audio = null
  }
  if (audioUrl) URL.revokeObjectURL(audioUrl)
  audioUrl = null
  try {
    synthesis()?.cancel()
  } catch {
    /* Browser implementation failed to cancel. */
  }
  if (snapshot.status || snapshot.notice) notify({ status: '', notice: '' })
}
export function setSpeechOwner(id: string | null) {
  cancelSpeech()
  metadataRequest?.abort()
  metadataRequest = null
  if (metadataTimer) clearTimeout(metadataTimer)
  metadataTimer = null
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
          !isSpeechRate(p.rate) ||
          typeof p.autoPrompt !== 'boolean' ||
          (p.speakEn !== undefined && typeof p.speakEn !== 'boolean') ||
          (p.speakRu !== undefined && typeof p.speakRu !== 'boolean') ||
          (p.engine !== undefined && !isSpeechEngine(p.engine)) ||
          (p.engineEn !== undefined && !isSpeechEngine(p.engineEn)) ||
          (p.engineRu !== undefined && !isSpeechEngine(p.engineRu)) ||
          [p.serverEnUS, p.serverEnGB, p.serverRu].some(
            (value) => value !== undefined && value !== null && typeof value !== 'string',
          )
        )
          throw new Error('invalid')
        preferences = {
          enLocale: p.enLocale,
          enVoiceURI: p.enVoiceURI,
          ruVoiceURI: p.ruVoiceURI,
          rate: p.rate,
          autoPrompt: p.autoPrompt,
          speakEn: typeof p.speakEn === 'boolean' ? p.speakEn : true,
          speakRu: typeof p.speakRu === 'boolean' ? p.speakRu : true,
          engineEn: isSpeechEngine(p.engineEn)
            ? p.engineEn
            : isSpeechEngine(p.engine)
              ? p.engine
              : 'auto',
          engineRu: isSpeechEngine(p.engineRu)
            ? p.engineRu
            : isSpeechEngine(p.engine)
              ? p.engine
              : 'auto',
          serverEnUS: typeof p.serverEnUS === 'string' ? p.serverEnUS : null,
          serverEnGB: typeof p.serverEnGB === 'string' ? p.serverEnGB : null,
          serverRu: typeof p.serverRu === 'string' ? p.serverRu : null,
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
  if (id) refreshServerVoices()
  if (!id || !synthesis()) return
  synthesis()?.addEventListener('voiceschanged', refreshVoices)
  refreshVoices()
  voiceTimer = setTimeout(() => {
    if (!snapshot.voices.length) notify({ voiceState: 'unavailable' })
  }, 2000)
}
export function refreshServerVoices() {
  if (!owner) return
  metadataRequest?.abort()
  if (metadataTimer) clearTimeout(metadataTimer)
  const request = new AbortController()
  const currentOwner = owner
  metadataRequest = request
  notify({ serverState: 'loading', serverVoices: [] })
  metadataTimer = setTimeout(() => {
    if (metadataRequest !== request) return
    request.abort()
    metadataRequest = null
    metadataTimer = null
    notify({ serverVoices: [], serverState: 'unavailable' })
  }, 10000)
  void (async () => {
    try {
      const result = await api.listSpeechVoices(request.signal)
      if (metadataRequest !== request || owner !== currentOwner) return
      notify({
        serverVoices: result.voices,
        serverState: result.available && result.voices.length ? 'ready' : 'unavailable',
      })
    } catch {
      if (metadataRequest === request && owner === currentOwner)
        notify({ serverVoices: [], serverState: 'unavailable' })
    } finally {
      if (metadataRequest === request) {
        if (metadataTimer) clearTimeout(metadataTimer)
        metadataTimer = null
        metadataRequest = null
      }
    }
  })()
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
export function speak(text: string, lang: 'en' | 'ru', options?: { force?: boolean }) {
  if (!options?.force && !speechEnabled(lang)) return
  const choice = languageEngine(lang)
  if (audio && readyFingerprint && choice !== 'browser') {
    const voice = selectServerVoice(snapshot.serverVoices, lang, snapshot.preferences)
    const fingerprint = JSON.stringify([text, lang, voice?.id, snapshot.preferences.rate])
    if (fingerprint === readyFingerprint) {
      const current = audio
      readyFingerprint = null
      notify({ notice: '' })
      startAudio(current, generation, fingerprint)
      return
    }
  }
  cancelSpeech()
  const token = generation
  if (choice !== 'browser') {
    if (snapshot.serverState === 'loading') {
      problem('Загружаем серверные голоса. Попробуйте ещё раз.')
      return
    }
    if (
      snapshot.serverState === 'ready' &&
      (choice === 'server' || hasServerLocale(snapshot.serverVoices, lang, snapshot.preferences))
    ) {
      speakServer(text, lang, token)
      return
    }
    if (choice === 'server') {
      problem('Серверные голоса недоступны. Выберите браузерное озвучивание в настройках.')
      return
    }
  }
  const engine = synthesis()
  if (!engine || typeof SpeechSynthesisUtterance === 'undefined') {
    problem('Озвучивание недоступно в этом браузере.')
    return
  }
  const start = () => {
    if (token !== generation) return
    if (timer) clearTimeout(timer)
    timer = null
    const exactLocale =
      choice === 'auto' &&
      snapshot.serverState === 'ready' &&
      !hasServerLocale(snapshot.serverVoices, lang, snapshot.preferences)
    const locale = lang === 'ru' ? 'ru-RU' : snapshot.preferences.enLocale
    const available = exactLocale
      ? snapshot.voices.filter((voice) => voice.lang.toLowerCase() === locale.toLowerCase())
      : snapshot.voices
    const voice = selectVoice(available, lang, snapshot.preferences)
    if (!voice) {
      problem(`Подходящий ${lang.toUpperCase()} голос не найден. Попробуйте ещё раз.`)
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
          problem('Не удалось воспроизвести речь. Попробуйте вручную ещё раз.')
        }
      }
      notify({ status: 'Ожидание воспроизведения…' })
      timer = setTimeout(
        () => {
          if (generation === token && utterance === current) {
            cancelSpeech()
            problem('Воспроизведение не завершилось. Попробуйте ещё раз.')
          }
        },
        Math.min(600000, Math.max(20000, (15 + [...text].length / (8 * current.rate)) * 1000)),
      )
      engine.speak(current)
    } catch {
      if (generation === token) {
        cancelSpeech()
        problem('Не удалось запустить речь. Попробуйте ещё раз.')
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
        notify({ voiceState: 'unavailable' })
        problem(`Подходящий ${lang.toUpperCase()} голос не найден. Попробуйте ещё раз.`)
      }
    }, 2000)
  }
}

function speakServer(text: string, lang: 'en' | 'ru', token: number) {
  const voice = selectServerVoice(snapshot.serverVoices, lang, snapshot.preferences)
  if (!voice) {
    problem(
      `Выбранный серверный ${lang.toUpperCase()} голос недоступен. Выберите другой в настройках.`,
    )
    return
  }
  const request = new AbortController()
  const fingerprint = JSON.stringify([text, lang, voice.id, snapshot.preferences.rate])
  audioRequest = request
  notify({ status: 'Готовим озвучивание…' })
  timer = setTimeout(
    () => {
      if (generation !== token) return
      cancelSpeech()
      problem('Озвучивание не завершилось. Попробуйте ещё раз.')
    },
    Math.min(
      600000,
      Math.max(90000, (60 + [...text].length / (8 * snapshot.preferences.rate)) * 1000),
    ),
  )
  void (async () => {
    try {
      const blob = await api.synthesizeSpeech(
        text,
        voice.id,
        snapshot.preferences.rate,
        request.signal,
      )
      if (token !== generation || request.signal.aborted) return
      audioUrl = URL.createObjectURL(blob)
      const current = new Audio(audioUrl)
      audio = current
      current.onplaying = () => {
        if (generation === token) notify({ status: 'Воспроизводится…' })
      }
      current.onended = () => {
        if (generation !== token) return
        cancelSpeech()
        notify({ status: 'Воспроизведение завершено.' })
      }
      current.onerror = () => {
        if (generation !== token) return
        cancelSpeech()
        problem('Не удалось воспроизвести речь. Попробуйте вручную ещё раз.')
      }
      startAudio(current, token, fingerprint)
    } catch (error) {
      if (generation !== token || request.signal.aborted) return
      cancelSpeech()
      const message =
        error instanceof ApiError && error.message === 'speech_busy'
          ? 'Сервер озвучивания занят.'
          : error instanceof ApiError && error.message === 'speech_timeout'
            ? 'Сервер озвучивания не ответил вовремя.'
            : 'Не удалось озвучить текст.'
      problem(`${message} Попробуйте ещё раз или выберите браузерное озвучивание в настройках.`)
    }
  })()
}

function startAudio(current: HTMLAudioElement, token: number, fingerprint: string) {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    if (generation !== token) return
    cancelSpeech()
    problem('Воспроизведение не завершилось. Попробуйте ещё раз.')
  }, 600000)
  notify({ status: 'Ожидание воспроизведения…' })
  const failed = (error: unknown) => {
    if (generation !== token || audio !== current) return
    if (error && typeof error === 'object' && 'name' in error && error.name === 'NotAllowedError') {
      if (timer) clearTimeout(timer)
      timer = null
      readyFingerprint = fingerprint
      problem('Аудио готово. Нажмите озвучку ещё раз.')
      return
    }
    cancelSpeech()
    problem('Не удалось воспроизвести речь. Попробуйте ещё раз.')
  }
  try {
    void current.play().catch(failed)
  } catch (error) {
    failed(error)
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
