import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, type TrainingSession } from '../api'
import { TrainingPage } from './TrainingPage'

vi.mock('../api', async (original) => {
  const actual = await original<typeof import('../api')>()
  return {
    ...actual,
    api: {
      startTraining: vi.fn(),
      listTags: () => Promise.resolve([]),
      answer: vi.fn(),
      revealAnswer: vi.fn(),
      skipItem: vi.fn(),
    },
  }
})

const twoItems: TrainingSession = {
  id: 's',
  purpose: 'free',
  mode: 'matching',
  direction: 'en_ru',
  items: [
    { id: 'cat', prompt: 'cat', options: ['кот', 'собака'] },
    { id: 'dog', prompt: 'dog', options: ['кот', 'собака'] },
  ],
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <TrainingPage />
    </QueryClientProvider>,
  )
}

async function start(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByLabelText('Сопоставление пар: EN → RU'))
  await user.click(screen.getByRole('button', { name: 'Начать' }))
  return within(await screen.findByRole('group', { name: 'Русские переводы' }))
}

describe('сопоставление пар', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(api.startTraining).mockResolvedValue(twoItems)
  })

  it('показывает восемь пар и затем оставшиеся две', async () => {
    const user = userEvent.setup()
    const items = Array.from({ length: 10 }, (_, index) => ({
      id: `i${index}`,
      prompt: `word${index}`,
      options: Array.from(
        { length: index < 8 ? 8 : 2 },
        (_, option) => `перевод${index < 8 ? option : option + 8}`,
      ),
    }))
    vi.mocked(api.startTraining).mockResolvedValue({ ...twoItems, items })
    vi.mocked(api.skipItem).mockResolvedValue({ outcome: 'skipped', delta: 0, progress: 0 })
    renderPage()
    await start(user)
    expect(
      within(screen.getByRole('group', { name: 'Английские слова' })).getAllByRole('button'),
    ).toHaveLength(8)
    expect(
      within(screen.getByRole('group', { name: 'Русские переводы' })).getAllByRole('button'),
    ).toHaveLength(8)
    for (let index = 0; index < 8; index++) {
      await user.click(screen.getByRole('button', { name: `word${index}` }))
      await user.click(screen.getByRole('button', { name: 'Пропустить' }))
    }
    await user.click(await screen.findByRole('button', { name: 'Следующая группа' }))
    expect(screen.getByText('Группа 2 / 2')).toBeInTheDocument()
    expect(
      within(screen.getByRole('group', { name: 'Английские слова' })).getAllByRole('button'),
    ).toHaveLength(2)
    expect(
      within(screen.getByRole('group', { name: 'Русские переводы' })).getAllByRole('button'),
    ).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'word8' })).toBeInTheDocument()
  })

  it('сопоставляет две колонки и разрешает исправление без второго штрафа', async () => {
    const user = userEvent.setup()
    vi.mocked(api.answer)
      .mockResolvedValueOnce({
        outcome: 'answered',
        correct: false,
        correct_option: 0,
        chosen_option: 1,
        delta: -4,
        progress: 46,
      })
      .mockResolvedValueOnce({
        outcome: 'answered',
        correct: true,
        correct_option: 0,
        chosen_option: 0,
        delta: 0,
        progress: 46,
      })
      .mockResolvedValueOnce({
        outcome: 'answered',
        correct: true,
        correct_option: 1,
        chosen_option: 1,
        delta: 4,
        progress: 4,
      })
    renderPage()
    const translations = await start(user)
    expect(api.startTraining).toHaveBeenCalledWith('en_ru', 10, 'matching', undefined, 'free', true)

    await user.click(translations.getByRole('button', { name: 'кот' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Сначала выберите английское слово')
    expect(api.answer).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'cat' }))
    await user.click(translations.getByRole('button', { name: 'собака' }))
    expect(api.answer).toHaveBeenCalledWith('cat', 1)
    expect(await screen.findByRole('status')).toHaveTextContent('Неверно (-4) · прогресс 46%')
    expect(screen.getByRole('status')).toHaveTextContent('Повторного штрафа не будет')
    expect(screen.queryByText('Ответ: кот')).not.toBeInTheDocument()

    await user.click(translations.getByRole('button', { name: 'кот' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Верно (0) · прогресс 46%')
    expect(screen.getByRole('button', { name: 'cat' })).toBeDisabled()
    expect(translations.getByRole('button', { name: 'кот' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'dog' }))
    await user.click(translations.getByRole('button', { name: 'собака' }))
    await user.click(await screen.findByRole('button', { name: 'Завершить занятие' }))
    expect(await screen.findByText('2 из 2')).toBeInTheDocument()
    expect(api.answer).toHaveBeenCalledTimes(3)
  })

  it('переходит между группами и учитывает reveal/skip без дополнительного ответа', async () => {
    const user = userEvent.setup()
    const items = [
      { id: 'cat', prompt: 'cat', options: ['кот', 'собака', 'лиса', 'сова'] },
      { id: 'dog', prompt: 'dog', options: ['кот', 'собака', 'лиса', 'сова'] },
      { id: 'fox', prompt: 'fox', options: ['кот', 'собака', 'лиса', 'сова'] },
      { id: 'owl', prompt: 'owl', options: ['кот', 'собака', 'лиса', 'сова'] },
      { id: 'wolf', prompt: 'wolf', options: ['волк'] },
    ]
    vi.mocked(api.startTraining).mockResolvedValue({ ...twoItems, items })
    vi.mocked(api.revealAnswer).mockResolvedValue({
      outcome: 'assisted',
      expected_answers: ['кот'],
      correct_option: 0,
      delta: 0,
      progress: 50,
    })
    vi.mocked(api.skipItem).mockResolvedValue({ outcome: 'skipped', delta: 0, progress: 50 })
    vi.mocked(api.answer).mockImplementation(async (id, option) => ({
      outcome: 'answered',
      correct: true,
      correct_option: option,
      chosen_option: option,
      delta: 4,
      progress: id === 'cat' ? 54 : 4,
    }))
    renderPage()
    await start(user)

    await user.click(screen.getByRole('button', { name: 'cat' }))
    await user.click(screen.getByRole('button', { name: 'Показать ответ' }))
    expect(api.revealAnswer).toHaveBeenCalledWith('cat')
    expect(await screen.findByRole('status')).toHaveTextContent('Ответ: кот')
    await user.click(screen.getByRole('button', { name: 'dog' }))
    await user.click(screen.getByRole('button', { name: 'Пропустить' }))
    expect(api.skipItem).toHaveBeenCalledWith('dog')

    const translations = screen.getByRole('group', { name: 'Русские переводы' })
    for (const [word, option] of [
      ['fox', 'лиса'],
      ['owl', 'сова'],
    ]) {
      await user.click(screen.getByRole('button', { name: word }))
      await user.click(within(translations).getByRole('button', { name: option }))
    }
    await user.click(await screen.findByRole('button', { name: 'Следующая группа' }))
    expect(screen.getByText('Группа 2 / 2')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'wolf' }))
    await user.click(screen.getByRole('button', { name: 'волк' }))
    await user.click(await screen.findByRole('button', { name: 'Завершить занятие' }))
    expect(await screen.findByText('3 из 3')).toBeInTheDocument()
    expect(screen.getByText('С помощью: 1')).toBeInTheDocument()
    expect(screen.getByText('Пропущено: 1')).toBeInTheDocument()
    expect(api.answer).toHaveBeenCalledTimes(3)
  })

  it('блокирует действия при запросе и позволяет повторить после сетевой ошибки', async () => {
    const user = userEvent.setup()
    let rejectAnswer!: (error: Error) => void
    vi.mocked(api.answer)
      .mockImplementationOnce(() => new Promise((_, reject) => (rejectAnswer = reject)))
      .mockResolvedValueOnce({
        outcome: 'answered',
        correct: true,
        correct_option: 0,
        chosen_option: 0,
        delta: 4,
        progress: 4,
      })
    renderPage()
    const translations = await start(user)
    await user.click(screen.getByRole('button', { name: 'cat' }))
    await user.click(translations.getByRole('button', { name: 'кот' }))
    expect(screen.getByRole('status')).toHaveTextContent('Проверяем')
    expect(screen.getByRole('button', { name: 'dog' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Пропустить' })).toBeDisabled()
    await user.click(translations.getByRole('button', { name: 'кот' }))
    expect(api.answer).toHaveBeenCalledTimes(1)
    await act(async () => rejectAnswer(new Error('Сеть недоступна')))
    expect(await screen.findByRole('alert')).toHaveTextContent('Попробуйте ещё раз')
    await user.click(translations.getByRole('button', { name: 'кот' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Верно')
    expect(api.answer).toHaveBeenCalledTimes(2)
  })

  it('работает с клавиатуры и учитывает недоступное задание', async () => {
    const user = userEvent.setup()
    vi.mocked(api.answer)
      .mockResolvedValueOnce({
        outcome: 'unavailable',
        reason: 'training_state_changed',
        delta: 0,
        progress: 0,
      })
      .mockResolvedValueOnce({
        outcome: 'answered',
        correct: true,
        correct_option: 1,
        chosen_option: 1,
        delta: 4,
        progress: 4,
      })
    renderPage()
    await start(user)
    screen.getByRole('button', { name: 'cat' }).focus()
    await user.keyboard('{Enter}')
    screen.getByRole('button', { name: 'кот' }).focus()
    await user.keyboard(' ')
    expect(await screen.findByRole('status')).toHaveTextContent('Задание недоступно')
    screen.getByRole('button', { name: 'dog' }).focus()
    await user.keyboard('{Enter}')
    screen.getByRole('button', { name: 'собака' }).focus()
    await user.keyboard('{Enter}')
    const finish = await screen.findByRole('button', { name: 'Завершить занятие' })
    finish.focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByText('1 из 1')).toBeInTheDocument()
    expect(screen.getByText('Недоступно: 1')).toBeInTheDocument()
  })
})
