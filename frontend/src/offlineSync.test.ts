import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, type OfflinePack, type TrainingSize } from './api'
import { type OfflineRecord } from './offlineStorage'
import { syncOffline } from './offlineSync'

let stored: OfflineRecord

vi.mock('./offlineStorage', () => ({
  offlineSignedOut: () => false,
  offlineDiscardRequested: () => false,
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

    expect(prepare).toHaveBeenNthCalledWith(1, 'older-request-key')
    expect(stored).toMatchObject({ pack: { id: 'current-pack' }, key: 'current-key' })
    const reserved = stored.nextKey
    expect(reserved).toMatch(/^[a-f0-9]{32}$/)

    await sync('all')

    expect(prepare).toHaveBeenNthCalledWith(2, reserved)
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
    expect(prepare).toHaveBeenCalledWith('current-key')
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
})
