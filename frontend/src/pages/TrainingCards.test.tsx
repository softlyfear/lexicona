import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, type CardAnswerResult, type CardRevealResult, type TrainingSession } from '../api'
import { Run } from './TrainingPage'
import { summaryFixture } from './trainingSummaryFixture'

vi.mock('../api', async (original) => {
  const actual = await original<typeof import('../api')>()
  return {
    ...actual,
    api: {
      startTraining: vi.fn(),
      trainingSummary: vi.fn(),
      previewTraining: () =>
        Promise.resolve({
          count: 10,
          selection_seed: '0123456789abcdef0123456789abcdef',
          unavailable_reason: null,
        }),
      latestTraining: () => Promise.resolve(null),
      finishTraining: () => Promise.resolve({ id: 's', status: 'finished', finished_at: '' }),
      listTags: () => Promise.resolve([]),
      revealCard: vi.fn(),
      answerCard: vi.fn(),
    },
  }
})

function renderPage(session: TrainingSession) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['training', 'latest'], null)
  return render(
    <QueryClientProvider client={client}>
      <Run session={session} requestedSize={10} onFinish={() => {}} />
    </QueryClientProvider>,
  )
}

describe('карточки', () => {
  beforeEach(() => vi.resetAllMocks())

  it('раскрывает и оценивает карточку только после ответов сервера', async () => {
    vi.mocked(api.trainingSummary).mockResolvedValue(
      summaryFixture({ answered: 1 }, { not_applicable: 1 }),
    )
    const user = userEvent.setup()
    let finishReveal!: (value: CardRevealResult) => void
    let finishAnswer!: (value: CardAnswerResult) => void
    vi.mocked(api.revealCard).mockReturnValue(
      new Promise((resolve) => {
        finishReveal = resolve
      }),
    )
    vi.mocked(api.answerCard).mockReturnValue(
      new Promise((resolve) => {
        finishAnswer = resolve
      }),
    )
    renderPage({
      id: 's',
      purpose: 'free',
      mode: 'cards',
      direction: 'en_ru',
      items: [{ id: 'i1', prompt: 'cat', options: [] }],
    })
    expect(await screen.findByText('cat')).toBeInTheDocument()
    expect(screen.queryByText('кот')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Хорошо' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Показать ответ' }))
    expect(screen.getByRole('button', { name: 'Показать ответ' })).toBeDisabled()
    expect(api.revealCard).toHaveBeenCalledOnce()
    await act(async () => finishReveal({ outcome: 'revealed', expected_answers: ['кот', 'кошка'] }))
    expect(await screen.findByRole('group', { name: 'Ответ карточки' })).toHaveTextContent(
      'кот, кошка',
    )
    expect(screen.getByRole('button', { name: 'Произнести RU «кот, кошка»' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Хорошо' }))
    expect(api.answerCard).toHaveBeenCalledWith('i1', 'good')
    for (const label of ['Повторить', 'Трудно', 'Хорошо', 'Легко'])
      expect(screen.getByRole('button', { name: label })).toBeDisabled()
    await act(async () =>
      finishAnswer({
        outcome: 'answered',
        grade: 'good',
        expected_answers: ['кот', 'кошка'],
        delta: 4,
        progress: 4,
      }),
    )
    expect(await screen.findByRole('status')).toHaveTextContent('Хорошо (+4) · прогресс 4%')
    expect(screen.getByRole('button', { name: 'Хорошо' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Далее' }))
    expect(await screen.findByText('С ответом: 1')).toBeInTheDocument()
    expect(screen.getByText('Не применяется: 1')).toBeInTheDocument()
    expect(screen.getByText('Точность: неизвестна')).toBeInTheDocument()
  })

  it('позволяет повторить раскрытие и самооценку после сетевой ошибки', async () => {
    const user = userEvent.setup()
    const session: TrainingSession = {
      id: 's',
      purpose: 'free',
      mode: 'cards',
      direction: 'ru_en',
      items: [{ id: 'i2', prompt: 'кот', options: [] }],
    }
    vi.mocked(api.revealCard)
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce({ outcome: 'revealed', expected_answers: ['cat'] })
    vi.mocked(api.answerCard)
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce({
        outcome: 'answered',
        grade: 'hard',
        expected_answers: ['cat'],
        delta: 0,
        progress: 3,
      })
    renderPage(session)
    expect(await screen.findByText('кот')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Показать ответ' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Нет связи с сервером')
    expect(screen.queryByRole('group', { name: 'Ответ карточки' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Показать ответ' }))
    expect(await screen.findByRole('group', { name: 'Ответ карточки' })).toHaveTextContent('cat')
    await user.click(screen.getByRole('button', { name: 'Трудно' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Нет связи с сервером')
    expect(screen.getByRole('button', { name: 'Трудно' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Трудно' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Трудно (0) · прогресс 3%')
    expect(api.answerCard).toHaveBeenCalledTimes(2)
  })
})
