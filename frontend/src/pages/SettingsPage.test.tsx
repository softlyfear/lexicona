import { QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api, type Session } from '../api'
import { Layout } from '../components/Layout'
import {
  forgetSession,
  loginSession,
  logoutSession,
  queryClient,
  rememberSession,
  useSession,
} from '../session'
import { AccountPage } from './AccountPage'
import { SettingsPage } from './SettingsPage'

const initial: Session = {
  user: { id: 'a', login: 'alice', is_admin: false, difficulty: 'medium' },
  csrf_token: 'old',
}
const rotated: Session = { ...initial, csrf_token: 'new' }

function Settings() {
  const session = useSession()
  if (!session.data) return <p>Вход</p>
  return <SettingsPage user={session.data.user} />
}

function Account() {
  const session = useSession()
  if (!session.data) return <p>Вход</p>
  return <AccountPage user={session.data.user} />
}

function renderSettings() {
  return render(
    <QueryClientProvider client={queryClient}>
      <Settings />
    </QueryClientProvider>,
  )
}

function renderAccount() {
  return render(
    <QueryClientProvider client={queryClient}>
      <Account />
    </QueryClientProvider>,
  )
}

function fill(current: string, next: string, confirm: string) {
  fireEvent.change(screen.getByLabelText('Текущий пароль'), { target: { value: current } })
  fireEvent.change(screen.getByLabelText('Новый пароль'), { target: { value: next } })
  fireEvent.change(screen.getByLabelText('Повторите новый пароль'), { target: { value: confirm } })
}

describe('профиль и смена пароля', () => {
  beforeEach(() => {
    sessionStorage.clear()
    rememberSession(initial)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    forgetSession()
    queryClient.clear()
  })

  it('логин в шапке — ссылка на профиль, пять уровней подписаны процентами', async () => {
    const user = userEvent.setup()
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route element={<Layout user={initial.user} />}>
              <Route index element={<p>Словарь</p>} />
              <Route path="account" element={<Account />} />
              <Route path="settings" element={<Settings />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    const link = screen.getByRole('link', { name: 'alice' })
    expect(link).toHaveAttribute('href', '/account')
    await user.click(link)
    expect(screen.getByRole('heading', { name: 'Аккаунт' })).toBeInTheDocument()
    expect(screen.getByText(/Логин:/)).toHaveTextContent('alice')
    expect(screen.getByRole('heading', { name: 'Смена пароля' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Озвучивание' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('link', { name: 'Настройки' }))
    expect(screen.queryByRole('heading', { name: 'Смена пароля' })).not.toBeInTheDocument()
    for (const text of [
      'выбор ±10% · ввод +20%/−10%',
      'выбор ±7% · ввод +14%/−7%',
      'выбор ±4% · ввод +8%/−4%',
      'выбор ±3% · ввод +6%/−3%',
      'выбор ±2% · ввод +4%/−2%',
    ])
      expect(screen.getByText(text)).toBeInTheDocument()
  })

  it('проверяет длину Unicode и подтверждение, не отправляя невалидные данные', async () => {
    const change = vi.spyOn(api, 'changePassword')
    const user = userEvent.setup()
    renderAccount()
    fill('old', '😀'.repeat(11), '😀'.repeat(11))
    await user.click(screen.getByRole('button', { name: 'Сменить пароль' }))
    expect(screen.getByRole('alert')).toHaveTextContent('от 12 до 128 символов')
    fill('old', '😀'.repeat(12), '😀'.repeat(11))
    await user.click(screen.getByRole('button', { name: 'Сменить пароль' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Пароли не совпадают')
    fill('old', '😀'.repeat(129), '😀'.repeat(129))
    await user.click(screen.getByRole('button', { name: 'Сменить пароль' }))
    expect(screen.getByRole('alert')).toHaveTextContent('от 12 до 128 символов')
    expect(change).not.toHaveBeenCalled()
  })

  it('Enter отправляет Unicode без обрезки, блокирует повтор и обновляет CSRF', async () => {
    let resolve!: (session: Session) => void
    const change = vi.spyOn(api, 'changePassword').mockReturnValue(
      new Promise((r) => {
        resolve = r
      }),
    )
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    renderAccount()
    const password = '😀'.repeat(12)
    fill(' old ', password, password)
    expect(screen.getByLabelText('Текущий пароль')).toHaveAttribute(
      'autocomplete',
      'current-password',
    )
    expect(screen.getByLabelText('Новый пароль')).toHaveAttribute('autocomplete', 'new-password')
    expect(screen.getByLabelText('Новый пароль')).not.toHaveAttribute('maxlength')
    await user.click(screen.getByLabelText('Повторите новый пароль'))
    await user.keyboard('{Enter}')
    expect(change).toHaveBeenCalledWith(' old ', password)
    expect(screen.getByRole('button', { name: 'Сменить пароль' })).toBeDisabled()
    await user.keyboard('{Enter}')
    expect(change).toHaveBeenCalledTimes(1)
    await act(async () => resolve(rotated))
    expect(
      await screen.findByText('Пароль изменён. Остальные сеансы завершены.'),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Текущий пароль')).toHaveValue('')
    expect(screen.getByLabelText('Новый пароль')).toHaveValue('')
    expect(screen.getByLabelText('Повторите новый пароль')).toHaveValue('')
    expect(queryClient.getQueryData(['session'])).toEqual(rotated)
    await api.setWordTraining('i', true)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.headers).toMatchObject({ 'X-CSRF-Token': 'new' })
  })

  it('неверный текущий пароль не разлогинивает и оставляет поля для исправления', async () => {
    vi.spyOn(api, 'changePassword').mockRejectedValue(new ApiError(400, 'invalid_current_password'))
    const user = userEvent.setup()
    renderAccount()
    fill('bad', 'long password 1', 'long password 1')
    await user.click(screen.getByRole('button', { name: 'Сменить пароль' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Неверный текущий пароль')
    expect(screen.getByLabelText('Текущий пароль')).toHaveValue('bad')
    expect(queryClient.getQueryData(['session'])).toEqual(initial)
  })

  it('поздний ответ сложности не перезаписывает другой аккаунт', async () => {
    let resolve!: (value: Session['user']) => void
    vi.spyOn(api, 'updateSettings').mockReturnValue(
      new Promise((r) => {
        resolve = r
      }),
    )
    const user = userEvent.setup()
    renderSettings()
    await user.click(screen.getByLabelText(/Очень легко/))
    expect(screen.getByLabelText(/Очень легко/)).toBeDisabled()
    const bob = { user: { ...initial.user, id: 'b', login: 'bob' }, csrf_token: 'bob' }
    vi.spyOn(api, 'login').mockResolvedValue(bob)
    await act(async () => {
      await loginSession('bob', 'secret')
    })
    await act(async () => resolve({ ...initial.user, difficulty: 'very_easy' }))
    expect(queryClient.getQueryData(['session'])).toEqual(bob)
  })

  it('401 смены пароля закрывает только текущую сессию', async () => {
    vi.spyOn(api, 'changePassword').mockRejectedValue(new ApiError(401, 'not_authenticated'))
    const user = userEvent.setup()
    renderAccount()
    fill('old', 'long password 1', 'long password 1')
    await user.click(screen.getByRole('button', { name: 'Сменить пароль' }))
    expect(await screen.findByText('Вход')).toBeInTheDocument()
    expect(queryClient.getQueryData(['session'])).toBeNull()
  })

  it('при потерянном ответе обновляет CSRF через me, но не заявляет об успехе', async () => {
    const change = vi.spyOn(api, 'changePassword').mockRejectedValue(new TypeError('offline'))
    const me = vi.spyOn(api, 'me').mockResolvedValue(rotated)
    const user = userEvent.setup()
    renderAccount()
    fill('old', 'long password 1', 'long password 1')
    await user.click(screen.getByRole('button', { name: 'Сменить пароль' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Не удалось подтвердить смену пароля',
    )
    expect(
      screen.queryByText('Пароль изменён. Остальные сеансы завершены.'),
    ).not.toBeInTheDocument()
    expect(change).toHaveBeenCalledTimes(1)
    expect(me).toHaveBeenCalledOnce()
    expect(queryClient.getQueryData(['session'])).toEqual(rotated)
  })

  it('при недоступной сессии после потери ответа предлагает заново войти', async () => {
    vi.spyOn(api, 'changePassword').mockRejectedValue(new SyntaxError('bad JSON'))
    vi.spyOn(api, 'me').mockRejectedValue(new TypeError('offline'))
    const user = userEvent.setup()
    renderAccount()
    fill('old', 'long password 1', 'long password 1')
    await user.click(screen.getByRole('button', { name: 'Сменить пароль' }))
    expect(await screen.findByText('Вход')).toBeInTheDocument()
    expect(sessionStorage.getItem('require-explicit-login')).toBe('1')
    expect(
      screen.queryByText('Пароль изменён. Остальные сеансы завершены.'),
    ).not.toBeInTheDocument()
  })

  it('поздняя сверка me после смены аккаунта не восстанавливает прежнюю сессию', async () => {
    let resolve!: (session: Session) => void
    vi.spyOn(api, 'changePassword').mockRejectedValue(new TypeError('offline'))
    const me = vi.spyOn(api, 'me').mockReturnValue(
      new Promise((r) => {
        resolve = r
      }),
    )
    const user = userEvent.setup()
    renderAccount()
    fill('old', 'long password 1', 'long password 1')
    await user.click(screen.getByRole('button', { name: 'Сменить пароль' }))
    await waitFor(() => expect(me).toHaveBeenCalledOnce())
    const bob = { user: { ...initial.user, id: 'b', login: 'bob' }, csrf_token: 'bob' }
    vi.spyOn(api, 'logoutWithCsrf').mockResolvedValue()
    const login = vi.spyOn(api, 'login').mockResolvedValue(bob)
    let queued!: ReturnType<typeof loginSession>
    act(() => {
      void logoutSession()
      queued = loginSession('bob', 'secret')
    })
    expect(login).not.toHaveBeenCalled()
    await act(async () => {
      resolve(rotated)
      await queued
    })
    expect(queryClient.getQueryData(['session'])).toEqual(bob)
    expect(
      screen.queryByText('Пароль изменён. Остальные сеансы завершены.'),
    ).not.toBeInTheDocument()
  })

  it('поздний ответ после выхода и входа другого аккаунта не восстанавливает прежний', async () => {
    let resolve!: (session: Session) => void
    vi.spyOn(api, 'changePassword').mockReturnValue(
      new Promise((r) => {
        resolve = r
      }),
    )
    const user = userEvent.setup()
    renderAccount()
    fill('old', 'long password 1', 'long password 1')
    await user.click(screen.getByRole('button', { name: 'Сменить пароль' }))
    vi.spyOn(api, 'logoutWithCsrf').mockResolvedValue()
    act(() => {
      void logoutSession()
    })
    await act(async () => resolve(rotated))
    await waitFor(() => expect(queryClient.getQueryData(['session'])).not.toEqual(rotated))
    expect(queryClient.getQueryData(['session'])).toBeNull()
  })
})
