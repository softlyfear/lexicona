export type Difficulty = 'very_easy' | 'easy' | 'medium' | 'hard' | 'very_hard'
export type Direction = 'en_ru' | 'ru_en' | 'en_en'
export type TrainingMode = 'choice' | 'input' | 'cards' | 'matching' | 'cloze'
export type NewTrainingMode = Exclude<TrainingMode, 'cards' | 'cloze'>
export type TrainingPurpose = 'scheduled' | 'free'
export type CardGrade = 'again' | 'hard' | 'good' | 'easy'
export type WordSort =
  | 'created_desc'
  | 'created_asc'
  | 'headword_asc'
  | 'headword_desc'
  | 'progress_asc'
  | 'progress_desc'
export type WordTrainingFilter = 'active' | 'excluded' | 'learned' | 'all'
export type TrainingSize = number | 'all'
export type TrainingOrder =
  | 'random'
  | 'reviewed_desc'
  | 'reviewed_asc'
  | 'created_desc'
  | 'created_asc'
  | 'progress_asc'
  | 'progress_desc'
export interface TrainingFilters {
  tag_ids?: string[]
  progress_min?: number | null
  progress_max?: number | null
  order?: TrainingOrder
  shuffle?: boolean
  include_learned?: boolean
}

export interface TrainingPreview {
  count: number
  selection_seed: string
  unavailable_reason: 'no_matching_words' | 'no_scheduled_words' | 'not_enough_words' | null
}

export interface TrainingPreferences {
  mode: NewTrainingMode
  direction: 'en_ru' | 'ru_en'
  purpose: TrainingPurpose
  include_new: boolean
  size: number | 'all'
  tag_ids: string[]
  progress_min: number | null
  progress_max: number | null
  order: TrainingOrder
  shuffle: boolean
  include_learned: boolean
}

export interface SpeechPreferencesDto {
  en_locale: string
  en_voice_uri: string | null
  ru_voice_uri: string | null
  rate: 0.5 | 0.75 | 1 | 1.25 | 1.5
  auto_prompt: boolean
  speak_en: boolean
  speak_ru: boolean
  engine_en: 'auto' | 'server' | 'browser'
  engine_ru: 'auto' | 'server' | 'browser'
  server_en_us: string | null
  server_en_gb: string | null
  server_ru: string | null
}

export interface AccountPreferences {
  training?: TrainingPreferences | null
  speech?: SpeechPreferencesDto | null
}

export interface SettingsUpdate {
  difficulty?: Difficulty
  training?: TrainingPreferences | null
  speech?: SpeechPreferencesDto | null
}

export interface User {
  id: string
  login: string
  is_admin: boolean
  difficulty: Difficulty
  preferences?: AccountPreferences | null
}

export interface Session {
  user: User
  csrf_token: string
}

export interface SourceRef {
  source_id: 'freedict-wikdict-eng-rus-2025.11.23'
  entry_id: number
  field: 'translation' | 'transcription'
  value: string
}

export interface DictionarySource {
  id: SourceRef['source_id']
  title: string
  edition: string
  license: string
  license_url: string
  source_url: string
  credits: string
}

export interface DictionaryMatch {
  entry_id: number
  headword: string
  part_of_speech: string | null
  translations: string[]
  transcriptions: string[]
  match: 'exact' | 'normalized'
}

export interface MachineTranslation {
  provider: 'deepl' | 'openrouter'
  text: string
  alternatives?: string[]
  transcription?: string | null
}

export interface DictionaryLookup {
  source: DictionarySource
  matches: DictionaryMatch[]
  spelling_suggestions?: string[]
  machine_translation?: MachineTranslation | null
  machine_transcription?: string | null
}
export interface DictionaryNotices {
  source: DictionarySource
  sha256: string
  copying: string
  tei_header: string
  transformations: string[]
}

export interface WordInput {
  headword: string
  translations: string[]
  transcription: string | null
  example_en: string | null
  example_ru: string | null
  note: string | null
  tags?: string[]
  source_refs?: SourceRef[]
}

export interface Tag {
  id: string
  name: string
}

export interface Word extends Omit<WordInput, 'tags'> {
  id: string
  progress: number
  is_excluded: boolean
  is_learned: boolean
  created_at: string
  updated_at: string
  tags: Tag[]
}

export interface TrainingItem {
  id: string
  prompt: string
  options: string[]
  transcription?: string | null
  word_id?: string | null
}

export interface TrainingSession {
  id: string
  mode: TrainingMode
  direction: Direction
  purpose: TrainingPurpose
  items: TrainingItem[]
}

export interface TrainingSummary {
  id: string
  total: number
  completion: {
    answered: number
    assisted: number
    skipped: number
    unavailable: number
    pending: number
  }
  first_attempt: {
    correct: number
    incorrect: number
    unknown: number
    not_attempted: number
    not_applicable: number
    accuracy_percent: number | null
  }
}

export interface RetryableResult {
  outcome: 'retryable'
  correct: false
  chosen_option?: number
  submitted_text?: string
  delta: number
  progress: number
}

export interface ResumedItem extends TrainingItem {
  state: 'open' | 'retryable' | 'revealed' | 'done'
  result: RetryableResult | RevealResult | null
}

export interface ResumedSession extends Omit<TrainingSession, 'items'> {
  status: 'active' | 'finished'
  created_at: string
  finished_at: string | null
  requested_size: TrainingSize | null
  resume_error?: 'invalid_matching_snapshot'
  items: ResumedItem[]
}

export type StatisticsPeriod = '30d' | 'year' | 'all'
export interface Statistics {
  period: StatisticsPeriod
  history_started_at: string | null
  total_words: number
  learned_words: number
  unlearned_words: number
  total_answers: number
  correct_answers: number
  accuracy_percent: number | null
  average_answers_per_day: number
  active_days: number
  days: { date: string; answers: number; correct: number }[]
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
  reason: 'training_state_changed' | 'word_deleted'
  delta: 0
  progress: number | null
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
  readonly sessionGeneration: number | undefined

  constructor(status: number, detail: string, sessionGeneration?: number) {
    super(detail)
    this.status = status
    this.sessionGeneration = sessionGeneration
  }
}

export interface ServerVoice {
  id: string
  name: string
  language: 'en-US' | 'en-GB' | 'ru-RU'
  gender: 'female' | 'male' | 'nonbinary'
}

// Kept in memory only: never persisted to browser storage.
let csrfToken = ''
let sessionGeneration = 0

export function setCsrfToken(token: string) {
  if (csrfToken !== token) sessionGeneration += 1
  csrfToken = token
}

export function isCurrentApiError(error: ApiError) {
  return error.sessionGeneration === undefined || error.sessionGeneration === sessionGeneration
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  csrfOverride?: string,
  signal?: AbortSignal,
  binary = false,
): Promise<T> {
  const requestGeneration = sessionGeneration
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (method !== 'GET') headers['X-CSRF-Token'] = csrfOverride ?? csrfToken
  const response = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  })
  if (!response.ok) {
    let detail = response.statusText
    try {
      const data: unknown = await response.json()
      if (data && typeof data === 'object' && 'detail' in data && typeof data.detail === 'string')
        detail = data.detail
    } catch {}
    throw new ApiError(response.status, detail, requestGeneration)
  }
  return (
    response.status === 204 ? undefined : binary ? await response.blob() : await response.json()
  ) as T
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
  listSpeechVoices: (signal?: AbortSignal) =>
    request<{ voices: ServerVoice[]; available: boolean }>(
      'GET',
      '/speech/voices',
      undefined,
      undefined,
      signal,
    ),
  synthesizeSpeech: (
    text: string,
    voiceId: string,
    rate: 0.5 | 0.75 | 1 | 1.25 | 1.5,
    signal: AbortSignal,
  ) =>
    request<Blob>(
      'POST',
      '/speech/synthesize',
      { text, voice_id: voiceId, rate },
      undefined,
      signal,
      true,
    ),
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
  updateSettings: (body: SettingsUpdate) => request<User>('PUT', '/auth/settings', body),

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
  lookupDictionary: (headword: string) =>
    request<DictionaryLookup>('POST', '/dictionary/lookup', { headword }),
  generateExample: (headword: string, previousExamples: string[]) =>
    request<{ example_en: string; example_ru: string }>('POST', '/dictionary/example', {
      headword,
      previous_examples: previousExamples,
    }),
  dictionaryNotices: () => request<DictionaryNotices>('GET', '/dictionary/notices'),
  listTags: () => request<Tag[]>('GET', '/tags'),
  createWord: (word: WordInput) => request<Word>('POST', '/words', word),
  getWord: (id: string) => request<Word>('GET', `/words/${id}`),
  updateWord: (id: string, word: WordInput) => request<Word>('PUT', `/words/${id}`, word),
  deleteWord: (id: string) => request<void>('DELETE', `/words/${id}`),
  setWordTraining: (id: string, isExcluded: boolean) =>
    request<Word>('PATCH', `/words/${id}/training`, { is_excluded: isExcluded }),
  setWordLearned: (id: string, isLearned: boolean) =>
    request<Word>('PATCH', `/words/${id}/learned`, { is_learned: isLearned }),

  startTraining: (
    direction: Direction,
    size: TrainingSize,
    mode: NewTrainingMode = 'choice',
    filters?: TrainingFilters,
    purpose: TrainingPurpose = 'free',
    includeNew = true,
    selectionSeed?: string,
  ) =>
    request<TrainingSession>('POST', '/training/sessions', {
      mode,
      direction,
      size,
      purpose,
      include_new: includeNew,
      selection_seed: selectionSeed,
      ...filters,
    }),
  previewTraining: (
    direction: Direction,
    size: TrainingSize,
    mode: NewTrainingMode,
    filters: TrainingFilters | undefined,
    purpose: TrainingPurpose,
    includeNew: boolean,
  ) =>
    request<TrainingPreview>('POST', '/training/sessions/preview', {
      mode,
      direction,
      size,
      purpose,
      include_new: includeNew,
      ...filters,
    }),
  latestTraining: () => request<ResumedSession | null>('GET', '/training/sessions/latest'),
  getTraining: (id: string) => request<ResumedSession>('GET', `/training/sessions/${id}`),
  trainingSummary: (id: string) =>
    request<TrainingSummary>('GET', `/training/sessions/${id}/summary`),
  finishTraining: (id: string) =>
    request<{ id: string; status: 'finished'; finished_at: string }>(
      'POST',
      `/training/sessions/${id}/finish`,
    ),
  statistics: (period: StatisticsPeriod) =>
    request<Statistics>('GET', `/statistics?period=${period}`),
  answer: (itemId: string, option: number) =>
    request<TerminalResult>('POST', `/training/items/${itemId}/answer`, { option }),
  answerText: (itemId: string, text: string) =>
    request<TerminalResult>('POST', `/training/items/${itemId}/answer`, { text }),
  letterHint: (itemId: string, text: string) =>
    request<{ text: string; complete: boolean }>('POST', `/training/items/${itemId}/hint`, {
      text,
    }),
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
  dictionary_timeout:
    'Поиск перевода занял слишком много времени. Попробуйте ещё раз или введите данные вручную.',
  examples_timeout:
    'Составление примера заняло слишком много времени. Попробуйте ещё раз или введите его вручную.',
  not_enough_words: 'Нужно хотя бы 6 подходящих активных слов с различными словами и переводами.',
  no_eligible_cloze_examples:
    'Добавьте английский пример, где слово или выражение встречается ровно один раз целиком.',
  word_exists: 'Такое слово или выражение уже есть в словаре.',
  word_not_found: 'Слово уже удалено.',
  tag_not_found: 'Один из выбранных тегов недоступен. Снимите его и повторите поиск.',
  no_matching_words:
    'Нет подходящих слов. Измените или очистите фильтры либо добавьте слова в словарь.',
  no_scheduled_words:
    'Сейчас нет слов для занятия по расписанию. Включите новые слова или выберите свободную практику.',
  PROGRESS_CHANGED:
    'Ответ не засчитан: слово изменилось в другом занятии. Пропустите это задание и продолжите.',
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError)
    return MESSAGES[error.message] ?? `Ошибка сервера (${error.status}).`
  return 'Нет связи с сервером.'
}
