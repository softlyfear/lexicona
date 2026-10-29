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
    api: { listWords: vi.fn(), createWord: vi.fn(), updateWord: vi.fn(), deleteWord: vi.fn() },
  }
})

const word = (id: string, headword: string): Word => ({
  id,
  headword,
  translations: ['перевод'],
  progress: 10,
  transcription: null,
  example_en: null,
  example_ru: null,
  note: null,
  created_at: '',
  updated_at: '',
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

function renderPage(url = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <Navigation />
        <WordsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function params() {
  return new URLSearchParams(screen.getByTestId('url').textContent ?? '')
}

describe('сортировка словаря', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(api.listWords).mockResolvedValue([word('1', 'cat'), word('2', 'dog')])
  })

  it('читает начальные q и sort из URL и меняет только выбранный параметр', async () => {
    const user = userEvent.setup()
    renderPage('/?q=cat&sort=progress_asc')
    expect(await screen.findByText('cat')).toBeInTheDocument()
    expect(screen.getByRole('searchbox', { name: 'Поиск' })).toHaveValue('cat')
    const select = screen.getByRole('combobox', { name: 'Сортировка' })
    expect(select).toHaveValue('progress_asc')
    expect(api.listWords).toHaveBeenCalledWith('cat', 'progress_asc')
    await user.selectOptions(select, 'headword_desc')
    expect(params().get('q')).toBe('cat')
    expect(params().get('sort')).toBe('headword_desc')
    await waitFor(() => expect(api.listWords).toHaveBeenCalledWith('cat', 'headword_desc'))
    await user.clear(screen.getByRole('searchbox', { name: 'Поиск' }))
    await user.type(screen.getByRole('searchbox', { name: 'Поиск' }), 'dog')
    expect(params().get('q')).toBe('dog')
    expect(params().get('sort')).toBe('headword_desc')
    await waitFor(() => expect(api.listWords).toHaveBeenCalledWith('dog', 'headword_desc'))
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
    await waitFor(() => expect(api.listWords).toHaveBeenCalledWith('cat', 'created_asc'))
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

  it('при неизвестной сортировке использует безопасный default и позволяет выбрать все шесть', async () => {
    const user = userEvent.setup()
    renderPage('/?q=cat&sort=malicious')
    expect(await screen.findByText('cat')).toBeInTheDocument()
    const select = screen.getByRole('combobox', { name: 'Сортировка' })
    expect(select).toHaveValue('created_desc')
    expect(api.listWords).toHaveBeenCalledWith('cat', 'created_desc')
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
      await waitFor(() => expect(api.listWords).toHaveBeenCalledWith('cat', value))
      expect(params().get('q')).toBe('cat')
    }
    expect(params().has('sort')).toBe(false)
  })

  it('показывает обновление предыдущего списка и сохраняет открытый редактор', async () => {
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
    await user.click(screen.getByRole('button', { name: 'Изменить «cat»' }))
    const input = screen.getByLabelText('Слово или выражение (EN)')
    await user.clear(input)
    await user.type(input, 'cat draft')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Сортировка' }), 'created_asc')
    expect(await screen.findByRole('status')).toHaveTextContent('Обновляем список')
    expect(screen.getByText('cat')).toBeInTheDocument()
    expect(input).toHaveValue('cat draft')
    await act(async () => resolve([word('2', 'dog'), word('1', 'cat')]))
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
    expect(screen.getByLabelText('Слово или выражение (EN)')).toHaveValue('cat draft')
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
    await waitFor(() => expect(api.listWords).toHaveBeenCalledWith('pet', 'created_desc'))
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
})
