import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
import {
  cancelSpeech,
  selectServerVoice,
  setSpeechOwner,
  speak,
  updateSpeechPreferences,
  useSpeech,
  type SpeechPreferences,
} from './speech'

const voice = (lang: string, voiceURI: string, defaultVoice = false) =>
  ({
    lang,
    voiceURI,
    name: voiceURI,
    default: defaultVoice,
    localService: true,
  }) as SpeechSynthesisVoice
let voices: SpeechSynthesisVoice[]
let current: SpeechSynthesisUtterance
let changed: () => void
const engine = {
  getVoices: () => voices,
  addEventListener: (_name: string, callback: () => void) => {
    changed = callback
  },
  removeEventListener: vi.fn(),
  cancel: vi.fn(),
  speak: vi.fn((value: SpeechSynthesisUtterance) => {
    current = value
  }),
}
class Utterance {
  text: string
  constructor(text: string) {
    this.text = text
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(api, 'listSpeechVoices').mockImplementation(() => new Promise(() => {}))
  localStorage.clear()
  voices = []
  engine.speak.mockClear()
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: engine })
  vi.stubGlobal('SpeechSynthesisUtterance', Utterance)
})
afterEach(() => {
  setSpeechOwner(null)
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, 'speechSynthesis')
})

function browserSpeak(text: string, lang: 'en' | 'ru') {
  updateSpeechPreferences({ engineEn: 'browser', engineRu: 'browser' })
  speak(text, lang)
}

describe('браузерная речь', () => {
  it('ожидает голоса ограниченно и не запускает просроченную речь', () => {
    setSpeechOwner('a')
    const { result } = renderHook(() => useSpeech())
    act(() => browserSpeak('hello', 'en'))
    expect(result.current.status).toContain('Ожидание')
    act(() => vi.advanceTimersByTime(2000))
    expect(result.current.status).toContain('не найден')
    voices = [voice('en-US', 'english')]
    act(() => changed())
    expect(engine.speak).not.toHaveBeenCalled()
    act(() => browserSpeak('hello', 'en'))
    expect(engine.speak).toHaveBeenCalledOnce()
    expect(current.voice?.voiceURI).toBe('english')
  })

  it('выбирает только голос нужного языка и игнорирует старые события', () => {
    voices = [voice('ru-RU', 'ru'), voice('en-GB', 'gb'), voice('en-US', 'us')]
    setSpeechOwner('a')
    const { result } = renderHook(() => useSpeech())
    act(() => updateSpeechPreferences({ enVoiceURI: 'ru', enLocale: 'en-GB' }))
    act(() => browserSpeak('first', 'en'))
    const old = current
    expect(old.voice?.voiceURI).toBe('gb')
    act(() => browserSpeak('второй', 'ru'))
    expect(current.voice?.voiceURI).toBe('ru')
    act(() => old.onerror?.({} as SpeechSynthesisErrorEvent))
    expect(result.current.status).toContain('Ожидание')
    act(() => cancelSpeech())
    act(() => current.onend?.({} as SpeechSynthesisEvent))
    expect(result.current.status).toBe('')
  })

  it('сохраняет только настройки отдельно для каждого аккаунта', () => {
    setSpeechOwner('a')
    updateSpeechPreferences({ rate: 0.75, autoPrompt: false })
    expect(JSON.parse(localStorage.getItem('lexicona:speech:v1:a')!)).toEqual({
      version: 1,
      enLocale: 'en-US',
      enVoiceURI: null,
      ruVoiceURI: null,
      rate: 0.75,
      autoPrompt: false,
      speakEn: true,
      speakRu: true,
      engineEn: 'auto',
      engineRu: 'auto',
      serverEnUS: null,
      serverEnGB: null,
      serverRu: null,
    })
    setSpeechOwner('b')
    const { result } = renderHook(() => useSpeech())
    expect(result.current.preferences.autoPrompt).toBe(true)
    act(() => setSpeechOwner('a'))
    expect(result.current.preferences.rate).toBe(0.75)
  })

  it('ограничивает ожидание длинного текста с учётом скорости и позволяет повторить', () => {
    voices = [voice('en-US', 'english')]
    setSpeechOwner('a')
    const { result } = renderHook(() => useSpeech())
    act(() => updateSpeechPreferences({ rate: 0.75 }))
    act(() => browserSpeak('x'.repeat(1800), 'en'))
    expect(current.rate).toBe(0.75)
    act(() => vi.advanceTimersByTime(20000))
    expect(result.current.status).not.toContain('не завершилось')
    act(() => vi.advanceTimersByTime(295000))
    expect(result.current.status).toContain('не завершилось')
    act(() => browserSpeak('retry', 'en'))
    expect(engine.speak).toHaveBeenCalledTimes(2)
  })

  it('не озвучивает выключенный язык, пока проверка не запрошена явно', () => {
    voices = [voice('ru-RU', 'ru'), voice('en-US', 'en')]
    setSpeechOwner('a')
    const { result } = renderHook(() => useSpeech())
    act(() => updateSpeechPreferences({ engineEn: 'browser', engineRu: 'browser', speakRu: false }))
    act(() => speak('кот', 'ru'))
    expect(engine.speak).not.toHaveBeenCalled()
    expect(result.current.status).toBe('')
    act(() => speak('кот', 'ru', { force: true }))
    expect(engine.speak).toHaveBeenCalledOnce()
    expect(current.text).toBe('кот')
    act(() => speak('hello', 'en'))
    expect(engine.speak).toHaveBeenCalledTimes(2)
  })

  it('старый общий источник применяется к обоим языкам', () => {
    localStorage.setItem(
      'lexicona:speech:v1:a',
      JSON.stringify({
        version: 1,
        enLocale: 'en-US',
        enVoiceURI: null,
        ruVoiceURI: null,
        rate: 1,
        autoPrompt: true,
        engine: 'browser',
      }),
    )
    setSpeechOwner('a')
    const { result } = renderHook(() => useSpeech())
    expect(result.current.preferences.engineEn).toBe('browser')
    expect(result.current.preferences.engineRu).toBe('browser')
    expect(result.current.storageError).toBe(false)
  })

  it('старые настройки без выбора языка озвучивают оба языка', () => {
    localStorage.setItem(
      'lexicona:speech:v1:a',
      JSON.stringify({
        version: 1,
        enLocale: 'en-US',
        enVoiceURI: null,
        ruVoiceURI: null,
        rate: 1,
        autoPrompt: true,
      }),
    )
    voices = [voice('ru-RU', 'ru')]
    setSpeechOwner('a')
    const { result } = renderHook(() => useSpeech())
    expect(result.current.preferences.speakEn).toBe(true)
    expect(result.current.preferences.speakRu).toBe(true)
    expect(result.current.storageError).toBe(false)
    act(() => browserSpeak('кот', 'ru'))
    expect(engine.speak).toHaveBeenCalledOnce()
  })

  it('повреждённый флаг языка сбрасывает чтение настроек к значениям по умолчанию', () => {
    localStorage.setItem(
      'lexicona:speech:v1:a',
      JSON.stringify({
        version: 1,
        enLocale: 'en-US',
        enVoiceURI: null,
        ruVoiceURI: null,
        rate: 1,
        autoPrompt: true,
        speakRu: 'no',
      }),
    )
    setSpeechOwner('a')
    const { result } = renderHook(() => useSpeech())
    expect(result.current.storageError).toBe(true)
    expect(result.current.preferences.speakEn).toBe(true)
    expect(result.current.preferences.speakRu).toBe(true)
  })

  it('без подходящего языка или API сообщает ошибку и не запускает речь', () => {
    voices = [voice('ru-RU', 'ru'), voice('', 'unknown')]
    setSpeechOwner('a')
    const { result } = renderHook(() => useSpeech())
    act(() => browserSpeak('hello', 'en'))
    expect(result.current.status).toContain('EN голос не найден')
    expect(engine.speak).not.toHaveBeenCalled()
    Reflect.deleteProperty(window, 'speechSynthesis')
    act(() => browserSpeak('hello', 'en'))
    expect(result.current.status).toContain('недоступно')
  })

  it('повреждённое или недоступное хранилище не ломает работу и использует defaults', () => {
    localStorage.setItem('lexicona:speech:v1:a', '{broken')
    setSpeechOwner('a')
    const { result } = renderHook(() => useSpeech())
    expect(result.current.storageError).toBe(true)
    expect(result.current.preferences.autoPrompt).toBe(true)
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'QuotaExceededError')
    })
    act(() => updateSpeechPreferences({ rate: 0.75 }))
    expect(result.current.storageError).toBe(true)
    expect(result.current.preferences.rate).toBe(0.75)
    write.mockRestore()
  })

  it('объясняет отказ браузера и не принимает события после завершения', () => {
    voices = [voice('en-US', 'english')]
    setSpeechOwner('a')
    const { result } = renderHook(() => useSpeech())
    act(() => browserSpeak('hello', 'en'))
    act(() => current.onerror?.({ error: 'not-allowed' } as SpeechSynthesisErrorEvent))
    expect(result.current.status).toContain('Не удалось')
    act(() => current.onend?.({} as SpeechSynthesisEvent))
    expect(result.current.status).toContain('Не удалось')
    engine.speak.mockImplementationOnce(() => {
      throw new Error('not allowed')
    })
    act(() => browserSpeak('retry', 'en'))
    expect(result.current.status).toContain('Не удалось')
  })

  it('после исчезновения голоса и ошибки getVoices не сообщает о доступной речи', () => {
    voices = [voice('en-US', 'english')]
    setSpeechOwner('a')
    const { result } = renderHook(() => useSpeech())
    expect(result.current.voiceState).toBe('ready')
    voices = []
    act(() => changed())
    expect(result.current.voiceState).toBe('unavailable')
    act(() => browserSpeak('hello', 'en'))
    expect(result.current.status).toContain('не найден')
    const getVoices = vi.spyOn(engine, 'getVoices').mockImplementation(() => {
      throw new Error('browser failure')
    })
    act(() => browserSpeak('retry', 'en'))
    expect(result.current.voiceState).toBe('unavailable')
    expect(result.current.status).toContain('не найден')
    expect(engine.speak).not.toHaveBeenCalled()
    getVoices.mockRestore()
  })
})

describe('серверный голос', () => {
  const preferences = {
    enLocale: 'en-US',
    enVoiceURI: null,
    ruVoiceURI: null,
    rate: 1,
    autoPrompt: true,
    speakEn: true,
    speakRu: true,
    engineEn: 'server',
    engineRu: 'server',
    serverEnUS: 'en_US-lessac-medium',
    serverEnGB: null,
    serverRu: null,
  } satisfies SpeechPreferences

  it('берёт high вместо сохранённого medium того же диктора', () => {
    const selected = selectServerVoice(
      [{ id: 'en_US-lessac-high', name: 'Lessac', language: 'en-US', gender: 'female' }],
      'en',
      preferences,
    )
    expect(selected?.id).toBe('en_US-lessac-high')
  })
})
