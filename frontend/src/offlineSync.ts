import { ApiError, api, type OfflineExercise, type TrainingSize } from './api'
import {
  clearOfflineDiscard,
  listenOfflineOptIn,
  offlineDiscardRequested,
  offlineOptIn,
  offlineSignedOut,
  readOffline,
  updateOffline,
  type OfflineRecord,
  type OfflineReport,
} from './offlineStorage'

const DAY = 86_400_000
export const OFFLINE_PACK_VERSION = 3

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

export async function discardOfflineForSignOut(
  ownerId: string | null | undefined,
  allowed: () => boolean,
  confirmRemoval: (count: number) => boolean,
): Promise<'removed' | 'declined' | 'stale' | 'failed' | 'logout'> {
  if (!allowed()) return 'stale'
  let stored: OfflineRecord | undefined
  try {
    stored = await readOffline()
  } catch {
    // A broken store must not trap the user. Do not set the discard flag:
    // the next sign-in still has to sync whatever attempts remain.
    return 'logout'
  }
  if (!allowed() || (stored != null && stored.ownerId !== ownerId)) return 'stale'
  const pendingCount = pendingOffline(stored)
  // confirm() runs a nested event loop and makes an open IndexedDB transaction
  // inactive, so the deletion must happen only after the dialog returns.
  if (pendingCount > 0 && !confirmRemoval(pendingCount)) return 'declined'
  if (!allowed()) return 'stale'
  let removed = false
  let stale = false
  try {
    await updateOffline((latest) => {
      if (!allowed() || (latest != null && latest.ownerId !== ownerId)) {
        stale = true
        return
      }
      if (pendingOffline(latest) > pendingCount) return
      removed = true
      return null
    })
  } catch {
    // A failed delete must not mark the record discarded: the next sync would
    // drop answers added after the user signs in again. With nothing queued,
    // signing out is still safe.
    return pendingCount > 0 ? 'failed' : 'logout'
  }
  if (!allowed() || stale) return 'stale'
  return removed ? 'removed' : 'failed'
}

type StoredExercise = Omit<OfflineExercise, 'items'> & {
  items: { id: string; prompt: string; options?: string[] }[]
}

export function offlineExercises(pack: OfflineRecord['pack']): StoredExercise[] {
  if (!pack) return []
  if ('exercises' in pack) return pack.exercises
  return [{ id: pack.id, mode: 'input', direction: 'en_ru', items: pack.items }]
}

export function offlineReport(record: OfflineRecord | undefined): OfflineReport | null {
  if (!record?.attempts.some((attempt) => attempt.result !== 'pending'))
    return record?.report ?? null
  const report = { correct: 0, incorrect: 0, skipped: 0, conflicts: 0 }
  for (const { result } of record.attempts) {
    if (result !== 'pending') report[result === 'conflict' ? 'conflicts' : result] += 1
  }
  return report
}

function permanentFailure(error: unknown) {
  return error instanceof ApiError && [404, 409, 422].includes(error.status)
}

function newKey() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

function clearPackage(record: OfflineRecord): OfflineRecord {
  return {
    ...record,
    key: newKey(),
    nextKey: null,
    pack: null,
    preparedAt: 0,
    attempts: [],
    finishedExerciseIds: [],
    report: offlineReport(record),
  }
}

export async function clearUnusedOffline(ownerId: string, allowed: () => boolean) {
  await updateOffline((record) => {
    if (
      !allowed() ||
      offlineOptIn(ownerId) ||
      record?.ownerId !== ownerId ||
      !(record.pack || record.nextKey || record.preparedAt || record.attempts.length) ||
      pendingOffline(record)
    )
      return
    return clearPackage(record)
  })
}

export async function recordOfflineAnswer(
  ownerId: string,
  packId: string,
  exerciseId: string,
  itemId: string,
  answer: string | number | null,
  allowed: () => boolean,
) {
  await updateOffline((record) => {
    if (
      !allowed() ||
      !offlineOptIn(ownerId) ||
      offlineSignedOut() ||
      !record ||
      record.ownerId !== ownerId ||
      record.pack?.id !== packId ||
      !packAvailable(record)
    )
      throw new Error('offline_pack_changed')
    const exercise = offlineExercises(record.pack).find(({ id }) => id === exerciseId)
    const attempted = new Set(record.attempts.map((attempt) => attempt.itemId))
    if (attempted.has(itemId) && exercise?.items.some(({ id }) => id === itemId)) return
    const next = exercise?.items.find(({ id }) => !attempted.has(id))
    if (next?.id !== itemId) throw new Error('offline_item_changed')
    if (
      answer !== null &&
      (exercise?.mode === 'choice'
        ? typeof answer !== 'number' ||
          !Number.isInteger(answer) ||
          answer < 0 ||
          answer >= (next.options?.length ?? 0)
        : typeof answer !== 'string')
    )
      throw new Error('invalid_offline_answer')
    const attempt = {
      itemId,
      text: typeof answer === 'string' ? answer : null,
      ...(typeof answer === 'number' ? { option: answer } : {}),
      result: 'pending' as const,
    }
    return {
      ...record,
      attempts: [...record.attempts, attempt],
    }
  })
}

export async function syncOffline(
  ownerId: string,
  desiredSize: TrainingSize,
  allowed: () => boolean,
  onApplied: () => void,
  shellReady = true,
) {
  const current = () => allowed() && !offlineSignedOut()
  const optIn = offlineOptIn(ownerId)
  const canPrepare = () =>
    shellReady && current() && optIn !== null && offlineOptIn(ownerId) === optIn
  let discarded = false
  await updateOffline((record) => {
    if (!current()) return
    discarded = offlineDiscardRequested(ownerId)
    if (!discarded && record?.ownerId === ownerId) return
    if (!canPrepare()) return discarded && record?.ownerId === ownerId ? null : undefined
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
          attempt.option !== undefined
            ? await api.answer(attempt.itemId, attempt.option)
            : attempt.text === null
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
              ? { itemId: saved.itemId, result, text: null }
              : saved,
          ),
        }
      })
      if (current() && (result === 'correct' || result === 'incorrect')) onApplied()
    }

    record = await readOffline()
    if (!current() || record?.ownerId !== ownerId || record.key !== key) return
    const exercises = offlineExercises(pack).filter(({ items }) => items.length)
    const sentItems = new Set(
      record.attempts.filter(({ result }) => result !== 'pending').map(({ itemId }) => itemId),
    )
    for (const { id, items } of exercises) {
      if (
        record.finishedExerciseIds?.includes(id) ||
        !items.every((item) => sentItems.has(item.id))
      )
        continue
      if (!current()) return
      try {
        await api.finishTraining(id)
      } catch (error) {
        if (!permanentFailure(error)) throw error
      }
      await updateOffline((latest) => {
        if (!current() || latest?.ownerId !== ownerId || latest.key !== key) return
        const finished = latest.finishedExerciseIds ?? []
        if (finished.includes(id)) return
        return { ...latest, finishedExerciseIds: [...finished, id] }
      })
    }
    if (sentItems.size && exercises.length) {
      await updateOffline((latest) => {
        if (
          !current() ||
          latest?.ownerId !== ownerId ||
          latest.key !== key ||
          pendingOffline(latest) ||
          !exercises.every(({ id }) => latest.finishedExerciseIds?.includes(id))
        )
          return
        return clearPackage(latest)
      })
    }
  }

  if (!canPrepare()) {
    await clearUnusedOffline(ownerId, current)
    return
  }
  await updateOffline((latest) => {
    if (!canPrepare() || latest?.ownerId !== ownerId) return
    if (latest.attempts.length) return latest.nextKey ? { ...latest, nextKey: null } : undefined
    if (
      latest.nextKey ||
      !latest.preparedAt ||
      ((latest.pack ? latest.pack.version : latest.packVersion) === OFFLINE_PACK_VERSION &&
        Date.now() - latest.preparedAt < (latest.pack ? DAY : 60_000) &&
        (!latest.pack || latest.pack.requested_size === desiredSize))
    )
      return
    return { ...latest, nextKey: newKey() }
  })
  record = await readOffline()
  if (!canPrepare() || record?.ownerId !== ownerId) return
  const renewing = !!record.pack && !packAvailable(record)
  const nextKey = record.attempts.length ? null : record.nextKey
  if (!nextKey && record.preparedAt && !renewing) return
  const requestKey = nextKey ?? record.key
  const version = !nextKey && record.pack ? record.pack.version : OFFLINE_PACK_VERSION
  const controller = new AbortController()
  const unlisten = listenOfflineOptIn(ownerId, () => {
    if (!canPrepare()) controller.abort()
  })
  let packResponse
  try {
    packResponse = version
      ? await api.offlineExercisePack(requestKey, version, controller.signal)
      : await api.offlinePack(requestKey, controller.signal)
  } catch (error) {
    if (!canPrepare()) return
    throw error
  } finally {
    unlisten()
  }
  if (
    packResponse &&
    (packResponse.owner_id !== ownerId ||
      packResponse.version !== version ||
      !Number.isFinite(Date.parse(packResponse.expires_at)))
  )
    throw new Error('invalid_offline_pack')
  await updateOffline((latest) => {
    if (!canPrepare() || latest?.ownerId !== ownerId) return
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
      packVersion: version,
      preparedAt: Date.now(),
      finishedExerciseIds: preparing ? [] : latest.finishedExerciseIds,
    }
  })
}
