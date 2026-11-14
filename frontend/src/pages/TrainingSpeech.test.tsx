import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api, type TerminalResult, type TrainingSession } from '../api'
import { Layout } from '../components/Layout'
import { forgetSession } from '../session'
import {
  cancelSpeech,
  setSpeechOwner,
  speak,
  speechGeneration,
  updateSpeechPreferences,
} from '../speech'
import { TrainingPage } from './TrainingPage'
import css from './pages.module.css'

vi.mock('../api', async (original) => {
  const actual = await original<typeof import('../api')>()
  return {
    ...actual,
    api: {
      startTraining: vi.fn(),
      previewTraining: () =>
        Promise.resolve({
          count: 10,
          selection_seed: '0123456789abcdef0123456789abcdef',
          unavailable_reason: null,
        }),
      latestTraining: vi.fn(),
      finishTraining: vi.fn(),
      listTags: () => Promise.resolve([]),
      answer: vi.fn(),
      answerText: vi.fn(),
      revealAnswer: vi.fn(),
      getWord: vi.fn(),
    },
  }
})
vi.mock('../speech', async (original) => {
  const actual = await original<typeof import('../speech')>()
  return { ...actual, speak: vi.fn(actual.speak) }
})

const session: TrainingSession = {
  id: 's',
  purpose: 'free',
  mode: 'choice',
  direction: 'ru_en',
  items: [
    { id: 'i1', prompt: 'кот', options: ['cat', 'dog', 'fox', 'owl'] },
    { id: 'i2', prompt: 'собака', options: ['cat', 'dog', 'fox', 'owl'] },
  ],
}
function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['training', 'latest'], null)
  return render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/training']}>
          <Routes>
            <Route
              element={
                <Layout user={{ id: 'a', login: 'alice', is_admin: false, difficulty: 'medium' }} />
              }
            >
              <Route path="training" element={<TrainingPage />} />
              <Route index element={<p>Словарь</p>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </StrictMode>,
  )
}
beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  vi.mocked(api.startTraining).mockResolvedValue(session)
  vi.mocked(api.latestTraining).mockResolvedValue(null)
  vi.mocked(api.finishTraining).mockResolvedValue({ id: 's', status: 'finished', finished_at: '' })
  vi.mocked(api.answer).mockResolvedValue({
    outcome: 'answered',
    correct: true,
    correct_option: 0,
    chosen_option: 0,
    delta: 4,
    progress: 4,
  })
})
afterEach(() => {
  act(() => cancelSpeech())
  vi.unstubAllGlobals()
})

it('в StrictMode читает только публичные RU prompts при старте и далее', async () => {
  const user = userEvent.setup()
  renderPage()
  await user.click(screen.getByRole('button', { name: 'Начать' }))
  expect(await screen.findByText('кот')).toBeInTheDocument()
  expect(speak).toHaveBeenCalledTimes(1)
  expect(speak).toHaveBeenLastCalledWith('кот', 'ru')
  expect(api.answer).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: /cat/ }))
  expect(await screen.findByText(/Верно/)).toBeInTheDocument()
  expect(speak).toHaveBeenCalledTimes(2)
  expect(speak).toHaveBeenLastCalledWith('cat', 'en')
  await user.click(screen.getByRole('button', { name: 'Далее' }))
  expect(speak).toHaveBeenCalledTimes(3)
  expect(speak).toHaveBeenLastCalledWith('собака', 'ru')
  await user.click(screen.getByRole('button', { name: /cat/ }))
  await screen.findByText(/Верно/)
  await user.keyboard('{Enter}')
  expect(speak).toHaveBeenCalledTimes(4)
  expect(speak).toHaveBeenLastCalledWith('cat', 'en')
})

it('не запускает поздний start после скрытия вкладки', async () => {
  let resolve!: (value: TrainingSession) => void
  vi.mocked(api.startTraining).mockReturnValue(
    new Promise((r) => {
      resolve = r
    }),
  )
  const user = userEvent.setup()
  renderPage()
  await user.click(screen.getByRole('button', { name: 'Начать' }))
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  act(() => document.dispatchEvent(new Event('visibilitychange')))
  await act(async () => resolve(session))
  expect(speak).not.toHaveBeenCalled()
  hidden.mockRestore()
})

it('не озвучивает запоздавший ответ start после ухода со страницы', async () => {
  let resolve!: (value: TrainingSession) => void
  vi.mocked(api.startTraining).mockReturnValue(
    new Promise((r) => {
      resolve = r
    }),
  )
  const user = userEvent.setup()
  renderPage()
  await user.click(screen.getByRole('button', { name: 'Начать' }))
  await user.click(screen.getByRole('link', { name: 'Словарь' }))
  expect(await screen.findByText('Словарь', { selector: 'p' })).toBeInTheDocument()
  await act(async () => resolve(session))
  expect(speak).not.toHaveBeenCalled()
})

it('отменяет ожидающий start синхронно при завершении сессии', async () => {
  let resolve!: (value: TrainingSession) => void
  vi.mocked(api.startTraining).mockReturnValue(
    new Promise((r) => {
      resolve = r
    }),
  )
  const user = userEvent.setup()
  renderPage()
  await user.click(screen.getByRole('button', { name: 'Начать' }))
  act(() => forgetSession())
  await act(async () => resolve(session))
  expect(speak).not.toHaveBeenCalled()
})

it('при отключённой автоозвучке доступна ручная речь без повторов', async () => {
  localStorage.setItem(
    'lexicona:speech:v1:a',
    JSON.stringify({
      version: 1,
      enLocale: 'en-US',
      enVoiceURI: null,
      ruVoiceURI: null,
      rate: 1,
      autoPrompt: false,
    }),
  )
  const user = userEvent.setup()
  renderPage()
  await user.click(screen.getByRole('button', { name: 'Начать' }))
  expect(await screen.findByText('кот')).toBeInTheDocument()
  expect(speak).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: 'Произнести RU «кот»' }))
  expect(speak).toHaveBeenCalledExactlyOnceWith('кот', 'ru')
})

it('не озвучивает русский вопрос и скрывает кнопку, если русский выключен', async () => {
  localStorage.setItem(
    'lexicona:speech:v1:a',
    JSON.stringify({
      version: 1,
      enLocale: 'en-US',
      enVoiceURI: null,
      ruVoiceURI: null,
      rate: 1,
      autoPrompt: true,
      speakEn: true,
      speakRu: false,
    }),
  )
  const user = userEvent.setup()
  renderPage()
  await user.click(screen.getByRole('button', { name: 'Начать' }))
  expect(await screen.findByText('кот')).toBeInTheDocument()
  expect(speak).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Произнести RU «кот»' })).not.toBeInTheDocument()
})

it.each([
  ['en_ru', 'empty'],
  ['ru_en', 'empty'],
  ['en_ru', 'wrong'],
  ['ru_en', 'wrong'],
  ['en_ru', 'resume'],
  ['ru_en', 'resume'],
] as const)(
  'reveals a prominent authorized %s answer after %s input with adjacent playback and Next',
  async (direction, state) => {
    const user = userEvent.setup()
    const answer = direction === 'ru_en' ? 'Poach' : 'браконьерствовать'
    const lang = direction === 'ru_en' ? 'en' : 'ru'
    const inputSession: TrainingSession = {
      ...session,
      direction,
      mode: 'input',
      items: [{ id: 'i1', prompt: 'question', options: [] }, session.items[1]],
    }
    vi.mocked(api.startTraining).mockResolvedValue(inputSession)
    vi.mocked(api.answerText).mockResolvedValue({
      outcome: 'answered',
      correct: false,
      submitted_text: 'wrong',
      expected_answers: [answer],
      delta: -4,
      progress: 0,
    })
    if (state === 'resume') {
      vi.mocked(api.latestTraining).mockResolvedValue({
        ...inputSession,
        status: 'active',
        created_at: '',
        finished_at: null,
        requested_size: 2,
        items: inputSession.items.map((item) => ({
          ...item,
          state: 'retryable',
          result: {
            outcome: 'retryable',
            correct: false,
            submitted_text: 'wrong',
            delta: -4,
            progress: 0,
          },
        })),
      })
    }
    let resolve!: (result: TerminalResult) => void
    vi.mocked(api.revealAnswer).mockReturnValue(
      new Promise((done) => {
        resolve = done
      }),
    )
    renderPage()
    if (state === 'resume') {
      await user.click(await screen.findByRole('button', { name: 'Продолжить' }))
    } else {
      await user.click(
        screen.getByLabelText(
          direction === 'ru_en' ? 'Написание слова: RU → EN' : 'Написание перевода: EN → RU',
        ),
      )
      await user.click(screen.getByRole('button', { name: 'Начать' }))
    }
    const input = await screen.findByRole('textbox')
    if (state === 'wrong') {
      await user.type(input, 'wrong{Enter}')
      expect(await screen.findByRole('status')).toHaveTextContent('Неверно')
    }
    expect(screen.queryByRole('group', { name: 'Ответ' })).not.toBeInTheDocument()
    expect(screen.queryByText(answer)).not.toBeInTheDocument()
    expect(speak).not.toHaveBeenCalledWith(answer, lang)
    await user.click(screen.getByRole('button', { name: 'Показать ответ' }))
    expect(screen.getByRole('button', { name: 'Показать ответ' })).toBeDisabled()
    expect(screen.queryByRole('group', { name: 'Ответ' })).not.toBeInTheDocument()
    await act(async () =>
      resolve({ outcome: 'assisted', expected_answers: [answer], delta: 0, progress: 0 }),
    )
    const group = screen.getByRole('group', { name: 'Ответ' })
    expect(group).toHaveClass(css.revealedAnswer)
    expect(group.querySelector('p')).toHaveAttribute('lang', lang)
    expect(group).toHaveTextContent(`Ответ: ${answer}`)
    const playback = within(group).getByRole('button', {
      name: `Произнести ${lang.toUpperCase()} «${answer}»`,
    })
    expect(playback).toHaveClass(css.answerSpeak)
    expect(group.parentElement).toContainElement(screen.getByRole('button', { name: 'Далее' }))
    playback.focus()
    await user.keyboard('{Enter}')
    expect(speak).toHaveBeenLastCalledWith(answer, lang)
    expect(api.revealAnswer).toHaveBeenCalledExactlyOnceWith('i1')
    expect(api.answerText).toHaveBeenCalledTimes(state === 'wrong' ? 1 : 0)
    const generation = speechGeneration()
    await user.click(screen.getByRole('button', { name: 'Далее' }))
    expect(speechGeneration()).toBeGreaterThan(generation)
    expect(screen.queryByRole('group', { name: 'Ответ' })).not.toBeInTheDocument()
  },
)

it.each(['en_ru', 'ru_en'] as const)(
  'shows accepted %s server answer, not submitted text, and respects disabled answer language',
  async (direction) => {
    const user = userEvent.setup()
    const lang = direction === 'en_ru' ? 'ru' : 'en'
    vi.mocked(api.startTraining).mockResolvedValue({ ...session, mode: 'input', direction })
    vi.mocked(api.answerText).mockResolvedValue({
      outcome: 'answered',
      correct: true,
      submitted_text: 'accepted spelling',
      expected_answers: ['server answer'],
      delta: 8,
      progress: 8,
    })
    renderPage()
    await user.click(
      screen.getByLabelText(
        direction === 'ru_en' ? 'Написание слова: RU → EN' : 'Написание перевода: EN → RU',
      ),
    )
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    await user.type(await screen.findByRole('textbox'), 'accepted spelling{Enter}')
    const group = await screen.findByRole('group', { name: 'Ответ' })
    expect(group).toHaveTextContent('server answer')
    expect(group).not.toHaveTextContent('accepted spelling')
    const playback = within(group).getByRole('button')
    await user.click(playback)
    expect(speak).toHaveBeenLastCalledWith('server answer', lang)
    act(() => updateSpeechPreferences(lang === 'ru' ? { speakRu: false } : { speakEn: false }))
    expect(within(group).queryByRole('button')).not.toBeInTheDocument()
    expect(group).toHaveTextContent('server answer')
    expect(api.answerText).toHaveBeenCalledOnce()
  },
)

it.each(['next', 'editor', 'finish', 'unmount', 'owner'] as const)(
  'cancels answer speech on %s without additional training mutations',
  async (action) => {
    const user = userEvent.setup()
    vi.mocked(api.startTraining).mockResolvedValue({
      ...session,
      mode: 'input',
      items: [{ id: 'i1', word_id: 'word', prompt: 'вопрос', options: [] }, session.items[1]],
    })
    vi.mocked(api.answerText).mockResolvedValue({
      outcome: 'answered',
      correct: true,
      submitted_text: 'Poach',
      expected_answers: ['Poach'],
      delta: 8,
      progress: 8,
    })
    vi.mocked(api.getWord).mockReturnValue(new Promise(() => {}))
    const view = renderPage()
    await user.click(screen.getByLabelText('Написание слова: RU → EN'))
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    await user.type(await screen.findByRole('textbox'), 'Poach{Enter}')
    await user.click(
      within(await screen.findByRole('group', { name: 'Ответ' })).getByRole('button'),
    )
    const generation = speechGeneration()
    if (action === 'next') await user.click(screen.getByRole('button', { name: 'Далее' }))
    if (action === 'editor')
      await user.click(screen.getByRole('button', { name: 'Редактировать слово «вопрос»' }))
    if (action === 'finish') await user.click(screen.getByRole('button', { name: 'Завершить' }))
    if (action === 'unmount') view.unmount()
    if (action === 'owner') act(() => setSpeechOwner('b'))
    expect(speechGeneration()).toBeGreaterThan(generation)
    expect(api.answerText).toHaveBeenCalledOnce()
    expect(api.finishTraining).toHaveBeenCalledTimes(action === 'finish' ? 1 : 0)
  },
)

it('browser TTS failure leaves the authorized answer, Next and server progress unchanged', async () => {
  const user = userEvent.setup()
  let utterance!: SpeechSynthesisUtterance
  vi.stubGlobal(
    'SpeechSynthesisUtterance',
    class {
      text: string
      constructor(text: string) {
        this.text = text
      }
    },
  )
  vi.stubGlobal('speechSynthesis', {
    getVoices: () => [{ lang: 'en-US', voiceURI: 'english', name: 'English' }],
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    cancel: vi.fn(),
    speak: vi.fn((value: SpeechSynthesisUtterance) => {
      utterance = value
    }),
  })
  vi.mocked(api.startTraining).mockResolvedValue({ ...session, mode: 'input' })
  vi.mocked(api.revealAnswer).mockResolvedValue({
    outcome: 'assisted',
    expected_answers: ['Poach'],
    delta: 0,
    progress: 25,
  })
  renderPage()
  act(() => updateSpeechPreferences({ engineEn: 'browser', autoPrompt: false }))
  await user.click(screen.getByLabelText('Написание слова: RU → EN'))
  await user.click(screen.getByRole('button', { name: 'Начать' }))
  await user.click(await screen.findByRole('button', { name: 'Показать ответ' }))
  await user.click(within(await screen.findByRole('group', { name: 'Ответ' })).getByRole('button'))
  expect(utterance.text).toBe('Poach')
  act(() => utterance.onerror?.({ error: 'synthesis-failed' } as SpeechSynthesisErrorEvent))
  expect(await screen.findByText(/Не удалось воспроизвести речь/)).toBeInTheDocument()
  expect(screen.getByRole('group', { name: 'Ответ' })).toHaveTextContent('Poach')
  expect(screen.getByText(/прогресс 25%/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Далее' })).toBeEnabled()
  expect(api.revealAnswer).toHaveBeenCalledOnce()
  expect(api.answerText).not.toHaveBeenCalled()
  expect(api.finishTraining).not.toHaveBeenCalled()
})

it('keeps choice answer playback keyboard activation separate from Next', async () => {
  const user = userEvent.setup()
  renderPage()
  await user.click(screen.getByRole('button', { name: 'Начать' }))
  await user.click(await screen.findByRole('button', { name: 'cat' }))
  const answer = await screen.findByRole('group', { name: 'Ответ' })
  const playback = within(answer).getByRole('button', { name: 'Произнести EN «cat»' })
  playback.focus()
  await user.keyboard(' ')
  expect(screen.getByText('1 / 2')).toBeInTheDocument()
  expect(speak).toHaveBeenLastCalledWith('cat', 'en')
  await user.keyboard('{Enter}')
  expect(screen.getByText('1 / 2')).toBeInTheDocument()
  expect(api.answer).toHaveBeenCalledOnce()
  screen.getByRole('button', { name: 'Далее' }).focus()
  await user.keyboard(' ')
  expect(screen.getByText('2 / 2')).toBeInTheDocument()
})
