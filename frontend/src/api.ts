export type Difficulty = 'very_easy' | 'easy' | 'medium' | 'hard' | 'very_hard'
export type Direction = 'en_ru' | 'ru_en'
export type TrainingMode = 'choice' | 'input'

export interface User {
  id: string
  login: string
  is_admin: boolean
  difficulty: Difficulty
}

export interface Session {
  user: User
  csrf_token: string
}

export interface WordInput {
  headword: string
  translations: string[]
  transcription: string | null
  example_en: string | null
  example_ru: string | null
  note: string | null
}

export interface Word extends WordInput {
  id: string
  progress: number
  created_at: string
  updated_at: string
}

export interface TrainingItem {
  id: string
  prompt: string
  options: string[]
}

export interface TrainingSession {
  id: string
  mode: TrainingMode
  direction: Direction
  items: TrainingItem[]
}

export interface AnswerResult {
  correct: boolean
  correct_option: number
  chosen_option: number
  delta: number
  progress: number
}

export interface TextAnswerResult {
  correct: boolean
  submitted_text: string
  expected_answers: string[]
  delta: number
  progress: number
}

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, detail: string) {
    super(detail)
    this.status = status
  }
}

// Kept in memory only: never persisted to browser storage.
let csrfToken = ''

export function setCsrfToken(token: string) {
  csrfToken = token
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken
  const response = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) {
    let detail = response.statusText
    try {
      const data: unknown = await response.json()
      if (data && typeof data === 'object' && 'detail' in data && typeof data.detail === 'string')
        detail = data.detail
    } catch {
      // Non-JSON error body: keep the status text.
    }
    throw new ApiError(response.status, detail)
  }
  return (response.status === 204 ? undefined : await response.json()) as T
}

export const api = {
  me: () => request<Session>('GET', '/auth/me'),
  login: (login: string, password: string) =>
    request<Session>('POST', '/auth/login', { login, password }),
  logout: () => request<void>('POST', '/auth/logout'),
  updateSettings: (difficulty: Difficulty) =>
    request<User>('PUT', '/auth/settings', { difficulty }),

  listWords: (q: string) => request<Word[]>('GET', `/words?${new URLSearchParams({ q })}`),
  createWord: (word: WordInput) => request<Word>('POST', '/words', word),
  updateWord: (id: string, word: WordInput) => request<Word>('PUT', `/words/${id}`, word),
  deleteWord: (id: string) => request<void>('DELETE', `/words/${id}`),

  startTraining: (direction: Direction, size: number, mode: TrainingMode = 'choice') =>
    request<TrainingSession>('POST', '/training/sessions', { mode, direction, size }),
  answer: (itemId: string, option: number) =>
    request<AnswerResult>('POST', `/training/items/${itemId}/answer`, { option }),
  answerText: (itemId: string, text: string) =>
    request<TextAnswerResult>('POST', `/training/items/${itemId}/answer`, { text }),
}

const MESSAGES: Record<string, string> = {
  invalid_credentials: 'Неверный логин или пароль.',
  too_many_attempts: 'Слишком много попыток. Попробуйте через 15 минут.',
  not_enough_words: 'Нужно хотя бы 4 слова с разными переводами.',
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError)
    return MESSAGES[error.message] ?? `Ошибка сервера (${error.status}).`
  return 'Нет связи с сервером.'
}
