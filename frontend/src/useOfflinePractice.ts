import { useEffect, useState, type ReactNode } from 'react'
import { DEFAULT_TRAINING, listenTrainingSaved } from './accountPreferences'
import { ApiError, type TrainingSize } from './api'
import {
  getSessionRevision,
  forgetSession,
  isCurrentSession,
  logoutSession,
  queryClient,
  requiresExplicitLogin,
  revokeLocalSession,
  useSession,
  verifyOfflineSession,
} from './session'
import {
  listenOfflineSignOut,
  listenOfflineStorage,
  markOfflineSignedOut,
  offlineDiscardRequested,
  offlineOwner,
  offlineStorageAvailable,
  readOffline,
  requestOfflineDiscard,
  updateOffline,
  type OfflineRecord,
} from './offlineStorage'
import {
  networkUnavailable,
  packAvailable,
  pendingOffline,
  recordOfflineAnswer,
  syncOffline,
} from './offlineSync'
import { refreshServerVoices } from './speech'

export function useOfflinePractice(session: ReturnType<typeof useSession>) {
  const [record, setRecord] = useState<OfflineRecord>()
  const [status, setStatus] = useState<'ready' | 'offline' | 'problem'>('ready')
  const [shellReady, setShellReady] = useState(false)
  const [checkedAt, setCheckedAt] = useState(Date.now)
  const [desired, setDesired] = useState<{
    ownerId: string
    revision: number
    size: TrainingSize
  }>()
  const [startupOwner] = useState(offlineOwner)
  const ownerId = session.data?.user.id
  const coldOffline = session.isError && networkUnavailable(session.error)
  const { refetch } = session
  const revision = getSessionRevision()
  const enabled = offlineStorageAvailable()
  const offline = enabled && (status === 'offline' || coldOffline)

  useEffect(() => {
    if (!enabled) return
    let active = true
    let version = 0
    const refresh = () => {
      const current = ++version
      void readOffline()
        .then((stored) => {
          if (active && version === current) setRecord(stored)
        })
        .catch(() => {
          if (active && version === current) setRecord(undefined)
        })
    }
    const unsubscribe = listenOfflineStorage(refresh)
    const unlisten = listenOfflineSignOut(
      forgetSession,
      ownerId ?? (coldOffline ? (startupOwner ?? undefined) : undefined),
    )
    refresh()
    return () => {
      active = false
      unsubscribe()
      unlisten()
    }
  }, [enabled, ownerId, coldOffline, startupOwner])

  useEffect(() => {
    if (!enabled || !navigator.serviceWorker) return
    let active = true
    void navigator.serviceWorker.ready.then(() => {
      if (active) setShellReady(true)
    })
    return () => {
      active = false
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled || (!ownerId && !coldOffline)) return
    let active = true
    let running = false
    let refreshAfterSave = false
    let wasDisconnected = false
    const disconnected = () => {
      wasDisconnected = true
      setStatus('offline')
      setCheckedAt(Date.now())
    }

    async function refresh() {
      if (!active || running || document.hidden || requiresExplicitLogin()) return
      if (!navigator.onLine) {
        disconnected()
        return
      }
      running = true
      const allowed = () =>
        active &&
        ownerId !== undefined &&
        offlineOwner() === ownerId &&
        isCurrentSession(revision, ownerId)
      try {
        if (!ownerId) {
          const result = await refetch()
          if (active && result.isSuccess) setStatus('ready')
          return
        }
        const user = await verifyOfflineSession(revision, ownerId)
        if (!user || !allowed()) return
        const size = user.preferences?.training?.size ?? DEFAULT_TRAINING.size
        setDesired({ ownerId, revision, size })
        setStatus('ready')
        if (wasDisconnected) {
          wasDisconnected = false
          refreshServerVoices()
        }
        await syncOffline(ownerId, size, allowed, () => {
          void queryClient.invalidateQueries({ queryKey: ['words'] })
          void queryClient.invalidateQueries({ queryKey: ['statistics'] })
        })
      } catch (error) {
        if (error instanceof ApiError && error.status === 401 && allowed()) revokeLocalSession()
        else if (active && networkUnavailable(error)) disconnected()
        else if (active) setStatus('problem')
      } finally {
        running = false
        if (refreshAfterSave) {
          refreshAfterSave = false
          pulse()
        }
      }
    }

    const pulse = () => void refresh()
    const unlisten = listenTrainingSaved((savedOwner, size) => {
      if (savedOwner !== ownerId || !isCurrentSession(revision, ownerId)) return
      setDesired({ ownerId, revision, size })
      if (running) refreshAfterSave = true
      else pulse()
    })
    pulse()
    const timer = window.setInterval(pulse, 20_000)
    window.addEventListener('offline', disconnected)
    window.addEventListener('online', pulse)
    document.addEventListener('visibilitychange', pulse)
    return () => {
      active = false
      unlisten()
      clearInterval(timer)
      window.removeEventListener('offline', disconnected)
      window.removeEventListener('online', pulse)
      document.removeEventListener('visibilitychange', pulse)
    }
  }, [enabled, ownerId, coldOffline, refetch, revision])

  const ownRecord =
    !requiresExplicitLogin() &&
    record &&
    record.ownerId === offlineOwner() &&
    !offlineDiscardRequested(record.ownerId) &&
    ((ownerId && record.ownerId === ownerId) ||
      (!ownerId && coldOffline && record.ownerId === startupOwner))
      ? record
      : undefined
  const readyPack =
    packAvailable(ownRecord) && Date.parse(ownRecord?.pack?.expires_at ?? '') > checkedAt
      ? ownRecord
      : undefined
  const desiredSize =
    desired?.ownerId === ownerId && desired?.revision === revision
      ? desired.size
      : (session.data?.user.preferences?.training?.size ?? DEFAULT_TRAINING.size)
  const shellAndPackReady =
    shellReady &&
    !!readyPack &&
    (offline || readyPack.attempts.length > 0 || readyPack.pack?.requested_size === desiredSize)
  const pending = pendingOffline(ownRecord)
  const report = ownRecord?.attempts.some((attempt) => attempt.result !== 'pending')
    ? {
        correct: ownRecord.attempts.filter((attempt) => attempt.result === 'correct').length,
        incorrect: ownRecord.attempts.filter((attempt) => attempt.result === 'incorrect').length,
        skipped: ownRecord.attempts.filter((attempt) => attempt.result === 'skipped').length,
        conflicts: ownRecord.attempts.filter((attempt) => attempt.result === 'conflict').length,
      }
    : ownRecord?.report

  const message: ReactNode =
    status === 'problem'
      ? 'Не удалось синхронизировать офлайн-данные. Приложение повторит попытку.'
      : pending
        ? `Ждут отправки: ${pending}.`
        : report
          ? `Офлайн: верных — ${report.correct}, неверных — ${report.incorrect}, пропущенных — ${report.skipped}.${report.conflicts ? ` Не засчитано из-за изменений: ${report.conflicts}.` : ''}${!offline && shellAndPackReady ? ' Готово к офлайну.' : ''}`
          : shellAndPackReady
            ? 'Готово к офлайну'
            : null

  async function signOut() {
    if (!enabled) {
      await logoutSession()
      return
    }
    let accepted = false
    let stale = false
    const revision = getSessionRevision()
    const expectedOwner = ownerId ?? startupOwner
    const couldBeCurrent = () => {
      const currentOwner = offlineOwner()
      return !currentOwner || currentOwner === expectedOwner
    }
    const discard = () => {
      if (expectedOwner) requestOfflineDiscard(expectedOwner)
      markOfflineSignedOut()
    }
    const confirmPending = (count: number) =>
      count === 0 ||
      window.confirm(`Неотправленных действий: ${count}. При выходе они будут удалены. Выйти?`)
    try {
      await updateOffline((stored) => {
        if (revision !== getSessionRevision()) return
        if (!couldBeCurrent() || (stored && stored.ownerId !== expectedOwner)) {
          stale = true
          return
        }
        if (!confirmPending(pendingOffline(stored))) return
        accepted = true
        discard()
        return null
      })
    } catch {
      if (revision !== getSessionRevision()) return
      if (!couldBeCurrent()) stale = true
      else if (accepted || confirmPending(pending)) {
        try {
          discard()
        } catch {
          // The per-tab login guard and the server logout still apply.
        }
        accepted = true
      }
    }
    if (stale) forgetSession()
    else if (accepted) await logoutSession()
  }

  async function save(itemId: string, answer: string | null) {
    if (!readyPack?.pack) throw new Error('offline_pack_not_ready')
    const revision = getSessionRevision()
    await recordOfflineAnswer(readyPack.ownerId, readyPack.pack.id, itemId, answer, () =>
      ownerId
        ? isCurrentSession(revision, ownerId)
        : revision === getSessionRevision() &&
          offlineOwner() === startupOwner &&
          !requiresExplicitLogin(),
    )
    const stored = await readOffline()
    if (revision === getSessionRevision() && stored?.ownerId === readyPack.ownerId)
      setRecord(stored)
  }

  return { offline, readyPack, message, signOut, save }
}
