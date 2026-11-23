import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError, api, type Session } from './api'
import { App } from './App'
import {
  markOfflineSignedOut,
  readOffline,
  setOfflineOptIn,
  setOfflineOwner,
} from './offlineStorage'
import { queryClient } from './session'

vi.mock('./offlineStorage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./offlineStorage')>()),
  readOffline: vi.fn(),
}))

const ownerId = 'alice'
let online: boolean

function mountApp() {
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  online = true
  vi.stubGlobal('indexedDB', {})
  vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online)
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  setOfflineOwner(ownerId)
  setOfflineOptIn(ownerId, true)
  vi.mocked(readOffline).mockResolvedValue({
    ownerId,
    key: 'saved',
    nextKey: null,
    preparedAt: Date.now(),
    pack: {
      id: 'pack',
      owner_id: ownerId,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      requested_size: 10,
      items: [{ id: 'item', prompt: 'paper' }],
      study: [{ headword: 'ink', translations: ['чернила'] }],
    },
    attempts: [],
    report: null,
  })
})

afterEach(() => {
  cleanup()
  queryClient.clear()
  localStorage.clear()
  sessionStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('opens the prepared pack on a cold offline start without calling the server', async () => {
  online = false
  const me = vi.spyOn(api, 'me').mockImplementation(() => new Promise(() => {}))
  mountApp()

  expect(screen.getByRole('heading', { name: 'Lexicona · Офлайн' })).toBeInTheDocument()
  expect(await screen.findByRole('heading', { name: 'Перевод на русский 1 из 1' })).toBeVisible()
  expect(screen.getByText('чернила')).toBeVisible()
  expect(me).not.toHaveBeenCalled()
})

it('keeps the offline exercise mounted during retry and closes it if the session is rejected', async () => {
  let rejectSession!: (error: ApiError) => void
  const me = vi
    .spyOn(api, 'me')
    .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    .mockReturnValueOnce(
      new Promise<Session>((_resolve, reject) => {
        rejectSession = reject
      }),
    )
  mountApp()

  const exercise = await screen.findByRole('heading', { name: 'Перевод на русский 1 из 1' })
  expect(me).toHaveBeenCalledOnce()
  act(() => window.dispatchEvent(new Event('online')))
  await waitFor(() => {
    expect(me).toHaveBeenCalledTimes(2)
    expect(queryClient.getQueryState(['session'])?.status).toBe('pending')
  })
  expect(exercise).toBeVisible()
  expect(screen.getByRole('heading', { name: 'Перевод на русский 1 из 1' })).toBe(exercise)

  await act(async () => rejectSession(new ApiError(401, 'not_authenticated')))
  expect(await screen.findByRole('heading', { name: 'Lexicona' })).toBeVisible()
  expect(exercise).not.toBeInTheDocument()
})

it.each(['disabled', 'signed out'])(
  'keeps the pack hidden when %s on a cold start',
  async (guard) => {
    online = false
    if (guard === 'disabled') setOfflineOptIn(ownerId, false)
    else markOfflineSignedOut()
    mountApp()

    if (guard === 'disabled')
      expect(await screen.findByRole('alert')).toHaveTextContent('Нет связи')
    else expect(await screen.findByRole('heading', { name: 'Lexicona' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Lexicona · Офлайн' })).not.toBeInTheDocument()
    expect(screen.queryByText('чернила')).not.toBeInTheDocument()
  },
)
