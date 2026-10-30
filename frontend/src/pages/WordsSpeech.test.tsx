import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api, type Word } from '../api'
import { setSpeechOwner } from '../speech'
import { WordsPage } from './WordsPage'

vi.mock('../api', async (original) => {
  const actual = await original<typeof import('../api')>()
  return { ...actual, api: { listWords: vi.fn(), listTags: vi.fn() } }
})

const word: Word = {
  id: '1',
  headword: 'cat',
  translations: ['кот'],
  progress: 0,
  is_excluded: false,
  transcription: null,
  example_en: null,
  example_ru: null,
  note: null,
  created_at: '',
  updated_at: '',
  tags: [],
}
const voice = {
  lang: 'en-US',
  voiceURI: 'en',
  name: 'English',
  default: true,
  localService: true,
} as SpeechSynthesisVoice
let voices: SpeechSynthesisVoice[]
let changed: () => void
let current: SpeechSynthesisUtterance
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
  vi.clearAllMocks()
  voices = []
  vi.mocked(api.listWords).mockResolvedValue([word])
  vi.mocked(api.listTags).mockResolvedValue([])
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: engine })
  vi.stubGlobal('SpeechSynthesisUtterance', Utterance)
})
afterEach(() => {
  setSpeechOwner(null)
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, 'speechSynthesis')
})

it.each(['Добавить слово', 'Изменить «cat»'])('%s отменяет текущую речь', async (action) => {
  voices = [voice]
  setSpeechOwner('a')
  const user = userEvent.setup()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <WordsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  await user.click(await screen.findByRole('button', { name: 'Произнести EN «cat»' }))
  expect(engine.speak).toHaveBeenCalledOnce()
  const old = current
  const before = engine.cancel.mock.calls.length
  await user.click(screen.getByRole('button', { name: action }))
  expect(engine.cancel).toHaveBeenCalledTimes(before + 1)
  expect(screen.getByLabelText('Слово или выражение (EN)')).toBeInTheDocument()
  if (action === 'Добавить слово')
    expect(screen.queryByRole('button', { name: 'Остановить речь' })).not.toBeInTheDocument()
  act(() => old.onerror?.({} as SpeechSynthesisErrorEvent))
  expect(screen.queryByText(/Не удалось воспроизвести речь/)).not.toBeInTheDocument()
})

it.each(['Добавить слово', 'Изменить «cat»'])('%s отменяет ожидающий голос', async (action) => {
  setSpeechOwner('a')
  const user = userEvent.setup()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <WordsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  await user.click(await screen.findByRole('button', { name: 'Произнести EN «cat»' }))
  expect(screen.getByText('Ожидание голосов…')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: action }))
  voices = [voice]
  act(() => changed())
  expect(engine.speak).not.toHaveBeenCalled()
  expect(screen.queryByText('Ожидание голосов…')).not.toBeInTheDocument()
})
