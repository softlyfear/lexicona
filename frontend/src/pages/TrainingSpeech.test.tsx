import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api, type TrainingSession } from '../api'
import { Layout } from '../components/Layout'
import { forgetSession } from '../session'
import { cancelSpeech, speak } from '../speech'
import { TrainingPage } from './TrainingPage'

vi.mock('../api', async (original) => {
  const actual = await original<typeof import('../api')>()
  return {
    ...actual,
    api: { startTraining: vi.fn(), listTags: () => Promise.resolve([]), answer: vi.fn() },
  }
})
vi.mock('../speech', async (original) => {
  const actual = await original<typeof import('../speech')>()
  return { ...actual, speak: vi.fn(actual.speak) }
})

const session: TrainingSession = {
  id: 's',
  mode: 'choice',
  direction: 'ru_en',
  items: [
    { id: 'i1', prompt: 'кот', options: ['cat', 'dog', 'fox', 'owl'] },
    { id: 'i2', prompt: 'собака', options: ['cat', 'dog', 'fox', 'owl'] },
  ],
}
function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
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
  vi.mocked(api.answer).mockResolvedValue({
    outcome: 'answered',
    correct: true,
    correct_option: 0,
    chosen_option: 0,
    delta: 4,
    progress: 4,
  })
})
afterEach(() => cancelSpeech())

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
  expect(speak).toHaveBeenCalledTimes(1)
  await user.click(screen.getByRole('button', { name: 'Далее' }))
  expect(speak).toHaveBeenCalledTimes(2)
  expect(speak).toHaveBeenLastCalledWith('собака', 'ru')
  await user.click(screen.getByRole('button', { name: /cat/ }))
  await screen.findByText(/Верно/)
  await user.keyboard('{Enter}')
  expect(speak).toHaveBeenCalledTimes(2)
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
