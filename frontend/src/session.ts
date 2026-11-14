import { QueryCache, QueryClient, MutationCache, useQuery } from '@tanstack/react-query'
import { cancelSpeech } from './speech'
import { ApiError, api, isCurrentApiError, setCsrfToken, type Session } from './api'

const SESSION_KEY = ['session']
const EXPLICIT_LOGIN_KEY = 'require-explicit-login'
let sessionRevision = 0
let authTail: Promise<void> = Promise.resolve()

function requireExplicitLogin() {
  try {
    sessionStorage.setItem(EXPLICIT_LOGIN_KEY, '1')
  } catch {
    /* A blocked store fails closed below. */
  }
}

export function requiresExplicitLogin() {
  try {
    return sessionStorage.getItem(EXPLICIT_LOGIN_KEY) === '1'
  } catch {
    return true
  }
}

function clearExplicitLogin() {
  sessionStorage.removeItem(EXPLICIT_LOGIN_KEY)
}

function authChannel<T>(operation: () => Promise<T>): Promise<T> {
  const result = authTail.then(operation)
  authTail = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

export function getSessionRevision() {
  return sessionRevision
}

export function isCurrentSession(revision: number, userId: string) {
  const current = queryClient.getQueryData<Session | null>(SESSION_KEY)
  return revision === sessionRevision && current?.user.id === userId && !requiresExplicitLogin()
}

function onError(error: unknown) {
  if (error instanceof ApiError && error.status === 401 && isCurrentApiError(error)) forgetSession()
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError }),
  mutationCache: new MutationCache({ onError }),
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
})

async function loadSession(): Promise<Session | null> {
  const revision = sessionRevision
  if (requiresExplicitLogin()) return null
  try {
    const session = await api.me()
    if (revision !== sessionRevision || requiresExplicitLogin())
      return queryClient.getQueryData<Session | null>(SESSION_KEY) ?? null
    setCsrfToken(session.csrf_token)
    return session
  } catch (error) {
    if (revision !== sessionRevision || requiresExplicitLogin())
      return queryClient.getQueryData<Session | null>(SESSION_KEY) ?? null
    if (error instanceof ApiError && error.status === 401) return null
    throw error
  }
}

export function useSession() {
  return useQuery({ queryKey: SESSION_KEY, queryFn: loadSession, staleTime: Infinity })
}

export function rememberSession(session: Session) {
  if (requiresExplicitLogin()) return
  const current = queryClient.getQueryData<Session | null>(SESSION_KEY)
  if (current && current.user.id !== session.user.id) cancelSpeech()
  sessionRevision += 1
  setCsrfToken(session.csrf_token)
  queryClient.setQueryData(SESSION_KEY, session)
}

export function forgetSession() {
  cancelSpeech()
  requireExplicitLogin()
  sessionRevision += 1
  setCsrfToken('')
  queryClient.cancelQueries()
  queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== SESSION_KEY[0] })
  queryClient.setQueryData(SESSION_KEY, null)
}

async function cleanupSession(session: Session) {
  try {
    await api.logoutWithCsrf(session.csrf_token)
  } catch {
    /* The explicit-login guard remains set even if cleanup is unavailable. */
  }
}

export function logoutSession() {
  const session = queryClient.getQueryData<Session | null>(SESSION_KEY)
  forgetSession()
  return authChannel(async () => {
    if (session) await cleanupSession(session)
  })
}

type LoginResult = { kind: 'success' } | { kind: 'stale' } | { kind: 'error'; error: unknown }

export function loginSession(login: string, password: string): Promise<LoginResult> {
  // This is an explicit account switch, even if an old operation is still pending.
  forgetSession()
  const revision = sessionRevision
  return authChannel(async () => {
    if (revision !== sessionRevision) return { kind: 'stale' }
    let session: Session
    try {
      session = await api.login(login, password)
    } catch (error) {
      return { kind: revision === sessionRevision ? 'error' : 'stale', error } as LoginResult
    }
    if (revision !== sessionRevision) {
      await cleanupSession(session)
      return { kind: 'stale' }
    }
    try {
      clearExplicitLogin()
    } catch (error) {
      await cleanupSession(session)
      return { kind: 'error', error }
    }
    rememberSession(session)
    return { kind: 'success' }
  })
}

type PasswordResult =
  | { kind: 'success' }
  | { kind: 'error'; error: unknown }
  | { kind: 'uncertain'; recovered: boolean }
  | { kind: 'stale' }

export function changePasswordSession(
  revision: number,
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<PasswordResult> {
  return authChannel(async () => {
    if (!isCurrentSession(revision, userId)) return { kind: 'stale' }
    let session: Session
    try {
      session = await api.changePassword(currentPassword, newPassword)
    } catch (error) {
      const uncertain = !(error instanceof ApiError) || error.status >= 500
      if (!uncertain)
        return {
          kind: isCurrentSession(revision, userId) ? 'error' : 'stale',
          error,
        } as PasswordResult
      // A response body may have been lost after the browser accepted the new cookie.
      try {
        const current = await api.me()
        if (!isCurrentSession(revision, userId)) {
          await cleanupSession(current)
          return { kind: 'stale' }
        }
        if (current.user.id !== userId) {
          forgetSession()
          return { kind: 'uncertain', recovered: false }
        }
        rememberSession(current)
        return { kind: 'uncertain', recovered: true }
      } catch {
        if (isCurrentSession(revision, userId)) forgetSession()
        return { kind: 'uncertain', recovered: false }
      }
    }
    if (!isCurrentSession(revision, userId) || session.user.id !== userId) {
      if (isCurrentSession(revision, userId)) forgetSession()
      await cleanupSession(session)
      return { kind: 'stale' }
    }
    rememberSession(session)
    return { kind: 'success' }
  })
}
