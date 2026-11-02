import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api, type TrainingSession } from '../api'
import { TrainingPage } from './TrainingPage'

vi.mock('../api', async (original) => {
  const actual = await original<typeof import('../api')>()
  return {
    ...actual,
    api: {
      startTraining: vi.fn(),
      listTags: () => Promise.resolve([]),
      answer: vi.fn(),
      skipItem: vi.fn(),
    },
  }
})

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <TrainingPage />
    </QueryClientProvider>,
  )
}

function session(purpose: TrainingSession['purpose']): TrainingSession {
  return {
    id: 's',
    mode: 'choice',
    direction: 'en_ru',
    purpose,
    items: [{ id: 'i1', prompt: 'cat', options: ['собака', 'кот', 'лиса', 'сова'] }],
  }
}

describe('тип занятия', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(api.startTraining).mockResolvedValue(session('free'))
  })

  it('по умолчанию выбирает free, а для scheduled отправляет include_new и объясняет очередь', async () => {
    vi.mocked(api.startTraining).mockResolvedValue(session('scheduled'))
    const user = userEvent.setup()
    renderPage()

    expect(screen.getByLabelText('Свободная практика')).toBeChecked()
    expect(screen.getByLabelText('По расписанию')).not.toBeChecked()
    expect(screen.getByText('Свободная практика не меняет расписание повторений.')).toBeVisible()
    expect(screen.queryByLabelText('Включать новые слова')).not.toBeInTheDocument()

    await user.click(screen.getByLabelText('По расписанию'))
    const includeNew = screen.getByLabelText('Включать новые слова')
    expect(includeNew).toBeChecked()
    expect(screen.getByText(/Сначала — слова с наступившим сроком повторения/)).toHaveTextContent(
      'затем — до 10 новых слов',
    )
    await user.click(includeNew)
    await user.click(screen.getByRole('button', { name: 'Начать' }))

    expect(api.startTraining).toHaveBeenCalledWith(
      'en_ru',
      10,
      'choice',
      undefined,
      'scheduled',
      false,
    )
    expect(await screen.findByText('cat')).toBeInTheDocument()
  })

  it('объясняет no_scheduled_words без ложного старта и позволяет перейти к free', async () => {
    vi.mocked(api.startTraining)
      .mockRejectedValueOnce(new ApiError(409, 'no_scheduled_words'))
      .mockResolvedValueOnce(session('free'))
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByLabelText('По расписанию'))
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Сейчас нет слов для занятия по расписанию. Включите новые слова или выберите свободную практику.',
    )
    expect(screen.queryByText('cat')).not.toBeInTheDocument()

    await user.click(screen.getByLabelText('Свободная практика'))
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    expect(await screen.findByText('cat')).toBeInTheDocument()
    expect(api.startTraining).toHaveBeenLastCalledWith(
      'en_ru',
      10,
      'choice',
      undefined,
      'free',
      true,
    )
  })

  it('не засчитывает PROGRESS_CHANGED и позволяет пропустить задание и продолжить', async () => {
    vi.mocked(api.startTraining).mockResolvedValue({
      ...session('scheduled'),
      items: [
        { id: 'i1', prompt: 'cat', options: ['собака', 'кот', 'лиса', 'сова'] },
        { id: 'i2', prompt: 'dog', options: ['собака', 'кот', 'лиса', 'сова'] },
      ],
    })
    vi.mocked(api.answer).mockRejectedValue(new ApiError(409, 'PROGRESS_CHANGED'))
    vi.mocked(api.skipItem).mockResolvedValue({ outcome: 'skipped', delta: 0, progress: 20 })
    const user = userEvent.setup()
    renderPage()

    await user.click(screen.getByLabelText('По расписанию'))
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    await user.click(await screen.findByRole('button', { name: /кот/ }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Ответ не засчитан: слово изменилось в другом занятии.')
    expect(alert).toHaveTextContent('Пропустите это задание и продолжите.')
    expect(alert).not.toHaveTextContent('Попробуйте ещё раз')
    expect(screen.getByText('cat')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Далее' })).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Пропустить' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: 'Пропустить' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Пропущено (0)')
    await user.click(screen.getByRole('button', { name: 'Далее' }))
    expect(await screen.findByText('dog')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Пропустить' }))
    await user.click(await screen.findByRole('button', { name: 'Далее' }))

    expect(await screen.findByText('Верно: 0 · Неверно: 0')).toBeInTheDocument()
    expect(screen.getByText('Пропущено: 2')).toBeInTheDocument()
    expect(screen.queryByText(/из 1/)).not.toBeInTheDocument()
    expect(api.answer).toHaveBeenCalledTimes(1)
  })
})
