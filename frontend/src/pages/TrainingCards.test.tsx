import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api, type CardAnswerResult, type CardRevealResult } from '../api'
import { TrainingPage } from './TrainingPage'

vi.mock('../api', async (original) => {
  const actual = await original<typeof import('../api')>()
  return { ...actual, api: { startTraining: vi.fn(), revealCard: vi.fn(), answerCard: vi.fn() } }
})

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <TrainingPage />
    </QueryClientProvider>,
  )
}

describe('карточки', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(api.startTraining).mockResolvedValue({
      id: 's',
      mode: 'cards',
      direction: 'en_ru',
      items: [{ id: 'i1', prompt: 'cat', options: [] }],
    })
  })

  it('раскрывает и оценивает карточку только после ответов сервера', async () => {
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
    renderPage()
    await user.click(screen.getByLabelText('Карточки: EN → RU'))
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    expect(await screen.findByText('cat')).toBeInTheDocument()
    expect(api.startTraining).toHaveBeenCalledWith('en_ru', 10, 'cards')
    expect(screen.queryByText('кот')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Хорошо' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Показать ответ' }))
    expect(screen.getByRole('button', { name: 'Показать ответ' })).toBeDisabled()
    expect(api.revealCard).toHaveBeenCalledOnce()
    await act(async () => finishReveal({ expected_answers: ['кот', 'кошка'] }))
    expect(await screen.findByText('Ответ: кот, кошка')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Хорошо' }))
    expect(api.answerCard).toHaveBeenCalledWith('i1', 'good')
    for (const label of ['Повторить', 'Трудно', 'Хорошо', 'Легко'])
      expect(screen.getByRole('button', { name: label })).toBeDisabled()
    await act(async () =>
      finishAnswer({ grade: 'good', expected_answers: ['кот', 'кошка'], delta: 4, progress: 4 }),
    )
    expect(await screen.findByRole('status')).toHaveTextContent('Хорошо (+4) · прогресс 4%')
    expect(screen.getByRole('button', { name: 'Хорошо' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Далее' }))
    expect(await screen.findByText('Оценено карточек: 1')).toBeInTheDocument()
    expect(screen.queryByText(/Верно|правильн/i)).not.toBeInTheDocument()
  })

  it('позволяет повторить раскрытие и самооценку после сетевой ошибки', async () => {
    const user = userEvent.setup()
    vi.mocked(api.startTraining).mockResolvedValue({
      id: 's',
      mode: 'cards',
      direction: 'ru_en',
      items: [{ id: 'i2', prompt: 'кот', options: [] }],
    })
    vi.mocked(api.revealCard)
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce({ expected_answers: ['cat'] })
    vi.mocked(api.answerCard)
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce({ grade: 'hard', expected_answers: ['cat'], delta: 0, progress: 3 })
    renderPage()
    await user.click(screen.getByLabelText('Карточки: RU → EN'))
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    expect(await screen.findByText('кот')).toBeInTheDocument()
    expect(api.startTraining).toHaveBeenCalledWith('ru_en', 10, 'cards')
    await user.click(screen.getByRole('button', { name: 'Показать ответ' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Нет связи с сервером')
    expect(screen.queryByText('Ответ: cat')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Показать ответ' }))
    expect(await screen.findByText('Ответ: cat')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Трудно' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Нет связи с сервером')
    expect(screen.getByRole('button', { name: 'Трудно' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Трудно' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Трудно (0) · прогресс 3%')
    expect(api.answerCard).toHaveBeenCalledTimes(2)
  })

  it('объясняет, что для карточек достаточно одного слова', async () => {
    vi.mocked(api.startTraining).mockRejectedValue(new ApiError(409, 'not_enough_words'))
    renderPage()
    const user = userEvent.setup()
    await user.click(screen.getByLabelText('Карточки: EN → RU'))
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Добавьте хотя бы одно слово')
  })
})
