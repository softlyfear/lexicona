export type Difficulty = 'very_easy' | 'easy' | 'medium' | 'hard' | 'very_hard'
export type Direction = 'en_ru' | 'ru_en' | 'en_en'
export type TrainingMode = 'choice' | 'input' | 'cards' | 'cloze'
export type CardGrade = 'again' | 'hard' | 'good' | 'easy'
export type WordSort =
  | 'created_desc'
  | 'created_asc'
  | 'headword_asc'
  | 'headword_desc'
  | 'progress_asc'
  | 'progress_desc'
export type WordTrainingFilter = 'active' | 'excluded' | 'all'
export type TrainingSize = number | 'all'
export interface TrainingFilters {
  tag_ids?: string[]
  progress_min?: number | null
  progress_max?: number | null
}

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
  tags?: string[]
}

export interface Tag {
  id: string
  name: string
}

export interface Word extends Omit<WordInput, 'tags'> {
  id: string
  progress: number
  is_excluded: boolean
  created_at: string
  updated_at: string
  tags: Tag[]
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
  outcome: 'answered'
  correct: boolean
  correct_option: number
  chosen_option: number
  delta: number
  progress: number
}

export interface TextAnswerResult {
  outcome: 'answered'
  correct: boolean
  submitted_text: string
  expected_answers: string[]
  delta: number
  progress: number
}

export interface CardRevealResult {
  outcome: 'revealed'
  expected_answers: string[]
}

export interface CardAnswerResult {
  outcome: 'answered'
  expected_answers: string[]
  grade: CardGrade
  delta: number
  progress: number
}

export interface AssistedResult {
  outcome: 'assisted'
  expected_answers: string[]
  correct_option?: number
  delta: 0
  progress: number
}

export interface SkippedResult {
  outcome: 'skipped'
  delta: 0
  progress: number
}

export interface UnavailableResult {
  outcome: 'unavailable'
  reason: 'training_state_changed'
  delta: 0
  progress: number
}

export type TerminalResult =
  | AnswerResult
  | TextAnswerResult
  | CardAnswerResult
  | AssistedResult
  | SkippedResult
  | UnavailableResult
export type RevealResult = CardRevealResult | TerminalResult

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

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  csrfOverride?: string,
): Promise<T> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (method !== 'GET') headers['X-CSRF-Token'] = csrfOverride ?? csrfToken
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

function validSession(value: unknown): value is Session {
  if (!value || typeof value !== 'object' || !('csrf_token' in value) || !('user' in value))
    return false
  const user = value.user
  return (
    typeof value.csrf_token === 'string' &&
    value.csrf_token.length > 0 &&
    !!user &&
    typeof user === 'object' &&
    'id' in user &&
    typeof user.id === 'string' &&
    'login' in user &&
    typeof user.login === 'string' &&
    'is_admin' in user &&
    typeof user.is_admin === 'boolean' &&
    'difficulty' in user &&
    ['very_easy', 'easy', 'medium', 'hard', 'very_hard'].includes(String(user.difficulty))
  )
}

async function sessionRequest(method: string, path: string, body?: unknown): Promise<Session> {
  const result = await request<unknown>(method, path, body)
  if (!validSession(result)) throw new Error('invalid_session_response')
  return result
}

export const api = {
  me: () => sessionRequest('GET', '/auth/me'),
  login: (login: string, password: string) =>
    sessionRequest('POST', '/auth/login', { login, password }),
  logout: () => request<void>('POST', '/auth/logout'),
  logoutWithCsrf: (csrf: string) => request<void>('POST', '/auth/logout', undefined, csrf),
  changePassword: (currentPassword: string, newPassword: string) =>
    sessionRequest('POST', '/auth/change-password', {
      current_password: currentPassword,
      new_password: newPassword,
    }),
  updateSettings: (difficulty: Difficulty) =>
    request<User>('PUT', '/auth/settings', { difficulty }),

  listWords: (
    q: string,
    sort: WordSort = 'created_desc',
    training: WordTrainingFilter = 'active',
    tagIds: string[] = [],
  ) => {
    const params = new URLSearchParams({ q, sort, training })
    for (const id of tagIds) params.append('tag_id', id)
    return request<Word[]>('GET', `/words?${params}`)
  },
  listTags: () => request<Tag[]>('GET', '/tags'),
  createWord: (word: WordInput) => request<Word>('POST', '/words', word),
  updateWord: (id: string, word: WordInput) => request<Word>('PUT', `/words/${id}`, word),
  deleteWord: (id: string) => request<void>('DELETE', `/words/${id}`),
  setWordTraining: (id: string, isExcluded: boolean) =>
    request<Word>('PATCH', `/words/${id}/training`, { is_excluded: isExcluded }),

  startTraining: (
    direction: Direction,
    size: TrainingSize,
    mode: TrainingMode = 'choice',
    filters?: TrainingFilters,
  ) =>
    request<TrainingSession>('POST', '/training/sessions', { mode, direction, size, ...filters }),
  answer: (itemId: string, option: number) =>
    request<TerminalResult>('POST', `/training/items/${itemId}/answer`, { option }),
  answerText: (itemId: string, text: string) =>
    request<TerminalResult>('POST', `/training/items/${itemId}/answer`, { text }),
  revealCard: (itemId: string) => request<RevealResult>('POST', `/training/items/${itemId}/reveal`),
  revealAnswer: (itemId: string) =>
    request<TerminalResult>('POST', `/training/items/${itemId}/reveal`),
  skipItem: (itemId: string) => request<TerminalResult>('POST', `/training/items/${itemId}/skip`),
  answerCard: (itemId: string, grade: CardGrade) =>
    request<TerminalResult>('POST', `/training/items/${itemId}/answer`, { grade }),
}

const MESSAGES: Record<string, string> = {
  invalid_credentials: 'Неверный логин или пароль.',
  invalid_current_password: 'Неверный текущий пароль.',
  too_many_attempts: 'Слишком много попыток. Попробуйте через 15 минут.',
  not_enough_words: 'Нужно хотя бы 6 подходящих активных слов с различными словами и переводами.',
  no_eligible_cloze_examples:
    'Добавьте английский пример, где слово или выражение встречается ровно один раз целиком.',
  tag_not_found: 'Один из выбранных тегов недоступен. Снимите его и повторите поиск.',
  no_matching_words:
    'Нет подходящих слов. Измените или очистите фильтры либо добавьте слова в словарь.',
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError)
    return MESSAGES[error.message] ?? `Ошибка сервера (${error.status}).`
  return 'Нет связи с сервером.'
}
