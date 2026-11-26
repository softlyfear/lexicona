import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { App } from './App'

const speechState = vi.hoisted(() => ({ notice: '', enLocale: 'en-GB' }))
const speechControls = vi.hoisted(() => ({
  speak: vi.fn(),
  cancelSpeech: vi.fn(),
}))

vi.mock('./session', async (original) => ({
  ...(await original<typeof import('./session')>()),
  useSession: () => ({
    data: {
      user: { id: 'a', login: 'alice', is_admin: false, difficulty: 'medium' },
      csrf_token: 'test',
    },
    isPending: false,
    isError: false,
  }),
  requiresExplicitLogin: () => false,
  getSessionRevision: () => 0,
  logoutSession: vi.fn(),
}))

vi.mock('./useOfflinePractice', () => ({
  useOfflinePractice: () => ({ offline: false }),
}))

vi.mock('./accountPreferences', async (original) => ({
  ...(await original<typeof import('./accountPreferences')>()),
  bindSpeechSync: () => ({ publish: vi.fn(), stop: vi.fn() }),
  speechFromAccount: () => null,
  cancelTrainingSync: vi.fn(),
}))

vi.mock('./speech', async (original) => ({
  ...(await original<typeof import('./speech')>()),
  useSpeech: () => ({
    preferences: { enLocale: speechState.enLocale },
    notice: speechState.notice,
    busy: false,
  }),
  setSpeechAccountPublisher: vi.fn(),
  setSpeechOwner: vi.fn(),
  cancelSpeech: speechControls.cancelSpeech,
  speak: speechControls.speak,
}))

vi.mock('./pages/WordsPage', () => ({
  WordsPage: () => <h1>Словарь</h1>,
}))

beforeEach(() => {
  window.history.replaceState(null, '', '/')
  speechState.notice = ''
  speechState.enLocale = 'en-GB'
  speechControls.speak.mockClear()
  speechControls.cancelSpeech.mockClear()
})

afterEach(() => {
  cleanup()
  window.history.replaceState(null, '', '/')
  vi.clearAllMocks()
})

it('открывает /sounds из основной навигации и останавливает речь при уходе с маршрута', async () => {
  const user = userEvent.setup()
  render(<App />)

  await user.click(screen.getByRole('link', { name: 'Звуки' }))
  expect(await screen.findByRole('heading', { name: 'Звуки' })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Звуки' })).toHaveAttribute('aria-current', 'page')
  expect(window.location.pathname).toBe('/sounds')

  await user.click(screen.getByRole('button', { name: 'Прослушать /iː/, британский акцент' }))
  expect(speechControls.speak).toHaveBeenCalledWith('see', 'en', { force: true, locale: 'en-GB' })
  await user.click(screen.getByRole('link', { name: 'Словарь' }))
  expect(await screen.findByRole('heading', { name: 'Словарь' })).toBeInTheDocument()
  expect(speechControls.cancelSpeech).toHaveBeenCalled()
})

it('открывает прямой маршрут и оставляет ошибки общей речи видимыми в Layout', async () => {
  window.history.replaceState(null, '', '/sounds')
  speechState.notice = 'Не удалось воспроизвести речь.'
  render(<App />)

  expect(await screen.findByRole('heading', { name: 'Звуки' })).toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('Не удалось воспроизвести речь.')
})
