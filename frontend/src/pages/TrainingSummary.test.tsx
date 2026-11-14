import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { api, type ResumedSession, type TrainingSummary as Summary } from '../api'
import { MatchingRun } from './MatchingRun'
import { Run } from './TrainingPage'
import { TrainingSummary } from './TrainingSummary'
import { summaryFixture } from './trainingSummaryFixture'

vi.mock('../api', async (original) => {
  const actual = await original<typeof import('../api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      trainingSummary: vi.fn(),
      answer: vi.fn(),
      answerText: vi.fn(),
      revealAnswer: vi.fn(),
      skipItem: vi.fn(),
    },
  }
})

function renderWithClient(element: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>)
}

beforeEach(() => vi.resetAllMocks())

it('loads authoritative results, retries once from the keyboard and keeps finish available', async () => {
  let resolve!: (data: Summary) => void
  vi.mocked(api.trainingSummary)
    .mockRejectedValueOnce(new TypeError('offline'))
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
  const finish = vi.fn()
  const user = userEvent.setup()
  renderWithClient(<TrainingSummary sessionId="s" onFinish={finish} finishing={false} />)
  expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось загрузить итоги')
  expect(screen.queryByText(/Верно:/)).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Завершить' })).toBeEnabled()
  screen.getByRole('button', { name: 'Повторить' }).focus()
  await user.keyboard('{Enter}{Enter}')
  expect(api.trainingSummary).toHaveBeenCalledTimes(2)
  expect(screen.getByRole('status')).toHaveTextContent('Загружаем итоги')
  expect(screen.getByRole('button', { name: 'Завершить' })).toBeEnabled()
  await act(async () =>
    resolve(
      summaryFixture(
        { answered: 2 },
        {
          correct: 1,
          incorrect: 1,
          accuracy_percent: 50,
        },
      ),
    ),
  )
  expect(await screen.findByText('Точность: 50%')).toBeInTheDocument()
  expect(screen.getByRole('region', { name: 'Первые ответы' })).toHaveTextContent(
    'Верно: 1 · Неверно: 1',
  )
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  screen.getByRole('button', { name: 'Завершить' }).focus()
  await user.keyboard('{Enter}')
  expect(finish).toHaveBeenCalledOnce()
})

it('allows finishing while loading, and disables repeated finish while finishing', async () => {
  vi.mocked(api.trainingSummary).mockReturnValue(new Promise(() => {}))
  const finish = vi.fn()
  const view = renderWithClient(
    <TrainingSummary sessionId="s" onFinish={finish} finishing={false} />,
  )
  expect(screen.getByRole('status')).toHaveTextContent('Загружаем итоги')
  await userEvent.click(screen.getByRole('button', { name: 'Завершить' }))
  expect(finish).toHaveBeenCalledOnce()
  view.unmount()
  renderWithClient(<TrainingSummary sessionId="s" onFinish={finish} finishing />)
  expect(screen.getByRole('button', { name: 'Завершить' })).toBeDisabled()
})

it.each(['choice', 'input', 'matching'] as const)(
  '%s preserves resumed first error after correction, reveal or skip',
  async (mode) => {
    const user = userEvent.setup()
    const session: ResumedSession = {
      id: 's',
      mode,
      direction: 'en_ru',
      purpose: 'free',
      status: 'active',
      created_at: '',
      finished_at: null,
      requested_size: 3,
      items: ['cat', 'dog', 'fox'].map((prompt, index) => ({
        id: `i${index}`,
        prompt,
        options: mode === 'input' ? [] : ['кот', 'пёс', 'лиса'],
        state: 'retryable',
        result: { outcome: 'retryable', correct: false, chosen_option: 2, delta: -4, progress: 0 },
      })),
    }
    vi.mocked(api.answer).mockResolvedValue({
      outcome: 'answered',
      correct: true,
      correct_option: 0,
      chosen_option: 0,
      delta: 0,
      progress: 0,
    })
    vi.mocked(api.answerText).mockResolvedValue({
      outcome: 'answered',
      correct: true,
      submitted_text: 'кот',
      expected_answers: ['кот'],
      delta: 0,
      progress: 0,
    })
    vi.mocked(api.revealAnswer).mockResolvedValue({
      outcome: 'assisted',
      expected_answers: ['пёс'],
      correct_option: 1,
      delta: 0,
      progress: 0,
    })
    vi.mocked(api.skipItem).mockResolvedValue({ outcome: 'skipped', delta: 0, progress: 0 })
    vi.mocked(api.trainingSummary).mockResolvedValue(
      summaryFixture(
        { answered: 1, assisted: 1, skipped: 1 },
        { incorrect: 3, accuracy_percent: 0 },
      ),
    )
    renderWithClient(
      mode === 'matching' ? (
        <MatchingRun session={session} requestedSize={3} onFinish={() => {}} />
      ) : (
        <Run session={session} requestedSize={3} onFinish={() => {}} />
      ),
    )
    if (mode === 'matching') await user.click(screen.getByRole('button', { name: 'cat' }))
    if (mode === 'input')
      await user.type(screen.getByRole('textbox', { name: 'Введите перевод' }), 'кот{Enter}')
    else {
      const group =
        mode === 'matching'
          ? within(screen.getByRole('group', { name: 'Русские переводы' }))
          : screen
      await user.click(group.getByRole('button', { name: /кот/ }))
    }
    if (mode === 'matching') await user.click(screen.getByRole('button', { name: 'dog' }))
    else await user.click(screen.getByRole('button', { name: 'Далее' }))
    await user.click(screen.getByRole('button', { name: 'Показать ответ' }))
    if (mode === 'matching') await user.click(screen.getByRole('button', { name: 'fox' }))
    else await user.click(screen.getByRole('button', { name: 'Далее' }))
    await user.click(screen.getByRole('button', { name: 'Пропустить' }))
    await user.click(
      screen.getByRole('button', { name: mode === 'matching' ? 'Завершить занятие' : 'Далее' }),
    )
    expect(await screen.findByText('Верно: 0 · Неверно: 3')).toBeInTheDocument()
    expect(screen.getByText('Точность: 0%')).toBeInTheDocument()
    expect(screen.getByText('С ответом: 1')).toBeInTheDocument()
    expect(screen.getByText('С помощью: 1')).toBeInTheDocument()
    expect(screen.getByText('Пропущено: 1')).toBeInTheDocument()
    expect(api.trainingSummary).toHaveBeenCalledExactlyOnceWith('s')
  },
)

it.each(['choice', 'matching'] as const)(
  '%s does not invent legacy first answers from terminal results',
  async (mode) => {
    const session: ResumedSession = {
      id: 's',
      mode,
      direction: 'en_ru',
      purpose: 'free',
      status: 'active',
      created_at: '',
      finished_at: null,
      requested_size: 1,
      items: [
        {
          id: 'i',
          prompt: 'cat',
          options: ['кот'],
          state: 'done',
          result: {
            outcome: 'answered',
            correct: true,
            correct_option: 0,
            chosen_option: 0,
            delta: 0,
            progress: 0,
          },
        },
      ],
    }
    vi.mocked(api.trainingSummary).mockResolvedValue(
      summaryFixture({ answered: 1 }, { unknown: 1 }),
    )
    renderWithClient(
      mode === 'matching' ? (
        <MatchingRun session={session} requestedSize={1} onFinish={() => {}} />
      ) : (
        <Run session={session} requestedSize={1} onFinish={() => {}} />
      ),
    )
    expect(await screen.findByText('Неизвестно: 1')).toBeInTheDocument()
    expect(screen.getByText('Точность: неизвестна')).toBeInTheDocument()
    expect(screen.getByText('Верно: 0 · Неверно: 0')).toBeInTheDocument()
    expect(screen.queryByText('1 из 1')).not.toBeInTheDocument()
  },
)
