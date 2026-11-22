import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, type OfflinePack, type TrainingSize } from './api'
import { type OfflineRecord } from './offlineStorage'
import { recordOfflineAnswer, syncOffline } from './offlineSync'

let stored: OfflineRecord
let optIn: string | null
const optionListeners = new Set<() => void>()

vi.mock('./offlineStorage', () => ({
  offlineSignedOut: () => false,
  offlineDiscardRequested: () => false,
  offlineOptIn: () => optIn,
  listenOfflineOptIn: (_ownerId: string, listener: () => void) => {
    optionListeners.add(listener)
    return () => optionListeners.delete(listener)
  },
  clearOfflineDiscard: vi.fn(),
  readOffline: async () => structuredClone(stored),
  updateOffline: async (update: (value: OfflineRecord) => OfflineRecord | undefined) => {
    const next = update(structuredClone(stored))
    if (next) stored = next
  },
}))

function pack(id: string, requestedSize: TrainingSize): OfflinePack {
  return {
    id,
    owner_id: 'alice',
    expires_at: '2027-08-02T00:00:00Z',
    requested_size: requestedSize,
    items: [
      { id: 'item-1', prompt: 'paper' },
      { id: 'item-2', prompt: 'ink' },
    ],
    study: [],
  }
}

function sync(size: TrainingSize) {
  return syncOffline('alice', size, () => true, vi.fn())
}

describe('offline exercise size', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2027-06-01T12:00:00Z'))
    optIn = 'initial-opt-in'
    stored = {
      ownerId: 'alice',
      key: 'current-key',
      nextKey: null,
      preparedAt: Date.now(),
      pack: pack('current-pack', 10),
      attempts: [],
      report: null,
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('replaces an untouched legacy package immediately using the saved requested size', async () => {
    delete stored.pack?.requested_size
    const replacement = pack('all-pack', 'all')
    const prepare = vi.spyOn(api, 'offlinePack').mockResolvedValue(replacement)

    await sync('all')

    expect(prepare).toHaveBeenCalledOnce()
    expect(prepare.mock.calls[0]?.[0]).toMatch(/^[a-f0-9]{32}$/)
    expect(stored).toMatchObject({ pack: replacement, nextKey: null, attempts: [] })
    await sync('all')
    expect(prepare).toHaveBeenCalledOnce()
  })

  it('reserves a fresh key if an earlier preparation committed at a different size', async () => {
    stored.nextKey = 'older-request-key'
    const prepare = vi
      .spyOn(api, 'offlinePack')
      .mockResolvedValueOnce(pack('older-pack', 5))
      .mockResolvedValueOnce(pack('new-pack', 'all'))

    await sync('all')

    expect(prepare).toHaveBeenNthCalledWith(1, 'older-request-key', expect.any(AbortSignal))
    expect(stored).toMatchObject({ pack: { id: 'current-pack' }, key: 'current-key' })
    const reserved = stored.nextKey
    expect(reserved).toMatch(/^[a-f0-9]{32}$/)

    await sync('all')

    expect(prepare).toHaveBeenNthCalledWith(2, reserved, expect.any(AbortSignal))
    expect(stored).toMatchObject({ pack: { id: 'new-pack' }, key: reserved, nextKey: null })
  })

  it('renews an expired package using its existing key after replaying pending answers', async () => {
    if (!stored.pack) throw new Error('missing fixture')
    stored.pack.expires_at = '2027-01-02T00:00:00Z'
    stored.nextKey = 'interrupted-replacement'
    stored.attempts = [{ itemId: 'item-1', text: 'бумага', result: 'pending' }]
    const replay = vi.spyOn(api, 'answerText').mockResolvedValue({
      outcome: 'answered',
      correct: true,
      submitted_text: 'бумага',
      expected_answers: ['бумага'],
      delta: 2,
      progress: 2,
    })
    const prepare = vi.spyOn(api, 'offlinePack').mockResolvedValue(pack('current-pack', 10))

    await sync('all')

    expect(replay).toHaveBeenCalledWith('item-1', 'бумага')
    expect(prepare).toHaveBeenCalledWith('current-key', expect.any(AbortSignal))
    expect(stored).toMatchObject({
      pack: { id: 'current-pack', requested_size: 10, expires_at: '2027-08-02T00:00:00Z' },
      nextKey: null,
      attempts: [{ itemId: 'item-1', text: null, result: 'correct' }],
    })
  })

  it('keeps an answer queued if another tab starts the old package during preparation', async () => {
    vi.spyOn(api, 'offlinePack').mockImplementationOnce(async () => {
      stored.attempts.push({ itemId: 'item-1', text: 'бумага', result: 'pending' })
      return pack('new-pack', 'all')
    })

    await sync('all')

    expect(stored).toMatchObject({
      pack: { id: 'current-pack' },
      nextKey: null,
      attempts: [{ itemId: 'item-1', text: 'бумага', result: 'pending' }],
    })
  })

  it('clears a legacy package without preparing another one when the option is off', async () => {
    optIn = null
    const prepare = vi.spyOn(api, 'offlinePack')

    await sync('all')

    expect(prepare).not.toHaveBeenCalled()
    expect(stored).toMatchObject({ pack: null, nextKey: null, attempts: [] })
  })

  it('replays existing answers but waits for the public shell before preparing a package', async () => {
    stored.attempts = [{ itemId: 'item-1', text: null, result: 'pending' }]
    const prepare = vi.spyOn(api, 'offlinePack')
    const replay = vi.spyOn(api, 'skipItem').mockResolvedValue({
      outcome: 'skipped',
      delta: 0,
      progress: 0,
    })

    await syncOffline('alice', 'all', () => true, vi.fn(), false)

    expect(replay).toHaveBeenCalledWith('item-1')
    expect(prepare).not.toHaveBeenCalled()
    expect(stored.attempts[0]?.result).toBe('skipped')
  })

  it('keeps disabled offline answers until confirmed and retains the result after cleanup', async () => {
    optIn = null
    stored.attempts = [{ itemId: 'item-1', text: 'бумага', result: 'pending' }]
    const prepare = vi.spyOn(api, 'offlinePack')
    const replay = vi
      .spyOn(api, 'answerText')
      .mockRejectedValueOnce(new TypeError('No connection'))
      .mockResolvedValueOnce({
        outcome: 'answered',
        correct: true,
        submitted_text: 'бумага',
        expected_answers: ['бумага'],
        delta: 2,
        progress: 2,
      })

    await expect(sync('all')).rejects.toThrow('No connection')
    expect(stored).toMatchObject({
      pack: { id: 'current-pack' },
      attempts: [{ result: 'pending' }],
    })
    await sync('all')

    expect(replay).toHaveBeenCalledTimes(2)
    expect(prepare).not.toHaveBeenCalled()
    expect(stored).toMatchObject({
      pack: null,
      attempts: [],
      report: { correct: 1, incorrect: 0, skipped: 0, conflicts: 0 },
    })
  })

  it('aborts preparation when the option is disabled and ignores the old response', async () => {
    const prepare = vi.spyOn(api, 'offlinePack').mockImplementationOnce(async (_key, signal) => {
      optIn = null
      optionListeners.forEach((listener) => listener())
      expect(signal?.aborted).toBe(true)
      optIn = 'new-opt-in'
      return pack('aborted-pack', 'all')
    })

    await sync('all')

    expect(prepare).toHaveBeenCalledOnce()
    expect(stored.pack?.id).toBe('current-pack')
  })

  it('checks the live option before committing an answer from the offline page', async () => {
    optIn = null

    await expect(
      recordOfflineAnswer('alice', 'current-pack', 'item-1', 'бумага', () => true),
    ).rejects.toThrow('offline_pack_changed')
    expect(stored.attempts).toEqual([])
  })
})
