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
      translations: ['книга', 'книжка'],
      transcriptions: ['bʊk'],
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

it('сохраняет ручной черновик до явного выбора и provenance после выбора', async () => {
  vi.spyOn(api, 'lookupDictionary').mockResolvedValue(result)
  const user = userEvent.setup()
  const { submit } = form()
  await user.click(screen.getByRole('button', { name: /Подобрать перевод/ }))
  expect(
    await screen.findByRole('button', { name: 'Добавить перевод «книга»' }),
  ).toBeInTheDocument()
  expect(screen.getByLabelText(/Переводы/)).toHaveValue('ручной')
  expect(screen.getByLabelText('Транскрипция')).toHaveValue('manual')
  await user.click(screen.getByRole('button', { name: 'Добавить перевод «книга»' }))
  await user.click(screen.getByRole('button', { name: 'Заменить транскрипцию на «bʊk»' }))
  await user.click(screen.getByRole('button', { name: 'Сохранить' }))
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({
      translations: ['ручной', 'книга'],
      transcription: 'bʊk',
      source_refs: [
        { source_id: source.id, entry_id: 1, field: 'translation', value: 'книга' },
        { source_id: source.id, entry_id: 1, field: 'transcription', value: 'bʊk' },
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

it('отклоняет нормализованный дубль и одиннадцатый перевод', async () => {
  vi.spyOn(api, 'lookupDictionary').mockResolvedValue(result)
  const user = userEvent.setup()
  form({ ...word, translations: ['КНИГА.'] })
  await user.click(screen.getByRole('button', { name: /Подобрать перевод/ }))
  await user.click(await screen.findByRole('button', { name: 'Добавить перевод «книга»' }))
  expect(screen.getByRole('alert')).toHaveTextContent('уже добавлен')
  const input = screen.getByLabelText(/Переводы/)
  await user.clear(input)
  await user.type(input, Array.from({ length: 10 }, (_, i) => `слово${i}`).join('\n'))
  await user.click(screen.getByRole('button', { name: 'Добавить перевод «книжка»' }))
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
  expect(await screen.findByText('Добавить перевод «книга»')).toBeInTheDocument()
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
  expect(screen.queryByText('Добавить перевод «книга»')).not.toBeInTheDocument()
  await user.click(button)
  forgetSession()
  await act(async () => resolve(result))
  expect(screen.queryByText('Добавить перевод «книга»')).not.toBeInTheDocument()
})

it('показывает сведения и исходные уведомления только по запросу', async () => {
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
  expect(await screen.findByText(/CC BY-SA 3.0 Unported/)).toBeInTheDocument()
  expect(notices).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: /Сведения об источнике/ }))
  expect(await screen.findByText('COPYING text')).toBeInTheDocument()
  expect(screen.getByRole('link', { name: /Лицензия CC BY-SA 3.0/ })).toHaveAttribute(
    'href',
    source.license_url,
  )
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
  expect(screen.queryByText('Добавить перевод «книга»')).not.toBeInTheDocument()
})
