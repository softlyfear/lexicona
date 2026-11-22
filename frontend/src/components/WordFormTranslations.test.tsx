import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { api, ApiError, type GeneratedTranslations, type Word } from '../api'
import { forgetSession, getSessionRevision, queryClient, rememberSession } from '../session'
import { WordForm } from './WordForm'

const source = 'freedict-wikdict-eng-rus-2025.11.23' as const
const word: Word = {
  id: 'word',
  headword: 'book',
  translations: ['ручной'],
  transcription: '/manual/',
  example_en: 'Example.',
  example_ru: 'Пример.',
  note: 'keep note',
  tags: [{ id: 'tag', name: 'Tag' }],
  progress: 158,
  is_excluded: false,
  is_learned: false,
  created_at: '',
  updated_at: '',
  source_refs: [
    { source_id: source, entry_id: 1, field: 'translation', value: 'ручной' },
    { source_id: source, entry_id: 1, field: 'transcription', value: '/manual/' },
  ],
}
const result: GeneratedTranslations = {
  provider: 'openrouter',
  translations: ['книга', 'бронировать', 'записывать'],
}
const ai = () => screen.getByRole('button', { name: 'Заполнить с помощью ИИ' })
const draft = () => screen.getByLabelText('Переводы — по одному в строке, первый основной')
function form(initial: Word | null = word) {
  const submit = vi.fn()
  const cancel = vi.fn()
  const view = render(
    <WordForm
      word={initial ?? undefined}
      pending={false}
      error={null}
      onSubmit={submit}
      onCancel={cancel}
      availableTags={[]}
      tagsLoading={false}
      tagsError={null}
    />,
  )
  return { ...view, submit, cancel }
}
beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(api, 'listWords').mockResolvedValue([])
  vi.spyOn(api, 'generateTranslations').mockResolvedValue(result)
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  sessionStorage.clear()
  rememberSession({
    user: { id: 'a', login: 'alice', difficulty: 'medium', is_admin: false },
    csrf_token: 'test',
  })
})

it.each(['add', 'edit'] as const)(
  'explicitly fills %s draft, preserving other fields, manual order and provenance until Save',
  async (mode) => {
    const user = userEvent.setup()
    const lookup = vi.spyOn(api, 'lookupDictionary')
    const ipa = vi.spyOn(api, 'generateTranscription')
    const example = vi.spyOn(api, 'generateExample')
    const create = vi.spyOn(api, 'createWord')
    const update = vi.spyOn(api, 'updateWord')
    const view = mode === 'edit' ? form() : form(null)
    if (mode === 'add') {
      await user.type(screen.getByLabelText(/Слово или выражение/), 'book')
      await user.type(draft(), 'ручной')
      await user.type(screen.getByLabelText('Транскрипция'), '/manual/')
      await user.type(screen.getByLabelText('Пример (EN)'), 'Example.')
      await user.type(screen.getByLabelText('Перевод примера'), 'Пример.')
      await user.type(screen.getByLabelText('Заметка'), 'keep note')
    }
    expect(ai()).toHaveAttribute('type', 'button')
    expect(ai()).toHaveAccessibleDescription('3–5 распространённых значений')
    ai().focus()
    await user.keyboard('{Enter}')
    expect(screen.queryByText(/Добавлено переводов в черновик/)).not.toBeInTheDocument()
    expect(draft()).toHaveValue('ручной\nкнига\nбронировать\nзаписывать')
    expect(screen.getByLabelText('Транскрипция')).toHaveValue('/manual/')
    expect(screen.getByLabelText('Пример (EN)')).toHaveValue('Example.')
    expect(screen.getByLabelText('Перевод примера')).toHaveValue('Пример.')
    expect(screen.getByLabelText('Заметка')).toHaveValue('keep note')
    expect(api.generateTranslations).toHaveBeenCalledExactlyOnceWith('book')
    expect(view.submit).not.toHaveBeenCalled()
    for (const request of [lookup, ipa, example, create, update])
      expect(request).not.toHaveBeenCalled()
    await user.click(
      screen.getByRole('button', { name: mode === 'edit' ? 'Сохранить' : 'Добавить' }),
    )
    expect(view.submit).toHaveBeenCalledExactlyOnceWith({
      headword: word.headword,
      translations: ['ручной', ...result.translations],
      transcription: word.transcription,
      example_en: word.example_en,
      example_ru: word.example_ru,
      note: word.note,
      tags: mode === 'edit' ? ['Tag'] : [],
      source_refs: mode === 'edit' ? word.source_refs : [],
    })
  },
)

it.each([1, 2])('accepts %s available senses without inventing extra entries', async (count) => {
  vi.mocked(api.generateTranslations).mockResolvedValue({
    provider: 'openrouter',
    translations: result.translations.slice(0, count),
  })
  const user = userEvent.setup()
  form({ ...word, translations: [] })
  await user.click(ai())
  expect(draft()).toHaveValue(result.translations.slice(0, count).join('\n'))
})

it('does not request more AI translations when the draft is full', async () => {
  const user = userEvent.setup()
  const existing = Array.from({ length: 10 }, (_, index) => `перевод ${index}`)
  form({ ...word, translations: existing })
  expect(ai()).toBeDisabled()
  await user.click(ai())
  expect(api.generateTranslations).not.toHaveBeenCalled()
  expect(draft()).toHaveValue(existing.join('\n'))
})

it('keeps the original entry and provenance when every generated value is already present', async () => {
  vi.mocked(api.generateTranslations).mockResolvedValue({
    provider: 'openrouter',
    translations: ['РУЧНОЙ.'],
  })
  const user = userEvent.setup()
  const { submit } = form()
  await user.click(ai())
  expect(await screen.findByText(/Все предложенные переводы уже есть/)).toBeInTheDocument()
  expect(draft()).toHaveValue('ручной')
  await user.click(screen.getByRole('button', { name: 'Сохранить' }))
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({
      translations: ['ручной'],
      source_refs: word.source_refs,
    }),
  )
})

it('appends distinct AI values to the latest manually edited draft, not the request snapshot', async () => {
  let resolve!: (value: GeneratedTranslations) => void
  vi.mocked(api.generateTranslations).mockReturnValue(
    new Promise((done) => {
      resolve = done
    }),
  )
  const user = userEvent.setup()
  const { submit } = form()
  await user.click(ai())
  const latest = '  новый ручной \nКнига.\n'
  fireEvent.change(draft(), { target: { value: latest } })
  await act(async () =>
    resolve({ provider: 'openrouter', translations: ['книга', 'бронировать', 'БРОНИРОВАТЬ.'] }),
  )
  expect(draft()).toHaveValue(`${latest}бронировать`)
  expect(submit).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: 'Сохранить' }))
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({
      translations: ['новый ручной', 'Книга.', 'бронировать'],
      source_refs: [word.source_refs![1]],
    }),
  )
})

it('uses storage normalization, not answer-only apostrophe and hyphen tolerance', async () => {
  vi.mocked(api.generateTranslations).mockResolvedValue({
    provider: 'openrouter',
    translations: ["can't", 'low-life', 'cant.'],
  })
  const user = userEvent.setup()
  form({ ...word, translations: ['cant', 'low life'] })
  await user.click(ai())
  expect(draft()).toHaveValue("cant\nlow life\ncan't\nlow-life")
})

it('keeps a near-full draft untouched and exposes all suggestions for explicit selection without truncation', async () => {
  const existing = Array.from({ length: 8 }, (_, index) => `ручной ${index}`)
  const suggestions = ['один', 'два', 'три', 'четыре', 'пять']
  vi.mocked(api.generateTranslations).mockResolvedValue({
    provider: 'openrouter',
    translations: suggestions,
  })
  const user = userEvent.setup()
  const { submit } = form({ ...word, translations: existing })
  await user.click(ai())
  expect(await screen.findByText(/Текст не изменён: максимум 10/)).toBeInTheDocument()
  expect(draft()).toHaveValue(existing.join('\n'))
  const choices = within(screen.getByRole('region', { name: 'Предложенные переводы ИИ' }))
  expect(choices.getAllByRole('button')).toHaveLength(5)
  await user.click(choices.getByRole('button', { name: 'один' }))
  await user.click(choices.getByRole('button', { name: 'два' }))
  expect(draft()).toHaveValue([...existing, 'один', 'два'].join('\n'))
  expect(ai()).toBeDisabled()
  expect(choices.getByRole('button', { name: 'три' })).toBeDisabled()
  const edited = `  ${existing.slice(0, 7).join('\n')}\n\n`
  fireEvent.change(draft(), { target: { value: edited } })
  expect(choices.getByRole('button', { name: 'три' })).toBeEnabled()
  await user.click(choices.getByRole('button', { name: 'три' }))
  expect(draft()).toHaveValue(`${edited}три`)
  expect(submit).not.toHaveBeenCalled()
})

it('rechecks capacity after pending manual edits and never drops entries', async () => {
  let resolve!: (value: GeneratedTranslations) => void
  vi.mocked(api.generateTranslations).mockReturnValue(
    new Promise((done) => {
      resolve = done
    }),
  )
  const user = userEvent.setup()
  form()
  await user.click(ai())
  const current = Array.from({ length: 10 }, (_, index) => `manual ${index}`).join('\n')
  fireEvent.change(draft(), { target: { value: current } })
  await act(async () => resolve(result))
  expect(draft()).toHaveValue(current)
  expect(screen.getByText(/Текст не изменён: максимум 10/)).toBeInTheDocument()
  expect(
    within(screen.getByRole('region', { name: 'Предложенные переводы ИИ' }))
      .getAllByRole('button')
      .every((button) => (button as HTMLButtonElement).disabled),
  ).toBe(true)
})

it('does not append to an overlength manual entry or silently truncate it on Save', async () => {
  const user = userEvent.setup()
  const tooLong = 'я'.repeat(201)
  const { submit } = form({ ...word, translations: [tooLong] })
  await user.click(ai())
  expect(await screen.findByText(/Текст не изменён: максимум 10/)).toBeInTheDocument()
  expect(draft()).toHaveValue(tooLong)
  expect(
    within(screen.getByRole('region', { name: 'Предложенные переводы ИИ' })).getByRole('button', {
      name: 'книга',
    }),
  ).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Сохранить' }))
  expect(screen.getByRole('alert')).toHaveTextContent('200 символов')
  expect(submit).not.toHaveBeenCalled()
  fireEvent.change(draft(), { target: { value: 'я'.repeat(200) } })
  await user.click(screen.getByRole('button', { name: 'Сохранить' }))
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ translations: ['я'.repeat(200)] }))
})

it('requires English input, locks duplicate requests and Save but keeps RU draft editable while loading', async () => {
  vi.mocked(api.generateTranslations).mockReturnValue(new Promise(() => {}))
  const user = userEvent.setup()
  const { submit } = form({ ...word, headword: '', translations: [] })
  expect(ai()).toBeDisabled()
  await user.type(screen.getByLabelText(/Слово или выражение/), 'book')
  await user.click(ai())
  expect(screen.getByRole('status')).toHaveTextContent('ИИ подбирает переводы')
  expect(ai()).toBeDisabled()
  expect(draft()).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled()
  await user.click(ai())
  fireEvent.submit(screen.getByRole('form', { name: 'Слово' }))
  expect(api.generateTranslations).toHaveBeenCalledOnce()
  expect(submit).not.toHaveBeenCalled()
})

it.each(['headword', 'cancel', 'unmount', 'owner', 'revision'] as const)(
  'ignores late AI results after %s',
  async (reason) => {
    let resolve!: (value: GeneratedTranslations) => void
    vi.mocked(api.generateTranslations).mockReturnValue(
      new Promise((done) => {
        resolve = done
      }),
    )
    const user = userEvent.setup()
    const view = form()
    await user.click(ai())
    if (reason === 'headword') {
      fireEvent.change(screen.getByLabelText(/Слово или выражение/), { target: { value: 'dog' } })
      fireEvent.change(screen.getByLabelText(/Слово или выражение/), { target: { value: 'book' } })
    }
    if (reason === 'cancel') await user.click(screen.getByRole('button', { name: 'Отмена' }))
    if (reason === 'unmount') view.unmount()
    if (reason === 'owner' || reason === 'revision')
      rememberSession({
        user: {
          id: reason === 'owner' ? 'b' : 'a',
          login: 'user',
          difficulty: 'medium',
          is_admin: false,
        },
        csrf_token: 'new',
      })
    await act(async () => resolve(result))
    if (reason !== 'unmount') expect(draft()).toHaveValue('ручной')
    expect(view.submit).not.toHaveBeenCalled()
  },
)

it.each([
  new ApiError(503, 'translations_unavailable'),
  new ApiError(504, 'translations_timeout'),
  new TypeError('offline'),
])('keeps the draft on AI failure and permits retry: %s', async (error) => {
  vi.mocked(api.generateTranslations).mockRejectedValueOnce(error).mockResolvedValueOnce(result)
  const user = userEvent.setup()
  const { submit } = form()
  await user.click(ai())
  expect(await screen.findByRole('alert')).not.toBeEmptyDOMElement()
  expect(draft()).toHaveValue('ручной')
  expect(ai()).toBeEnabled()
  await user.click(ai())
  expect(draft()).toHaveValue('ручной\nкнига\nбронировать\nзаписывать')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(submit).not.toHaveBeenCalled()
})

it.each(['lookup', 'ipa', 'ai'] as const)(
  'prevents concurrent lookup, IPA and AI generation when %s is pending',
  async (first) => {
    const lookup = vi.spyOn(api, 'lookupDictionary').mockReturnValue(new Promise(() => {}))
    const ipa = vi.spyOn(api, 'generateTranscription').mockReturnValue(new Promise(() => {}))
    vi.mocked(api.generateTranslations).mockReturnValue(new Promise(() => {}))
    const user = userEvent.setup()
    form({ ...word, transcription: null })
    const buttons = {
      lookup: screen.getByRole('button', { name: /Подобрать перевод/ }),
      ipa: screen.getByRole('button', { name: 'Получить американскую транскрипцию (US)' }),
      ai: ai(),
    }
    await user.click(buttons[first])
    for (const [name, button] of Object.entries(buttons)) {
      expect(button).toBeDisabled()
      await user.click(button)
      expect(name === first ? button : buttons[first]).toBeDisabled()
    }
    expect(lookup).toHaveBeenCalledTimes(first === 'lookup' ? 1 : 0)
    expect(ipa).toHaveBeenCalledTimes(first === 'ipa' ? 1 : 0)
    expect(api.generateTranslations).toHaveBeenCalledTimes(first === 'ai' ? 1 : 0)
  },
)

it('ignores an obsolete AI response and error without unlocking a newer request or expiring a new session', async () => {
  let reject!: (error: unknown) => void
  let resolve!: (value: GeneratedTranslations) => void
  vi.mocked(api.generateTranslations)
    .mockReturnValueOnce(
      new Promise((_, fail) => {
        reject = fail
      }),
    )
    .mockReturnValueOnce(
      new Promise((done) => {
        resolve = done
      }),
    )
  const user = userEvent.setup()
  form()
  await user.click(ai())
  fireEvent.change(screen.getByLabelText(/Слово или выражение/), { target: { value: 'books' } })
  await user.click(ai())
  const revision = getSessionRevision()
  await act(async () => reject(new ApiError(401, 'expired')))
  expect(ai()).toBeDisabled()
  expect(getSessionRevision()).toBe(revision)
  await act(async () => resolve(result))
  expect(draft()).toHaveValue(['ручной', ...result.translations].join('\n'))
  expect(queryClient.getQueryData(['session'])).not.toBeNull()
})

it('expires only a current AI request 401 and never mutates the draft on auth failure', async () => {
  vi.mocked(api.generateTranslations).mockRejectedValue(new ApiError(401, 'expired'))
  const user = userEvent.setup()
  form()
  const revision = getSessionRevision()
  await user.click(ai())
  expect(getSessionRevision()).toBe(revision + 1)
  expect(draft()).toHaveValue('ручной')
  forgetSession()
})
