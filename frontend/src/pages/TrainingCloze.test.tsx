import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api, type TerminalResult } from '../api'
import { speak } from '../speech'
import { TrainingPage } from './TrainingPage'

vi.mock('../api', async (original) => {
  const actual = await original<typeof import('../api')>()
  return {
    ...actual,
    api: { startTraining: vi.fn(), answerText: vi.fn(), revealAnswer: vi.fn(), skipItem: vi.fn() },
  }
})
vi.mock('../speech', () => ({ canSpeak: true, speak: vi.fn() }))

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <TrainingPage />
    </QueryClientProvider>,
  )
}

async function start() {
  const user = userEvent.setup()
  renderPage()
  await user.click(screen.getByLabelText('Слово в примере: EN → EN'))
  expect(screen.getByText(/встречается ровно один раз целиком/)).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Начать' }))
  return user
}

describe('слово в примере', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(api.startTraining).mockResolvedValue({
      id: 's',
      mode: 'cloze',
      direction: 'en_en',
      items: [{ id: 'i', prompt: 'The ____ sleeps.', options: [] }],
    })
  })

  it('показывает замаскированный пример, озвучивает его и отправляет ответ по Enter', async () => {
    vi.mocked(api.answerText).mockResolvedValue({
      outcome: 'answered',
      correct: true,
      submitted_text: 'cat',
      expected_answers: ['cat'],
      delta: 8,
      progress: 8,
    })
    const user = await start()
    const prompt = await screen.findByText('The ____ sleeps.')
    expect(prompt).toHaveAttribute('lang', 'en')
    expect(screen.queryByText('The cat sleeps.')).not.toBeInTheDocument()
    expect(screen.queryByText('cat')).not.toBeInTheDocument()
    expect(screen.getByText('1 / 1')).toBeInTheDocument()
    expect(api.startTraining).toHaveBeenCalledWith('en_en', 10, 'cloze')
    await user.click(screen.getByRole('button', { name: 'Произнести «The ____ sleeps.»' }))
    expect(speak).toHaveBeenCalledWith('The ____ sleeps.', 'en-US')
    const input = screen.getByRole('textbox', { name: 'Введите пропущенное выражение' })
    expect(input).toHaveAttribute('lang', 'en')
    await user.type(input, 'cat{Enter}')
    expect(api.answerText).toHaveBeenCalledWith('i', 'cat')
    expect(await screen.findByRole('status')).toHaveTextContent('Верно (+8) · прогресс 8%')
    expect(screen.getByText('Ответ: cat')).toHaveAttribute('lang', 'en')
    await user.click(screen.getByRole('button', { name: 'Далее' }))
    expect(await screen.findByText('1 из 1')).toBeInTheDocument()
    expect(screen.getByText('С помощью: 0')).toBeInTheDocument()
  })

  it('объясняет, какие примеры нужно добавить при отсутствии подходящих', async () => {
    vi.mocked(api.startTraining).mockRejectedValue(new ApiError(409, 'no_eligible_cloze_examples'))
    await start()
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Добавьте английский пример, где слово или выражение встречается ровно один раз целиком.',
    )
  })

  it('после ошибки сохраняет ввод; во время повтора блокирует другие действия', async () => {
    let resolve!: (result: TerminalResult) => void
    vi.mocked(api.answerText)
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockReturnValueOnce(
        new Promise((r) => {
          resolve = r
        }),
      )
    const user = await start()
    const input = await screen.findByRole('textbox', { name: 'Введите пропущенное выражение' })
    await user.type(input, 'cat{Enter}')
    expect(await screen.findByRole('alert')).toHaveTextContent('Нет связи с сервером')
    expect(input).toHaveValue('cat')
    expect(input).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Проверить' }))
    expect(input).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Показать ответ' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Пропустить' })).toBeDisabled()
    await act(async () =>
      resolve({
        outcome: 'answered',
        correct: false,
        submitted_text: 'cat',
        expected_answers: ['dog'],
        delta: -4,
        progress: 12,
      }),
    )
    expect(await screen.findByRole('status')).toHaveTextContent('Неверно (-4)')
    expect(screen.getByRole('status')).toHaveTextContent('Ответ: dog')
  })

  it('учитывает помощь и пропуск отдельно без правильных ответов', async () => {
    vi.mocked(api.startTraining).mockResolvedValue({
      id: 's',
      mode: 'cloze',
      direction: 'en_en',
      items: [
        { id: 'i1', prompt: 'The ____ sleeps.', options: [] },
        { id: 'i2', prompt: 'A ____ runs.', options: [] },
      ],
    })
    vi.mocked(api.revealAnswer).mockResolvedValue({
      outcome: 'assisted',
      expected_answers: ['cat'],
      delta: 0,
      progress: 20,
    })
    vi.mocked(api.skipItem).mockResolvedValue({ outcome: 'skipped', delta: 0, progress: 30 })
    const user = await start()
    expect(await screen.findByText('1 / 2')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Показать ответ' }))
    expect(await screen.findByRole('status')).toHaveTextContent('С помощью (0)')
    expect(screen.getByRole('status')).toHaveTextContent('Ответ: cat')
    await user.click(screen.getByRole('button', { name: 'Далее' }))
    expect(await screen.findByText('2 / 2')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Пропустить' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Пропущено (0)')
    expect(screen.getByRole('status')).not.toHaveTextContent('Ответ:')
    await user.click(screen.getByRole('button', { name: 'Далее' }))
    expect(await screen.findByText('С помощью: 1')).toBeInTheDocument()
    expect(screen.getByText('Пропущено: 1')).toBeInTheDocument()
    expect(screen.queryByText(/0 из 0|0%/)).not.toBeInTheDocument()
  })
})
