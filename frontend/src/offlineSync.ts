import { ApiError, api, type TrainingSize } from './api'
import {
  clearOfflineDiscard,
  offlineDiscardRequested,
  offlineSignedOut,
  readOffline,
  updateOffline,
  type OfflineRecord,
} from './offlineStorage'

const DAY = 86_400_000

export function networkUnavailable(error: unknown) {
  return (
    error instanceof TypeError ||
    (error instanceof DOMException &&
      (error.name === 'NetworkError' || error.name === 'TimeoutError')) ||
    (error instanceof ApiError && error.status >= 500)
  )
}

export function packAvailable(record: OfflineRecord | undefined) {
  return !!record?.pack && Date.parse(record.pack.expires_at) > Date.now()
}

export function pendingOffline(record: OfflineRecord | undefined) {
  return record?.attempts.filter((attempt) => attempt.result === 'pending').length ?? 0
}

function permanentFailure(error: unknown) {
  return error instanceof ApiError && [404, 409, 422].includes(error.status)
}

function newKey() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

export async function recordOfflineAnswer(
  ownerId: string,
  packId: string,
  itemId: string,
  answer: string | null,
  allowed: () => boolean,
) {
  await updateOffline((record) => {
    if (
      !allowed() ||
      offlineSignedOut() ||
      !record ||
      record.ownerId !== ownerId ||
      record.pack?.id !== packId ||
      !packAvailable(record)
    )
      throw new Error('offline_pack_changed')
    const next = record.pack.items[record.attempts.length]
    if (next?.id !== itemId) return
    return {
      ...record,
      attempts: [...record.attempts, { itemId, text: answer, result: 'pending' }],
    }
  })
}

export async function syncOffline(
  ownerId: string,
  desiredSize: TrainingSize,
  allowed: () => boolean,
  onApplied: () => void,
) {
  const current = () => allowed() && !offlineSignedOut()
  let discarded = false
  await updateOffline((record) => {
    if (!current()) return
    discarded = offlineDiscardRequested(ownerId)
    if (!discarded && record?.ownerId === ownerId) return
    return {
      ownerId,
      key: newKey(),
      nextKey: null,
      pack: null,
      preparedAt: 0,
      attempts: [],
      report: null,
    }
  })
  if (discarded && current()) clearOfflineDiscard(ownerId)

  let record = await readOffline()
  if (!current() || record?.ownerId !== ownerId) return
  const key = record.key
  const pack = record.pack
  if (pack) {
    for (const attempt of record.attempts) {
      if (attempt.result !== 'pending') continue
      if (!current()) return
      let result: 'correct' | 'incorrect' | 'skipped' | 'conflict'
      try {
        const response =
          attempt.text === null
            ? await api.skipItem(attempt.itemId)
            : await api.answerText(attempt.itemId, attempt.text)
        result =
          response.outcome === 'answered' && 'correct' in response
            ? response.correct
              ? 'correct'
              : 'incorrect'
            : response.outcome === 'skipped'
              ? 'skipped'
              : 'conflict'
      } catch (error) {
        if (!permanentFailure(error)) throw error
        result = 'conflict'
      }
      await updateOffline((latest) => {
        if (!current() || latest?.ownerId !== ownerId || latest.key !== key) return
        return {
          ...latest,
          attempts: latest.attempts.map((saved) =>
            saved.itemId === attempt.itemId && saved.result === 'pending'
              ? { ...saved, result, text: null }
              : saved,
          ),
        }
      })
      if (current() && (result === 'correct' || result === 'incorrect')) onApplied()
    }

    record = await readOffline()
    if (!current() || record?.ownerId !== ownerId || record.key !== key) return
    if (
      pack.items.length > 0 &&
      record.attempts.length === pack.items.length &&
      pendingOffline(record) === 0
    ) {
      try {
        await api.finishTraining(pack.id)
      } catch (error) {
        if (!permanentFailure(error)) throw error
      }
      await updateOffline((latest) => {
        if (!current() || latest?.ownerId !== ownerId || latest.key !== key) return
        const report = {
          correct: latest.attempts.filter((attempt) => attempt.result === 'correct').length,
          incorrect: latest.attempts.filter((attempt) => attempt.result === 'incorrect').length,
          skipped: latest.attempts.filter((attempt) => attempt.result === 'skipped').length,
          conflicts: latest.attempts.filter((attempt) => attempt.result === 'conflict').length,
        }
        return {
          ...latest,
          key: newKey(),
          nextKey: null,
          pack: null,
          preparedAt: 0,
          attempts: [],
          report,
        }
      })
    }
  }

  await updateOffline((latest) => {
    if (!current() || latest?.ownerId !== ownerId) return
    if (latest.attempts.length) return latest.nextKey ? { ...latest, nextKey: null } : undefined
    if (
      latest.nextKey ||
      !latest.preparedAt ||
      (Date.now() - latest.preparedAt < (latest.pack?.items.length ? DAY : 60_000) &&
        (!latest.pack || latest.pack.requested_size === desiredSize))
    )
      return
    return { ...latest, nextKey: newKey() }
  })
  record = await readOffline()
  if (!current() || record?.ownerId !== ownerId) return
  const renewing = !!record.pack && !packAvailable(record)
  const nextKey = record.attempts.length ? null : record.nextKey
  if (!nextKey && record.preparedAt && !renewing) return
  const requestKey = nextKey ?? record.key
  const packResponse = await api.offlinePack(requestKey)
  if (
    packResponse &&
    (packResponse.owner_id !== ownerId || !Number.isFinite(Date.parse(packResponse.expires_at)))
  )
    throw new Error('invalid_offline_pack')
  await updateOffline((latest) => {
    if (!current() || latest?.ownerId !== ownerId) return
    const preparing = latest.nextKey === requestKey
    if (!preparing && latest.key !== requestKey) return
    if (latest.attempts.length) {
      if (preparing) return { ...latest, nextKey: null }
      if (latest.pack?.id !== packResponse?.id) return
    } else if (packResponse && packResponse.requested_size !== desiredSize) {
      if (preparing || !latest.nextKey) return { ...latest, nextKey: newKey() }
      return
    }
    if (!preparing && latest.pack && latest.pack.id !== packResponse?.id) return
    return {
      ...latest,
      key: requestKey,
      nextKey: preparing ? null : latest.nextKey,
      pack: packResponse,
      preparedAt: Date.now(),
    }
  })
}
