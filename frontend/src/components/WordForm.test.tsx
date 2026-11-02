import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { api, type DictionaryLookup, type Word } from '../api'
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

it('автоматически подставляет fallback IPA и сохраняет provenance выбранного перевода', async () => {
  vi.spyOn(api, 'lookupDictionary').mockResolvedValue(result)
  const user = userEvent.setup()
  const { submit } = form()
  await user.click(screen.getByRole('button', { name: /Подобрать перевод/ }))
  expect(await screen.findByRole('button', { name: 'книга' })).toBeInTheDocument()
  expect(screen.getByLabelText(/Переводы/)).toHaveValue('ручной')
  expect(screen.getByLabelText('Транскрипция')).toHaveValue('/bʊk/')
  await user.click(screen.getByRole('button', { name: 'книга' }))
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

it('отклоняет нормализованный дубль и одиннадцатый перевод', async () => {
  vi.spyOn(api, 'lookupDictionary').mockResolvedValue(result)
  const user = userEvent.setup()
  form({ ...word, translations: ['КНИГА.'] })
  await user.click(screen.getByRole('button', { name: /Подобрать перевод/ }))
  await user.click(await screen.findByRole('button', { name: 'книга' }))
  expect(screen.getByRole('alert')).toHaveTextContent('уже добавлен')
  const input = screen.getByLabelText(/Переводы/)
  await user.clear(input)
  await user.type(input, Array.from({ length: 10 }, (_, i) => `слово${i}`).join('\n'))
  await user.click(screen.getByRole('button', { name: 'книжка' }))
  expect(screen.getByRole('alert')).toHaveTextContent('не больше 10')
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
  expect(await screen.findByText(/Варианты не найдены/)).toBeInTheDocument()
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
  expect(await screen.findByText(/Варианты не найдены/)).toBeInTheDocument()
  await act(async () => resolve(result))
  expect(screen.queryByRole('button', { name: 'книга' })).not.toBeInTheDocument()
})
