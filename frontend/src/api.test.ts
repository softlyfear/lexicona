import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api, errorMessage, setCsrfToken } from './api'

function mockFetch(status: number, body?: unknown) {
  const fetchMock = vi.fn(async () =>
    body === undefined
      ? new Response(null, { status })
      : new Response(JSON.stringify(body), { status }),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
  setCsrfToken('')
})

describe('api', () => {
  it('requests AI translation drafts explicitly through OpenRouter without lookup or word writes', async () => {
    setCsrfToken('secret')
    const result = { provider: 'openrouter', translations: ['книга', 'бронировать'] }
    const fetchMock = mockFetch(200, result)
    await expect(api.generateTranslations('book')).resolves.toEqual(result)
    expect(fetchMock).toHaveBeenCalledOnce()
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe('/api/dictionary/translations')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ 'X-CSRF-Token': 'secret' })
    expect(JSON.parse(init.body as string)).toEqual({ headword: 'book' })
  })

  it('accepts five bounded Unicode translations using character rather than UTF-16 length', async () => {
    const response = {
      provider: 'openrouter',
      translations: Array.from({ length: 5 }, (_, i) => `${i}${'😀'.repeat(199)}`),
    }
    mockFetch(200, response)
    await expect(api.generateTranslations('word')).resolves.toEqual(response)
  })

  it.each([
    null,
    { provider: 'deepl', translations: ['книга'] },
    { provider: 'openrouter', translations: [] },
    { provider: 'openrouter', translations: Array(6).fill('книга') },
    { provider: 'openrouter', translations: ['x'.repeat(201)] },
    { provider: 'openrouter', translations: ['one\ntwo'] },
    { provider: 'openrouter', translations: ['   '] },
    { provider: 'openrouter', translations: [null] },
  ])('rejects malformed or out-of-bounds AI draft output: %j', async (response) => {
    mockFetch(200, response)
    await expect(api.generateTranslations('book')).rejects.toMatchObject({
      status: 503,
      message: 'translations_unavailable',
    })
  })

  it.each([
    [503, 'translations_unavailable', 'Не удалось получить переводы ИИ'],
    [504, 'translations_timeout', 'слишком много времени'],
  ])('maps translation failure %s safely', async (status, detail, message) => {
    mockFetch(status as number, { detail })
    try {
      await api.generateTranslations('book')
      expect.unreachable()
    } catch (error) {
      expect(errorMessage(error)).toContain(message)
      expect(errorMessage(error)).toContain('вручную')
    }
  })
  it('requests only a transcription draft with CSRF without word mutations or translation lookup', async () => {
    setCsrfToken('secret')
    const fetchMock = mockFetch(200, { transcription: '/bʊk/' })
    await expect(api.generateTranscription('book')).resolves.toEqual({ transcription: '/bʊk/' })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe('/api/dictionary/transcription')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('same-origin')
    expect(init.headers).toMatchObject({
      'X-CSRF-Token': 'secret',
      'Content-Type': 'application/json',
    })
    expect(JSON.parse(init.body as string)).toEqual({ headword: 'book' })
  })

  it.each([
    ['lookup', api.lookupDictionary],
    ['transcription', api.generateTranscription],
  ] as const)('sends an explicit UK pronunciation preference to %s', async (path, request) => {
    const fetchMock = mockFetch(200, {})
    await request('schedule', 'UK')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`/api/dictionary/${path}`)
    expect(JSON.parse(init.body as string)).toEqual({ headword: 'schedule', dialect: 'UK' })
  })

  it.each([
    [503, 'transcription_unavailable', 'Не удалось получить транскрипцию'],
    [504, 'transcription_timeout', 'слишком много времени'],
  ])(
    'maps safe transcription failure %s to an actionable message',
    async (status, detail, message) => {
      mockFetch(status as number, { detail })
      try {
        await api.generateTranscription('book')
        expect.unreachable()
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError)
        expect(errorMessage(error)).toContain(message)
        expect(errorMessage(error)).toContain('вручную')
      }
    },
  )
  it('saves automatic next as an independent scalar with CSRF without sending preference sections', async () => {
    setCsrfToken('secret')
    const fetchMock = mockFetch(200, {})
    await api.updateSettings({ training_auto_advance: true })
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe('/api/auth/settings')
    expect(init.method).toBe('PUT')
    expect(init.headers).toMatchObject({ 'X-CSRF-Token': 'secret' })
    expect(JSON.parse(init.body as string)).toEqual({ training_auto_advance: true })
  })
  it('requests session summary read-only through the shared request entry point', async () => {
    setCsrfToken('secret')
    const fetchMock = mockFetch(200, { id: 'session' })
    await api.trainingSummary('session')
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe('/api/training/sessions/session/summary')
    expect(init.method).toBe('GET')
    expect(init.headers).not.toHaveProperty('X-CSRF-Token')
    expect(init.credentials).toBe('same-origin')
  })
  it('sends speech synthesis with CSRF and abort signal and returns binary audio', async () => {
    setCsrfToken('secret')
    const fetchMock = vi.fn(async () => new Response('wav', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const blob = await api.synthesizeSpeech('hello', 'voice', 0.75, controller.signal)
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe('/api/speech/synthesize')
    expect(init.headers).toMatchObject({ 'X-CSRF-Token': 'secret' })
    expect(init.body).toBe(JSON.stringify({ text: 'hello', voice_id: 'voice', rate: 0.75 }))
    expect(init.signal).toBeInstanceOf(AbortSignal)
    controller.abort()
    expect(init.signal?.aborted).toBe(true)
    expect(blob.size).toBe(3)
  })
  it('sends the CSRF token only on mutations', async () => {
    setCsrfToken('secret')
    const fetchMock = mockFetch(200, [])
    await api.listWords('')
    await api.createWord({
      headword: 'cat',
      translations: ['кот'],
      transcription: null,
      example_en: null,
      example_ru: null,
      note: null,
    })
    const [, getInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const [, postInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
    expect(getInit.headers).not.toHaveProperty('X-CSRF-Token')
    expect(postInit.headers).toMatchObject({
      'X-CSRF-Token': 'secret',
      'Content-Type': 'application/json',
    })
  })

  it('sends search and sort parameters to the dictionary endpoint', async () => {
    const fetchMock = mockFetch(200, [])
    await api.listWords('ёж cat', 'progress_desc', 'excluded', ['a', 'b'])
    const [path] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const url = new URL(path, 'http://test')
    expect(url.pathname).toBe('/api/words')
    expect(url.searchParams.get('q')).toBe('ёж cat')
    expect(url.searchParams.get('sort')).toBe('progress_desc')
    expect(url.searchParams.get('training')).toBe('excluded')
    expect(url.searchParams.getAll('tag_id')).toEqual(['a', 'b'])
    await api.listWords('')
    const [defaultPath] = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
    expect(new URL(defaultPath, 'http://test').searchParams.get('sort')).toBe('created_desc')
    expect(new URL(defaultPath, 'http://test').searchParams.get('training')).toBe('active')
  })

  it('sends dictionary lookup in the POST body with CSRF, and notices by GET', async () => {
    setCsrfToken('secret')
    const fetchMock = mockFetch(200, {})
    await api.lookupDictionary('private word')
    await api.dictionaryNotices()
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe('/api/dictionary/lookup')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ 'X-CSRF-Token': 'secret' })
    expect(init.body).toBe(JSON.stringify({ headword: 'private word' }))
    const [noticesPath, noticesInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
    expect(noticesPath).toBe('/api/dictionary/notices')
    expect(noticesInit.method).toBe('GET')
  })

  it('sends previous examples for diverse generation', async () => {
    setCsrfToken('secret')
    const fetchMock = mockFetch(200, {})
    await api.generateExample('sleep', ['I sleep early.'])
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe('/api/dictionary/example')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ 'X-CSRF-Token': 'secret' })
    expect(init.body).toBe(
      JSON.stringify({ headword: 'sleep', previous_examples: ['I sleep early.'] }),
    )
  })

  it('updates word training state with CSRF and strict boolean body', async () => {
    setCsrfToken('secret')
    const fetchMock = mockFetch(200, { id: 'word', is_excluded: true })
    await api.setWordTraining('word', true)
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe('/api/words/word/training')
    expect(init.method).toBe('PATCH')
    expect(init.headers).toMatchObject({
      'X-CSRF-Token': 'secret',
      'Content-Type': 'application/json',
    })
    expect(init.body).toBe(JSON.stringify({ is_excluded: true }))
  })

  it('marks a word learned with CSRF and a strict boolean body', async () => {
    setCsrfToken('secret')
    const fetchMock = mockFetch(200, { id: 'word', is_learned: true })
    await api.setWordLearned('word', true)
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe('/api/words/word/learned')
    expect(init.method).toBe('PATCH')
    expect(init.headers).toMatchObject({
      'X-CSRF-Token': 'secret',
      'Content-Type': 'application/json',
    })
    expect(init.body).toBe(JSON.stringify({ is_learned: true }))
  })

  it('turns error responses into ApiError with the server detail', async () => {
    mockFetch(401, { detail: 'invalid_credentials' })
    const error = await api.login('a', 'b').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(errorMessage(error)).toBe('Неверный логин или пароль.')
    expect(errorMessage(new ApiError(409, 'word_exists'))).toBe(
      'Такое слово или выражение уже есть в словаре.',
    )
  })

  it('sends untrimmed passwords with CSRF and accepts a rotated session', async () => {
    setCsrfToken('old-csrf')
    const session = {
      user: { id: 'u', login: 'alice', is_admin: false, difficulty: 'medium' },
      csrf_token: 'new-csrf',
    }
    const fetchMock = mockFetch(200, session)
    await expect(api.changePassword(' old ', '😀😀😀😀😀😀😀😀😀😀😀😀')).resolves.toEqual(session)
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe('/api/auth/change-password')
    expect(init.headers).toMatchObject({ 'X-CSRF-Token': 'old-csrf' })
    expect(init.body).toBe(
      JSON.stringify({ current_password: ' old ', new_password: '😀😀😀😀😀😀😀😀😀😀😀😀' }),
    )
  })

  it('rejects a malformed session response after password change', async () => {
    mockFetch(200, { user: { id: 'u' } })
    await expect(api.changePassword('old', 'new password')).rejects.toThrow(
      'invalid_session_response',
    )
  })

  it('handles empty 204 responses', async () => {
    mockFetch(204)
    await expect(api.deleteWord('id')).resolves.toBeUndefined()
  })

  it('starts matching with the explicit en_ru direction and additive defaults', async () => {
    setCsrfToken('secret')
    const fetchMock = mockFetch(201, {
      id: 's',
      mode: 'matching',
      direction: 'en_ru',
      purpose: 'free',
      items: [],
    })
    await api.startTraining('en_ru', 10, 'matching')
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe('/api/training/sessions')
    expect(init.body).toBe(
      JSON.stringify({
        mode: 'matching',
        direction: 'en_ru',
        size: 10,
        purpose: 'free',
        include_new: true,
      }),
    )
    expect(init.headers).toMatchObject({ 'X-CSRF-Token': 'secret' })
  })

  it('sends all and training filters with the free purpose', async () => {
    const fetchMock = mockFetch(201, { id: 's', purpose: 'free', items: [] })
    await api.startTraining('en_ru', 'all', 'choice', {
      tag_ids: ['a', 'b'],
      progress_min: 100,
      progress_max: 158,
    })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({
      mode: 'choice',
      direction: 'en_ru',
      size: 'all',
      purpose: 'free',
      include_new: true,
      tag_ids: ['a', 'b'],
      progress_min: 100,
      progress_max: 158,
    })
  })

  it('sends scheduled options and returns the server session purpose', async () => {
    const session = {
      id: 's',
      mode: 'choice',
      direction: 'en_ru',
      purpose: 'scheduled',
      items: [],
    } as const
    const fetchMock = mockFetch(201, session)
    await expect(
      api.startTraining('en_ru', 10, 'choice', undefined, 'scheduled', false),
    ).resolves.toEqual(session)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({
      mode: 'choice',
      direction: 'en_ru',
      size: 10,
      purpose: 'scheduled',
      include_new: false,
    })
  })

  it('uses the preview endpoint with CSRF and sends its seed when starting', async () => {
    setCsrfToken('secret')
    const seed = '0123456789abcdef0123456789abcdef'
    const fetchMock = mockFetch(200, { count: 2, selection_seed: seed, unavailable_reason: null })
    const filters = {
      tag_ids: ['a'],
      progress_min: 10,
      order: 'progress_asc' as const,
      shuffle: true,
    }
    const preview = await api.previewTraining(
      'en_ru',
      'all',
      'matching',
      filters,
      'scheduled',
      false,
    )
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe('/api/training/sessions/preview')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ 'X-CSRF-Token': 'secret' })
    expect(JSON.parse(init.body as string)).toEqual({
      mode: 'matching',
      direction: 'en_ru',
      size: 'all',
      purpose: 'scheduled',
      include_new: false,
      ...filters,
    })
    await api.startTraining(
      'en_ru',
      'all',
      'matching',
      filters,
      'scheduled',
      false,
      preview.selection_seed,
    )
    const [, startInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
    expect(JSON.parse(startInit.body as string)).toMatchObject({ selection_seed: seed, ...filters })
  })

  it('sends reveal and skip mutations with CSRF and no payload', async () => {
    setCsrfToken('secret')
    const fetchMock = mockFetch(200, { outcome: 'skipped', delta: 0, progress: 5 })
    await api.revealAnswer('item')
    await api.skipItem('item')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const [path, init] of fetchMock.mock.calls as unknown as [string, RequestInit][]) {
      expect(path).toMatch(/^\/api\/training\/items\/item\/(reveal|skip)$/)
      expect(init.method).toBe('POST')
      expect(init.headers).toMatchObject({ 'X-CSRF-Token': 'secret' })
      expect(init.body).toBeUndefined()
    }
  })

  it('reports network failures in plain words', () => {
    expect(errorMessage(new TypeError('Failed to fetch'))).toBe('Нет связи с сервером.')
  })

  it('bounds requests with a timeout signal and explains timeouts', async () => {
    const fetchMock = mockFetch(200, [])
    await api.listWords('', 'created_desc', 'active', [])
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(errorMessage(new DOMException('late', 'TimeoutError'))).toContain('время ожидания')
  })

  it('keeps the timeout when a caller signal is passed and AbortSignal.any is missing', async () => {
    const originalAny = AbortSignal.any
    Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined })
    const timeout = new AbortController()
    const originalTimeout = AbortSignal.timeout
    AbortSignal.timeout = () => timeout.signal
    try {
      const fetchMock = mockFetch(200, { voices: [], available: false })
      const caller = new AbortController()
      await api.listSpeechVoices(caller.signal)
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(init.signal).toBeInstanceOf(AbortSignal)
      expect(init.signal).not.toBe(caller.signal)
      expect(init.signal?.aborted).toBe(false)
      caller.abort()
      expect(init.signal?.aborted).toBe(true)

      const second = mockFetch(200, { voices: [], available: false })
      const hanging = new AbortController()
      await api.listSpeechVoices(hanging.signal)
      const [, limited] = second.mock.calls[0] as unknown as [string, RequestInit]
      timeout.abort()
      expect(limited.signal?.aborted).toBe(true)
    } finally {
      AbortSignal.timeout = originalTimeout
      Object.defineProperty(AbortSignal, 'any', { configurable: true, value: originalAny })
    }
  })
})
