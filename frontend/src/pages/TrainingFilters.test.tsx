import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, type TrainingSession } from '../api'
import { TrainingPage } from './TrainingPage'

vi.mock('../api', async (original) => {
  const actual = await original<typeof import('../api')>()
  return {
    ...actual,
    api: {
      startTraining: vi.fn(),
      previewTraining: () =>
        Promise.resolve({
          count: 10,
          selection_seed: '0123456789abcdef0123456789abcdef',
          unavailable_reason: null,
        }),
      latestTraining: () => Promise.resolve(null),
      finishTraining: () => Promise.resolve({ id: 's', status: 'finished', finished_at: '' }),
      listTags: vi.fn(),
    },
  }
})

const session: TrainingSession = {
  id: 's',
  purpose: 'free',
  mode: 'choice',
  direction: 'en_ru',
  items: [{ id: 'i', prompt: 'cat', options: ['кот'] }],
}
function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['training', 'latest'], null)
  render(
    <QueryClientProvider client={client}>
      <TrainingPage />
    </QueryClientProvider>,
  )
}

describe('фильтры тренировки', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(api.listTags).mockResolvedValue([
      { id: 'a', name: 'Дом' },
      { id: 'b', name: 'Работа' },
    ])
    vi.mocked(api.startTraining).mockResolvedValue(session)
  })

  it('отправляет выбранные теги и включительные границы, игнорируя неверный размер', async () => {
    const user = userEvent.setup()
    renderPage()
    const size = screen.getByRole('textbox', { name: 'Своё число слов' })
    await user.clear(size)
    await user.click(screen.getByLabelText('Все подходящие слова'))
    await user.click(await screen.findByLabelText('Дом'))
    await user.click(screen.getByLabelText('Работа'))
    await user.type(screen.getByLabelText('Прогресс от, %'), '100')
    await user.type(screen.getByLabelText('Прогресс до, %'), '158')
    expect(
      screen.getByText('Подходящие слова выбираются и идут в случайном порядке.'),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    expect(api.startTraining).toHaveBeenCalledWith(
      'en_ru',
      'all',
      'choice',
      {
        tag_ids: ['a', 'b'],
        progress_min: 100,
        progress_max: 158,
      },
      'free',
      true,
      '0123456789abcdef0123456789abcdef',
    )
    expect(await screen.findByText('Все подходящие слова: 1')).toBeInTheDocument()
    expect(screen.queryByText(/запрошенных слов/)).not.toBeInTheDocument()
  })

  it.each(['-1', '1.5', '9007199254740992', 'abc'])(
    'не отправляет некорректную границу %s',
    async (value) => {
      const user = userEvent.setup()
      renderPage()
      await user.type(screen.getByLabelText('Прогресс от, %'), value)
      expect(screen.getByRole('button', { name: 'Начать' })).toBeDisabled()
      expect(screen.getByLabelText('Прогресс от, %')).toHaveAttribute('aria-invalid', 'true')
      expect(api.startTraining).not.toHaveBeenCalled()
    },
  )

  it('проверяет порядок границ, сохраняет фильтры при ошибке и очищает их', async () => {
    vi.mocked(api.startTraining).mockRejectedValue(new ApiError(409, 'no_matching_words'))
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByLabelText('Дом'))
    const min = screen.getByLabelText('Прогресс от, %')
    const max = screen.getByLabelText('Прогресс до, %')
    await user.type(min, '101')
    await user.type(max, '100')
    expect(screen.getByRole('button', { name: 'Начать' })).toBeDisabled()
    await user.clear(max)
    await user.type(max, '101')
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Нет подходящих слов')
    expect(screen.getByRole('link', { name: 'Перейти в словарь' })).toHaveAttribute('href', '/')
    expect(min).toHaveValue('101')
    expect(screen.getByLabelText('Дом')).toBeChecked()
    await user.selectOptions(screen.getByLabelText('Сначала показывать'), 'progress_asc')
    await user.click(screen.getByRole('button', { name: 'Перемешать' }))
    await user.click(screen.getByRole('button', { name: 'Очистить фильтры' }))
    expect(min).toHaveValue('')
    expect(max).toHaveValue('')
    expect(screen.getByLabelText('Дом')).not.toBeChecked()
    expect(screen.getByLabelText('Сначала показывать')).toHaveValue('random')
    expect(screen.getByRole('button', { name: 'Перемешать' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('в режиме всех слов игнорирует неверный размер, но не неверную границу', async () => {
    const user = userEvent.setup()
    renderPage()
    const size = screen.getByRole('textbox', { name: 'Своё число слов' })
    await user.clear(size)
    await user.type(size, '0')
    await user.click(screen.getByLabelText('Все подходящие слова'))
    const max = screen.getByLabelText('Прогресс до, %')
    await user.type(max, '9007199254740992')
    expect(max).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('button', { name: 'Начать' })).toBeDisabled()
    expect(api.startTraining).not.toHaveBeenCalled()
    await user.clear(max)
    await user.type(max, '0')
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    expect(api.startTraining).toHaveBeenCalledWith(
      'en_ru',
      'all',
      'choice',
      expect.objectContaining({ progress_max: 0 }),
      'free',
      true,
      '0123456789abcdef0123456789abcdef',
    )
  })

  it('передаёт выбранный порядок слов и поясняет его', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.selectOptions(
      screen.getByLabelText('Сначала показывать'),
      'С наименьшим процентом выученности',
    )
    expect(
      screen.getByText('Подходящие слова идут в выбранном порядке, в пределах размера занятия.'),
    ).toBeInTheDocument()
    await user.click(screen.getByLabelText('По расписанию'))
    expect(screen.getByText(/Слова со сроком повторения остаются первыми/)).toBeInTheDocument()
    await user.click(screen.getByLabelText('Свободная практика'))
    await user.click(screen.getByRole('button', { name: 'Перемешать' }))
    expect(screen.getByRole('button', { name: 'Перемешать' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(
      screen.getByText(
        'Сначала отбираются слова в выбранном порядке, в пределах размера занятия. В упражнении они идут в случайном порядке.',
      ),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    expect(api.startTraining).toHaveBeenCalledWith(
      'en_ru',
      10,
      'choice',
      { order: 'progress_asc', shuffle: true },
      'free',
      true,
      '0123456789abcdef0123456789abcdef',
    )
  })

  it('ошибка справочника не мешает старту без тегов', async () => {
    vi.mocked(api.listTags).mockRejectedValue(new TypeError('offline'))
    const user = userEvent.setup()
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent('можно начать без них')
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    expect(api.startTraining).toHaveBeenCalledWith(
      'en_ru',
      10,
      'choice',
      undefined,
      'free',
      true,
      '0123456789abcdef0123456789abcdef',
    )
  })

  it('блокирует фильтры и повторный старт во время запроса', async () => {
    let resolve!: (value: TrainingSession) => void
    vi.mocked(api.startTraining).mockReturnValue(
      new Promise((r) => {
        resolve = r
      }),
    )
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByLabelText('Дом'))
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    await waitFor(() => expect(screen.getByLabelText('Дом')).toBeDisabled())
    expect(screen.getByLabelText('Прогресс от, %')).toBeDisabled()
    expect(screen.getByLabelText('Сначала показывать')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Перемешать' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Очистить фильтры' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Начать' })).toBeDisabled()
    expect(api.startTraining).toHaveBeenCalledTimes(1)
    await act(async () => resolve(session))
  })
})
