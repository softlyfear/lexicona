import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, type Word } from '../api'
import { WordsPage } from './WordsPage'

vi.mock('../api', async (original) => {
  const actual = await original<typeof import('../api')>()
  return {
    ...actual,
    api: {
      listWords: vi.fn(),
      listTags: vi.fn(),
      createWord: vi.fn(),
      updateWord: vi.fn(),
      deleteWord: vi.fn(),
      setWordTraining: vi.fn(),
      setWordLearned: vi.fn(),
    },
  }
})

const word = (id: string, headword: string): Word => ({
  id,
  headword,
  translations: ['перевод'],
  progress: 10,
  is_excluded: false,
  is_learned: false,
  transcription: null,
  example_en: null,
  example_ru: null,
  note: null,
  created_at: '',
  updated_at: '',
  tags: [],
})

function Navigation() {
  const navigate = useNavigate()
  const location = useLocation()
  return (
    <>
      <button onClick={() => navigate(-1)}>Назад</button>
      <button onClick={() => navigate(1)}>Вперёд</button>
      <span data-testid="url">{location.search}</span>
    </>
  )
}

function renderPage(url = '/', userId = 'alice') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <Navigation />
        <main>
          <WordsPage userId={userId} />
        </main>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function params() {
  return new URLSearchParams(screen.getByTestId('url').textContent ?? '')
}

describe('сортировка словаря', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetAllMocks()
    vi.mocked(api.listTags).mockResolvedValue([])
    vi.mocked(api.listWords).mockResolvedValue([word('1', 'cat'), word('2', 'dog')])
  })

  it('раскрывает фильтры и действия, сохраняя видимую сводку', async () => {
    vi.mocked(api.listTags).mockResolvedValue([{ id: 'home', name: 'Дом' }])
    const user = userEvent.setup()
    renderPage('/?sort=progress_desc&training=all&tag_id=home')
    await screen.findByText('cat')
    const filters = screen.getByText('Фильтры').closest('summary')!
    const filterDetails = filters.parentElement!
    expect(filterDetails).not.toHaveAttribute('open')
    expect(filters).toHaveTextContent('Прогресс ↓')
    expect(filters).toHaveTextContent('Все слова')
    expect(filters).toHaveTextContent('Дом')
    await user.click(filters)
    expect(filterDetails).toHaveAttribute('open')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Обучение' }), 'excluded')
    await user.click(filters)
    expect(filterDetails).not.toHaveAttribute('open')
    expect(filters).toHaveTextContent('Исключённые')
    expect(params().get('training')).toBe('excluded')

    const actions = screen.getByLabelText('Действия со словом «cat»')
    expect(actions.parentElement).not.toHaveAttribute('open')
    await user.click(actions)
    expect(actions.parentElement).toHaveAttribute('open')
    expect(screen.getByRole('button', { name: 'Изменить «cat»' })).toHaveTextContent('Изменить')
  })

  it('читает начальные q и sort из URL и меняет только выбранный параметр', async () => {
    const user = userEvent.setup()
    renderPage('/?q=cat&sort=progress_asc')
    expect(await screen.findByText('cat')).toBeInTheDocument()
    expect(screen.getByRole('searchbox', { name: 'Поиск' })).toHaveValue('cat')
    const select = screen.getByRole('combobox', { name: 'Сортировка' })
    expect(select).toHaveValue('progress_asc')
    expect(api.listWords).toHaveBeenCalledWith('cat', 'progress_asc', 'active', [])
    await user.selectOptions(select, 'headword_desc')
    expect(params().get('q')).toBe('cat')
    expect(params().get('sort')).toBe('headword_desc')
    await waitFor(() =>
      expect(api.listWords).toHaveBeenCalledWith('cat', 'headword_desc', 'active', []),
    )
    await user.clear(screen.getByRole('searchbox', { name: 'Поиск' }))
    await user.type(screen.getByRole('searchbox', { name: 'Поиск' }), 'dog')
    expect(params().get('q')).toBe('dog')
    expect(params().get('sort')).toBe('headword_desc')
    await waitFor(() =>
      expect(api.listWords).toHaveBeenCalledWith('dog', 'headword_desc', 'active', []),
    )
  })

  it('восстанавливает поиск и сортировку при переходах назад и вперёд', async () => {
    const user = userEvent.setup()
    renderPage('/?q=cat&sort=progress_asc')
    await screen.findByText('cat')
    const select = screen.getByRole('combobox', { name: 'Сортировка' })
    await user.selectOptions(select, 'created_asc')
    await user.selectOptions(select, 'headword_asc')
    expect(params().get('q')).toBe('cat')
    await user.click(screen.getByRole('button', { name: 'Назад' }))
    expect(select).toHaveValue('created_asc')
    expect(screen.getByRole('searchbox', { name: 'Поиск' })).toHaveValue('cat')
    await waitFor(() =>
      expect(api.listWords).toHaveBeenCalledWith('cat', 'created_asc', 'active', []),
    )
    await user.click(screen.getByRole('button', { name: 'Вперёд' }))
    expect(select).toHaveValue('headword_asc')
    expect(params().get('q')).toBe('cat')
  })

  it('восстанавливает изменённый поиск в истории, не теряя сортировку', async () => {
    const user = userEvent.setup()
    renderPage('/?q=cat&sort=progress_asc')
    await screen.findByText('cat')
    const input = screen.getByRole('searchbox', { name: 'Поиск' })
    await user.type(input, 's')
    expect(input).toHaveValue('cats')
    await user.click(screen.getByRole('button', { name: 'Назад' }))
    expect(input).toHaveValue('cat')
    expect(screen.getByRole('combobox', { name: 'Сортировка' })).toHaveValue('progress_asc')
    await user.click(screen.getByRole('button', { name: 'Вперёд' }))
    expect(input).toHaveValue('cats')
    expect(params().get('sort')).toBe('progress_asc')
  })

  it('сохраняет сортировку, обучение и теги этого аккаунта после выхода', async () => {
    vi.mocked(api.listTags).mockResolvedValue([
      { id: 'home', name: 'Дом' },
      { id: 'work', name: 'Работа' },
    ])
    const user = userEvent.setup()
    const first = renderPage('/?q=cat')
    await screen.findByText('cat')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Сортировка' }), 'progress_desc')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Обучение' }), 'excluded')
    await user.click(await screen.findByRole('checkbox', { name: 'Дом' }))
    expect(params().get('q')).toBe('cat')
    first.unmount()

    const restored = renderPage('/')
    expect(screen.getByRole('searchbox', { name: 'Поиск' })).toHaveValue('')
    expect(screen.getByRole('combobox', { name: 'Сортировка' })).toHaveValue('progress_desc')
    expect(screen.getByRole('combobox', { name: 'Обучение' })).toHaveValue('excluded')
    expect(await screen.findByRole('checkbox', { name: 'Дом' })).toBeChecked()
    await waitFor(() => expect(params().get('sort')).toBe('progress_desc'))
    expect(params().get('training')).toBe('excluded')
    expect(params().getAll('tag_id')).toEqual(['home'])
    expect(params().has('q')).toBe(false)
    expect(JSON.parse(localStorage.getItem('lexicona:words:v1:alice')!).tagIds).toEqual(['home'])
    restored.unmount()

    renderPage('/', 'bob')
    expect(screen.getByRole('combobox', { name: 'Сортировка' })).toHaveValue('created_desc')
    expect(screen.getByRole('combobox', { name: 'Обучение' })).toHaveValue('active')
    expect(await screen.findByRole('checkbox', { name: 'Дом' })).not.toBeChecked()
  })

  it('испорченное сохранение фильтров не подменяет адрес', async () => {
    localStorage.setItem('lexicona:words:v1:alice', '{broken')
    renderPage('/?q=cat')
    expect(await screen.findByText('cat')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Сортировка' })).toHaveValue('created_desc')
    expect(screen.getByRole('combobox', { name: 'Обучение' })).toHaveValue('active')
    expect(params().toString()).toBe('q=cat')
  })

  it('выбор значений по умолчанию не возвращает прежнее сохранение', async () => {
    localStorage.setItem(
      'lexicona:words:v1:alice',
      JSON.stringify({
        version: 1,
        sort: 'progress_desc',
        training: 'excluded',
        tagIds: ['home'],
      }),
    )
    vi.mocked(api.listTags).mockResolvedValue([{ id: 'home', name: 'Дом' }])
    const user = userEvent.setup()
    const first = renderPage('/')
    expect(await screen.findByRole('checkbox', { name: 'Дом' })).toBeChecked()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Сортировка' }), 'created_desc')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Обучение' }), 'active')
    await user.click(screen.getByRole('button', { name: 'Снять фильтр тегов' }))
    await waitFor(() => expect(params().toString()).toBe(''))
    first.unmount()

    renderPage('/')
    expect(screen.getByRole('combobox', { name: 'Сортировка' })).toHaveValue('created_desc')
    expect(screen.getByRole('combobox', { name: 'Обучение' })).toHaveValue('active')
    expect(await screen.findByRole('checkbox', { name: 'Дом' })).not.toBeChecked()
    expect(params().toString()).toBe('')
  })

  it('шаг назад показывает прежний вид и запоминает его', async () => {
    const user = userEvent.setup()
    renderPage('/')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Сортировка' }), 'progress_desc')
    await waitFor(() => expect(params().get('sort')).toBe('progress_desc'))
    await user.click(screen.getByRole('button', { name: 'Назад' }))
    expect(screen.getByRole('combobox', { name: 'Сортировка' })).toHaveValue('created_desc')
    await waitFor(() => expect(params().has('sort')).toBe(false))
    expect(JSON.parse(localStorage.getItem('lexicona:words:v1:alice')!).sort).toBe('created_desc')
  })

  it('при неизвестной сортировке использует безопасный default и позволяет выбрать все шесть', async () => {
    const user = userEvent.setup()
    renderPage('/?q=cat&sort=malicious')
    expect(await screen.findByText('cat')).toBeInTheDocument()
    const select = screen.getByRole('combobox', { name: 'Сортировка' })
    expect(select).toHaveValue('created_desc')
    expect(api.listWords).toHaveBeenCalledWith('cat', 'created_desc', 'active', [])
    expect(within(select).getAllByRole('option')).toHaveLength(6)
    for (const value of [
      'created_asc',
      'headword_asc',
      'headword_desc',
      'progress_asc',
      'progress_desc',
      'created_desc',
    ]) {
      await user.selectOptions(select, value)
      await waitFor(() => expect(api.listWords).toHaveBeenCalledWith('cat', value, 'active', []))
      expect(params().get('q')).toBe('cat')
    }
    expect(params().has('sort')).toBe(false)
  })

  it('показывает прежний список до завершения обновления сортировки', async () => {
    let resolve!: (words: Word[]) => void
    vi.mocked(api.listWords).mockImplementation((_q, sort) =>
      sort === 'created_asc'
        ? new Promise((r) => {
            resolve = r
          })
        : Promise.resolve([word('1', 'cat'), word('2', 'dog')]),
    )
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('cat')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Сортировка' }), 'created_asc')
    expect(await screen.findByRole('status')).toHaveTextContent('Обновляем список')
    expect(screen.getByText('cat')).toBeInTheDocument()
    await act(async () => resolve([word('2', 'dog'), word('1', 'cat')]))
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
    expect(
      screen.getAllByRole('listitem').map((item) => within(item).getByRole('strong').textContent),
    ).toEqual(['dog', 'cat'])
  })

  it('поздний ответ прежней сортировки не заменяет новый список', async () => {
    let resolveOld!: (words: Word[]) => void
    vi.mocked(api.listWords).mockImplementation((_q, sort) =>
      sort === 'created_desc'
        ? new Promise((resolve) => {
            resolveOld = resolve
          })
        : Promise.resolve([word('2', 'dog')]),
    )
    const user = userEvent.setup()
    renderPage('/?q=pet')
    await waitFor(() =>
      expect(api.listWords).toHaveBeenCalledWith('pet', 'created_desc', 'active', []),
    )
    await user.selectOptions(screen.getByRole('combobox', { name: 'Сортировка' }), 'created_asc')
    expect(await screen.findByText('dog')).toBeInTheDocument()
    await act(async () => resolveOld([word('1', 'cat')]))
    expect(screen.getByText('dog')).toBeInTheDocument()
    expect(screen.queryByText('cat')).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Сортировка' })).toHaveValue('created_asc')
  })

  it('сохраняет сообщения для пустой выдачи и ошибки загрузки', async () => {
    vi.mocked(api.listWords)
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce([])
    const user = userEvent.setup()
    renderPage('/?q=cat')
    expect(await screen.findByRole('alert')).toHaveTextContent('Нет связи с сервером')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Сортировка' }), 'progress_desc')
    expect(await screen.findByText('Ничего не найдено.')).toBeInTheDocument()
  })

  it('фильтрует active/excluded/all, сохраняет q и sort и восстанавливает URL', async () => {
    const user = userEvent.setup()
    renderPage('/?q=cat&sort=progress_desc&training=invalid')
    await screen.findByText('cat')
    const filter = screen.getByRole('combobox', { name: 'Обучение' })
    expect(filter).toHaveValue('active')
    expect(api.listWords).toHaveBeenCalledWith('cat', 'progress_desc', 'active', [])
    await user.selectOptions(filter, 'excluded')
    expect(params().get('q')).toBe('cat')
    expect(params().get('sort')).toBe('progress_desc')
    expect(params().get('training')).toBe('excluded')
    await waitFor(() =>
      expect(api.listWords).toHaveBeenCalledWith('cat', 'progress_desc', 'excluded', []),
    )
    await user.selectOptions(filter, 'all')
    await waitFor(() =>
      expect(api.listWords).toHaveBeenCalledWith('cat', 'progress_desc', 'all', []),
    )
    await user.click(screen.getByRole('button', { name: 'Назад' }))
    expect(filter).toHaveValue('excluded')
    await user.click(screen.getByRole('button', { name: 'Вперёд' }))
    expect(filter).toHaveValue('all')
    await user.selectOptions(filter, 'active')
    expect(params().has('training')).toBe(false)
  })

  it('показывает и запоминает слова, отмеченные как выученные', async () => {
    vi.mocked(api.listWords).mockResolvedValue([])
    const user = userEvent.setup()
    const first = renderPage('/')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Обучение' }), 'learned')
    expect(await screen.findByText('Нет выученных слов.')).toBeInTheDocument()
    await waitFor(() =>
      expect(api.listWords).toHaveBeenCalledWith('', 'created_desc', 'learned', []),
    )
    expect(params().get('training')).toBe('learned')
    first.unmount()

    renderPage('/')
    expect(screen.getByRole('combobox', { name: 'Обучение' })).toHaveValue('learned')
  })

  it('игнорирует неизвестный фильтр обучения в сохранении', async () => {
    localStorage.setItem(
      'lexicona:words:v1:alice',
      JSON.stringify({ version: 1, sort: 'created_desc', training: 'mastered', tagIds: [] }),
    )
    renderPage('/')
    expect(await screen.findByText('cat')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Обучение' })).toHaveValue('active')
    expect(params().has('training')).toBe(false)
  })

  it('прячет выученное слово из списка «В обучении» и снимает отметку', async () => {
    let learned = false
    vi.mocked(api.listWords).mockImplementation(async (_q, _sort, training = 'active') => {
      const row = { ...word('1', 'cat'), progress: 36, is_learned: learned }
      if (training === 'active' && learned) return []
      if (training === 'learned' && !learned) return []
      return [row]
    })
    vi.mocked(api.setWordLearned).mockImplementation(async (_id, isLearned) => {
      learned = isLearned
      return { ...word('1', 'cat'), progress: 36, is_learned: isLearned }
    })
    const user = userEvent.setup()
    renderPage('/')
    await screen.findByText('cat')
    expect(screen.getByText('36%')).toBeInTheDocument()
    const mark = screen.getByRole('button', { name: 'Отметить «cat» как выученное' })
    expect(mark).toHaveAttribute('aria-pressed', 'false')
    expect(mark).toHaveTextContent('✓')
    expect(mark.parentElement).toContainElement(
      screen.getByRole('button', { name: 'Исключить из обучения «cat»' }),
    )
    await user.click(mark)
    await waitFor(() => expect(screen.queryByText('cat')).not.toBeInTheDocument())
    expect(
      screen.getByText('Нет слов в обучении. Добавьте слово или верните исключённые.'),
    ).toBeInTheDocument()
    expect(api.setWordLearned).toHaveBeenCalledWith('1', true)

    await user.selectOptions(screen.getByRole('combobox', { name: 'Обучение' }), 'learned')
    const clear = await screen.findByRole('button', { name: 'Снять отметку «выучено» с «cat»' })
    expect(clear).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('36%')).toBeInTheDocument()
    await user.click(clear)
    await waitFor(() => expect(screen.queryByText('cat')).not.toBeInTheDocument())
    expect(api.setWordLearned).toHaveBeenLastCalledWith('1', false)
    expect(screen.getByText('Нет выученных слов.')).toBeInTheDocument()
  })

  it('исключает и возвращает слово без сброса прогресса; ошибка допускает повтор', async () => {
    let excluded = false
    let finish!: (value: Word) => void
    vi.mocked(api.listWords).mockImplementation(async () => [
      { ...word('1', 'cat'), progress: 158, is_excluded: excluded },
    ])
    vi.mocked(api.setWordTraining)
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      )
      .mockImplementationOnce(async () => {
        excluded = false
        return { ...word('1', 'cat'), progress: 158, is_excluded: false }
      })
    const user = userEvent.setup()
    renderPage('/?training=all')
    await screen.findByText('cat')
    const row = screen.getByText('cat').closest('li')!
    expect(within(row).queryByText('В обучении')).not.toBeInTheDocument()
    const action = within(row).getByRole('button', { name: 'Исключить из обучения «cat»' })
    expect(action.parentElement).toContainElement(
      within(row).getByRole('button', { name: 'Изменить «cat»' }),
    )
    expect(action.parentElement).toContainElement(
      within(row).getByRole('button', { name: 'Удалить «cat»' }),
    )
    expect(action).toHaveAttribute('title', 'Исключить из обучения')
    expect(within(row).getByRole('button', { name: 'Изменить «cat»' })).toHaveAttribute(
      'title',
      'Изменить',
    )
    expect(within(row).getByRole('button', { name: 'Удалить «cat»' })).toHaveAttribute(
      'title',
      'Удалить',
    )
    expect(within(row).getByText('Выучено')).toBeInTheDocument()
    expect(within(row).getByText('Исключить')).toBeInTheDocument()
    expect(within(row).getByText('Изменить')).toBeInTheDocument()
    expect(within(row).getByText('Удалить')).toBeInTheDocument()
    expect(screen.getByText('158%')).toBeInTheDocument()
    const bar = screen.getByRole('progressbar', { name: 'Прогресс' })
    expect(bar).toHaveAttribute('aria-valuenow', '100')
    expect(bar).toHaveAttribute('aria-valuetext', '158%')
    expect(bar.firstElementChild).toHaveStyle({ width: '100%' })
    await user.click(action)
    expect(await screen.findByRole('alert')).toHaveTextContent('Нет связи с сервером')
    await user.click(screen.getByRole('button', { name: 'Исключить из обучения «cat»' }))
    expect(screen.getByRole('button', { name: 'Исключить из обучения «cat»' })).toBeDisabled()
    excluded = true
    await act(async () => finish({ ...word('1', 'cat'), progress: 158, is_excluded: true }))
    const restore = await screen.findByRole('button', { name: 'Вернуть в обучение «cat»' })
    expect(restore).toHaveAttribute('title', 'Вернуть в обучение')
    expect(screen.getByText('Исключено из обучения')).toBeInTheDocument()
    expect(screen.getByText('158%')).toBeInTheDocument()
    await user.click(restore)
    expect(
      await screen.findByRole('button', { name: 'Исключить из обучения «cat»' }),
    ).toBeInTheDocument()
    expect(api.setWordTraining).toHaveBeenNthCalledWith(2, '1', true)
    expect(api.setWordTraining).toHaveBeenNthCalledWith(3, '1', false)
  })

  it('возвращает прокрутку к началу при открытии и закрытии редактора', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('cat')
    const main = screen.getByRole('main')
    main.scrollTop = 500
    await user.click(screen.getByRole('button', { name: 'Добавить слово' }))
    expect(main.scrollTop).toBe(0)
    main.scrollTop = 300
    await user.click(screen.getByRole('button', { name: 'Отмена' }))
    expect(main.scrollTop).toBe(0)
  })

  it('изолирует новый редактор и возвращает прежние параметры после отмены', async () => {
    vi.mocked(api.listWords).mockRejectedValue(new TypeError('offline'))
    const user = userEvent.setup()
    renderPage('/?q=cat&sort=progress_desc&training=excluded')
    expect(await screen.findByRole('alert')).toHaveTextContent('Нет связи с сервером')
    await user.click(screen.getByRole('button', { name: 'Добавить слово' }))
    expect(screen.getByRole('heading', { name: 'Добавить слово' })).toBeInTheDocument()
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Добавить слово' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Слово или выражение (EN)')).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Отмена' }))
    expect(screen.getByRole('searchbox', { name: 'Поиск' })).toHaveValue('cat')
    expect(screen.getByRole('combobox', { name: 'Сортировка' })).toHaveValue('progress_desc')
    expect(screen.getByRole('combobox', { name: 'Обучение' })).toHaveValue('excluded')
    expect(params().toString()).toBe('q=cat&sort=progress_desc&training=excluded')
  })

  it('изолирует редактирование слова от поиска, фильтра тегов и списка', async () => {
    const user = userEvent.setup()
    renderPage('/?q=cat&sort=progress_desc&training=all')
    await user.click(await screen.findByRole('button', { name: 'Изменить «cat»' }))
    expect(screen.getByRole('heading', { name: 'Редактировать слово' })).toBeInTheDocument()
    expect(screen.getByLabelText('Слово или выражение (EN)')).toHaveValue('cat')
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Теги: все выбранные' })).not.toBeInTheDocument()
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Отмена' }))
    expect(screen.getByRole('searchbox', { name: 'Поиск' })).toHaveValue('cat')
    expect(params().toString()).toBe('q=cat&sort=progress_desc&training=all')
  })

  it('сохраняет черновик при ошибке создания и возвращает обновлённый список при успехе', async () => {
    vi.mocked(api.createWord)
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(word('3', 'cats'))
    const user = userEvent.setup()
    renderPage('/?q=cat&sort=progress_desc&training=all')
    await screen.findByText('cat')
    await user.click(screen.getByRole('button', { name: 'Добавить слово' }))
    await user.type(screen.getByLabelText('Слово или выражение (EN)'), 'cats')
    await user.type(
      screen.getByLabelText('Переводы — по одному в строке, первый основной'),
      'кошки',
    )
    await user.click(screen.getByRole('button', { name: 'Добавить' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Нет связи с сервером')
    expect(screen.getByLabelText('Слово или выражение (EN)')).toHaveValue('cats')
    expect(screen.getByLabelText('Переводы — по одному в строке, первый основной')).toHaveValue(
      'кошки',
    )
    vi.mocked(api.listWords).mockResolvedValue([word('3', 'cats')])
    await user.click(screen.getByRole('button', { name: 'Добавить' }))
    expect(await screen.findByText('cats')).toBeInTheDocument()
    expect(params().toString()).toBe('q=cat&sort=progress_desc&training=all')
    expect(api.listWords).toHaveBeenLastCalledWith('cat', 'progress_desc', 'all', [])
  })

  it('совмещает фильтр любого тега с URL и историей и позволяет снять пустой результат', async () => {
    vi.mocked(api.listTags).mockResolvedValue([
      { id: 'b', name: 'Работа' },
      { id: 'a', name: 'Дом' },
    ])
    vi.mocked(api.listWords).mockImplementation(async (_q, _sort, _training, ids) =>
      ids?.length ? [] : [word('1', 'cat')],
    )
    const user = userEvent.setup()
    renderPage('/?q=cat&sort=progress_desc&training=all')
    expect(screen.getByText('Теги: любой выбранный')).toBeInTheDocument()
    await screen.findByText('cat')
    await user.click(await screen.findByRole('checkbox', { name: 'Работа' }))
    await user.click(screen.getByRole('checkbox', { name: 'Дом' }))
    expect(params().getAll('tag_id')).toEqual(['a', 'b'])
    await waitFor(() =>
      expect(api.listWords).toHaveBeenCalledWith('cat', 'progress_desc', 'all', ['a', 'b']),
    )
    expect(await screen.findByText('Ничего не найдено.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Назад' }))
    expect(screen.getByRole('checkbox', { name: 'Дом' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Работа' })).toBeChecked()
    await user.click(screen.getByRole('button', { name: 'Вперёд' }))
    expect(screen.getByRole('checkbox', { name: 'Дом' })).toBeChecked()
    await user.click(screen.getByRole('button', { name: 'Снять фильтр тегов' }))
    expect(params().getAll('tag_id')).toEqual([])
    expect(params().get('q')).toBe('cat')
    expect(params().get('sort')).toBe('progress_desc')
    expect(params().get('training')).toBe('all')
  })

  it('выбирает, создаёт и снимает теги слова без дубликатов и обновляет справочник', async () => {
    vi.mocked(api.listTags).mockResolvedValue([{ id: '1', name: 'Работа' }])
    vi.mocked(api.createWord).mockResolvedValue(word('3', 'cats'))
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('cat')
    await user.click(screen.getByRole('button', { name: 'Добавить слово' }))
    await user.type(screen.getByLabelText('Слово или выражение (EN)'), 'cats')
    await user.type(
      screen.getByLabelText('Переводы — по одному в строке, первый основной'),
      'кошки',
    )
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Выбрать существующий тег' }),
      'Работа',
    )
    const input = screen.getByRole('textbox', { name: 'Новый тег' })
    await user.type(input, '  работа  ')
    await user.click(screen.getByRole('button', { name: 'Добавить тег' }))
    expect(screen.getByRole('alert')).toHaveTextContent('уже выбран')
    await user.clear(input)
    await user.type(input, ' Дом{Enter}')
    await user.click(screen.getByRole('button', { name: 'Снять тег «Работа»' }))
    await user.click(screen.getByRole('button', { name: 'Добавить' }))
    await waitFor(() =>
      expect(api.createWord).toHaveBeenCalledWith(expect.objectContaining({ tags: ['Дом'] })),
    )
    await waitFor(() => expect(api.listTags).toHaveBeenCalledTimes(2))
  })

  it('разрешает ручной тег при ошибке справочника и сохраняет его в черновике при ошибке', async () => {
    vi.mocked(api.listTags).mockRejectedValue(new TypeError('offline'))
    vi.mocked(api.createWord).mockRejectedValue(new TypeError('offline'))
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('cat')
    await user.click(screen.getByRole('button', { name: 'Добавить слово' }))
    expect(await screen.findByText(/Можно ввести тег вручную/)).toBeInTheDocument()
    await user.type(screen.getByLabelText('Слово или выражение (EN)'), 'cats')
    await user.type(
      screen.getByLabelText('Переводы — по одному в строке, первый основной'),
      'кошки',
    )
    await user.type(screen.getByRole('textbox', { name: 'Новый тег' }), 'Работа{Enter}')
    await user.click(screen.getByRole('button', { name: 'Добавить' }))
    await waitFor(() =>
      expect(api.createWord).toHaveBeenCalledWith(expect.objectContaining({ tags: ['Работа'] })),
    )
    expect(screen.getByRole('button', { name: 'Снять тег «Работа»' })).toBeInTheDocument()
    expect(screen.getByLabelText('Слово или выражение (EN)')).toHaveValue('cats')
  })

  it('показывает теги слова и сохраняет снятие всех тегов при редактировании', async () => {
    const tagged = { ...word('1', 'cat'), tags: [{ id: 't', name: 'Дом' }] }
    vi.mocked(api.listTags).mockResolvedValue(tagged.tags)
    vi.mocked(api.listWords).mockResolvedValue([tagged])
    vi.mocked(api.updateWord).mockResolvedValue({ ...tagged, tags: [] })
    const user = userEvent.setup()
    renderPage()
    const row = (await screen.findByText('cat')).closest('li')!
    expect(within(row).getByText('Дом')).toBeInTheDocument()
    await user.click(within(row).getByRole('button', { name: 'Изменить «cat»' }))
    await user.click(screen.getByRole('button', { name: 'Снять тег «Дом»' }))
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))
    await waitFor(() =>
      expect(api.updateWord).toHaveBeenCalledWith('1', expect.objectContaining({ tags: [] })),
    )
  })

  it('объясняет ограничения длины и количества тегов', async () => {
    const tagged = {
      ...word('1', 'cat'),
      tags: Array.from({ length: 20 }, (_, i) => ({ id: String(i), name: `tag${i}` })),
    }
    vi.mocked(api.listWords).mockResolvedValue([tagged])
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('cat')
    await user.click(screen.getByRole('button', { name: 'Изменить «cat»' }))
    const input = screen.getByRole('textbox', { name: 'Новый тег' })
    await user.type(input, 'x'.repeat(81))
    await user.click(screen.getByRole('button', { name: 'Добавить тег' }))
    expect(screen.getByRole('alert')).toHaveTextContent('от 1 до 80')
    await user.clear(input)
    await user.type(input, 'новый')
    await user.click(screen.getByRole('button', { name: 'Добавить тег' }))
    expect(screen.getByRole('alert')).toHaveTextContent('не больше 20')
  })
})
