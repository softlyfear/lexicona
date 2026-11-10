import { act, render, renderHook, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, type ServerVoice } from './api'
import { cancelSpeech, setSpeechOwner, speak, updateSpeechPreferences, useSpeech } from './speech'
import { Layout } from './components/Layout'
import { createElement } from 'react'

const serverVoices: ServerVoice[] = [
  { id: 'us', name: 'Lessac', language: 'en-US', gender: 'female' },
  { id: 'gb', name: 'Alan', language: 'en-GB', gender: 'male' },
  { id: 'ru', name: 'Denis', language: 'ru-RU', gender: 'male' },
]
class FakeAudio {
  static instances: FakeAudio[] = []
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  onplaying: (() => void) | null = null
  pause = vi.fn()
  removeAttribute = vi.fn()
  play = vi.fn().mockResolvedValue(undefined)
  constructor(_src: string) {
    FakeAudio.instances.push(this)
  }
}

beforeEach(() => {
  FakeAudio.instances = []
  localStorage.clear()
  vi.spyOn(api, 'listSpeechVoices').mockResolvedValue({ available: true, voices: serverVoices })
  vi.stubGlobal('Audio', FakeAudio)
  vi.stubGlobal(
    'URL',
    Object.assign(URL, {
      createObjectURL: vi.fn().mockReturnValue('blob:test'),
      revokeObjectURL: vi.fn(),
    }),
  )
})
afterEach(() => {
  act(() => setSpeechOwner(null))
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function owner(id = 'a') {
  await act(async () => {
    setSpeechOwner(id)
    await Promise.resolve()
  })
}

describe('серверная речь', () => {
  it('выбирает голос акцента и пользователя и очищает WAV после завершения', async () => {
    const synthesize = vi.spyOn(api, 'synthesizeSpeech').mockResolvedValue(new Blob(['wav']))
    await owner()
    const { result } = renderHook(() => useSpeech())
    expect(result.current.serverState).toBe('ready')
    act(() => updateSpeechPreferences({ enLocale: 'en-GB', serverEnGB: 'gb', rate: 0.75 }))
    await act(async () => {
      speak('hello', 'en')
      await Promise.resolve()
    })
    expect(synthesize).toHaveBeenCalledWith('hello', 'gb', 0.75, expect.any(AbortSignal))
    const instance = FakeAudio.instances[0]
    expect(instance.play).toHaveBeenCalledOnce()
    act(() => instance.onended?.())
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test')
    expect(instance.pause).toHaveBeenCalledOnce()
    expect(result.current.status).toContain('завершено')
    await owner('b')
    expect(result.current.preferences.enLocale).toBe('en-US')
    await owner('a')
    expect(result.current.preferences.serverEnGB).toBe('gb')
  })

  it('отменяет запрос и игнорирует опоздавший WAV', async () => {
    let resolve!: (blob: Blob) => void
    const synthesize = vi.spyOn(api, 'synthesizeSpeech').mockReturnValue(
      new Promise((done) => {
        resolve = done
      }),
    )
    await owner()
    act(() => speak('hello', 'en'))
    const signal = synthesize.mock.calls[0][3]
    act(() => cancelSpeech())
    expect(signal.aborted).toBe(true)
    await act(async () => resolve(new Blob(['wav'])))
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('не подменяет серверный голос браузерным при сбое или отказе play', async () => {
    const synthesize = vi
      .spyOn(api, 'synthesizeSpeech')
      .mockRejectedValueOnce(new ApiError(503, 'speech_busy'))
      .mockResolvedValueOnce(new Blob(['wav']))
    await owner()
    const { result } = renderHook(() => useSpeech())
    await act(async () => {
      speak('hello', 'en')
      await Promise.resolve()
    })
    expect(result.current.status).toContain('занят')
    vi.stubGlobal(
      'Audio',
      class extends FakeAudio {
        constructor(src: string) {
          super(src)
          this.play.mockRejectedValue(new Error('autoplay denied'))
        }
      },
    )
    await act(async () => {
      speak('hello', 'en')
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(synthesize).toHaveBeenCalledTimes(2)
    expect(result.current.status).toContain('Попробуйте ещё раз')
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test')
  })

  it('повторно воспроизводит готовый WAV по нажатию после отказа iOS без нового запроса', async () => {
    const synthesize = vi.spyOn(api, 'synthesizeSpeech').mockResolvedValue(new Blob(['wav']))
    vi.stubGlobal(
      'Audio',
      class extends FakeAudio {
        constructor(src: string) {
          super(src)
          this.play.mockRejectedValueOnce(new DOMException('gesture required', 'NotAllowedError'))
        }
      },
    )
    await owner()
    const { result } = renderHook(() => useSpeech())
    await act(async () => {
      speak('hello', 'en')
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.status).toContain('Аудио готово')
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    const current = FakeAudio.instances[0]
    act(() => {
      speak('hello', 'en')
      expect(current.play).toHaveBeenCalledTimes(2)
    })
    expect(synthesize).toHaveBeenCalledOnce()
    act(() => cancelSpeech())
    expect(current.pause).toHaveBeenCalledOnce()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test')
  })

  it('сообщает о необходимости повторного нажатия на любой странице приложения', async () => {
    let finish!: (blob: Blob) => void
    vi.spyOn(api, 'synthesizeSpeech').mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    vi.stubGlobal(
      'Audio',
      class extends FakeAudio {
        constructor(src: string) {
          super(src)
          this.play.mockRejectedValueOnce(new DOMException('gesture required', 'NotAllowedError'))
        }
      },
    )
    await act(async () => {
      render(
        createElement(
          MemoryRouter,
          null,
          createElement(Layout, {
            user: { id: 'a', login: 'a', is_admin: false, difficulty: 'medium' },
          }),
        ),
      )
      await Promise.resolve()
    })
    act(() => speak('hello', 'en'))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Остановить речь' })).not.toBeInTheDocument()
    await act(async () => {
      finish(new Blob(['wav']))
      await Promise.resolve()
    })
    expect(screen.getByRole('status')).toHaveTextContent('Аудио готово. Нажмите озвучку ещё раз.')
    expect(screen.queryByRole('button', { name: 'Остановить речь' })).not.toBeInTheDocument()
    act(() => cancelSpeech())
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('не использует отсутствующий сохранённый голос и защищается от старых метаданных', async () => {
    let resolve!: (value: { available: boolean; voices: ServerVoice[] }) => void
    vi.mocked(api.listSpeechVoices).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      }),
    )
    const synthesize = vi.spyOn(api, 'synthesizeSpeech')
    act(() => setSpeechOwner('old'))
    await owner('new')
    await act(async () => resolve({ available: true, voices: [{ ...serverVoices[0], id: 'old' }] }))
    const { result } = renderHook(() => useSpeech())
    expect(result.current.serverVoices[0].id).toBe('us')
    act(() => updateSpeechPreferences({ serverEnUS: 'missing' }))
    await act(async () => {
      speak('hello', 'en')
      await Promise.resolve()
    })
    expect(synthesize).toHaveBeenCalledWith('hello', 'us', 1, expect.any(AbortSignal))
  })

  it('сохраняет старый en-AU и использует браузер при отсутствии серверного акцента', async () => {
    localStorage.setItem(
      'lexicona:speech:v1:a',
      JSON.stringify({
        version: 1,
        enLocale: 'en-AU',
        enVoiceURI: 'au',
        ruVoiceURI: null,
        rate: 1,
        autoPrompt: true,
      }),
    )
    const australian = {
      lang: 'en-AU',
      voiceURI: 'au',
      name: 'Australian',
      default: true,
      localService: true,
    } as SpeechSynthesisVoice
    const browser = {
      getVoices: () => [australian],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      cancel: vi.fn(),
      speak: vi.fn((_utterance: SpeechSynthesisUtterance) => {}),
    }
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: browser })
    vi.stubGlobal(
      'SpeechSynthesisUtterance',
      class {
        constructor(_text: string) {}
      },
    )
    const synthesize = vi.spyOn(api, 'synthesizeSpeech')
    await owner()
    act(() => speak('hello', 'en'))
    expect(browser.speak).toHaveBeenCalledOnce()
    expect(browser.speak.mock.calls[0][0]).toMatchObject({ voice: australian, lang: 'en-AU' })
    expect(synthesize).not.toHaveBeenCalled()
    browser.getVoices = () => [{ ...australian, lang: 'en-US', voiceURI: 'us' }]
    act(() => speak('hello again', 'en'))
    expect(browser.speak).toHaveBeenCalledOnce()
    act(() => updateSpeechPreferences({ engineEn: 'server' }))
    act(() => speak('hello', 'en'))
    expect(browser.speak).toHaveBeenCalledOnce()
    expect(synthesize).not.toHaveBeenCalled()
    Reflect.deleteProperty(window, 'speechSynthesis')
  })

  it('оставляет английский на сервере, когда русский переключён на браузер', async () => {
    const synthesize = vi.spyOn(api, 'synthesizeSpeech').mockResolvedValue(new Blob(['wav']))
    const russian = {
      lang: 'ru-RU',
      voiceURI: 'browser-ru',
      name: 'Browser RU',
      default: true,
      localService: true,
    } as SpeechSynthesisVoice
    let spoken: SpeechSynthesisUtterance | undefined
    const browser = {
      getVoices: () => [russian],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      cancel: vi.fn(),
      speak: vi.fn((utterance: SpeechSynthesisUtterance) => {
        spoken = utterance
      }),
    }
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: browser })
    vi.stubGlobal(
      'SpeechSynthesisUtterance',
      class {
        text: string
        voice: SpeechSynthesisVoice | null = null
        lang = ''
        rate = 1
        constructor(text: string) {
          this.text = text
        }
      },
    )
    await owner()
    act(() => updateSpeechPreferences({ engineEn: 'server', engineRu: 'browser', rate: 1.25 }))
    await act(async () => {
      speak('hello', 'en')
      await Promise.resolve()
    })
    expect(synthesize).toHaveBeenCalledWith('hello', 'us', 1.25, expect.any(AbortSignal))
    expect(browser.speak).not.toHaveBeenCalled()
    act(() => speak('кот', 'ru'))
    expect(synthesize).toHaveBeenCalledOnce()
    expect(browser.speak).toHaveBeenCalledOnce()
    expect(spoken).toMatchObject({ text: 'кот', rate: 1.25, lang: 'ru-RU' })
    Reflect.deleteProperty(window, 'speechSynthesis')
  })
})
