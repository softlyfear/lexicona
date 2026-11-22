import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { ApiError, api, type DictionaryLookup, type Word } from '../api'
import { forgetSession, getSessionRevision, queryClient, rememberSession } from '../session'
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
  is_learned: false,
  created_at: '',
  updated_at: '',
}
function form(initial = word, onDirtyChange?: (dirty: boolean) => void) {
  const submit = vi.fn()
  const view = render(
    <WordForm
      word={initial}
      pending={false}
      error={null}
      onSubmit={submit}
      onCancel={() => {}}
      onDirtyChange={onDirtyChange}
      availableTags={[]}
      tagsLoading={false}
      tagsError={null}
    />,
  )
  return { submit, ...view }
}
beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(api, 'listWords').mockResolvedValue([])
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

const duplicateMessage = 'Такое слово или выражение уже есть в словаре.'

function newForm(initial?: Word) {
  const submit = vi.fn()
  const cancel = vi.fn()
  const view = render(
    <WordForm
      word={initial}
      pending={false}
      error={null}
      onSubmit={submit}
      onCancel={cancel}
      availableTags={[]}
      tagsLoading={false}
      tagsError={null}
    />,
  )
  return { submit, cancel, ...view }
}

it.each(['new', 'edit'] as const)(
  'generates only IPA in the %s draft and requires explicit Save',
  async (mode) => {
    const generate = vi
      .spyOn(api, 'generateTranscription')
      .mockResolvedValue({ transcription: '/bʊk/' })
    const lookup = vi.spyOn(api, 'lookupDictionary')
    const example = vi.spyOn(api, 'generateExample')
    const create = vi.spyOn(api, 'createWord')
    const update = vi.spyOn(api, 'updateWord')
    const user = userEvent.setup()
    const initial = {
      ...word,
      transcription: null,
      example_en: 'A book.',
      example_ru: 'Книга.',
      note: 'keep note',
      source_refs: [
        { source_id: source.id, entry_id: 1, field: 'transcription' as const, value: '/bʊk/' },
        { source_id: source.id, entry_id: 1, field: 'translation' as const, value: 'ручной' },
      ],
    }
    const { submit } = newForm(mode === 'edit' ? initial : undefined)
    if (mode === 'new') {
      await user.type(screen.getByLabelText(/Слово или выражение/), 'book')
      await user.type(screen.getByLabelText(/Переводы —/), 'ручной')
      await user.type(screen.getByLabelText('Пример (EN)'), 'A book.')
      await user.type(screen.getByLabelText('Перевод примера'), 'Книга.')
      await user.type(screen.getByLabelText('Заметка'), 'keep note')
    }
    const button = screen.getByRole('button', { name: 'Получить американскую транскрипцию (US)' })
    expect(button).toHaveTextContent(/^US$/)
    expect(button).toHaveAttribute('type', 'button')
    button.focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByText(/Транскрипция добавлена в черновик/)).toHaveAttribute(
      'role',
      'status',
    )
    expect(screen.getByLabelText('Транскрипция')).toHaveValue('/bʊk/')
    expect(button).toHaveAccessibleName('US — американская транскрипция')
    expect(button).toBeDisabled()
    expect(screen.getByLabelText(/Переводы —/)).toHaveValue('ручной')
    expect(screen.getByLabelText('Пример (EN)')).toHaveValue('A book.')
    expect(screen.getByLabelText('Перевод примера')).toHaveValue('Книга.')
    expect(screen.getByLabelText('Заметка')).toHaveValue('keep note')
    expect(generate).toHaveBeenCalledExactlyOnceWith('book')
    expect(submit).not.toHaveBeenCalled()
    expect(lookup).not.toHaveBeenCalled()
    expect(example).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    await user.click(
      screen.getByRole('button', { name: mode === 'edit' ? 'Сохранить' : 'Добавить' }),
    )
    expect(submit).toHaveBeenCalledExactlyOnceWith({
      headword: 'book',
      translations: ['ручной'],
      transcription: '/bʊk/',
      transcription_dialect: 'US',
      example_en: 'A book.',
      example_ru: 'Книга.',
      note: 'keep note',
      tags: [],
      source_refs:
        mode === 'edit'
          ? [{ source_id: source.id, entry_id: 1, field: 'translation', value: 'ручной' }]
          : [],
    })
  },
)

it.each(['manual', 'headword', 'dictionary'] as const)(
  'clears a saved US label after a %s edit even when normalized values are unchanged',
  async (edit) => {
    const user = userEvent.setup()
    const { submit } = form({ ...word, transcription: '/bʊk/', transcription_dialect: 'US' })
    const badge = screen.getByRole('button', { name: 'US — американская транскрипция' })
    if (edit === 'manual') {
      fireEvent.change(screen.getByLabelText('Транскрипция'), { target: { value: ' /bʊk/ ' } })
    } else if (edit === 'headword') {
      fireEvent.change(screen.getByLabelText(/Слово или выражение/), { target: { value: 'Book' } })
    } else {
      vi.spyOn(api, 'lookupDictionary').mockResolvedValue({
        ...result,
        matches: [{ ...result.matches[0], transcriptions: ['/buːk/', '/bʊk/'] }],
      })
      await user.click(screen.getByRole('button', { name: /Подобрать перевод/ }))
      const picker = await screen.findByRole('combobox', { name: 'Варианты транскрипции' })
      await user.selectOptions(picker, '/bʊk/')
    }
    expect(badge).toHaveAccessibleName(/диалект транскрипции неизвестен/)
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))
    expect(submit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ transcription: '/bʊk/', transcription_dialect: null }),
    )
  },
)

it('requires a headword and protects nonempty manual IPA until explicitly cleared', async () => {
  const generate = vi
    .spyOn(api, 'generateTranscription')
    .mockResolvedValue({ transcription: '/bʊk/' })
  const user = userEvent.setup()
  newForm()
  const button = screen.getByRole('button', { name: 'Получить американскую транскрипцию (US)' })
  expect(button).toBeDisabled()
  await user.type(screen.getByLabelText(/Слово или выражение/), 'book')
  await user.type(screen.getByLabelText('Транскрипция'), '/manual/')
  expect(button).toBeDisabled()
  expect(button).toHaveTextContent(/^\?$/)
  expect(button).toHaveAccessibleName(/диалект транскрипции неизвестен/)
  await user.click(button)
  expect(generate).not.toHaveBeenCalled()
  expect(button).toHaveAttribute('title', expect.stringContaining('очистите поле'))
  await user.clear(screen.getByLabelText('Транскрипция'))
  expect(button).toBeEnabled()
  expect(button).toHaveTextContent(/^US$/)
  await user.click(button)
  expect(await screen.findByText(/Транскрипция добавлена/)).toBeInTheDocument()
})

it('locks repeated IPA requests and Save while loading but keeps manual input and Cancel available', async () => {
  let resolve!: (value: { transcription: string }) => void
  const generate = vi.spyOn(api, 'generateTranscription').mockReturnValue(
    new Promise((done) => {
      resolve = done
    }),
  )
  const user = userEvent.setup()
  const { submit, cancel } = newForm({ ...word, transcription: null })
  const button = screen.getByRole('button', { name: 'Получить американскую транскрипцию (US)' })
  await user.click(button)
  expect(button).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled()
  expect(screen.getByLabelText('Транскрипция')).toBeEnabled()
  expect(screen.getByRole('status')).toHaveTextContent('Получаем транскрипцию')
  expect(screen.getByLabelText('Транскрипция')).toHaveAccessibleDescription(
    'Получаем транскрипцию…',
  )
  await user.click(button)
  fireEvent.submit(screen.getByRole('form', { name: 'Слово' }))
  expect(generate).toHaveBeenCalledOnce()
  expect(submit).not.toHaveBeenCalled()
  await user.click(screen.getByRole('button', { name: 'Отмена' }))
  expect(cancel).toHaveBeenCalledOnce()
  await act(async () => resolve({ transcription: '/late/' }))
  expect(screen.getByLabelText('Транскрипция')).toHaveValue('')
})

it.each(['headword', 'manual', 'manual-clear', 'unmount'] as const)(
  'ignores late transcription after %s',
  async (action) => {
    let resolve!: (value: { transcription: string }) => void
    vi.spyOn(api, 'generateTranscription').mockReturnValue(
      new Promise((done) => {
        resolve = done
      }),
    )
    const user = userEvent.setup()
    const view = newForm({ ...word, transcription: null })
    await user.click(
      screen.getByRole('button', { name: 'Получить американскую транскрипцию (US)' }),
    )
    if (action === 'headword') {
      fireEvent.change(screen.getByLabelText(/Слово или выражение/), { target: { value: 'dog' } })
      fireEvent.change(screen.getByLabelText(/Слово или выражение/), { target: { value: 'book' } })
    }
    if (action === 'manual' || action === 'manual-clear') {
      await user.type(screen.getByLabelText('Транскрипция'), '/manual/')
      if (action === 'manual-clear') await user.clear(screen.getByLabelText('Транскрипция'))
    }
    if (action === 'unmount') view.unmount()
    await act(async () => resolve({ transcription: '/late/' }))
    if (action !== 'unmount') {
      expect(screen.getByLabelText('Транскрипция')).toHaveValue(
        action === 'manual' ? '/manual/' : '',
      )
      expect(screen.queryByText(/Транскрипция добавлена/)).not.toBeInTheDocument()
    }
    expect(view.submit).not.toHaveBeenCalled()
  },
)

it.each(['success', '401'] as const)(
  'ignores transcription %s after the account revision changes',
  async (ending) => {
    sessionStorage.clear()
    rememberSession({
      user: { id: 'a', login: 'alice', difficulty: 'medium', is_admin: false },
      csrf_token: 'old',
    })
    let resolve!: (value: { transcription: string }) => void
    let reject!: (error: unknown) => void
    vi.spyOn(api, 'generateTranscription').mockReturnValue(
      new Promise((done, fail) => {
        resolve = done
        reject = fail
      }),
    )
    const user = userEvent.setup()
    newForm({ ...word, transcription: null })
    await user.click(
      screen.getByRole('button', { name: 'Получить американскую транскрипцию (US)' }),
    )
    const other = {
      user: { id: 'b', login: 'bob', difficulty: 'medium' as const, is_admin: false },
      csrf_token: 'new',
    }
    rememberSession(other)
    const revision = getSessionRevision()
    await act(async () => {
      if (ending === 'success') resolve({ transcription: '/late/' })
      else reject(new ApiError(401, 'expired'))
    })
    expect(screen.getByLabelText('Транскрипция')).toHaveValue('')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(getSessionRevision()).toBe(revision)
    expect(queryClient.getQueryData(['session'])).toEqual(other)
    forgetSession()
  },
)

it.each([
  new ApiError(503, 'transcription_unavailable'),
  new ApiError(504, 'transcription_timeout'),
  new TypeError('offline'),
])('reports IPA failure and permits retry without changing translations: %s', async (error) => {
  const generate = vi
    .spyOn(api, 'generateTranscription')
    .mockRejectedValueOnce(error)
    .mockResolvedValueOnce({ transcription: '/bʊk/' })
  const user = userEvent.setup()
  const { submit } = newForm({ ...word, transcription: null })
  const button = screen.getByRole('button', { name: 'Получить американскую транскрипцию (US)' })
  await user.click(button)
  expect(await screen.findByRole('alert')).not.toBeEmptyDOMElement()
  expect(screen.getByLabelText(/Переводы —/)).toHaveValue('ручной')
  expect(button).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeEnabled()
  await user.click(button)
  expect(await screen.findByText(/Транскрипция добавлена/)).toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(generate).toHaveBeenCalledTimes(2)
  expect(submit).not.toHaveBeenCalled()
})

it('does not run IPA generation alongside lookup and ignores invalidated IPA after a later lookup', async () => {
  let finishIpa!: (value: { transcription: string }) => void
  let finishLookup!: (value: DictionaryLookup) => void
  const generate = vi.spyOn(api, 'generateTranscription').mockReturnValue(
    new Promise((done) => {
      finishIpa = done
    }),
  )
  const lookup = vi
    .spyOn(api, 'lookupDictionary')
    .mockReturnValueOnce(
      new Promise((done) => {
        finishLookup = done
      }),
    )
    .mockResolvedValueOnce(result)
  const user = userEvent.setup()
  const { submit } = newForm({ ...word, transcription: null })
  const ipa = screen.getByRole('button', { name: 'Получить американскую транскрипцию (US)' })
  const translate = screen.getByRole('button', { name: /Подобрать перевод/ })
  await user.click(translate)
  expect(ipa).toBeDisabled()
  await user.click(ipa)
  expect(generate).not.toHaveBeenCalled()
  await act(async () => finishLookup({ source, matches: [], spelling_suggestions: ['books'] }))
  await user.click(ipa)
  expect(translate).toBeDisabled()
  expect(screen.getByRole('button', { name: 'books' })).toBeDisabled()
  await user.click(translate)
  expect(lookup).toHaveBeenCalledOnce()
  await user.type(screen.getByLabelText('Транскрипция'), '/manual/')
  await user.clear(screen.getByLabelText('Транскрипция'))
  await user.click(translate)
  expect(await screen.findByRole('button', { name: 'книга' })).toBeInTheDocument()
  await act(async () => finishIpa({ transcription: '/stale/' }))
  expect(screen.getByLabelText('Транскрипция')).toHaveValue('/bʊk/')
  expect(ipa).toHaveTextContent(/^\?$/)
  expect(screen.getByLabelText(/Переводы —/)).toHaveValue('ручной')
  await user.click(screen.getByRole('button', { name: 'Сохранить' }))
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({
      source_refs: [{ source_id: source.id, entry_id: 1, field: 'transcription', value: '/bʊk/' }],
    }),
  )
})

it('retains the generated US badge through a failed lookup and clears its origin on edits', async () => {
  vi.spyOn(api, 'generateTranscription').mockResolvedValue({ transcription: '/bʊk/' })
  vi.spyOn(api, 'lookupDictionary').mockRejectedValue(new TypeError('offline'))
  const user = userEvent.setup()
  newForm({ ...word, transcription: null })
  const button = screen.getByRole('button', { name: 'Получить американскую транскрипцию (US)' })
  const ipa = screen.getByLabelText('Транскрипция')
  await user.click(button)
  expect(button).toHaveAccessibleName('US — американская транскрипция')
  await user.click(screen.getByRole('button', { name: /Подобрать перевод/ }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Словарь недоступен')
  expect(button).toHaveAccessibleName('US — американская транскрипция')

  fireEvent.change(ipa, { target: { value: '/bʊks/' } })
  expect(button).toHaveTextContent(/^\?$/)
  await user.clear(ipa)
  await user.click(button)
  expect(button).toHaveAccessibleName('US — американская транскрипция')
  await user.type(screen.getByLabelText(/Слово или выражение/), 's')
  expect(ipa).toHaveValue('/bʊk/')
  expect(button).toHaveTextContent(/^\?$/)
})

it('keeps a newer manual IPA when a lookup later returns generated IPA', async () => {
  let finishLookup!: (value: DictionaryLookup) => void
  vi.spyOn(api, 'lookupDictionary').mockReturnValue(new Promise((done) => (finishLookup = done)))
  const user = userEvent.setup()
  newForm({ ...word, transcription: null })
  const button = screen.getByRole('button', { name: 'Получить американскую транскрипцию (US)' })
  const ipa = screen.getByLabelText('Транскрипция')
  await user.click(screen.getByRole('button', { name: /Подобрать перевод/ }))
  await user.type(ipa, '/manual/')
  await act(async () =>
    finishLookup({
      ...result,
      matches: [{ ...result.matches[0], transcriptions: [] }],
      machine_transcription: '/bʊk/',
    }),
  )
  expect(await screen.findByRole('button', { name: 'книга' })).toBeInTheDocument()
  expect(ipa).toHaveValue('/manual/')
  expect(button).toHaveTextContent(/^\?$/)
  expect(screen.queryByText(/показана американская/)).not.toBeInTheDocument()
})

it('an obsolete IPA response does not unlock or replace a newer in-flight request', async () => {
  let old!: (value: { transcription: string }) => void
  let latest!: (value: { transcription: string }) => void
  vi.spyOn(api, 'generateTranscription')
    .mockReturnValueOnce(
      new Promise((resolve) => {
        old = resolve
      }),
    )
    .mockReturnValueOnce(
      new Promise((resolve) => {
        latest = resolve
      }),
    )
  const user = userEvent.setup()
  newForm({ ...word, transcription: null })
  const button = screen.getByRole('button', { name: 'Получить американскую транскрипцию (US)' })
  await user.click(button)
  await user.type(screen.getByLabelText('Транскрипция'), 'manual')
  await user.clear(screen.getByLabelText('Транскрипция'))
  await user.click(button)
  await act(async () => old({ transcription: '/old/' }))
  expect(screen.getByLabelText('Транскрипция')).toHaveValue('')
  expect(button).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled()
  await act(async () => latest({ transcription: '/new/' }))
  expect(screen.getByLabelText('Транскрипция')).toHaveValue('/new/')
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeEnabled()
})

it('a current transcription 401 expires the session without changing the draft', async () => {
  vi.spyOn(api, 'generateTranscription').mockRejectedValue(new ApiError(401, 'not_authenticated'))
  const user = userEvent.setup()
  newForm({ ...word, transcription: null })
  const revision = getSessionRevision()
  await user.click(screen.getByRole('button', { name: 'Получить американскую транскрипцию (US)' }))
  expect(getSessionRevision()).toBe(revision + 1)
  expect(screen.getByLabelText('Транскрипция')).toHaveValue('')
  expect(screen.getByLabelText(/Переводы —/)).toHaveValue('ручной')
})

it.each([
  { headword: '  BOOK. ', existing: word },
  {
    headword: '  FAKE   it till you make it. ',
    existing: { ...word, headword: 'fake it till you make it', is_learned: true },
  },
  { headword: 'Book', existing: { ...word, is_excluded: true } },
])(
  'предупреждает о дубле $headword над ещё загружающимся переводом',
  async ({ headword, existing }) => {
    vi.spyOn(api, 'listWords').mockResolvedValue([existing])
    vi.spyOn(api, 'lookupDictionary').mockReturnValue(new Promise(() => {}))
    const user = userEvent.setup()
    newForm()
    fireEvent.change(screen.getByLabelText(/Слово или выражение/), { target: { value: headword } })
    const lookupButton = screen.getByRole('button', { name: /Подобрать перевод/ })
    lookupButton.focus()
    await user.keyboard('{Enter}')
    const warning = await screen.findByText(duplicateMessage)
    const lookupStatus = screen.getByText('Ищем в словаре…')
    expect(warning).toHaveAttribute('role', 'status')
    expect(
      warning.compareDocumentPosition(lookupStatus) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0)
    expect(screen.getByLabelText(/Слово или выражение/)).toHaveAccessibleDescription(
      duplicateMessage,
    )
    expect(screen.getByRole('button', { name: 'Добавить' })).toBeEnabled()
    expect(api.listWords).toHaveBeenCalledWith(headword.trim(), 'created_desc', 'all')
    fireEvent.change(screen.getByLabelText(/Слово или выражение/), { target: { value: 'new' } })
    expect(screen.queryByText(duplicateMessage)).not.toBeInTheDocument()
  },
)

it('не считает подстроку дублем и повторяет раннюю проверку после ошибки перевода', async () => {
  vi.spyOn(api, 'listWords')
    .mockResolvedValueOnce([{ ...word, headword: 'book shop' }])
    .mockResolvedValueOnce([word])
  vi.spyOn(api, 'lookupDictionary').mockRejectedValue(new Error('offline'))
  const user = userEvent.setup()
  newForm()
  await user.type(screen.getByLabelText(/Слово или выражение/), 'book')
  await user.click(screen.getByRole('button', { name: /Подобрать перевод/ }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Словарь недоступен')
  expect(screen.queryByText(duplicateMessage)).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: /Подобрать перевод/ }))
  expect(await screen.findByText(duplicateMessage)).toBeInTheDocument()
  expect(api.listWords).toHaveBeenCalledTimes(2)
})

it('ошибка ранней проверки не мешает ручному вводу и новой проверке при сохранении', async () => {
  vi.spyOn(api, 'listWords').mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([])
  vi.spyOn(api, 'lookupDictionary').mockRejectedValue(new Error('offline'))
  const user = userEvent.setup()
  const { submit } = newForm()
  await user.type(screen.getByLabelText(/Слово или выражение/), 'book')
  await user.click(screen.getByRole('button', { name: /Подобрать перевод/ }))
  await screen.findByRole('alert')
  await user.type(screen.getByLabelText(/Переводы/), 'книга')
  await user.click(screen.getByRole('button', { name: 'Добавить' }))
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ headword: 'book' }))
  expect(api.listWords).toHaveBeenCalledTimes(2)
})

it.each(['change', 'cancel', 'unmount', 'session', 'retry'] as const)(
  'игнорирует устаревший ранний ответ после %s',
  async (action) => {
    let resolveList: (words: Word[]) => void = () => {}
    vi.spyOn(api, 'listWords')
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveList = resolve
          }),
      )
      .mockResolvedValue([])
    vi.spyOn(api, 'lookupDictionary').mockResolvedValue(result)
    const user = userEvent.setup()
    const { unmount, cancel, submit } = newForm()
    await user.type(screen.getByLabelText(/Слово или выражение/), 'book')
    await user.click(screen.getByRole('button', { name: /Подобрать перевод/ }))
    await screen.findByRole('button', { name: 'книга' })
    if (action === 'change') {
      fireEvent.change(screen.getByLabelText(/Слово или выражение/), { target: { value: 'new' } })
    } else if (action === 'cancel') {
      await user.click(screen.getByRole('button', { name: 'Отмена' }))
      expect(cancel).toHaveBeenCalledTimes(1)
    } else if (action === 'unmount') {
      unmount()
    } else if (action === 'session') {
      act(() => forgetSession())
    } else {
      await user.click(screen.getByRole('button', { name: /Подобрать перевод/ }))
    }
    await act(async () => resolveList([word]))
    expect(screen.queryByText(duplicateMessage)).not.toBeInTheDocument()
    expect(submit).not.toHaveBeenCalled()
  },
)

it('не предупреждает при неизменённом заголовке дубля, но проверяет изменённый при поиске', async () => {
  vi.spyOn(api, 'listWords').mockResolvedValue([{ ...word, id: 'other' }])
  vi.spyOn(api, 'lookupDictionary').mockResolvedValue(result)
  const user = userEvent.setup()
  const { submit } = newForm(word)
  fireEvent.change(screen.getByLabelText(/Слово или выражение/), { target: { value: ' BOOK. ' } })
  await user.click(screen.getByRole('button', { name: /Подобрать перевод/ }))
  await screen.findByRole('button', { name: 'книга' })
  expect(api.listWords).not.toHaveBeenCalled()
  expect(screen.queryByText(duplicateMessage)).not.toBeInTheDocument()
  await user.type(screen.getByLabelText('Заметка'), 'уточнение')
  await user.click(screen.getByRole('button', { name: 'Сохранить' }))
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ note: 'уточнение' }))
  fireEvent.change(screen.getByLabelText(/Слово или выражение/), { target: { value: 'other' } })
  vi.mocked(api.listWords).mockResolvedValue([{ ...word, id: 'other', headword: 'other' }])
  await user.click(screen.getByRole('button', { name: /Подобрать перевод/ }))
  expect(await screen.findByText(duplicateMessage)).toBeInTheDocument()
})

it('отклоняет повтор слова и фразы, в том числе выученной, и пропускает более короткое слово', async () => {
  const phrase: Word = {
    ...word,
    id: 'phrase',
    headword: 'fake it till you make it',
    translations: ['притворяйся, пока это не станет правдой'],
    is_learned: true,
  }
  vi.spyOn(api, 'listWords').mockResolvedValue([word, phrase])
  const user = userEvent.setup()
  const submit = vi.fn()
  const props = {
    pending: false,
    error: null,
    onSubmit: submit,
    onCancel: () => {},
    availableTags: [],
    tagsLoading: false,
    tagsError: null,
  }
  render(<WordForm {...props} />)
  await user.type(screen.getByLabelText(/Слово или выражение/), '  BOOK. ')
  await user.type(screen.getByLabelText(/Переводы/), 'книга')
  await user.click(screen.getByRole('button', { name: 'Добавить' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Такое слово или выражение уже есть в словаре.',
  )
  expect(api.listWords).toHaveBeenCalledWith('BOOK.', 'created_desc', 'all')
  expect(submit).not.toHaveBeenCalled()
  cleanup()

  render(<WordForm {...props} />)
  await user.type(screen.getByLabelText(/Слово или выражение/), 'Fake it till you make it.')
  await user.type(screen.getByLabelText(/Переводы/), 'другой перевод')
  await user.click(screen.getByRole('button', { name: 'Добавить' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Такое слово или выражение уже есть в словаре.',
  )
  expect(submit).not.toHaveBeenCalled()
  cleanup()

  render(<WordForm {...props} />)
  await user.type(screen.getByLabelText(/Слово или выражение/), 'fake')
  await user.type(screen.getByLabelText(/Переводы/), 'подделка')
  await user.click(screen.getByRole('button', { name: 'Добавить' }))
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ headword: 'fake' }))
  cleanup()

  submit.mockClear()
  render(<WordForm {...props} word={phrase} />)
  await user.clear(screen.getByLabelText(/Слово или выражение/))
  await user.type(screen.getByLabelText(/Слово или выражение/), 'FAKE IT TILL YOU MAKE IT')
  await user.click(screen.getByRole('button', { name: 'Сохранить' }))
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({ headword: 'FAKE IT TILL YOU MAKE IT' }),
  )
})

it('сохраняет заметку у уже существующего дубликата и отклоняет чужой заголовок', async () => {
  const other: Word = { ...word, id: '2', headword: 'Book.' }
  vi.spyOn(api, 'listWords').mockResolvedValue([word, other])
  const user = userEvent.setup()
  const submit = vi.fn()
  const props = {
    pending: false,
    error: null,
    onSubmit: submit,
    onCancel: () => {},
    availableTags: [],
    tagsLoading: false,
    tagsError: null,
  }
  render(<WordForm {...props} word={word} />)
  await user.type(screen.getByLabelText('Заметка'), 'уточнение')
  await user.click(screen.getByRole('button', { name: 'Сохранить' }))
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({ headword: 'book', note: 'уточнение' }),
  )
  expect(api.listWords).not.toHaveBeenCalled()
  cleanup()

  const mine: Word = { ...word, id: 'mine', headword: 'fake', translations: ['подделка'] }
  submit.mockClear()
  render(<WordForm {...props} word={mine} />)
  await user.clear(screen.getByLabelText(/Слово или выражение/))
  await user.type(screen.getByLabelText(/Слово или выражение/), 'BOOK')
  await user.click(screen.getByRole('button', { name: 'Сохранить' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Такое слово или выражение уже есть в словаре.',
  )
  expect(submit).not.toHaveBeenCalled()
  expect(api.listWords).toHaveBeenCalledWith('BOOK', 'created_desc', 'all')
})

it('отмена во время проверки не сохраняет слово и не шлёт второй запрос', async () => {
  let resolveList: (words: Word[]) => void = () => {}
  vi.spyOn(api, 'listWords').mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveList = resolve
      }),
  )
  const user = userEvent.setup()
  const submit = vi.fn()
  const onCancel = vi.fn()
  render(
    <WordForm
      pending={false}
      error={null}
      onSubmit={submit}
      onCancel={onCancel}
      availableTags={[]}
      tagsLoading={false}
      tagsError={null}
    />,
  )
  await user.type(screen.getByLabelText(/Слово или выражение/), 'book')
  await user.type(screen.getByLabelText(/Переводы/), 'книга')
  const form = screen.getByRole('form', { name: 'Слово' })
  fireEvent.submit(form)
  fireEvent.submit(form)
  expect(screen.getByLabelText(/Слово или выражение/)).toBeDisabled()
  expect(api.listWords).toHaveBeenCalledTimes(1)
  await user.click(screen.getByRole('button', { name: 'Отмена' }))
  expect(onCancel).toHaveBeenCalledTimes(1)
  await act(async () => {
    resolveList([word])
  })
  expect(submit).not.toHaveBeenCalled()
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
  expect(screen.getByRole('button', { name: 'книга' })).toBeDisabled()
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
  {
    headword: 'hello',
    transcriptions: ['/həˈləʊ/', '/hæˈlaʊ/', '/həˈloʊ/'],
    labels: ['UK · /həˈləʊ/', 'Без метки · /hæˈlaʊ/', 'US · /həˈloʊ/'],
    expected: '/həˈloʊ/',
  },
  {
    headword: 'good morning',
    transcriptions: ['/ˌɡʊd ˈmɔːnɪŋ/', '/ˌɡʊd ˈmɔɹnɪŋ/'],
    labels: ['UK · /ˌɡʊd ˈmɔːnɪŋ/', 'US · /ˌɡʊd ˈmɔɹnɪŋ/'],
    expected: '/ˌɡʊd ˈmɔɹnɪŋ/',
  },
])(
  'показывает вероятный диалект для $headword и сохраняет автоматическую подстановку',
  async ({ headword, transcriptions, labels, expected }) => {
    vi.spyOn(api, 'lookupDictionary').mockResolvedValue({
      ...result,
      matches: [{ ...result.matches[0], headword, transcriptions }],
    })
    const user = userEvent.setup()
    form({ ...word, headword })
    await user.click(screen.getByRole('button', { name: /Подобрать перевод/ }))
    const picker = await screen.findByRole('combobox', { name: 'Варианты транскрипции' })
    const options = within(picker).getAllByRole('option')
    expect(options.slice(1).map((option) => option.textContent)).toEqual(labels)
    expect(options[1]).toHaveAccessibleName(/^UK · .* — вероятно, британская транскрипция$/)
    expect(screen.getByLabelText('Транскрипция')).toHaveValue(expected)
    expect(picker).toHaveValue(expected)
    const badge = screen.getByRole('button', { name: 'US — вероятно, американская транскрипция' })
    expect(badge).toHaveTextContent(/^US$/)
    expect(badge).toBeDisabled()
  },
)

it('помечает различимые IPA и оставляет спорные варианты без догадки', async () => {
  const options = [
    ['/sɒk/', 'UK · /sɒk/'],
    ['/bɝd/', 'US · /bɝd/'],
    ['/ˈsɪstɚ/', 'US · /ˈsɪstɚ/'],
    ['/kɑr/', 'US · /kɑr/'],
    ['/kɑː/', 'UK · /kɑː/'],
    ['/ɡoʊ kɑr/', 'US · /ɡoʊ kɑr/'],
    ['/ɡoʊ kɑː/', 'Без метки · /ɡoʊ kɑː/'],
    ['/ɒn kɑr/', 'Без метки · /ɒn kɑr/'],
    ['/ɒn kɑː/', 'UK · /ɒn kɑː/'],
    ['/oʊ sɒk/', 'Без метки · /oʊ sɒk/'],
    ['/rʌn/', 'Без метки · /rʌn/'],
    ['/kɑrd/', 'Без метки · /kɑrd/'],
    ['/fɔːr ˈæp.əlz/', 'Без метки · /fɔːr ˈæp.əlz/'],
    ['/fɔː ˈæp.əlz/', 'Без метки · /fɔː ˈæp.əlz/'],
    ['[oʊ]', 'Без метки · [oʊ]'],
    ['/əʊ/ (UK)', 'Без метки · /əʊ/ (UK)'],
    ['/oʊ (US)/', 'Без метки · /oʊ (US)/'],
    ['/əʊ/ /oʊ/', 'Без метки · /əʊ/ /oʊ/'],
  ]
  vi.spyOn(api, 'lookupDictionary').mockResolvedValue({
    ...result,
    matches: [{ ...result.matches[0], transcriptions: options.map(([value]) => value) }],
  })
  const user = userEvent.setup()
  form()
  await user.click(screen.getByRole('button', { name: /Подобрать перевод/ }))
  const picker = await screen.findByRole('combobox', { name: 'Варианты транскрипции' })
  expect(
    within(picker)
      .getAllByRole<HTMLOptionElement>('option')
      .slice(1)
      .map((option) => [option.value, option.textContent]),
  ).toEqual(options)
})

it('показывает проверенные диалекты coverage и сохраняет исходную IPA', async () => {
  const headword = 'coverage'
  const transcriptions = ['/ˈkav.(ə.)ɹɪdʒ/', '/ˈkɐv.(ə.)ɹɪdʒ/', '/ˈkʌv.(ə.)ɹɪdʒ/']
  vi.spyOn(api, 'lookupDictionary').mockResolvedValue({
    ...result,
    matches: [{ ...result.matches[0], entry_id: 22, headword, transcriptions }],
  })
  const user = userEvent.setup()
  const { submit } = form({ ...word, headword, transcription: null })
  const button = screen.getByRole('button', { name: 'Получить американскую транскрипцию (US)' })
  await user.click(screen.getByRole('button', { name: /Подобрать перевод/ }))
  const picker = await screen.findByRole('combobox', { name: 'Варианты транскрипции' })
  const options = within(picker).getAllByRole('option')
  expect(options.slice(1).map((option) => option.textContent)).toEqual([
    'AU · /ˈkav.(ə.)ɹɪdʒ/',
    'AU · /ˈkɐv.(ə.)ɹɪdʒ/',
    'US/UK · /ˈkʌv.(ə.)ɹɪdʒ/',
  ])
  expect(button).toHaveAccessibleName('AU — австралийская транскрипция')
  expect(button).toBeDisabled()
  await user.selectOptions(picker, transcriptions[2])
  expect(button).toHaveAccessibleName('US/UK — американская и британская транскрипция')
  expect(button).toHaveTextContent(/^US\/UK$/)
  await user.click(screen.getByRole('button', { name: 'Сохранить' }))
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({
      transcription: transcriptions[2],
      source_refs: [
        { source_id: source.id, entry_id: 22, field: 'transcription', value: transcriptions[2] },
      ],
    }),
  )

  const ipa = screen.getByLabelText('Транскрипция')
  fireEvent.change(ipa, { target: { value: '/koʊ/' } })
  expect(button).toHaveTextContent(/^US$/)
  fireEvent.change(ipa, { target: { value: transcriptions[1] } })
  expect(button).toHaveTextContent(/^AU$/)
  await user.type(screen.getByLabelText(/Слово или выражение/), 's')
  expect(ipa).toHaveValue(transcriptions[1])
  expect(button).toHaveTextContent(/^\?$/)
})

it('выбирает IPA из другого совпадения, сохраняя его источник и прежние переводы', async () => {
  const match = { ...result.matches[0], headword: 'hard', translations: ['трудный'] }
  vi.spyOn(api, 'lookupDictionary').mockResolvedValue({
    ...result,
    matches: [
      { ...match, transcriptions: ['/hɑːd/'] },
      { ...match, entry_id: 2, transcriptions: ['/hɑɹd/'] },
      { ...match, entry_id: 3, transcriptions: ['/hɑːd/', '/hɑɹd/'] },
    ],
  })
  const user = userEvent.setup()
  const onDirtyChange = vi.fn()
  const translationRef = {
    source_id: source.id,
    entry_id: 1,
    field: 'translation' as const,
    value: 'трудный',
  }
  const { submit } = form(
    { ...word, headword: 'hard', translations: ['трудный'], source_refs: [translationRef] },
    onDirtyChange,
  )
  await user.click(screen.getByRole('button', { name: /Подобрать перевод/ }))
  const picker = await screen.findByRole('combobox', { name: 'Варианты транскрипции' })
  expect(
    within(picker)
      .getAllByRole('option')
      .map((option) => option.textContent),
  ).toEqual(['Выберите вариант', 'UK · /hɑːd/', 'US · /hɑɹd/'])
  expect(picker).toHaveValue('/hɑːd/')
  const badge = screen.getByRole('button', { name: /вероятно, британская транскрипция/ })
  expect(badge).toHaveTextContent(/^UK$/)
  await user.selectOptions(picker, '/hɑɹd/')
  const ipa = screen.getByLabelText('Транскрипция')
  expect(badge).toHaveTextContent(/^US$/)
  expect(ipa).toHaveValue('/hɑɹd/')
  expect(screen.getByLabelText(/Переводы/)).toHaveValue('трудный')
  expect(onDirtyChange).toHaveBeenCalledExactlyOnceWith(true)
  expect(submit).not.toHaveBeenCalled()

  const save = screen.getByRole('button', { name: 'Сохранить' })
  await user.click(save)
  expect(submit).toHaveBeenLastCalledWith(
    expect.objectContaining({
      transcription: '/hɑɹd/',
      translations: ['трудный'],
      source_refs: [
        translationRef,
        { source_id: source.id, entry_id: 2, field: 'transcription', value: '/hɑɹd/' },
      ],
    }),
  )
  expect(submit.mock.calls[0][0]).not.toHaveProperty('transcription_dialect')
  expect(window.confirm).not.toHaveBeenCalled()

  await user.clear(ipa)
  expect(picker).toHaveValue('')
  await user.click(save)
  expect(submit).toHaveBeenLastCalledWith(
    expect.objectContaining({ transcription: null, source_refs: [translationRef] }),
  )
})

it('скрывает список IPA при новом подборе или изменении слова', async () => {
  const withVariants = {
    ...result,
    matches: [{ ...result.matches[0], transcriptions: ['/bʊk/', '/buːk/'] }],
  }
  let finishLookup!: (value: DictionaryLookup) => void
  vi.spyOn(api, 'lookupDictionary')
    .mockResolvedValueOnce(withVariants)
    .mockImplementationOnce(() => new Promise((resolve) => (finishLookup = resolve)))
  const user = userEvent.setup()
  form()
  const lookup = screen.getByRole('button', { name: /Подобрать перевод/ })
  const name = 'Варианты транскрипции'
  await user.click(lookup)
  expect(await screen.findByRole('combobox', { name })).toBeInTheDocument()
  await user.click(lookup)
  expect(screen.queryByRole('combobox', { name })).not.toBeInTheDocument()
  await act(async () => finishLookup(withVariants))
  expect(screen.getByRole('combobox', { name })).toBeInTheDocument()
  await user.type(screen.getByLabelText(/Слово или выражение/), 's')
  expect(screen.queryByRole('combobox', { name })).not.toBeInTheDocument()
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
  expect(await screen.findByRole('button', { name: 'книжка' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'книга' })).toBeDisabled()
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
  expect(screen.getByRole('button', { name: 'притворись, пока не получится' })).toBeDisabled()
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
  expect(screen.getByRole('button', { name: 'US — американская транскрипция' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'второй перевод' }))
  await user.click(screen.getByRole('button', { name: 'Сохранить' }))
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({
      translations: ['ручной', 'второй перевод'],
      transcription: '/feɪk ɪt tɪl ju meɪk ɪt/',
      transcription_dialect: 'US',
      source_refs: [],
    }),
  )
})

it('подставляет американскую IPA для словарной фразы без транскрипции', async () => {
  vi.spyOn(api, 'lookupDictionary').mockResolvedValue({
    source,
    matches: [
      {
        entry_id: 7,
        headword: 'cut to the chase',
        part_of_speech: 'v',
        translations: ['перейти к делу'],
        transcriptions: [],
        match: 'exact',
      },
    ],
    machine_translation: null,
    machine_transcription: '/ˌkʌt tə ðə ˈtʃeɪs/',
  })
  const user = userEvent.setup()
  const { submit } = form({ ...word, headword: 'cut to the chase', transcription: '' })
  await user.click(screen.getByRole('button', { name: /Подобрать перевод/ }))
  expect(await screen.findByRole('button', { name: 'перейти к делу' })).toBeInTheDocument()
  expect(screen.getByText('Варианты из словаря в порядке источника.')).toBeInTheDocument()
  expect(
    screen.getByText('В словаре нет транскрипции — показана американская.'),
  ).toBeInTheDocument()
  expect(screen.queryByText(/Машинный перевод/)).not.toBeInTheDocument()
  expect(screen.getByLabelText('Транскрипция')).toHaveValue('/ˌkʌt tə ðə ˈtʃeɪs/')
  expect(screen.getByRole('button', { name: 'US — американская транскрипция' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'перейти к делу' }))
  await user.click(screen.getByRole('button', { name: 'Сохранить' }))
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({
      headword: 'cut to the chase',
      translations: ['ручной', 'перейти к делу'],
      transcription: '/ˌkʌt tə ðə ˈtʃeɪs/',
      transcription_dialect: 'US',
      source_refs: [
        { source_id: source.id, entry_id: 7, field: 'translation', value: 'перейти к делу' },
      ],
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

it('при единственной транскрипции не показывает список IPA и сведения об источнике', async () => {
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
  expect(screen.queryByRole('combobox', { name: 'Варианты транскрипции' })).not.toBeInTheDocument()
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

it('отправляет один перевод, если строки совпадают после нормализации', async () => {
  const user = userEvent.setup()
  const { submit } = form({ ...word, translations: [] })
  await user.type(screen.getByLabelText(/Переводы/), "кот{enter}кот.{enter}Don’t{enter}don't")
  await user.click(screen.getByRole('button', { name: 'Сохранить' }))
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({ headword: 'book', translations: ['кот', 'Don’t'] }),
  )
})

it('не отправляет слово или перевод из одной точки', async () => {
  const user = userEvent.setup()
  const head = form({ ...word, headword: '.', translations: ['кот'] })
  await user.click(screen.getByRole('button', { name: 'Сохранить' }))
  expect(head.submit).not.toHaveBeenCalled()
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Слово и переводы не могут состоять только из точки.',
  )
  head.unmount()

  const translation = form({ ...word, headword: 'cat', translations: ['.'] })
  await user.click(screen.getByRole('button', { name: 'Сохранить' }))
  expect(translation.submit).not.toHaveBeenCalled()
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Слово и переводы не могут состоять только из точки.',
  )
})

it('не затирает примеры, изменённые во время запроса', async () => {
  let resolve!: (value: { example_en: string; example_ru: string }) => void
  vi.spyOn(api, 'generateExample').mockReturnValue(
    new Promise((done) => {
      resolve = done
    }),
  )
  const user = userEvent.setup()
  form({ ...word, example_en: 'Old example.', example_ru: 'Старый пример.' })
  await user.click(screen.getByRole('button', { name: 'Добавить пример' }))
  const input = screen.getByLabelText('Пример (EN)')
  await user.clear(input)
  await user.type(input, 'Manual edit.')
  await act(async () => resolve({ example_en: 'Generated.', example_ru: 'Сгенерированный.' }))
  expect(input).toHaveValue('Manual edit.')
  expect(screen.getByRole('alert')).toHaveTextContent('Текст изменён вручную')
})

it('предупреждает о сбросе прогресса при смене переводов', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  const user = userEvent.setup()
  const { submit } = form()
  const translations = screen.getByLabelText(/Переводы/)
  await user.clear(translations)
  await user.type(translations, 'новый')
  await user.click(screen.getByRole('button', { name: 'Сохранить' }))
  expect(confirm).toHaveBeenCalled()
  expect(submit).not.toHaveBeenCalled()
  confirm.mockReturnValue(true)
  await user.click(screen.getByRole('button', { name: 'Сохранить' }))
  expect(submit).toHaveBeenCalled()
})
