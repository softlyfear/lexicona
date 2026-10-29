import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api } from '../api'
import { TrainingPage } from './TrainingPage'

vi.mock('../api', async (original) => {
  const actual = await original<typeof import('../api')>()
  return { ...actual, api: { startTraining: vi.fn(), answer: vi.fn(), answerText: vi.fn() } }
})

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <TrainingPage />
    </QueryClientProvider>,
  )
}

describe('письменная тренировка', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(api.startTraining).mockResolvedValue({
      id: 's',
      mode: 'input',
      direction: 'en_ru',
      items: [
        { id: 'i1', prompt: 'cat', options: [] },
        { id: 'i2', prompt: 'dog', options: [] },
      ],
    })
  })

  it('отправляет ввод по Enter, показывает ответ сервера и итог', async () => {
    const user = userEvent.setup()
    vi.mocked(api.answerText)
      .mockResolvedValueOnce({
        correct: true,
        submitted_text: 'кот 1',
        expected_answers: ['кот', 'кошка'],
        delta: 8,
        progress: 8,
      })
      .mockResolvedValueOnce({
        correct: false,
        submitted_text: 'волк',
        expected_answers: ['собака'],
        delta: -4,
        progress: 0,
      })
    renderPage()
    await user.click(screen.getByLabelText('Написание перевода: EN → RU'))
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    const input = await screen.findByRole('textbox', { name: 'Введите перевод' })
    expect(api.startTraining).toHaveBeenCalledWith('en_ru', 10, 'input')
    expect(screen.getByRole('button', { name: 'Проверить' })).toBeDisabled()
    await user.type(input, 'кот 1')
    expect(api.answer).not.toHaveBeenCalled()
    await user.keyboard('{Enter}')
    expect(api.answerText).toHaveBeenCalledWith('i1', 'кот 1')
    expect(await screen.findByRole('status')).toHaveTextContent('Верно (+8) · прогресс 8%')
    expect(screen.getByRole('status')).toHaveTextContent('кот, кошка')
    expect(input).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Проверить' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Далее' }))
    expect(await screen.findByText('dog')).toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: 'Введите перевод' }), 'волк{Enter}')
    expect(await screen.findByRole('status')).toHaveTextContent('Неверно (-4) · прогресс 0%')
    await user.click(screen.getByRole('button', { name: 'Далее' }))
    expect(await screen.findByText('1 из 2')).toBeInTheDocument()
  })

  it('сохраняет текст после сетевой ошибки и позволяет повторить', async () => {
    const user = userEvent.setup()
    vi.mocked(api.answerText)
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce({
        correct: true,
        submitted_text: 'cat',
        expected_answers: ['cat'],
        delta: 8,
        progress: 8,
      })
    vi.mocked(api.startTraining).mockResolvedValue({
      id: 's',
      mode: 'input',
      direction: 'ru_en',
      items: [{ id: 'i', prompt: 'кот', options: [] }],
    })
    renderPage()
    await user.click(screen.getByLabelText('Написание слова: RU → EN'))
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    const input = await screen.findByRole('textbox', { name: 'Введите слово' })
    expect(api.startTraining).toHaveBeenCalledWith('ru_en', 10, 'input')
    await user.type(input, 'cat{Enter}')
    expect(await screen.findByRole('alert')).toHaveTextContent('Нет связи с сервером')
    expect(input).toHaveValue('cat')
    expect(input).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Проверить' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Верно')
    expect(api.answerText).toHaveBeenCalledTimes(2)
  })

  it('объясняет, что для ввода достаточно одного слова', async () => {
    vi.mocked(api.startTraining).mockRejectedValue(new ApiError(409, 'not_enough_words'))
    renderPage()
    const user = userEvent.setup()
    await user.click(screen.getByLabelText('Написание слова: RU → EN'))
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Добавьте хотя бы одно слово')
  })
})
