import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api, type Word } from '../api'
import * as speech from '../speech'
import { parseTranslations } from '../words'
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
      listTags: () => Promise.resolve([]),
      answer: vi.fn(),
      revealAnswer: vi.fn(),
      getWord: vi.fn(),
      updateWord: vi.fn(),
    },
  }
})

const relevant: Word = {
  id: 'w1',
  headword: 'relevant',
  translations: ['соответствующий'],
  transcription: 'ˈrɛlɪvənt',
  example_en: null,
  example_ru: null,
  note: null,
  tags: [],
  progress: 4,
  is_excluded: false,
  is_learned: false,
  created_at: '',
  updated_at: '',
}

const relevantSession = {
  id: 's',
  purpose: 'free' as const,
  mode: 'choice' as const,
  direction: 'en_ru' as const,
  items: [
    {
      id: 'i1',
      word_id: 'w1',
      prompt: 'relevant',
      transcription: 'ˈrɛlɪvənt',
      options: ['слово', 'птица', 'сильный', 'соответствующий', 'соусник', 'утро'],
    },
  ],
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['training', 'latest'], null)
  return render(
    <QueryClientProvider client={client}>
      <TrainingPage />
    </QueryClientProvider>,
  )
}

describe('TrainingPage', () => {
  beforeEach(() => {
    vi.mocked(api.answer).mockReset()
    vi.mocked(api.startTraining).mockResolvedValue({
      id: 's',
      purpose: 'free',
      mode: 'choice',
      direction: 'en_ru',
      items: [
        { id: 'i1', prompt: 'cat', options: ['собака', 'кот', 'лиса', 'сова'] },
        { id: 'i2', prompt: 'dog', options: ['собака', 'кот', 'лиса', 'сова'] },
      ],
    })
  })

  it('показывает транскрипцию английского слова и озвучивает нажатый ответ', async () => {
    const speak = vi.spyOn(speech, 'speak').mockImplementation(() => {})
    const user = userEvent.setup()
    vi.mocked(api.answer).mockResolvedValue({
      outcome: 'answered',
      correct: true,
      correct_option: 1,
      chosen_option: 1,
      delta: 4,
      progress: 4,
    })
    vi.mocked(api.startTraining).mockResolvedValue({
      id: 's',
      purpose: 'free',
      mode: 'choice',
      direction: 'en_ru',
      items: [
        {
          id: 'i1',
          prompt: 'hype',
          transcription: '/haɪp/',
          options: ['чай', 'хайп, шумиха'],
        },
      ],
    })
    const view = renderPage()
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    expect(await screen.findByText('hype')).toBeInTheDocument()
    expect(screen.getByText('/haɪp/')).toBeInTheDocument()
    view.unmount()

    vi.mocked(api.startTraining).mockResolvedValue({
      id: 's',
      purpose: 'free',
      mode: 'choice',
      direction: 'ru_en',
      items: [
        {
          id: 'i1',
          prompt: 'хайп, шумиха',
          transcription: null,
          options: ['tea', 'hype', 'old'],
        },
      ],
    })
    renderPage()
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    expect(await screen.findByText('хайп, шумиха')).toBeInTheDocument()
    expect(screen.queryByText('/haɪp/')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Произнести вариант 2' }))
    expect(speak).toHaveBeenCalledWith('hype', 'en')
    speak.mockClear()
    await user.click(screen.getByRole('button', { name: /^2\s*hype$|^hype$/ }))
    expect(speak).toHaveBeenCalledWith('hype', 'en')
    speak.mockRestore()
  })

  it('не предлагает новые занятия с карточками', () => {
    renderPage()
    expect(screen.queryByLabelText('Карточки: EN → RU')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Карточки: RU → EN')).not.toBeInTheDocument()
    expect(screen.getByText('Теги: любой выбранный')).toBeInTheDocument()
  })

  it('uses keys 5 and 6 for six options and ignores repeated answers', async () => {
    const user = userEvent.setup()
    vi.mocked(api.startTraining).mockResolvedValue({
      id: 's',
      purpose: 'free',
      mode: 'choice',
      direction: 'en_ru',
      items: [
        { id: 'i1', prompt: 'cat', options: ['один', 'два', 'три', 'четыре', 'пять', 'шесть'] },
        { id: 'i2', prompt: 'dog', options: ['один', 'два', 'три', 'четыре', 'пять', 'шесть'] },
      ],
    })
    vi.mocked(api.answer).mockImplementation(async (_id, option) => ({
      outcome: 'answered',
      correct: true,
      correct_option: option,
      chosen_option: option,
      delta: 4,
      progress: 4,
    }))
    renderPage()
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    expect(await screen.findByRole('button', { name: /шесть/ })).toBeInTheDocument()
    await user.keyboard('55')
    expect(api.answer).toHaveBeenCalledTimes(1)
    expect(api.answer).toHaveBeenCalledWith('i1', 4)
    await screen.findByRole('status')
    await user.keyboard('6')
    expect(api.answer).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Далее' }))
    await user.keyboard('6')
    expect(api.answer).toHaveBeenLastCalledWith('i2', 5)
    expect(api.answer).toHaveBeenCalledTimes(2)
  })

  it('ignores keys 5 and 6 for a saved four-option item', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    await screen.findByText('cat')
    await user.keyboard('56')
    expect(api.answer).not.toHaveBeenCalled()
  })

  it('runs a session: answer, see feedback, finish with a score', async () => {
    const user = userEvent.setup()
    vi.mocked(api.answer)
      .mockResolvedValueOnce({
        outcome: 'answered',
        correct: true,
        correct_option: 1,
        chosen_option: 1,
        delta: 4,
        progress: 4,
      })
      .mockResolvedValueOnce({
        outcome: 'answered',
        correct: false,
        correct_option: 0,
        chosen_option: 2,
        delta: -4,
        progress: 0,
      })
      .mockResolvedValueOnce({
        outcome: 'answered',
        correct: true,
        correct_option: 0,
        chosen_option: 0,
        delta: 0,
        progress: 0,
      })
    renderPage()

    await user.click(screen.getByRole('button', { name: 'Начать' }))
    expect(await screen.findByText('cat')).toBeInTheDocument()
    expect(screen.getByText('1 / 2')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /кот/ }))
    expect(api.answer).toHaveBeenCalledWith('i1', 1)
    expect(await screen.findByRole('status')).toHaveTextContent('Верно (+4) · прогресс 4%')
    expect(screen.getByRole('button', { name: /собака/ })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Далее' }))
    expect(await screen.findByText('dog')).toBeInTheDocument()

    await user.keyboard('3')
    expect(api.answer).toHaveBeenLastCalledWith('i2', 2)
    expect(await screen.findByRole('status')).toHaveTextContent('Неверно (-4)')
    expect(screen.queryByRole('button', { name: 'Далее' })).not.toBeInTheDocument()

    await user.keyboard('{Enter}')
    expect(api.answer).toHaveBeenCalledTimes(2)
    await user.keyboard('1')
    expect(await screen.findByRole('status')).toHaveTextContent('Верно (0)')
    await user.keyboard('{Enter}')
    expect(await screen.findByText('2 из 2')).toBeInTheDocument()
  })

  it('не показывает кнопку правки без идентификатора слова', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    expect(await screen.findByText('cat')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Редактировать слово/ })).not.toBeInTheDocument()
  })

  it('открывает редактор текущего слова и не раскрывает ответ', async () => {
    const user = userEvent.setup()
    vi.mocked(api.getWord).mockResolvedValue(relevant)
    vi.mocked(api.startTraining).mockResolvedValue(relevantSession)
    renderPage()
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    await user.click(await screen.findByRole('button', { name: 'Редактировать слово «relevant»' }))
    expect(await screen.findByRole('heading', { name: 'Редактировать слово' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Показать ответ' })).not.toBeInTheDocument()
    await user.keyboard('1')
    expect(api.answer).not.toHaveBeenCalled()
    expect(api.revealAnswer).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Отмена' }))
    expect(screen.getByRole('button', { name: 'Показать ответ' })).toBeInTheDocument()
    expect(screen.getByText('relevant')).toBeInTheDocument()
    expect(screen.getByText('ˈrɛlɪvənt')).toBeInTheDocument()
  })

  it('сохраняет транскрипцию и оставляет прежний вопрос', async () => {
    const user = userEvent.setup()
    vi.mocked(api.getWord).mockResolvedValue(relevant)
    vi.mocked(api.updateWord).mockResolvedValue({ ...relevant, transcription: 'rel' })
    vi.mocked(api.startTraining).mockResolvedValue(relevantSession)
    renderPage()
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    await user.click(await screen.findByRole('button', { name: 'Редактировать слово «relevant»' }))
    const transcription = await screen.findByLabelText('Транскрипция')
    await user.clear(transcription)
    await user.type(transcription, 'rel')
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))
    expect(await screen.findByText('Правка сохранена в словаре.')).toBeInTheDocument()
    expect(screen.queryByText(/прежним вопросом/)).not.toBeInTheDocument()
    expect(screen.getByText('rel')).toBeInTheDocument()
    expect(screen.getByText('relevant')).toBeInTheDocument()
    expect(api.updateWord).toHaveBeenCalledWith(
      'w1',
      expect.objectContaining({ headword: 'relevant', transcription: 'rel' }),
    )
    expect(api.answer).not.toHaveBeenCalled()
    expect(api.revealAnswer).not.toHaveBeenCalled()
  })

  it('после смены перевода оставляет выданное задание', async () => {
    const user = userEvent.setup()
    vi.mocked(api.getWord).mockResolvedValue(relevant)
    vi.mocked(api.updateWord).mockResolvedValue({
      ...relevant,
      headword: 'relevantly',
      translations: ['актуальный'],
      transcription: 'new',
    })
    vi.mocked(api.startTraining).mockResolvedValue(relevantSession)
    renderPage()
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    await user.click(await screen.findByRole('button', { name: 'Редактировать слово «relevant»' }))
    const translations = await screen.findByRole('textbox', { name: /Переводы/ })
    await user.clear(translations)
    await user.type(translations, 'актуальный')
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))
    expect(await screen.findByText(/Это задание остаётся с прежним вопросом/)).toBeInTheDocument()
    expect(screen.getByText('relevant')).toBeInTheDocument()
    expect(screen.getByText('ˈrɛlɪvənt')).toBeInTheDocument()
    expect(screen.queryByText('new')).not.toBeInTheDocument()
    expect(screen.queryByText('relevantly')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'соответствующий' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'актуальный' })).not.toBeInTheDocument()
    expect(api.revealAnswer).not.toHaveBeenCalled()
  })

  it('сообщает, что слово уже удалено, и возвращает к заданию', async () => {
    const user = userEvent.setup()
    vi.mocked(api.getWord).mockRejectedValue(new ApiError(404, 'word_not_found'))
    vi.mocked(api.startTraining).mockResolvedValue(relevantSession)
    renderPage()
    await user.click(screen.getByRole('button', { name: 'Начать' }))
    await user.click(await screen.findByRole('button', { name: 'Редактировать слово «relevant»' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Слово уже удалено.')
    expect(api.revealAnswer).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Вернуться к заданию' }))
    expect(screen.getByRole('button', { name: 'Показать ответ' })).toBeInTheDocument()
  })

  it('explains why a session cannot start', async () => {
    const { ApiError } = await import('../api')
    vi.mocked(api.startTraining).mockRejectedValue(new ApiError(409, 'not_enough_words'))
    renderPage()
    await userEvent.click(screen.getByRole('button', { name: 'Начать' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Нужно хотя бы 6 подходящих активных слов',
    )
  })
})

describe('parseTranslations', () => {
  it('keeps one translation per line without blanks or repeats', () => {
    expect(parseTranslations(' кот \n\nКот\nкошка\nёж\nеж')).toEqual(['кот', 'кошка', 'ёж'])
    expect(parseTranslations("кот\nкот.\nкот  дома\nкот дома\nDon’t\ndon't\n.\n...")).toEqual([
      'кот',
      'кот  дома',
      'Don’t',
      '...',
    ])
    expect(parseTranslations('Straße\nstrasse')).toEqual(['Straße'])
  })
})
