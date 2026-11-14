import { useSyncExternalStore } from 'react'
import {
  ApiError,
  api,
  type Session,
  type SpeechPreferencesDto,
  type TrainingPreferences,
} from './api'
import { forgetSession, queryClient } from './session'
import { reportSpeechSyncError, type SpeechPreferences } from './speech'

const TAG_ID = /^[A-Za-z0-9_-]{1,32}$/
const LOCALE = /^en(?:-[A-Za-z0-9]{2,8}){0,3}$/
const SERVER_VOICE = /^[A-Za-z0-9._:-]{1,80}$/
const ORDERS = new Set<TrainingPreferences['order']>([
  'random',
  'reviewed_desc',
  'reviewed_asc',
  'created_desc',
  'created_asc',
  'progress_asc',
  'progress_desc',
])
const RATES = new Set([0.5, 0.75, 1, 1.25, 1.5])
const ENGINES = new Set(['auto', 'server', 'browser'])

export const DEFAULT_TRAINING: TrainingPreferences = {
  mode: 'choice',
  direction: 'en_ru',
  purpose: 'free',
  include_new: true,
  size: 10,
  tag_ids: [],
  progress_min: null,
  progress_max: null,
  order: 'random',
  shuffle: false,
  include_learned: false,
}

function isVoiceUri(value: unknown): value is string | null {
  if (value === null) return true
  if (typeof value !== 'string' || value.length === 0 || value.length > 300) return false
  return ![...value].some((char) => {
    const code = char.charCodeAt(0)
    return code < 32 || code === 127
  })
}

function isServerVoice(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && SERVER_VOICE.test(value))
}

function isRate(value: unknown): value is SpeechPreferencesDto['rate'] {
  return typeof value === 'number' && RATES.has(value)
}

function isProgress(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1_000_000_000)
  )
}

export function parseTrainingPreferences(value: unknown): TrainingPreferences | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const tags = raw.tag_ids
  if (
    (raw.mode !== 'choice' && raw.mode !== 'input' && raw.mode !== 'matching') ||
    (raw.direction !== 'en_ru' && raw.direction !== 'ru_en') ||
    (raw.mode === 'matching' && raw.direction !== 'en_ru') ||
    (raw.purpose !== 'scheduled' && raw.purpose !== 'free') ||
    typeof raw.include_new !== 'boolean' ||
    !(
      raw.size === 'all' ||
      (typeof raw.size === 'number' &&
        Number.isInteger(raw.size) &&
        raw.size >= 1 &&
        raw.size <= 1_000_000)
    ) ||
    !Array.isArray(tags) ||
    tags.length > 20 ||
    tags.some((id) => typeof id !== 'string' || !TAG_ID.test(id)) ||
    !isProgress(raw.progress_min) ||
    !isProgress(raw.progress_max) ||
    (raw.progress_min !== null &&
      raw.progress_max !== null &&
      raw.progress_max < raw.progress_min) ||
    typeof raw.order !== 'string' ||
    !ORDERS.has(raw.order as TrainingPreferences['order']) ||
    typeof raw.shuffle !== 'boolean' ||
    (raw.include_learned !== undefined && typeof raw.include_learned !== 'boolean')
  )
    return null
  return {
    mode: raw.mode,
    direction: raw.direction,
    purpose: raw.purpose,
    include_new: raw.include_new,
    size: raw.size,
    tag_ids: [...new Set(tags)].sort(),
    progress_min: raw.progress_min,
    progress_max: raw.progress_max,
    order: raw.order as TrainingPreferences['order'],
    shuffle: raw.shuffle,
    include_learned: raw.include_learned === true,
  }
}

function trainingKey(userId: string) {
  return `lexicona:training:v1:${userId}`
}

export function readTrainingLocal(userId: string): TrainingPreferences | null {
  try {
    const raw = localStorage.getItem(trainingKey(userId))
    if (!raw) return null
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return null
    const record = value as Record<string, unknown>
    if (record.version !== 1) return null
    return parseTrainingPreferences(record.training)
  } catch {
    return null
  }
}

export function writeTrainingLocal(userId: string, training: TrainingPreferences) {
  try {
    localStorage.setItem(trainingKey(userId), JSON.stringify({ version: 1, training }))
  } catch {
    // This device still keeps the choice in memory until the page closes.
  }
}

export function loadStoredTraining(
  userId: string | undefined,
  account: unknown,
): { training: TrainingPreferences; source: 'server' | 'local' | 'default' } {
  if (!userId) return { training: DEFAULT_TRAINING, source: 'default' }
  const server = parseTrainingPreferences(account)
  if (server) {
    writeTrainingLocal(userId, server)
    return { training: server, source: 'server' }
  }
  const local = readTrainingLocal(userId)
  if (local) return { training: local, source: 'local' }
  return { training: DEFAULT_TRAINING, source: 'default' }
}

export function speechToDto(preferences: SpeechPreferences): SpeechPreferencesDto {
  return {
    en_locale: preferences.enLocale,
    en_voice_uri: preferences.enVoiceURI,
    ru_voice_uri: preferences.ruVoiceURI,
    rate: preferences.rate,
    auto_prompt: preferences.autoPrompt,
    speak_en: preferences.speakEn,
    speak_ru: preferences.speakRu,
    engine_en: preferences.engineEn,
    engine_ru: preferences.engineRu,
    server_en_us: preferences.serverEnUS,
    server_en_gb: preferences.serverEnGB,
    server_ru: preferences.serverRu,
  }
}

export function speechFromAccount(value: unknown): SpeechPreferences | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  if (
    typeof raw.en_locale !== 'string' ||
    raw.en_locale.length > 32 ||
    !LOCALE.test(raw.en_locale) ||
    !isVoiceUri(raw.en_voice_uri) ||
    !isVoiceUri(raw.ru_voice_uri) ||
    !isRate(raw.rate) ||
    typeof raw.auto_prompt !== 'boolean' ||
    typeof raw.speak_en !== 'boolean' ||
    typeof raw.speak_ru !== 'boolean' ||
    typeof raw.engine_en !== 'string' ||
    !ENGINES.has(raw.engine_en) ||
    typeof raw.engine_ru !== 'string' ||
    !ENGINES.has(raw.engine_ru) ||
    !isServerVoice(raw.server_en_us) ||
    !isServerVoice(raw.server_en_gb) ||
    !isServerVoice(raw.server_ru)
  )
    return null
  return {
    enLocale: raw.en_locale,
    enVoiceURI: raw.en_voice_uri,
    ruVoiceURI: raw.ru_voice_uri,
    rate: raw.rate,
    autoPrompt: raw.auto_prompt,
    speakEn: raw.speak_en,
    speakRu: raw.speak_ru,
    engineEn: raw.engine_en as SpeechPreferences['engineEn'],
    engineRu: raw.engine_ru as SpeechPreferences['engineRu'],
    serverEnUS: raw.server_en_us,
    serverEnGB: raw.server_en_gb,
    serverRu: raw.server_ru,
  }
}

let trainingGeneration = 0
let trainingEpoch = 0
let trainingChain: Promise<void> = Promise.resolve()
let trainingSyncError = false
const trainingListeners = new Set<() => void>()

function setTrainingSyncError(value: boolean) {
  if (trainingSyncError === value) return
  trainingSyncError = value
  trainingListeners.forEach((listener) => listener())
}

export function useTrainingSyncError() {
  return useSyncExternalStore(
    (listener) => {
      trainingListeners.add(listener)
      return () => trainingListeners.delete(listener)
    },
    () => trainingSyncError,
  )
}

let trainingTimer: ReturnType<typeof window.setTimeout> | null = null

export function cancelTrainingSync() {
  trainingGeneration += 1
  if (trainingTimer) window.clearTimeout(trainingTimer)
  trainingTimer = null
  setTrainingSyncError(false)
}

function patchPreference(
  userId: string,
  section: 'training' | 'speech',
  value: TrainingPreferences | SpeechPreferencesDto | null,
) {
  queryClient.setQueryData<Session | null>(['session'], (prev) => {
    if (!prev || prev.user.id !== userId) return prev
    return {
      ...prev,
      user: {
        ...prev.user,
        preferences: { ...prev.user.preferences, [section]: value },
      },
    }
  })
}

export function scheduleTrainingSave(
  userId: string,
  training: TrainingPreferences,
  delayMs: number,
  onFire?: () => void,
) {
  writeTrainingLocal(userId, training)
  patchPreference(userId, 'training', training)
  if (trainingTimer) window.clearTimeout(trainingTimer)
  trainingTimer = window.setTimeout(() => {
    trainingTimer = null
    onFire?.()
    putTrainingPreferences(userId, training)
  }, delayMs)
}

export function putTrainingPreferences(userId: string, training: TrainingPreferences) {
  const token = trainingGeneration
  const epoch = ++trainingEpoch
  writeTrainingLocal(userId, training)
  patchPreference(userId, 'training', training)
  setTrainingSyncError(false)
  trainingChain = trainingChain.then(async () => {
    if (token !== trainingGeneration) return
    try {
      const user = await api.updateSettings({ training })
      if (token !== trainingGeneration || epoch !== trainingEpoch || user.id !== userId) return
      patchPreference(userId, 'training', user.preferences?.training ?? training)
      setTrainingSyncError(false)
    } catch (error) {
      if (token !== trainingGeneration || epoch !== trainingEpoch) return
      if (error instanceof ApiError && error.status === 401) forgetSession()
      else setTrainingSyncError(true)
    }
  })
}

let speechGeneration = 0
let speechEpoch = 0
let speechChain: Promise<void> = Promise.resolve()

export function bindSpeechSync(userId: string) {
  const token = ++speechGeneration
  return {
    publish(preferences: SpeechPreferences) {
      const epoch = ++speechEpoch
      const speech = speechToDto(preferences)
      if (!speechFromAccount(speech)) {
        reportSpeechSyncError(true)
        return
      }
      patchPreference(userId, 'speech', speech)
      reportSpeechSyncError(false)
      speechChain = speechChain.then(async () => {
        if (token !== speechGeneration) return
        try {
          const user = await api.updateSettings({ speech })
          if (token !== speechGeneration || epoch !== speechEpoch || user.id !== userId) return
          patchPreference(userId, 'speech', user.preferences?.speech ?? speech)
          reportSpeechSyncError(false)
        } catch (error) {
          if (token !== speechGeneration || epoch !== speechEpoch) return
          if (error instanceof ApiError && error.status === 401) forgetSession()
          else reportSpeechSyncError(true)
        }
      })
    },
    stop() {
      if (speechGeneration === token) speechGeneration += 1
    },
  }
}
