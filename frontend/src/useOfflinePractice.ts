import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
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
  listenOfflineOptIn,
  listenOfflineSignOut,
  listenOfflineStorage,
  markOfflineSignedOut,
  offlineDiscardRequested,
  offlineOptIn,
  offlineOwner,
  offlineStorageAvailable,
  readOffline,
  requestOfflineDiscard,
  setOfflineOptIn,
  updateOffline,
  type OfflineRecord,
} from './offlineStorage'
import {
  clearUnusedOffline,
  networkUnavailable,
  offlineReport,
  packAvailable,
  pendingOffline,
  recordOfflineAnswer,
  syncOffline,
} from './offlineSync'
import { refreshServerVoices } from './speech'

let shellRegistration: Promise<boolean> | undefined

function registerOfflineShell() {
  shellRegistration ??= navigator.serviceWorker.register('/service-worker.js').then(
    (registration) => {
      if (registration.active) return true
      const worker = registration.installing ?? registration.waiting
      if (!worker) return false
      return new Promise<boolean>((resolve) => {
        const changed = () => {
          if (worker.state !== 'activated' && worker.state !== 'redundant') return
          worker.removeEventListener('statechange', changed)
          resolve(worker.state === 'activated')
        }
        worker.addEventListener('statechange', changed)
        changed()
      })
    },
    () => false,
  )
  return shellRegistration
}

export function useOfflinePractice(session: ReturnType<typeof useSession>) {
  const [record, setRecord] = useState<OfflineRecord | null>()
  const [status, setStatus] = useState<'ready' | 'offline' | 'problem'>(() =>
    navigator.onLine ? 'ready' : 'offline',
  )
  const [shellState, setShellState] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const [settingError, setSettingError] = useState('')
  const [checkedAt, setCheckedAt] = useState(Date.now)
  const [desired, setDesired] = useState<{
    ownerId: string
    revision: number
    size: TrainingSize
  }>()
  const [startupOwner] = useState(offlineOwner)
  const ownerId = session.data?.user.id
  const connectionFailed = session.isError && networkUnavailable(session.error)
  const coldOffline =
    session.data === undefined && (connectionFailed || (session.isPending && status === 'offline'))
  const { refetch } = session
  const revision = getSessionRevision()
  const storageAvailable = offlineStorageAvailable()
  const settingsOwner = ownerId ?? (coldOffline ? startupOwner : undefined)
  const subscribeOptIn = useCallback(
    (listener: () => void) =>
      settingsOwner ? listenOfflineOptIn(settingsOwner, listener) : () => {},
    [settingsOwner],
  )
  const optedIn = useSyncExternalStore(subscribeOptIn, () => !!offlineOptIn(settingsOwner))
  const supported = storageAvailable && import.meta.env.PROD && !!navigator.serviceWorker
  const shellReady = shellState === 'ready'
  const offline = optedIn && (ownerId ? status === 'offline' : coldOffline)

  useEffect(() => {
    if (!storageAvailable) return
    let active = true
    let version = 0
    const refresh = () => {
      const current = ++version
      void readOffline()
        .then((stored) => {
          if (active && version === current) setRecord(stored ?? null)
        })
        .catch(() => {
          if (active && version === current) setRecord(null)
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
  }, [storageAvailable, ownerId, coldOffline, startupOwner])

  useEffect(() => {
    if (!supported) return
    let active = true
    void registerOfflineShell().then((ready) => {
      if (active) setShellState(ready ? 'ready' : 'unavailable')
    })
    return () => {
      active = false
    }
  }, [supported])

  useEffect(() => {
    if (!storageAvailable) return
    let active = true
    let running = false
    let refreshAgain = false
    let wasDisconnected = false
    const disconnected = () => {
      wasDisconnected = true
      setStatus('offline')
      setCheckedAt(Date.now())
    }

    async function refresh() {
      if (
        !active ||
        running ||
        document.hidden ||
        requiresExplicitLogin() ||
        (!ownerId && !coldOffline)
      )
        return
      running = true
      const allowed = () =>
        active &&
        ownerId !== undefined &&
        offlineOwner() === ownerId &&
        isCurrentSession(revision, ownerId)
      try {
        if (ownerId && !offlineOptIn(ownerId)) {
          const stored = await readOffline()
          if (!allowed()) return
          const pending = stored?.ownerId === ownerId && pendingOffline(stored) > 0
          if (
            !pending &&
            stored?.ownerId === ownerId &&
            (stored.pack || stored.preparedAt || stored.nextKey)
          )
            await clearUnusedOffline(ownerId, allowed)
          if (!pending && !offlineOptIn(ownerId)) {
            if (navigator.onLine) setStatus('ready')
            else disconnected()
            return
          }
        }
        if (!navigator.onLine) {
          disconnected()
          return
        }
        if (!ownerId) {
          // Keep the offline page mounted while rechecking the session.
          setStatus('offline')
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
        await syncOffline(
          ownerId,
          size,
          allowed,
          () => {
            void queryClient.invalidateQueries({ queryKey: ['words'] })
            void queryClient.invalidateQueries({ queryKey: ['statistics'] })
          },
          shellReady,
        )
      } catch (error) {
        if (error instanceof ApiError && error.status === 401 && allowed()) revokeLocalSession()
        else if (active && networkUnavailable(error)) disconnected()
        else if (active) setStatus('problem')
      } finally {
        running = false
        if (refreshAgain) {
          refreshAgain = false
          pulse()
        }
      }
    }

    const pulse = () => void refresh()
    const requestRefresh = () => {
      if (running) refreshAgain = true
      else pulse()
    }
    const unlisten = listenTrainingSaved((savedOwner, size) => {
      if (savedOwner !== ownerId || !isCurrentSession(revision, ownerId)) return
      setDesired({ ownerId, revision, size })
      requestRefresh()
    })
    const unlistenOptIn = ownerId ? listenOfflineOptIn(ownerId, requestRefresh) : undefined
    // A failed cold start waits for a reconnect, visibility change or the next retry tick.
    if (ownerId) pulse()
    const timer = window.setInterval(pulse, 20_000)
    window.addEventListener('offline', disconnected)
    window.addEventListener('online', pulse)
    document.addEventListener('visibilitychange', pulse)
    return () => {
      active = false
      unlisten()
      unlistenOptIn?.()
      clearInterval(timer)
      window.removeEventListener('offline', disconnected)
      window.removeEventListener('online', pulse)
      document.removeEventListener('visibilitychange', pulse)
    }
  }, [storageAvailable, ownerId, coldOffline, refetch, revision, shellReady])

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
    optedIn && packAvailable(ownRecord) && Date.parse(ownRecord?.pack?.expires_at ?? '') > checkedAt
      ? ownRecord
      : undefined
  const desiredSize =
    desired?.ownerId === ownerId && desired?.revision === revision
      ? desired.size
      : (session.data?.user.preferences?.training?.size ?? DEFAULT_TRAINING.size)
  const shellAndPackReady =
    shellReady &&
    !!readyPack &&
    (offline ||
      readyPack.attempts.length > 0 ||
      (readyPack.pack?.version === 2 && readyPack.pack.requested_size === desiredSize))
  const pending = pendingOffline(ownRecord)
  const report = offlineReport(ownRecord)
  const syncMessage =
    status === 'problem' && (optedIn || pending > 0 || ownRecord?.pack)
      ? 'Не удалось синхронизировать офлайн-данные. Приложение повторит попытку.'
      : pending
        ? `Ждут отправки: ${pending}.`
        : report
          ? `Верных — ${report.correct}, неверных — ${report.incorrect}, пропущенных — ${report.skipped}.${report.conflicts ? ` Не засчитано из-за изменений: ${report.conflicts}.` : ''}`
          : ''
  const readiness =
    optedIn && !offline && !pending && status !== 'problem' && shellState !== 'unavailable'
      ? shellAndPackReady
        ? 'Готово к офлайну'
        : ownRecord?.preparedAt && !ownRecord.pack
          ? 'Добавьте слова для офлайн-тренировки.'
          : 'Подготавливаем слова и упражнения…'
      : ''
  const message = [syncMessage, readiness].filter(Boolean).join(' ')

  function changeOptIn(next: boolean) {
    if (!ownerId || !isCurrentSession(revision, ownerId)) return
    setSettingError('')
    try {
      setOfflineOptIn(ownerId, next)
    } catch {
      setSettingError('Не удалось сохранить настройку офлайн-режима.')
    }
  }

  async function signOut() {
    if (!storageAvailable) {
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

  async function save(exerciseId: string, itemId: string, answer: string | number | null) {
    if (!readyPack?.pack) throw new Error('offline_pack_not_ready')
    const revision = getSessionRevision()
    await recordOfflineAnswer(
      readyPack.ownerId,
      readyPack.pack.id,
      exerciseId,
      itemId,
      answer,
      () =>
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

  return {
    offline,
    readyPack,
    loadingPack: record === undefined,
    message,
    signOut,
    save,
    settings: {
      supported,
      optedIn,
      message,
      settingError:
        settingError ||
        (optedIn && shellState === 'unavailable'
          ? 'Не удалось подготовить запуск без сети. Обновите страницу.'
          : ''),
      changeOptIn,
    },
  }
}
