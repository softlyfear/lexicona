import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { api, type TrainingPreview } from '../api'
import { TrainingPage } from './TrainingPage'

vi.mock('../api', async (original) => {
  const actual = await original<typeof import('../api')>()
  return {
    ...actual,
    api: {
      previewTraining: vi.fn(),
      startTraining: vi.fn(),
      listTags: () => Promise.resolve([{ id: 'a', name: 'Дом' }]),
      latestTraining: () => Promise.resolve(null),
    },
  }
})

const seed = '0123456789abcdef0123456789abcdef'
const result = (count: number): TrainingPreview => ({
  count,
  selection_seed: seed,
  unavailable_reason: count ? null : 'no_matching_words',
})

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['training', 'latest'], null)
  render(
    <QueryClientProvider client={client}>
      <TrainingPage />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.previewTraining).mockResolvedValue(result(10))
  vi.mocked(api.startTraining).mockRejectedValue(new TypeError('offline'))
})

it('передаёт параметры предпросмотра и seed показанного результата при старте', async () => {
  const user = userEvent.setup()
  renderPage()
  expect(await screen.findByText('Слов:')).toHaveTextContent('Слов: 10')
  await user.click(await screen.findByLabelText('Дом'))
  await user.type(screen.getByLabelText('Прогресс от, %'), '12')
  await user.click(screen.getByLabelText('Сопоставление пар: EN → RU'))
  await waitFor(() =>
    expect(api.previewTraining).toHaveBeenLastCalledWith(
      'en_ru',
      10,
      'matching',
      { tag_ids: ['a'], progress_min: 12, progress_max: null },
      'free',
      true,
    ),
  )
  await waitFor(() => expect(screen.getByText('Слов:')).toHaveTextContent('10'))
  await user.click(screen.getByRole('button', { name: 'Начать' }))
  expect(api.startTraining).toHaveBeenCalledWith(
    'en_ru',
    10,
    'matching',
    { tag_ids: ['a'], progress_min: 12, progress_max: null },
    'free',
    true,
    seed,
  )
})

it('скрывает старый результат при изменении и отклоняет поздний ответ', async () => {
  let finishOld!: (value: TrainingPreview) => void
  let finishNew!: (value: TrainingPreview) => void
  vi.mocked(api.previewTraining).mockImplementation(
    (direction) =>
      new Promise((resolve) => {
        if (direction === 'en_ru') finishOld = resolve
        else finishNew = resolve
      }),
  )
  const user = userEvent.setup()
  renderPage()
  await user.click(screen.getByLabelText('Поиск слова: RU → EN'))
  expect(screen.getByRole('button', { name: 'Начать' })).toBeDisabled()
  await act(async () => finishNew(result(3)))
  await waitFor(() => expect(screen.getByText('Слов:')).toHaveTextContent('3'))
  await act(async () => finishOld(result(99)))
  expect(screen.getByText('Слов:')).not.toHaveTextContent('99')
  await user.type(screen.getByLabelText('Прогресс от, %'), '-1')
  expect(screen.getByText('Проверьте параметры')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Начать' })).toBeDisabled()
})

it('отличает ошибку от пустого результата и позволяет повторить подсчёт', async () => {
  vi.mocked(api.previewTraining)
    .mockRejectedValueOnce(new TypeError('offline'))
    .mockResolvedValueOnce(result(0))
  const user = userEvent.setup()
  renderPage()
  expect(await screen.findByText('Не удалось подсчитать')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Начать' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Повторить подсчёт' }))
  await waitFor(() => expect(screen.getByText('Слов:')).toHaveTextContent('0'))
  expect(screen.getByText(/Нет подходящих слов/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Начать' })).toBeDisabled()
})
