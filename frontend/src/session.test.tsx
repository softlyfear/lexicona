import { QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, type Session } from './api'
import {
  changePasswordSession,
  forgetSession,
  getSessionRevision,
  loginSession,
  logoutSession,
  queryClient,
  rememberSession,
  useSession,
} from './session'

const alice: Session = {
  user: { id: 'a', login: 'alice', is_admin: false, difficulty: 'medium' },
  csrf_token: 'alice-old-csrf',
}
const rotated: Session = { ...alice, csrf_token: 'alice-new-csrf' }
const bob: Session = {
  user: { id: 'b', login: 'bob', is_admin: false, difficulty: 'medium' },
  csrf_token: 'bob-csrf',
}

function SessionProbe() {
  const result = useSession()
  return <span>{result.isPending ? 'loading' : (result.data?.user.login ?? 'signed out')}</span>
}

function mountProbe() {
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionProbe />
    </QueryClientProvider>,
  )
}

function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

const response = (status: number, data?: unknown) =>
  data === undefined
    ? new Response(null, { status })
    : new Response(JSON.stringify(data), { status })

describe('последовательность auth и cookie', () => {
  beforeEach(() => {
    sessionStorage.clear()
    queryClient.clear()
    rememberSession(alice)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    forgetSession()
    queryClient.clear()
    sessionStorage.clear()
  })

  it('late Alice cookie отзывается до входа Bob и reload восстанавливает Bob', async () => {
    let cookie: string | null = 'alice-old'
    const sessions: Record<string, Session> = { 'alice-old': alice, 'alice-new': rotated, bob }
    const rotation = deferred()
    const cleanup = deferred()
    const events: string[] = []
    const fetchMock = vi.fn(async (path: string, init: RequestInit) => {
      const csrf = (init.headers as Record<string, string>)['X-CSRF-Token']
      if (path === '/api/auth/change-password') {
        events.push('rotation-start')
        await rotation.promise
        cookie = 'alice-new'
        events.push('rotation-cookie')
        return response(200, rotated)
      }
      if (path === '/api/auth/logout') {
        events.push(`logout-${csrf}`)
        if (csrf === 'alice-new-csrf') await cleanup.promise
        if (!cookie || sessions[cookie]?.csrf_token !== csrf)
          return response(401, { detail: 'not_authenticated' })
        delete sessions[cookie]
        cookie = null
        return response(204)
      }
      if (path === '/api/auth/login') {
        events.push('bob-login')
        cookie = 'bob'
        return response(200, bob)
      }
      if (path === '/api/auth/me')
        return cookie && sessions[cookie]
          ? response(200, sessions[cookie])
          : response(401, { detail: 'not_authenticated' })
      throw new Error(`unexpected path ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const changed = changePasswordSession(getSessionRevision(), 'a', 'old', 'new password')
    await waitFor(() => expect(events).toContain('rotation-start'))
    const logout = logoutSession()
    const login = loginSession('bob', 'password')
    expect(queryClient.getQueryData(['session'])).toBeNull()
    expect(sessionStorage.getItem('require-explicit-login')).toBe('1')
    await act(async () => {
      rotation.release()
      await Promise.resolve()
    })
    await waitFor(() => expect(events).toContain('logout-alice-new-csrf'))
    expect(cookie).toBe('alice-new')
    expect(events).not.toContain('bob-login')
    await act(async () => {
      cleanup.release()
      await Promise.all([changed, logout, login])
    })
    expect(events.indexOf('logout-alice-new-csrf')).toBeLessThan(events.indexOf('bob-login'))
    expect(sessions['alice-new']).toBeUndefined()
    expect(cookie).toBe('bob')
    expect(queryClient.getQueryData(['session'])).toEqual(bob)
    expect(sessionStorage.getItem('require-explicit-login')).toBeNull()
    queryClient.clear()
    const view = mountProbe()
    expect(await screen.findByText('bob')).toBeInTheDocument()
    view.unmount()
  })

  it.each(['cleanup failure', 'lost response body'] as const)(
    '%s: reload не восстанавливает Alice до явного входа',
    async (failure) => {
      let cookie: string | null = 'alice-old'
      const rotation = deferred()
      const events: string[] = []
      const sessions: Record<string, Session> = { 'alice-old': alice, 'alice-new': rotated, bob }
      const fetchMock = vi.fn(async (path: string, init: RequestInit) => {
        const csrf = (init.headers as Record<string, string>)['X-CSRF-Token']
        if (path === '/api/auth/change-password') {
          events.push('rotation-start')
          await rotation.promise
          cookie = 'alice-new'
          return failure === 'lost response body'
            ? new Response('{invalid', { status: 200 })
            : response(200, rotated)
        }
        if (path === '/api/auth/logout') {
          events.push(`logout-${csrf}`)
          if (failure === 'cleanup failure' && csrf === 'alice-new-csrf')
            throw new TypeError('network')
          if (!cookie || sessions[cookie]?.csrf_token !== csrf)
            return response(403, { detail: 'csrf' })
          cookie = null
          return response(204)
        }
        if (path === '/api/auth/me') {
          events.push('me')
          if (failure === 'lost response body' && cookie === 'alice-new')
            throw new TypeError('network')
          return cookie && sessions[cookie]
            ? response(200, sessions[cookie])
            : response(401, { detail: 'not_authenticated' })
        }
        if (path === '/api/auth/login') {
          events.push('bob-login')
          cookie = 'bob'
          return response(200, bob)
        }
        throw new Error(`unexpected path ${path}`)
      })
      vi.stubGlobal('fetch', fetchMock)
      const changed = changePasswordSession(getSessionRevision(), 'a', 'old', 'new password')
      await waitFor(() => expect(events).toContain('rotation-start'))
      const logout = logoutSession()
      await act(async () => {
        rotation.release()
        await Promise.all([changed, logout])
      })
      expect(cookie).toBe('alice-new')
      expect(sessionStorage.getItem('require-explicit-login')).toBe('1')
      const meCount = events.filter((event) => event === 'me').length
      queryClient.clear()
      const view = mountProbe()
      expect(await screen.findByText('signed out')).toBeInTheDocument()
      expect(events.filter((event) => event === 'me')).toHaveLength(meCount)
      await act(async () => {
        expect((await loginSession('bob', 'password')).kind).toBe('success')
      })
      expect(sessionStorage.getItem('require-explicit-login')).toBeNull()
      expect(cookie).toBe('bob')
      view.unmount()
      queryClient.clear()
      const reloaded = mountProbe()
      expect(await screen.findByText('bob')).toBeInTheDocument()
      reloaded.unmount()
    },
  )

  it('запоздавший login не снимает guard и отзывается до следующего входа', async () => {
    let cookie: string | null = null
    const late = deferred()
    const events: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string, init: RequestInit) => {
        if (path === '/api/auth/login') {
          const body = JSON.parse(String(init.body)) as { login: string }
          events.push(`login-${body.login}`)
          if (body.login === 'alice') {
            await late.promise
            cookie = 'alice'
            return response(200, rotated)
          }
          cookie = 'bob'
          return response(200, bob)
        }
        if (path === '/api/auth/logout') {
          const csrf = (init.headers as Record<string, string>)['X-CSRF-Token']
          events.push(`logout-${csrf}`)
          if (cookie === 'alice' && csrf === rotated.csrf_token) cookie = null
          return response(204)
        }
        throw new Error(`unexpected path ${path}`)
      }),
    )
    forgetSession()
    const first = loginSession('alice', 'password')
    await waitFor(() => expect(events).toContain('login-alice'))
    const logout = logoutSession()
    const second = loginSession('bob', 'password')
    expect(events).not.toContain('login-bob')
    await act(async () => {
      late.release()
      await Promise.all([first, logout, second])
    })
    expect(events).toEqual(['login-alice', 'logout-alice-new-csrf', 'login-bob'])
    expect(cookie).toBe('bob')
    expect(queryClient.getQueryData(['session'])).toEqual(bob)
  })

  it('поздний 401 старой мутации не завершает новую сессию', async () => {
    const gate = deferred()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => {
        if (path === '/api/words/word-a/learned') {
          await gate.promise
          return response(401, { detail: 'not_authenticated' })
        }
        if (path === '/api/auth/login') return response(200, bob)
        throw new Error(`unexpected path ${path}`)
      }),
    )
    const mutation = queryClient.getMutationCache().build(queryClient, {
      mutationFn: () => api.setWordLearned('word-a', true),
    })
    const oldRequest = mutation.execute(undefined).catch(() => undefined)
    expect((await loginSession('bob', 'password')).kind).toBe('success')
    gate.release()
    await oldRequest
    expect(queryClient.getQueryData(['session'])).toEqual(bob)
    expect(sessionStorage.getItem('require-explicit-login')).toBeNull()
  })

  it('401 текущей сессии по-прежнему завершает вход', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(401, { detail: 'not_authenticated' })),
    )
    const mutation = queryClient.getMutationCache().build(queryClient, {
      mutationFn: () => api.setWordLearned('word-a', true),
    })
    await mutation.execute(undefined).catch(() => undefined)
    expect(queryClient.getQueryData(['session'])).toBeNull()
    expect(sessionStorage.getItem('require-explicit-login')).toBe('1')
  })

  it('поздний ответ /me после выхода не обходит guard после повторного открытия', async () => {
    const gate = deferred()
    const fetchMock = vi.fn(async (path: string) => {
      expect(path).toBe('/api/auth/me')
      await gate.promise
      return response(200, alice)
    })
    vi.stubGlobal('fetch', fetchMock)
    queryClient.clear()
    const view = mountProbe()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    act(() => {
      void logoutSession()
    })
    await act(async () => {
      gate.release()
      await gate.promise
    })
    expect(await screen.findByText('signed out')).toBeInTheDocument()
    expect(sessionStorage.getItem('require-explicit-login')).toBe('1')
    view.unmount()
    queryClient.clear()
    const reloaded = mountProbe()
    expect(await screen.findByText('signed out')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    reloaded.unmount()
  })
})
