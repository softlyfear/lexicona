import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { TrainingPage } from './TrainingPage'

vi.mock('../api', async (original) => {
  const actual = await original<typeof import('../api')>()
  return {
    ...actual,
    api: {
      startTraining: vi.fn(),
      listTags: () => Promise.resolve([]),
      answer: vi.fn(),
      answerText: vi.fn(),
      answerCard: vi.fn(),
      revealCard: vi.fn(),
      revealAnswer: vi.fn(),
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

describe('недоступное задание', () => {
  beforeEach(() => vi.resetAllMocks())

  it.each([
    ['choice', 'en_ru', 'Поиск перевода: EN → RU'],
    ['input', 'ru_en', 'Написание слова: RU → EN'],
    ['cards', 'en_ru', 'Карточки: EN → RU'],
  ] as const)(
    '%s не засчитывает unavailable как ответ или пропуск',
    async (mode, direction, label) => {
      vi.mocked(api.startTraining).mockResolvedValue({
        id: 's',
        purpose: 'free',
        mode,
        direction,
        items: [
          { id: 'i', prompt: 'The ____', options: mode === 'choice' ? ['a', 'b', 'c', 'd'] : [] },
        ],
      })
      vi.mocked(api.skipItem).mockResolvedValue({
        outcome: 'unavailable',
        reason: 'training_state_changed',
        delta: 0,
        progress: 158,
      })
      const user = userEvent.setup()
      renderPage()
      await user.click(screen.getByLabelText(label))
      await user.click(screen.getByRole('button', { name: 'Начать' }))
      expect(await screen.findByText('The ____')).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Пропустить' }))
      const status = await screen.findByRole('status')
      expect(status).toHaveTextContent(
        'Задание недоступно: слово исключалось из обучения (0) · прогресс 158%',
      )
      expect(status).not.toHaveTextContent('Ответ:')
      expect(screen.getByRole('button', { name: 'Пропустить' })).toBeDisabled()
      await user.click(screen.getByRole('button', { name: 'Далее' }))
      expect(await screen.findByText('Недоступно: 1')).toBeInTheDocument()
      expect(screen.getByText('Пропущено: 0')).toBeInTheDocument()
      if (mode === 'cards') expect(screen.getByText('Оценено карточек: 0')).toBeInTheDocument()
      else {
        expect(screen.getByText('С помощью: 0')).toBeInTheDocument()
        expect(screen.getByText('Верно: 0 · Неверно: 0')).toBeInTheDocument()
        expect(screen.queryByText('0 из 0')).not.toBeInTheDocument()
      }
    },
  )

  it('закрывает ранее раскрытую карточку без повторного показа ответа после исключения', async () => {
    vi.mocked(api.startTraining).mockResolvedValue({
      id: 's',
      purpose: 'free',
      mode: 'cards',
      direction: 'en_ru',
      items: [{ id: 'i', prompt: 'cat', options: [] }],
    })
    vi.mocked(api.revealCard).mockResolvedValue({ outcome: 'revealed', expected_answers: ['кот'] })
    vi.mocked(api.answerCard).mockResolvedValue({
      outcome: 'unavailable',
      reason: 'training_state_changed',
      delta: 0,
      progress: 50,
    })
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByLabelText('Карточки: EN → RU'))
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    await screen.findByText('cat')
    await user.click(screen.getByRole('button', { name: 'Показать ответ' }))
    expect(await screen.findByRole('group', { name: 'Ответ карточки' })).toHaveTextContent('кот')
    await user.click(screen.getByRole('button', { name: 'Хорошо' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Задание недоступно')
    expect(screen.queryByRole('group', { name: 'Ответ карточки' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Хорошо' })).not.toBeInTheDocument()
  })
})
