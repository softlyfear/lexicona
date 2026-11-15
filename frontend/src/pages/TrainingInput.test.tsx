import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api } from '../api'
import { TrainingPage } from './TrainingPage'
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
      answer: vi.fn(),
      answerText: vi.fn(),
      revealAnswer: vi.fn(),
      skipItem: vi.fn(),
      letterHint: vi.fn(),
      getWord: vi.fn(),
    },
  }
})

function renderPage(autoCheck = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['training', 'latest'], null)
  return render(
    <QueryClientProvider client={client}>
      <TrainingPage autoCheck={autoCheck} />
    </QueryClientProvider>,
  )
}

describe('письменная тренировка', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(api.startTraining).mockResolvedValue({
      id: 's',
      purpose: 'free',
      mode: 'input',
      direction: 'en_ru',
      items: [
        { id: 'i1', prompt: 'cat', options: [] },
        { id: 'i2', prompt: 'dog', options: [] },
      ],
    })
  })

  it('отправляет ввод по Enter, показывает ответ сервера и итог', async () => {
    vi.mocked(api.trainingSummary).mockResolvedValue(
      summaryFixture({ answered: 2 }, { correct: 1, incorrect: 1, accuracy_percent: 50 }),
    )
    const user = userEvent.setup()
    vi.mocked(api.answerText)
      .mockResolvedValueOnce({
        outcome: 'answered',
        correct: true,
        submitted_text: 'кот 1',
        expected_answers: ['кот', 'кошка'],
        delta: 8,
        progress: 8,
      })
      .mockResolvedValueOnce({
        outcome: 'answered',
        correct: false,
        submitted_text: 'волк',
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
    renderPage()
    await user.click(screen.getByLabelText('Написание перевода: EN → RU'))
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    const input = await screen.findByRole('textbox', { name: 'Введите перевод' })
    expect(api.startTraining).toHaveBeenCalledWith(
      'en_ru',
      10,
      'input',
      undefined,
      'free',
      true,
      '0123456789abcdef0123456789abcdef',
    )
    expect(screen.getByRole('button', { name: 'Проверить' })).toBeDisabled()
    await user.type(input, 'кот 1')
    expect(api.answer).not.toHaveBeenCalled()
    await user.keyboard('{Enter}')
    expect(api.answerText).toHaveBeenCalledWith('i1', 'кот 1')
    expect(await screen.findByRole('status')).toHaveTextContent('Верно (+8) · прогресс 8%')
    expect(input).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Проверить' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Далее' }))
    expect(await screen.findByText('dog')).toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: 'Введите перевод' }), 'волк{Enter}')
    expect(await screen.findByRole('status')).toHaveTextContent('Неверно (-4) · прогресс 0%')
    expect(screen.getByRole('button', { name: 'Далее' })).toBeEnabled()
    expect(screen.getByRole('status')).not.toHaveTextContent('Ответ: собака')
    const retry = screen.getByRole('textbox', { name: 'Введите перевод' })
    expect(retry).toBeEnabled()
    await user.clear(retry)
    await user.type(retry, 'собака{Enter}')
    expect(await screen.findByRole('status')).toHaveTextContent('Верно (0) · прогресс 0%')
    await user.click(screen.getByRole('button', { name: 'Далее' }))
    const results = await screen.findByRole('region', { name: 'Первые ответы' })
    expect(results).toHaveTextContent('Точность50%')
    expect(results).toHaveTextContent('Верно1')
    expect(results).toHaveTextContent('Неверно1')
  })

  it('подсказка открывает одну букву и сама отправляет полное слово без баллов', async () => {
    const user = userEvent.setup()
    vi.mocked(api.letterHint)
      .mockResolvedValueOnce({ text: 'к', complete: false })
      .mockResolvedValueOnce({ text: 'кот', complete: true })
    vi.mocked(api.answerText).mockResolvedValueOnce({
      outcome: 'answered',
      correct: true,
      submitted_text: 'кот',
      expected_answers: ['кот'],
      delta: 0,
      progress: 0,
    })
    renderPage()
    await user.click(screen.getByLabelText('Написание перевода: EN → RU'))
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    const input = await screen.findByRole('textbox', { name: 'Введите перевод' })
    await user.click(screen.getByRole('button', { name: 'Подсказка' }))
    expect(api.letterHint).toHaveBeenCalledWith('i1', '')
    expect(input).toHaveValue('к')
    await user.click(screen.getByRole('button', { name: 'Подсказка' }))
    expect(api.letterHint).toHaveBeenLastCalledWith('i1', 'к')
    expect(api.answerText).toHaveBeenCalledWith('i1', 'кот')
    expect(await screen.findByRole('status')).toHaveTextContent('Верно (0) · прогресс 0%')
  })

  it('автоматически проверяет введённый ответ после паузы', async () => {
    const user = userEvent.setup()
    vi.mocked(api.answerText).mockResolvedValueOnce({
      outcome: 'answered',
      correct: true,
      submitted_text: 'кот',
      expected_answers: ['кот'],
      delta: 8,
      progress: 8,
    })
    renderPage(true)
    await user.click(screen.getByLabelText('Написание перевода: EN → RU'))
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    const input = await screen.findByRole('textbox', { name: 'Введите перевод' })
    await user.type(input, 'кот')
    expect(api.answerText).not.toHaveBeenCalled()
    await waitFor(() => expect(api.answerText).toHaveBeenCalledWith('i1', 'кот'), { timeout: 4000 })
    expect(await screen.findByRole('status')).toHaveTextContent('Верно (+8) · прогресс 8%')
  })

  it('не проверяет автоматически текст подсказки, пока не начнут печатать', async () => {
    const user = userEvent.setup()
    vi.mocked(api.letterHint).mockResolvedValueOnce({ text: 'к', complete: false })
    vi.mocked(api.answerText).mockResolvedValueOnce({
      outcome: 'answered',
      correct: true,
      submitted_text: 'кот',
      expected_answers: ['кот'],
      delta: 4,
      progress: 4,
    })
    renderPage(true)
    await user.click(screen.getByLabelText('Написание перевода: EN → RU'))
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    const input = await screen.findByRole('textbox', { name: 'Введите перевод' })
    await user.click(screen.getByRole('button', { name: 'Подсказка' }))
    expect(input).toHaveValue('к')
    await act(async () => {
      await new Promise((done) => setTimeout(done, 2300))
    })
    expect(api.answerText).not.toHaveBeenCalled()
    await user.type(input, 'от')
    await waitFor(() => expect(api.answerText).toHaveBeenCalledWith('i1', 'кот'), { timeout: 4000 })
  })

  it('заполняет поле раскрытым ответом и не дублирует его отдельной плашкой', async () => {
    const user = userEvent.setup()
    vi.mocked(api.revealAnswer).mockResolvedValue({
      outcome: 'revealed',
      expected_answers: ['moved her stuff out today'],
    })
    vi.mocked(api.startTraining).mockResolvedValue({
      id: 's',
      purpose: 'free',
      mode: 'input',
      direction: 'ru_en',
      items: [
        { id: 'i', prompt: 'перенесла вещи', options: [] },
        { id: 'i2', prompt: 'кот', options: [] },
      ],
    })
    renderPage()
    await user.click(screen.getByLabelText('Написание слова: RU → EN'))
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    const input = await screen.findByRole('textbox', { name: 'Введите слово' })
    await user.click(screen.getByRole('button', { name: 'Показать ответ' }))
    expect(input).toHaveValue('moved her stuff out today')
    expect(screen.queryByText(/^Ответ:/)).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Ответ' })).not.toBeInTheDocument()
    vi.mocked(api.skipItem).mockResolvedValue({ outcome: 'skipped', delta: 0, progress: 0 })
    await user.click(screen.getByRole('button', { name: 'Далее' }))
    expect(api.skipItem).toHaveBeenCalledExactlyOnceWith('i')
    expect(await screen.findByText('кот')).toBeInTheDocument()
  })

  it('сохраняет текст после сетевой ошибки и позволяет повторить', async () => {
    const user = userEvent.setup()
    vi.mocked(api.answerText)
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce({
        outcome: 'answered',
        correct: true,
        submitted_text: 'cat',
        expected_answers: ['cat'],
        delta: 8,
        progress: 8,
      })
    vi.mocked(api.startTraining).mockResolvedValue({
      id: 's',
      purpose: 'free',
      mode: 'input',
      direction: 'ru_en',
      items: [{ id: 'i', prompt: 'кот', options: [] }],
    })
    renderPage()
    await user.click(screen.getByLabelText('Написание слова: RU → EN'))
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    const input = await screen.findByRole('textbox', { name: 'Введите слово' })
    expect(api.startTraining).toHaveBeenCalledWith(
      'ru_en',
      10,
      'input',
      undefined,
      'free',
      true,
      '0123456789abcdef0123456789abcdef',
    )
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

  it('не повторяет автопроверку после сетевой ошибки', async () => {
    const user = userEvent.setup()
    vi.mocked(api.answerText).mockRejectedValue(new TypeError('offline'))
    renderPage(true)
    await user.click(screen.getByLabelText('Написание перевода: EN → RU'))
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    const input = await screen.findByRole('textbox', { name: 'Введите перевод' })
    await user.type(input, 'кот')
    await waitFor(() => expect(api.answerText).toHaveBeenCalledTimes(1), { timeout: 4000 })
    expect(await screen.findByRole('alert')).toHaveTextContent('Нет связи')
    await act(async () => {
      await new Promise((done) => setTimeout(done, 2300))
    })
    expect(api.answerText).toHaveBeenCalledTimes(1)
  })

  it('не отправляет ответ, пока открыт редактор слова', async () => {
    const user = userEvent.setup()
    vi.mocked(api.startTraining).mockResolvedValue({
      id: 's',
      purpose: 'free',
      mode: 'input',
      direction: 'en_ru',
      items: [
        { id: 'i1', word_id: 'w1', prompt: 'cat', options: [] },
        { id: 'i2', prompt: 'dog', options: [] },
      ],
    })
    vi.mocked(api.getWord).mockReturnValue(new Promise(() => {}))
    vi.mocked(api.answerText).mockResolvedValue({
      outcome: 'answered',
      correct: true,
      submitted_text: 'кот',
      expected_answers: ['кот'],
      delta: 8,
      progress: 8,
    })
    renderPage(true)
    await user.click(screen.getByLabelText('Написание перевода: EN → RU'))
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    const input = await screen.findByRole('textbox', { name: 'Введите перевод' })
    await user.type(input, 'кот')
    await user.click(screen.getByRole('button', { name: 'Редактировать слово «cat»' }))
    await act(async () => {
      await new Promise((done) => setTimeout(done, 2300))
    })
    expect(api.answerText).not.toHaveBeenCalled()
  })

  it('ждёт окончания IME-композиции', async () => {
    const user = userEvent.setup()
    vi.mocked(api.answerText).mockResolvedValue({
      outcome: 'answered',
      correct: true,
      submitted_text: 'ко',
      expected_answers: ['кот'],
      delta: 4,
      progress: 4,
    })
    renderPage(true)
    await user.click(screen.getByLabelText('Написание перевода: EN → RU'))
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    const input = await screen.findByRole('textbox', { name: 'Введите перевод' })
    fireEvent.compositionStart(input)
    fireEvent.change(input, { target: { value: 'ко' } })
    await act(async () => {
      await new Promise((done) => setTimeout(done, 2300))
    })
    expect(api.answerText).not.toHaveBeenCalled()
    fireEvent.compositionEnd(input)
    await waitFor(() => expect(api.answerText).toHaveBeenCalledWith('i1', 'ко'), { timeout: 4000 })
  })

  it('не отправляет точку автоматически', async () => {
    const user = userEvent.setup()
    vi.mocked(api.answerText).mockResolvedValue({
      outcome: 'answered',
      correct: false,
      submitted_text: '.',
      expected_answers: ['кот'],
      delta: -4,
      progress: 0,
    })
    renderPage(true)
    await user.click(screen.getByLabelText('Написание перевода: EN → RU'))
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    const input = await screen.findByRole('textbox', { name: 'Введите перевод' })
    await user.type(input, '.')
    await act(async () => {
      await new Promise((done) => setTimeout(done, 2300))
    })
    expect(api.answerText).not.toHaveBeenCalled()
  })
})
