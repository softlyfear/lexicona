import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cancelTrainingSync } from '../accountPreferences'
import { api, type TrainingPreferences } from '../api'
import { Layout } from '../components/Layout'
import { TrainingPage } from './TrainingPage'

vi.mock('../api', async (original) => {
  const actual = await original<typeof import('../api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      startTraining: vi.fn(),
      previewTraining: () =>
        Promise.resolve({
          count: 4,
          selection_seed: '0123456789abcdef0123456789abcdef',
          unavailable_reason: null,
        }),
      latestTraining: () => Promise.resolve(null),
      finishTraining: () => Promise.resolve({ id: 's', status: 'finished', finished_at: '' }),
      listTags: vi.fn(),
      updateSettings: vi.fn(() =>
        Promise.resolve({ id: 'u1', login: 'a', is_admin: false, difficulty: 'medium' as const }),
      ),
    },
  }
})

const base: TrainingPreferences = {
  mode: 'choice',
  direction: 'en_ru',
  purpose: 'free',
  include_new: true,
  size: 10,
  tag_ids: [],
  progress_min: null,
  progress_max: null,
  order: 'random',
  shuffle: false,
}

function renderPage(account: unknown) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['training', 'latest'], null)
  render(
    <QueryClientProvider client={client}>
      <TrainingPage userId="u1" accountTraining={account} />
    </QueryClientProvider>,
  )
}

describe('сохранённые настройки тренировки', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.mocked(api.listTags).mockResolvedValue([{ id: 'a', name: 'Дом' }])
    vi.mocked(api.updateSettings).mockClear()
  })

  afterEach(() => {
    cancelTrainingSync()
    localStorage.clear()
  })

  it('показывает выбор аккаунта и не записывает его заново', async () => {
    renderPage({ ...base, mode: 'input', size: 20 })
    expect(await screen.findByRole('radio', { name: 'Написание перевода: EN → RU' })).toBeChecked()
    expect(screen.getByRole('textbox', { name: 'Своё число слов' })).toHaveValue('20')
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(api.updateSettings).not.toHaveBeenCalled()
  })

  it('один раз отправляет локальный выбор, если на аккаунте его ещё нет', async () => {
    const training = { ...base, purpose: 'scheduled' as const, include_new: false }
    localStorage.setItem('lexicona:training:v1:u1', JSON.stringify({ version: 1, training }))
    renderPage(null)
    expect(await screen.findByRole('radio', { name: 'По расписанию' })).toBeChecked()
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ training }))
  })

  it('в StrictMode тоже один раз отправляет локальный выбор', async () => {
    const training = { ...base, purpose: 'scheduled' as const, include_new: false }
    localStorage.setItem('lexicona:training:v1:u1', JSON.stringify({ version: 1, training }))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    client.setQueryData(['training', 'latest'], null)
    render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={['/training']}>
            <Routes>
              <Route
                element={
                  <Layout user={{ id: 'u1', login: 'a', is_admin: false, difficulty: 'medium' }} />
                }
              >
                <Route
                  path="training"
                  element={<TrainingPage userId="u1" accountTraining={null} />}
                />
              </Route>
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </StrictMode>,
    )
    expect(await screen.findByRole('radio', { name: 'По расписанию' })).toBeChecked()
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledTimes(1))
    expect(api.updateSettings).toHaveBeenCalledWith({ training })
  })

  it('сохраняет новый выбор и убирает удалённый тег', async () => {
    const user = userEvent.setup()
    renderPage({ ...base, tag_ids: ['gone', 'a'] })
    expect(await screen.findByRole('checkbox', { name: 'Дом' })).toBeChecked()
    await waitFor(() =>
      expect(api.updateSettings).toHaveBeenCalledWith({ training: { ...base, tag_ids: ['a'] } }),
    )
    await user.click(screen.getByRole('radio', { name: 'По расписанию' }))
    await waitFor(() =>
      expect(api.updateSettings).toHaveBeenCalledWith({
        training: { ...base, tag_ids: ['a'], purpose: 'scheduled', include_new: true },
      }),
    )
    expect(JSON.parse(localStorage.getItem('lexicona:training:v1:u1')!).training.purpose).toBe(
      'scheduled',
    )
  })
})
