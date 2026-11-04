import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { api, type ResumedSession } from '../api'
import { TrainingPage } from './TrainingPage'

vi.mock('../api', async (original) => {
  const actual = await original<typeof import('../api')>()
  return {
    ...actual,
    api: {
      latestTraining: vi.fn(),
      finishTraining: vi.fn(),
      listTags: () => Promise.resolve([]),
      answer: vi.fn(),
    },
  }
})
const base: ResumedSession = {
  id: 's',
  mode: 'choice',
  direction: 'en_ru',
  purpose: 'free',
  status: 'active',
  created_at: '',
  finished_at: null,
  requested_size: 2,
  items: [
    {
      id: 'a',
      prompt: 'cat',
      options: ['кот', 'пёс'],
      state: 'done',
      result: {
        outcome: 'answered',
        correct: true,
        correct_option: 0,
        chosen_option: 0,
        delta: 4,
        progress: 4,
      },
    },
    {
      id: 'b',
      prompt: 'dog',
      options: ['кот', 'пёс'],
      state: 'retryable',
      result: { outcome: 'retryable', correct: false, chosen_option: 0, delta: -4, progress: 0 },
    },
  ],
}
function page() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <TrainingPage />
    </QueryClientProvider>,
  )
}
beforeEach(() => vi.resetAllMocks())

it('восстанавливает неверную попытку без правильного ответа и завершает только после запроса', async () => {
  vi.mocked(api.latestTraining).mockResolvedValue(base)
  vi.mocked(api.finishTraining)
    .mockRejectedValueOnce(new TypeError('offline'))
    .mockResolvedValueOnce({ id: 's', status: 'finished', finished_at: '' })
  const user = userEvent.setup()
  page()
  await user.click(await screen.findByRole('button', { name: 'Продолжить' }))
  expect(screen.getByText('dog')).toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('Неверно')
  expect(screen.queryByText(/Правильный ответ/)).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Завершить' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось завершить занятие')
  expect(screen.getByText('dog')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Завершить' }))
  expect(await screen.findByRole('button', { name: 'Начать' })).toBeInTheDocument()
  expect(api.finishTraining).toHaveBeenCalledTimes(2)
})

it('не скрывает ошибку загрузки последнего занятия и позволяет повторить', async () => {
  vi.mocked(api.latestTraining)
    .mockRejectedValueOnce(new TypeError('offline'))
    .mockResolvedValueOnce(null)
  page()
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Не удалось загрузить последнее занятие',
  )
  expect(screen.queryByRole('button', { name: 'Начать' })).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Повторить' }))
  expect(await screen.findByRole('button', { name: 'Начать' })).toBeInTheDocument()
})

it('восстанавливает частичную группу matching и удалённое слово без null процентов', async () => {
  vi.mocked(api.latestTraining).mockResolvedValue({
    ...base,
    mode: 'matching',
    items: [
      {
        ...base.items[0],
        state: 'done',
        result: { outcome: 'unavailable', reason: 'word_deleted', delta: 0, progress: null },
      },
      base.items[1],
    ],
  })
  page()
  await userEvent.click(await screen.findByRole('button', { name: 'Продолжить' }))
  const english = within(screen.getByRole('group', { name: 'Английские слова' }))
  expect(english.getByRole('button', { name: 'cat' })).toBeDisabled()
  await userEvent.click(english.getByRole('button', { name: 'dog' }))
  expect(screen.getByRole('status')).toHaveTextContent('Неверно')
  expect(screen.getByRole('status')).not.toHaveTextContent('null%')
})

it('переходит к первой незавершённой группе из восьми и сохраняет неверную попытку', async () => {
  const items: ResumedSession['items'] = Array.from({ length: 10 }, (_, index) => {
    const options = Array.from({ length: index < 8 ? 8 : 2 }, (_, n) => `вариант ${n}`)
    return index < 8
      ? {
          id: `${index}`,
          prompt: `word ${index}`,
          options,
          state: 'done',
          result: {
            outcome: 'answered',
            correct: true,
            correct_option: index,
            chosen_option: index,
            delta: 4,
            progress: 4,
          },
        }
      : {
          id: `${index}`,
          prompt: `word ${index}`,
          options,
          state: index === 8 ? 'retryable' : 'open',
          result:
            index === 8
              ? { outcome: 'retryable', correct: false, chosen_option: 0, delta: -4, progress: 0 }
              : null,
        }
  })
  vi.mocked(api.latestTraining).mockResolvedValue({ ...base, mode: 'matching', items })
  page()
  await userEvent.click(await screen.findByRole('button', { name: 'Продолжить' }))
  expect(screen.getByText('Группа 2 / 2')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'word 0' })).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'word 8' }))
  expect(screen.getByRole('status')).toHaveTextContent('Неверно')
})

it('не предлагает продолжение завершённого последнего занятия', async () => {
  vi.mocked(api.latestTraining).mockResolvedValue({ ...base, status: 'finished' })
  page()
  expect(await screen.findByRole('button', { name: 'Начать' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Продолжить' })).not.toBeInTheDocument()
})

it.each(['cards', 'cloze'] as const)(
  'не предлагает продолжать старый режим %s, но позволяет завершить',
  async (mode) => {
    vi.mocked(api.latestTraining).mockResolvedValue({ ...base, mode })
    vi.mocked(api.finishTraining).mockResolvedValue({
      id: 's',
      status: 'finished',
      finished_at: '',
    })
    page()
    expect(await screen.findByText(/Этот режим больше недоступен/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Продолжить' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Завершить и начать новое' }))
    expect(await screen.findByRole('button', { name: 'Начать' })).toBeInTheDocument()
    expect(api.finishTraining).toHaveBeenCalledWith('s')
  },
)

it('позволяет завершить повреждённый снимок без попытки продолжения', async () => {
  vi.mocked(api.latestTraining).mockResolvedValue({
    ...base,
    mode: 'matching',
    items: [],
    resume_error: 'invalid_matching_snapshot',
  })
  vi.mocked(api.finishTraining).mockResolvedValue({ id: 's', status: 'finished', finished_at: '' })
  page()
  expect(await screen.findByText(/повреждённых данных/)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Продолжить' })).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Завершить и начать новое' }))
  expect(await screen.findByRole('button', { name: 'Начать' })).toBeInTheDocument()
  expect(api.finishTraining).toHaveBeenCalledWith('s')
})
