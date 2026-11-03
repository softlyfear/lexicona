import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, type TerminalResult } from '../api'
import { Run, TrainingPage } from './TrainingPage'

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

function renderLegacyCard(direction: 'en_ru' | 'ru_en' = 'en_ru') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Run
        session={{
          id: 's',
          purpose: 'free',
          mode: 'cards',
          direction,
          items: [{ id: 'i', prompt: 'cat', options: [] }],
        }}
        requestedSize={10}
        onFinish={() => {}}
      />
    </QueryClientProvider>,
  )
}

describe('помощь и пропуск', () => {
  beforeEach(() => vi.resetAllMocks())

  it.each([
    ['choice', 'en_ru', 'Поиск перевода: EN → RU'],
    ['choice', 'ru_en', 'Поиск слова: RU → EN'],
    ['input', 'en_ru', 'Написание перевода: EN → RU'],
    ['input', 'ru_en', 'Написание слова: RU → EN'],
  ] as const)('учитывает помощь и пропуск отдельно: %s %s', async (mode, direction, label) => {
    vi.mocked(api.startTraining).mockResolvedValue({
      id: 's',
      purpose: 'free',
      mode,
      direction,
      items: [
        { id: 'i1', prompt: 'first', options: mode === 'choice' ? ['a', 'b', 'c', 'd'] : [] },
        { id: 'i2', prompt: 'second', options: mode === 'choice' ? ['a', 'b', 'c', 'd'] : [] },
      ],
    })
    vi.mocked(api.revealAnswer).mockResolvedValue({
      outcome: 'assisted',
      expected_answers: ['b'],
      delta: 0,
      progress: 30,
      ...(mode === 'choice' ? { correct_option: 1 } : {}),
    })
    vi.mocked(api.skipItem).mockResolvedValue({ outcome: 'skipped', delta: 0, progress: 50 })
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByLabelText(label))
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    expect(await screen.findByText('first')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Показать ответ' }))
    expect(api.revealAnswer).toHaveBeenCalledWith('i1')
    expect(await screen.findByRole('status')).toHaveTextContent('С помощью (0) · прогресс 30%')
    expect(screen.getByRole('status')).toHaveTextContent('Ответ: b')
    expect(screen.getByRole('button', { name: 'Пропустить' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Далее' }))
    expect(await screen.findByText('second')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Пропустить' }))
    expect(api.skipItem).toHaveBeenCalledWith('i2')
    expect(await screen.findByRole('status')).toHaveTextContent('Пропущено (0) · прогресс 50%')
    expect(screen.getByRole('status')).not.toHaveTextContent('Ответ:')
    await user.click(screen.getByRole('button', { name: 'Далее' }))
    expect(await screen.findByText('С помощью: 1')).toBeInTheDocument()
    expect(screen.getByText('Пропущено: 1')).toBeInTheDocument()
    expect(screen.queryByText(/0 из 0|0%/)).not.toBeInTheDocument()
  })

  it('блокирует клавиатуру и другие действия до ответа сервера', async () => {
    vi.mocked(api.startTraining).mockResolvedValue({
      id: 's',
      purpose: 'free',
      mode: 'choice',
      direction: 'en_ru',
      items: [{ id: 'i', prompt: 'cat', options: ['one', 'two', 'three', 'four'] }],
    })
    let resolve!: (result: TerminalResult) => void
    vi.mocked(api.revealAnswer).mockReturnValue(
      new Promise((r) => {
        resolve = r
      }),
    )
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    await screen.findByText('cat')
    await user.click(screen.getByRole('button', { name: 'Показать ответ' }))
    expect(screen.getByRole('button', { name: 'Пропустить' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /one/ })).toBeDisabled()
    await user.keyboard('1')
    expect(api.answer).not.toHaveBeenCalled()
    await act(async () =>
      resolve({
        outcome: 'assisted',
        expected_answers: ['one'],
        correct_option: 0,
        delta: 0,
        progress: 12,
      }),
    )
    expect(await screen.findByRole('status')).toHaveTextContent('С помощью')
    await user.keyboard('2')
    expect(api.answer).not.toHaveBeenCalled()
  })

  it('показывает фактически сохранённый сервером результат, даже если действие было другим', async () => {
    vi.mocked(api.startTraining).mockResolvedValue({
      id: 's',
      purpose: 'free',
      mode: 'choice',
      direction: 'en_ru',
      items: [{ id: 'i', prompt: 'cat', options: ['one', 'two', 'three', 'four'] }],
    })
    vi.mocked(api.skipItem).mockResolvedValue({
      outcome: 'answered',
      correct: true,
      correct_option: 0,
      chosen_option: 0,
      delta: 4,
      progress: 14,
    })
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    await screen.findByText('cat')
    await user.click(screen.getByRole('button', { name: 'Пропустить' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Верно (+4)')
    await user.click(screen.getByRole('button', { name: 'Далее' }))
    expect(await screen.findByText('1 из 1')).toBeInTheDocument()
    expect(screen.getByText('Пропущено: 0')).toBeInTheDocument()
  })

  it('после сетевой ошибки помощи сохраняет ввод и позволяет повторить', async () => {
    vi.mocked(api.startTraining).mockResolvedValue({
      id: 's',
      purpose: 'free',
      mode: 'input',
      direction: 'ru_en',
      items: [{ id: 'i', prompt: 'кот', options: [] }],
    })
    vi.mocked(api.revealAnswer)
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce({
        outcome: 'assisted',
        expected_answers: ['cat'],
        delta: 0,
        progress: 20,
      })
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByLabelText('Написание слова: RU → EN'))
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    const input = await screen.findByRole('textbox', { name: 'Введите слово' })
    await user.type(input, 'ca')
    await user.click(screen.getByRole('button', { name: 'Показать ответ' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Нет связи с сервером')
    expect(input).toHaveValue('ca')
    expect(input).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Показать ответ' }))
    expect(await screen.findByRole('status')).toHaveTextContent('С помощью')
    expect(input).toHaveValue('ca')
  })

  it('после сетевой ошибки пропуска сохраняет ввод и позволяет повторить', async () => {
    vi.mocked(api.startTraining).mockResolvedValue({
      id: 's',
      purpose: 'free',
      mode: 'input',
      direction: 'ru_en',
      items: [{ id: 'i', prompt: 'кот', options: [] }],
    })
    vi.mocked(api.skipItem)
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce({ outcome: 'skipped', delta: 0, progress: 20 })
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByLabelText('Написание слова: RU → EN'))
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    const input = await screen.findByRole('textbox', { name: 'Введите слово' })
    await user.type(input, 'ca')
    await user.click(screen.getByRole('button', { name: 'Пропустить' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Нет связи с сервером')
    expect(input).toHaveValue('ca')
    expect(input).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Пропустить' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Пропущено (0)')
    expect(api.skipItem).toHaveBeenCalledTimes(2)
    expect(input).toHaveValue('ca')
  })

  it('считает самостоятельные ответы отдельно от помощи и пропусков', async () => {
    vi.mocked(api.startTraining).mockResolvedValue({
      id: 's',
      purpose: 'free',
      mode: 'input',
      direction: 'en_ru',
      items: ['cat', 'dog', 'cow', 'fox'].map((prompt, index) => ({
        id: `i${index}`,
        prompt,
        options: [],
      })),
    })
    vi.mocked(api.answerText)
      .mockResolvedValueOnce({
        outcome: 'answered',
        correct: true,
        submitted_text: 'кот',
        expected_answers: ['кот'],
        delta: 8,
        progress: 8,
      })
      .mockResolvedValueOnce({
        outcome: 'answered',
        correct: false,
        submitted_text: 'кот',
        expected_answers: ['собака'],
        delta: -4,
        progress: 0,
      })
      .mockResolvedValueOnce({
        outcome: 'answered',
        correct: true,
        submitted_text: 'собака',
        expected_answers: ['собака'],
        delta: 0,
        progress: 0,
      })
    vi.mocked(api.revealAnswer).mockResolvedValue({
      outcome: 'assisted',
      expected_answers: ['корова'],
      delta: 0,
      progress: 20,
    })
    vi.mocked(api.skipItem).mockResolvedValue({ outcome: 'skipped', delta: 0, progress: 30 })
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByLabelText('Написание перевода: EN → RU'))
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    await user.type(await screen.findByRole('textbox', { name: 'Введите перевод' }), 'кот{Enter}')
    expect(await screen.findByRole('status')).toHaveTextContent('Верно')
    await user.click(screen.getByRole('button', { name: 'Далее' }))
    await user.type(screen.getByRole('textbox', { name: 'Введите перевод' }), 'кот{Enter}')
    expect(await screen.findByRole('status')).toHaveTextContent('Неверно')
    const retry = screen.getByRole('textbox', { name: 'Введите перевод' })
    await user.clear(retry)
    await user.type(retry, 'собака{Enter}')
    expect(await screen.findByRole('status')).toHaveTextContent('Верно')
    await user.click(screen.getByRole('button', { name: 'Далее' }))
    await user.click(screen.getByRole('button', { name: 'Показать ответ' }))
    expect(await screen.findByRole('status')).toHaveTextContent('С помощью')
    await user.click(screen.getByRole('button', { name: 'Далее' }))
    await user.click(screen.getByRole('button', { name: 'Пропустить' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Пропущено')
    await user.click(screen.getByRole('button', { name: 'Далее' }))
    expect(await screen.findByText('2 из 2')).toBeInTheDocument()
    expect(screen.getByText('Верно: 2 · Неверно: 0')).toBeInTheDocument()
    expect(screen.getByText('С помощью: 1')).toBeInTheDocument()
    expect(screen.getByText('Пропущено: 1')).toBeInTheDocument()
  })

  it('карточный reveal показывает пропуск, сохранённый конкурентным запросом', async () => {
    vi.mocked(api.startTraining).mockResolvedValue({
      id: 's',
      purpose: 'free',
      mode: 'cards',
      direction: 'en_ru',
      items: [{ id: 'i', prompt: 'cat', options: [] }],
    })
    vi.mocked(api.revealCard).mockResolvedValue({ outcome: 'skipped', delta: 0, progress: 12 })
    const user = userEvent.setup()
    renderLegacyCard()
    await screen.findByText('cat')
    await user.click(screen.getByRole('button', { name: 'Показать ответ' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Пропущено (0)')
    expect(screen.queryByText(/Ответ:/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Хорошо' })).not.toBeInTheDocument()
  })

  it.each([['en_ru'], ['ru_en']] as const)(
    'пропускает карточку после раскрытия в направлении %s',
    async (direction) => {
      vi.mocked(api.startTraining).mockResolvedValue({
        id: 's',
        purpose: 'free',
        mode: 'cards',
        direction,
        items: [{ id: 'i', prompt: 'cat', options: [] }],
      })
      vi.mocked(api.revealCard).mockResolvedValue({
        outcome: 'revealed',
        expected_answers: ['кот'],
      })
      vi.mocked(api.skipItem).mockResolvedValue({ outcome: 'skipped', delta: 0, progress: 20 })
      const user = userEvent.setup()
      renderLegacyCard(direction)
      await screen.findByText('cat')
      await user.click(screen.getByRole('button', { name: 'Показать ответ' }))
      expect(await screen.findByRole('group', { name: 'Ответ карточки' })).toHaveTextContent('кот')
      await user.click(screen.getByRole('button', { name: 'Пропустить' }))
      expect(await screen.findByRole('status')).toHaveTextContent('Пропущено (0)')
      expect(screen.getByRole('button', { name: 'Хорошо' })).toBeDisabled()
      await user.click(screen.getByRole('button', { name: 'Далее' }))
      expect(await screen.findByText('Оценено карточек: 0')).toBeInTheDocument()
      expect(screen.getByText('Пропущено: 1')).toBeInTheDocument()
    },
  )
})
