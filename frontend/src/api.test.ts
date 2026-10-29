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

  it('turns error responses into ApiError with the server detail', async () => {
    mockFetch(401, { detail: 'invalid_credentials' })
    const error = await api.login('a', 'b').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(errorMessage(error)).toBe('Неверный логин или пароль.')
  })

  it('handles empty 204 responses', async () => {
    mockFetch(204)
    await expect(api.deleteWord('id')).resolves.toBeUndefined()
  })

  it('starts cloze with the explicit en_en direction', async () => {
    setCsrfToken('secret')
    const fetchMock = mockFetch(201, { id: 's', mode: 'cloze', direction: 'en_en', items: [] })
    await api.startTraining('en_en', 10, 'cloze')
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe('/api/training/sessions')
    expect(init.body).toBe(JSON.stringify({ mode: 'cloze', direction: 'en_en', size: 10 }))
    expect(init.headers).toMatchObject({ 'X-CSRF-Token': 'secret' })
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
})
