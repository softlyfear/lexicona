import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { parseTranslations } from '../words'
import { TrainingPage } from './TrainingPage'

vi.mock('../api', async (original) => {
  const actual = await original<typeof import('../api')>()
  return { ...actual, api: { startTraining: vi.fn(), answer: vi.fn() } }
})

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <TrainingPage />
    </QueryClientProvider>,
  )
}

describe('TrainingPage', () => {
  beforeEach(() => {
    vi.mocked(api.startTraining).mockResolvedValue({
      id: 's',
      mode: 'choice',
      direction: 'en_ru',
      items: [
        { id: 'i1', prompt: 'cat', options: ['собака', 'кот', 'лиса', 'сова'] },
        { id: 'i2', prompt: 'dog', options: ['собака', 'кот', 'лиса', 'сова'] },
      ],
    })
  })

  it('runs a session: answer, see feedback, finish with a score', async () => {
    const user = userEvent.setup()
    vi.mocked(api.answer)
      .mockResolvedValueOnce({
        correct: true,
        correct_option: 1,
        chosen_option: 1,
        delta: 4,
        progress: 4,
      })
      .mockResolvedValueOnce({
        correct: false,
        correct_option: 0,
        chosen_option: 2,
        delta: -4,
        progress: 0,
      })
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Начать' }))
    expect(await screen.findByText('cat')).toBeInTheDocument()
    expect(screen.getByText('1 / 2')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /кот/ }))
    expect(api.answer).toHaveBeenCalledWith('i1', 1)
    expect(await screen.findByRole('status')).toHaveTextContent('Верно (+4) · прогресс 4%')
    // Answer buttons are locked once answered.
    expect(screen.getByRole('button', { name: /собака/ })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Далее' }))
    expect(await screen.findByText('dog')).toBeInTheDocument()

    await user.keyboard('3') // keyboard shortcut for the third option
    expect(api.answer).toHaveBeenLastCalledWith('i2', 2)
    expect(await screen.findByRole('status')).toHaveTextContent('Неверно (-4)')

    await user.keyboard('{Enter}')
    expect(await screen.findByText('1 из 2')).toBeInTheDocument()
  })

  it('explains why a session cannot start', async () => {
    const { ApiError } = await import('../api')
    vi.mocked(api.startTraining).mockRejectedValue(new ApiError(409, 'not_enough_words'))
    renderPage()
    await userEvent.click(screen.getByRole('button', { name: 'Начать' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Нужно хотя бы 4 слова')
  })
})

describe('parseTranslations', () => {
  it('keeps one translation per line without blanks or repeats', () => {
    expect(parseTranslations(' кот \n\nКот\nкошка\nёж\nеж')).toEqual(['кот', 'кошка', 'ёж'])
  })
})
