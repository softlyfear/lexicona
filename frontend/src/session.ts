import { QueryCache, QueryClient, MutationCache, useQuery } from '@tanstack/react-query'
import { ApiError, api, setCsrfToken, type Session } from './api'

const SESSION_KEY = ['session']

function onError(error: unknown) {
  // Any 401 means the session is gone: drop to the login screen.
  if (error instanceof ApiError && error.status === 401) forgetSession()
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError }),
  mutationCache: new MutationCache({ onError }),
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
})

async function loadSession(): Promise<Session | null> {
  try {
    const session = await api.me()
    setCsrfToken(session.csrf_token)
    return session
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null
    throw error
  }
}

export function useSession() {
  return useQuery({ queryKey: SESSION_KEY, queryFn: loadSession, staleTime: Infinity })
}

export function rememberSession(session: Session) {
  setCsrfToken(session.csrf_token)
  queryClient.setQueryData(SESSION_KEY, session)
}

export function forgetSession() {
  setCsrfToken('')
  // Drop every cached query, including in-flight ones, so the next account
  // never sees data or late responses from the previous one.
  queryClient.cancelQueries()
  queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== SESSION_KEY[0] })
  queryClient.setQueryData(SESSION_KEY, null)
}
