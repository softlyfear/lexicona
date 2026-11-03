import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { ApiError, api, type DictionaryLookup, type Word } from '../api'
import { forgetSession } from '../session'
import { WordForm } from './WordForm'

const source = {
  id: 'freedict-wikdict-eng-rus-2025.11.23',
  title: 'Dictionary',
  edition: '2025.11.23',
  license: 'CC BY-SA 3.0',
  license_url: 'https://example.com/license',
  source_url: 'https://example.com/source',
  credits: 'Credits',
} as const
const result: DictionaryLookup = {
  source,
  matches: [
    {
      entry_id: 1,
      headword: 'book',
      part_of_speech: 'n',
      translations: ['кни́га', 'книжка'],
      transcriptions: ['/bʊk/'],
      match: 'exact',
    },
  ],
}
const word: Word = {
  id: '1',
  headword: 'book',
  translations: ['ручной'],
  transcription: 'manual',
  example_en: null,
  example_ru: null,
  note: null,
  tags: [],
  progress: 5,
  is_excluded: false,
  created_at: '',
  updated_at: '',
}
function form(initial = word) {
  const submit = vi.fn()
  const view = render(
    <WordForm
      word={initial}
      pending={false}
      error={null}
      onSubmit={submit}
      onCancel={() => {}}
      availableTags={[]}
      tagsLoading={false}
      tagsError={null}
    />,
  )
  return { submit, ...view }
}
beforeEach(() => {
  vi.restoreAllMocks()
})

it('сообщает о тайм-ауте поиска и позволяет повторить без потери введённого', async () => {
  vi.spyOn(api, 'lookupDictionary')
    .mockRejectedValueOnce(new ApiError(504, 'dictionary_timeout'))
    .mockResolvedValueOnce(result)
  const user = userEvent.setup()
  form()
  await user.click(screen.getByRole('button', { name: /Подобрать перевод/ }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Поиск перевода занял слишком много времени',
  )
  expect(screen.getByLabelText(/Переводы/)).toHaveValue('ручной')
  await user.click(screen.getByRole('button', { name: /Подобрать перевод/ }))
  expect(await screen.findByRole('button', { name: 'книга' })).toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('сообщает о тайм-ауте примера и позволяет повторить без потери текста', async () => {
  vi.spyOn(api, 'generateExample')
    .mockRejectedValueOnce(new ApiError(504, 'examples_timeout'))
    .mockResolvedValueOnce({ example_en: 'A book.', example_ru: 'Книга.' })
  const user = userEvent.setup()
  form({ ...word, example_en: 'Old example.', example_ru: 'Старый пример.' })
  await user.click(screen.getByRole('button', { name: 'Добавить пример' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Составление примера заняло слишком много времени',
  )
  expect(screen.getByLabelText('Пример (EN)')).toHaveValue('Old example.')
  await user.click(screen.getByRole('button', { name: 'Добавить пример' }))
  expect(await screen.findByDisplayValue('A book.')).toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('автоматически подставляет fallback IPA и сохраняет provenance выбранного перевода', async () => {
  vi.spyOn(api, 'lookupDictionary').mockResolvedValue(result)
  const user = userEvent.setup()
  const { submit } = form()
  await user.click(screen.getByRole('button', { name: /Подобрать перевод/ }))
  expect(await screen.findByRole('button', { name: 'книга' })).toBeInTheDocument()
  expect(screen.getByLabelText(/Переводы/)).toHaveValue('ручной')
  expect(screen.getByLabelText('Транскрипция')).toHaveValue('/bʊk/')
  await user.click(screen.getByRole('button', { name: 'книга' }))
  expect(screen.queryByRole('button', { name: 'книга' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Сохранить' }))
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({
      translations: ['ручной', 'книга'],
      transcription: '/bʊk/',
      source_refs: [
        { source_id: source.id, entry_id: 1, field: 'transcription', value: '/bʊk/' },
        { source_id: source.id, entry_id: 1, field: 'translation', value: 'книга' },
      ],
    }),
  )
  await user.clear(screen.getByLabelText('Транскрипция'))
  await user.type(screen.getByLabelText('Транскрипция'), 'new')
  await user.click(screen.getByRole('button', { name: 'Сохранить' }))
  expect(submit.mock.calls[1][0].source_refs).toEqual([
    { source_id: source.id, entry_id: 1, field: 'translation', value: 'книга' },
  ])
})

it.each([
  { transcriptions: ['/həˈləʊ/', '/hæˈlaʊ/', '/həˈloʊ/'], expected: '/həˈloʊ/' },
  { transcriptions: ['/ˌɡʊd ˈmɔːnɪŋ/', '/ˌɡʊd ˈmɔɹnɪŋ/'], expected: '/ˌɡʊd ˈmɔɹnɪŋ/' },
])('автоматически предпочитает IPA с US-признаками', async ({ transcriptions, expected }) => {
  vi.spyOn(api, 'lookupDictionary').mockResolvedValue({
    ...result,
    matches: [{ ...result.matches[0], transcriptions }],
  })
  const user = userEvent.setup()
  form()
  await user.click(screen.getByRole('button', { name: /Подобрать перевод/ }))
  expect(await screen.findByRole('button', { name: 'книга' })).toBeInTheDocument()
  expect(screen.getByLabelText('Транскрипция')).toHaveValue(expected)
  expect(
    screen.queryByRole('button', { name: /Выбрать транскрипцию|Заменить транскрипцию/ }),
  ).not.toBeInTheDocument()
})

it('убирает ударения и объединяет образовавшиеся дубли переводов', async () => {
  vi.spyOn(api, 'lookupDictionary').mockResolvedValue({
    ...result,
    matches: [{ ...result.matches[0], translations: ['приве́т', 'привет', 'до́брый день'] }],
  })
  const user = userEvent.setup()
  form()
  await user.click(screen.getByRole('button', { name: /Подобрать перевод/ }))
  expect(await screen.findAllByRole('button', { name: 'привет' })).toHaveLength(1)
  await user.click(screen.getByRole('button', { name: 'добрый день' }))
  expect(screen.getByLabelText(/Переводы/)).toHaveValue('ручной\nдобрый день')
  expect(screen.queryByText(/́/)).not.toBeInTheDocument()
})

it('скрывает нормализованный дубль и отклоняет одиннадцатый перевод', async () => {
  vi.spyOn(api, 'lookupDictionary').mockResolvedValue(result)
  const user = userEvent.setup()
  form({ ...word, translations: ['КНИГА.'] })
  await user.click(screen.getByRole('button', { name: /Подобрать перевод/ }))
  expect(await screen.findByRole('button', { name: 'книжка' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'книга' })).not.toBeInTheDocument()
  const input = screen.getByLabelText(/Переводы/)
  await user.clear(input)
  await user.type(input, Array.from({ length: 10 }, (_, i) => `слово${i}`).join('\n'))
  await user.click(screen.getByRole('button', { name: 'книжка' }))
  expect(screen.getByRole('alert')).toHaveTextContent('не больше 10')
})

it('добавляет машинный перевод без ударения и ссылки на словарь', async () => {
  vi.spyOn(api, 'lookupDictionary').mockResolvedValue({
    source,
    matches: [],
    machine_translation: { provider: 'deepl', text: 'притво́рись, пока не получится' },
  })
  const user = userEvent.setup()
  const { submit } = form()
  await user.click(screen.getByRole('button', { name: /Подобрать перевод/ }))
  expect(await screen.findByText('Машинный перевод · DeepL')).toBeInTheDocument()
  expect(screen.queryByText(/Слово не найдено/)).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'притворись, пока не получится' }))
  expect(screen.getByLabelText(/Переводы/)).toHaveValue('ручной\nпритворись, пока не получится')
  expect(
    screen.queryByRole('button', { name: 'притворись, пока не получится' }),
  ).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Сохранить' }))
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({
      translations: ['ручной', 'притворись, пока не получится'],
      source_refs: [],
    }),
  )
})

it('показывает варианты DeepSeek и автоматически подставляет US IPA', async () => {
  vi.spyOn(api, 'lookupDictionary').mockResolvedValue({
    source,
    matches: [],
    machine_translation: {
      provider: 'openrouter',
      text: 'первый перевод',
      alternatives: ['второй перевод', 'третий перевод'],
      transcription: '/feɪk ɪt tɪl ju meɪk ɪt/',
    },
  })
  const user = userEvent.setup()
  const { submit } = form()
  await user.click(screen.getByRole('button', { name: /Подобрать перевод/ }))
  expect(await screen.findByText('Машинный перевод · DeepSeek · OpenRouter')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'второй перевод' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'третий перевод' })).toBeInTheDocument()
  expect(screen.getByLabelText('Транскрипция')).toHaveValue('/feɪk ɪt tɪl ju meɪk ɪt/')
  await user.click(screen.getByRole('button', { name: 'второй перевод' }))
  await user.click(screen.getByRole('button', { name: 'Сохранить' }))
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({
      translations: ['ручной', 'второй перевод'],
      transcription: '/feɪk ɪt tɪl ju meɪk ɪt/',
      source_refs: [],
    }),
  )
})

it('позволяет сохранять вручную при пустом результате и ошибке и повторить запрос', async () => {
  vi.spyOn(api, 'lookupDictionary')
    .mockResolvedValueOnce({ source, matches: [] })
    .mockRejectedValueOnce(new Error())
    .mockResolvedValueOnce(result)
  const user = userEvent.setup()
  const { submit } = form()
  const button = screen.getByRole('button', { name: /Подобрать перевод/ })
  await user.click(button)
  expect(await screen.findByText(/Слово не найдено/)).toBeInTheDocument()
  await user.click(button)
  expect(await screen.findByRole('alert')).toHaveTextContent('Словарь недоступен')
  await user.click(screen.getByRole('button', { name: 'Сохранить' }))
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({ translations: ['ручной'], transcription: 'manual' }),
  )
  await user.click(button)
  expect(await screen.findByRole('button', { name: 'книга' })).toBeInTheDocument()
})

it('игнорирует поздний ответ после изменения слова и смены сессии', async () => {
  let resolve!: (value: DictionaryLookup) => void
  vi.spyOn(api, 'lookupDictionary').mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const user = userEvent.setup()
  form()
  const button = screen.getByRole('button', { name: /Подобрать перевод/ })
  await user.click(button)
  await user.type(screen.getByLabelText(/Слово или выражение/), 's')
  await act(async () => resolve(result))
  expect(screen.queryByRole('button', { name: 'книга' })).not.toBeInTheDocument()
  expect(screen.getByLabelText('Транскрипция')).toHaveValue('manual')
  await user.click(button)
  forgetSession()
  await act(async () => resolve(result))
  expect(screen.queryByRole('button', { name: 'книга' })).not.toBeInTheDocument()
})

it('не показывает IPA-варианты и сведения об источнике в редакторе', async () => {
  vi.spyOn(api, 'lookupDictionary').mockResolvedValue(result)
  const notices = vi.spyOn(api, 'dictionaryNotices').mockResolvedValue({
    source,
    sha256: 'abc',
    copying: 'COPYING text',
    tei_header: '<header/>',
    transformations: ['Converted'],
  })
  const user = userEvent.setup()
  form()
  await user.click(screen.getByRole('button', { name: /Подобрать перевод/ }))
  expect(await screen.findByRole('button', { name: 'книга' })).toBeInTheDocument()
  expect(screen.queryByText(/Источник:/)).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /Сведения об источнике/ })).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: /Выбрать транскрипцию|Заменить транскрипцию/ }),
  ).not.toBeInTheDocument()
  expect(notices).not.toHaveBeenCalled()
})

it('не показывает результат первого запроса после второго', async () => {
  let resolve!: (value: DictionaryLookup) => void
  vi.spyOn(api, 'lookupDictionary')
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    .mockResolvedValueOnce({ source, matches: [] })
  const user = userEvent.setup()
  form()
  const button = screen.getByRole('button', { name: /Подобрать перевод/ })
  await user.click(button)
  await user.type(screen.getByLabelText(/Слово или выражение/), 's')
  await user.click(button)
  expect(await screen.findByText(/Слово не найдено/)).toBeInTheDocument()
  await act(async () => resolve(result))
  expect(screen.queryByRole('button', { name: 'книга' })).not.toBeInTheDocument()
})

it('показывает полную часть речи, озвучку и добавляет пример DeepSeek', async () => {
  vi.spyOn(api, 'lookupDictionary').mockResolvedValue(result)
  vi.spyOn(api, 'generateExample').mockResolvedValue({
    example_en: 'I read a book.',
    example_ru: 'Я читаю книгу.',
  })
  const user = userEvent.setup()
  form()
  expect(screen.getByRole('button', { name: 'Произнести EN «book»' })).toBeEnabled()
  await user.click(screen.getByRole('button', { name: /Подобрать перевод/ }))
  expect(await screen.findByRole('region', { name: 'book, существительное' })).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Добавить пример' }))
  expect(screen.getByLabelText('Пример (EN)')).toHaveValue('I read a book.')
  expect(screen.getByLabelText('Перевод примера')).toHaveValue('Я читаю книгу.')
})

it.each([
  ['pn', 'имя собственное'],
  ['phraseologicalUnit', 'фразеологизм'],
  ['preposition', 'предлог'],
  ['postposition', 'послелог'],
  ['symbol', 'символ'],
])('расшифровывает часть речи %s', async (part, label) => {
  vi.spyOn(api, 'lookupDictionary').mockResolvedValue({
    ...result,
    matches: [{ ...result.matches[0], part_of_speech: part }],
  })
  const user = userEvent.setup()
  form()
  await user.click(screen.getByRole('button', { name: /Подобрать перевод/ }))
  expect(await screen.findByRole('region', { name: `book, ${label}` })).toBeInTheDocument()
})

it('сбрасывает загрузку примера при изменении слова и игнорирует поздний ответ', async () => {
  let resolve!: (value: { example_en: string; example_ru: string }) => void
  vi.spyOn(api, 'generateExample').mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const user = userEvent.setup()
  form()
  await user.click(screen.getByRole('button', { name: 'Добавить пример' }))
  expect(screen.getByRole('status')).toHaveTextContent('DeepSeek составляет пример')
  await user.type(screen.getByLabelText(/Слово или выражение/), 's')
  expect(screen.queryByText('DeepSeek составляет пример…')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Добавить пример' })).toBeEnabled()
  await act(async () => resolve({ example_en: 'A book.', example_ru: 'Книга.' }))
  expect(screen.getByLabelText('Пример (EN)')).toHaveValue('')
  expect(screen.getByLabelText('Перевод примера')).toHaveValue('')
})

it('предлагает исправление опечатки и ищет выбранный вариант', async () => {
  const lookup = vi
    .spyOn(api, 'lookupDictionary')
    .mockResolvedValueOnce({
      source,
      matches: [],
      spelling_suggestions: ['corsair'],
      machine_translation: { provider: 'deepl', text: 'корсар' },
    })
    .mockResolvedValueOnce({
      ...result,
      matches: [
        {
          ...result.matches[0],
          headword: 'corsair',
          translations: ['корсар'],
          transcriptions: ['/ˌkɔːrˈser/'],
        },
      ],
    })
  const user = userEvent.setup()
  form({ ...word, headword: 'corsar' })
  await user.click(screen.getByRole('button', { name: /Подобрать перевод/ }))
  expect(await screen.findByText(/Точного совпадения нет/)).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'corsair' }))
  expect(screen.getByLabelText(/Слово или выражение/)).toHaveValue('corsair')
  expect(await screen.findByRole('button', { name: 'корсар' })).toBeInTheDocument()
  expect(lookup).toHaveBeenNthCalledWith(2, 'corsair')
})

it('добавляет ещё один пример через пустую строку или полностью заменяет текущий', async () => {
  const generate = vi
    .spyOn(api, 'generateExample')
    .mockResolvedValueOnce({ example_en: 'First example.', example_ru: 'Первый пример.' })
    .mockResolvedValueOnce({ example_en: 'Second example.', example_ru: 'Второй пример.' })
    .mockResolvedValueOnce({ example_en: 'Replacement.', example_ru: 'Замена.' })
  const user = userEvent.setup()
  form()
  await user.click(screen.getByRole('button', { name: 'Добавить пример' }))
  expect(await screen.findByRole('button', { name: 'Добавить ещё 1 пример' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Заменить все примеры' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Добавить пример' })).not.toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Добавить ещё 1 пример' }))
  expect(screen.getByLabelText('Пример (EN)')).toHaveValue('First example.\n\nSecond example.')
  expect(screen.getByLabelText('Перевод примера')).toHaveValue('Первый пример.\n\nВторой пример.')

  await user.click(screen.getByRole('button', { name: 'Заменить все примеры' }))
  expect(screen.getByLabelText('Пример (EN)')).toHaveValue('Replacement.')
  expect(screen.getByLabelText('Перевод примера')).toHaveValue('Замена.')
  expect(generate).toHaveBeenNthCalledWith(1, 'book', [])
  expect(generate).toHaveBeenNthCalledWith(2, 'book', ['First example.'])
  expect(generate).toHaveBeenNthCalledWith(3, 'book', ['First example.', 'Second example.'])
})

it('не теряет примеры, если дополнение превышает лимит поля', async () => {
  vi.spyOn(api, 'generateExample')
    .mockResolvedValueOnce({ example_en: 'First example.', example_ru: 'Первый пример.' })
    .mockResolvedValueOnce({ example_en: 'Second example.', example_ru: 'Второй пример.' })
  const user = userEvent.setup()
  form()
  await user.click(screen.getByRole('button', { name: 'Добавить пример' }))
  const english = screen.getByLabelText('Пример (EN)')
  const russian = screen.getByLabelText('Перевод примера')
  await user.clear(english)
  await user.paste('a'.repeat(1999))
  await user.clear(russian)
  await user.paste('б'.repeat(1999))
  await user.click(screen.getByRole('button', { name: 'Добавить ещё 1 пример' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('Текст не изменён')
  expect(english).toHaveValue('a'.repeat(1999))
  expect(russian).toHaveValue('б'.repeat(1999))
})

it('не добавляет и не подставляет точный повтор прежнего примера', async () => {
  vi.spyOn(api, 'generateExample')
    .mockResolvedValueOnce({ example_en: 'First example.', example_ru: 'Первый пример.' })
    .mockResolvedValueOnce({ example_en: 'first example.', example_ru: 'Другой перевод.' })
  const user = userEvent.setup()
  form()
  await user.click(screen.getByRole('button', { name: 'Добавить пример' }))
  await user.click(await screen.findByRole('button', { name: 'Добавить ещё 1 пример' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('DeepSeek повторил прежний пример')
  expect(screen.getByLabelText('Пример (EN)')).toHaveValue('First example.')
  expect(screen.getByLabelText('Перевод примера')).toHaveValue('Первый пример.')
})
