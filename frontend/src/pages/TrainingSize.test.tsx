import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen } from '@testing-library/react'
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
      latestTraining: () => Promise.resolve(null),
      finishTraining: () => Promise.resolve({ id: 's', status: 'finished', finished_at: '' }),
      listTags: () => Promise.resolve([]),
      skipItem: vi.fn(),
    },
  }
})

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['training', 'latest'], null)
  return render(
    <QueryClientProvider client={client}>
      <TrainingPage />
    </QueryClientProvider>,
  )
}

const session: TrainingSession = {
  id: 's',
  purpose: 'free',
  mode: 'input',
  direction: 'ru_en',
  items: [{ id: 'i', prompt: 'кот', options: [] }],
}

describe('размер занятия', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(api.startTraining).mockResolvedValue(session)
  })

  it('пресеты и ручное поле задают один размер и не начинают занятие', async () => {
    const user = userEvent.setup()
    renderPage()
    const size = screen.getByRole('textbox', { name: 'Своё число слов' })
    expect(size).toHaveValue('10')
    for (const n of [5, 10, 20, 30, 50, 75, 100, 125, 150]) {
      await user.click(screen.getByRole('button', { name: String(n) }))
      expect(size).toHaveValue(String(n))
      expect(screen.getByRole('button', { name: String(n) })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
    }
    expect(api.startTraining).not.toHaveBeenCalled()
    await user.clear(size)
    await user.type(size, '75')
    expect(screen.getByRole('button', { name: '75' })).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByLabelText('Написание слова: RU → EN'))
    expect(size).toHaveValue('75')
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    expect(api.startTraining).toHaveBeenCalledWith('ru_en', 75, 'input', undefined, 'free', true)
    expect(await screen.findByText('Доступно 1 из 75 запрошенных слов')).toBeInTheDocument()
    expect(screen.getByText('1 / 1')).toBeInTheDocument()
  })

  it.each(['', '0', '9007199254740992', '1.5', '-1', '3.0', 'abc'])(
    'не запускает при недопустимом размере "%s"',
    async (value) => {
      const user = userEvent.setup()
      renderPage()
      const input = screen.getByRole('textbox', { name: 'Своё число слов' })
      await user.clear(input)
      if (value) await user.type(input, value)
      expect(input).toHaveAttribute('aria-invalid', 'true')
      expect(input).toHaveAccessibleDescription('Введите положительное целое число.')
      expect(screen.getByRole('button', { name: 'Начать' })).toBeDisabled()
      await user.type(input, '{Enter}')
      expect(api.startTraining).not.toHaveBeenCalled()
    },
  )

  it.each([1, 501])('принимает размер %i и отправляет его числом по Enter', async (n) => {
    const user = userEvent.setup()
    renderPage()
    const input = screen.getByRole('textbox', { name: 'Своё число слов' })
    await user.clear(input)
    await user.type(input, `${n}{Enter}`)
    expect(api.startTraining).toHaveBeenCalledWith('en_ru', n, 'choice', undefined, 'free', true)
    expect(await screen.findByText('кот')).toBeInTheDocument()
    if (n === 1) expect(screen.queryByText(/Доступно .* запрошенных слов/)).not.toBeInTheDocument()
    else expect(screen.getByText(`Доступно 1 из ${n} запрошенных слов`)).toBeInTheDocument()
  })

  it('ошибка сохраняет настройки; pending блокирует изменения и повторный старт', async () => {
    let resolve!: (value: TrainingSession) => void
    vi.mocked(api.startTraining)
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockReturnValueOnce(
        new Promise((r) => {
          resolve = r
        }),
      )
    const user = userEvent.setup()
    renderPage()
    const input = screen.getByRole('textbox', { name: 'Своё число слов' })
    await user.click(screen.getByLabelText('Написание слова: RU → EN'))
    await user.clear(input)
    await user.type(input, '150{Enter}')
    expect(await screen.findByRole('alert')).toHaveTextContent('Нет связи с сервером')
    expect(input).toHaveValue('150')
    expect(screen.getByLabelText('Написание слова: RU → EN')).toBeChecked()
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    expect(input).toBeDisabled()
    expect(screen.getByLabelText('Сопоставление пар: EN → RU')).toBeDisabled()
    expect(screen.getByRole('button', { name: '50' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Начать' })).toBeDisabled()
    await user.keyboard('{Enter}')
    expect(api.startTraining).toHaveBeenCalledTimes(2)
    await act(async () => resolve(session))
    expect(await screen.findByText('Доступно 1 из 150 запрошенных слов')).toBeInTheDocument()
  })
})
