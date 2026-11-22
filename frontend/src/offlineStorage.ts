import { type OfflinePack, type TrainingSize } from './api'

export type AttemptResult = 'pending' | 'correct' | 'incorrect' | 'skipped' | 'conflict'

export interface OfflineAttempt {
  itemId: string
  text: string | null
  result: AttemptResult
}

export interface OfflineReport {
  correct: number
  incorrect: number
  skipped: number
  conflicts: number
}

export interface OfflineRecord {
  ownerId: string
  key: string
  nextKey: string | null
  preparedAt: number
  pack: (Omit<OfflinePack, 'requested_size'> & { requested_size?: TrainingSize }) | null
  attempts: OfflineAttempt[]
  report: OfflineReport | null
}

const KEY = 'current'
const EVENT = 'change'
const LOGOUT_KEY = 'lexicona-offline-signed-out'
const OWNER_KEY = 'lexicona-offline-owner'
const DISCARD_KEY = 'lexicona-offline-discard'
const OPT_IN_KEY = 'lexicona-offline-opt-in'
const listeners = new EventTarget()
let channel: BroadcastChannel | undefined

export function offlineStorageAvailable() {
  try {
    if (typeof indexedDB === 'undefined') return false
    localStorage.getItem(LOGOUT_KEY)
    return true
  } catch {
    return false
  }
}

export function offlineOptIn(ownerId: string | null | undefined): string | null {
  if (!ownerId || !offlineStorageAvailable()) return null
  try {
    return localStorage.getItem(`${OPT_IN_KEY}:${ownerId}`)
  } catch {
    return null
  }
}

export function setOfflineOptIn(ownerId: string, enabled: boolean) {
  const key = `${OPT_IN_KEY}:${ownerId}`
  if (enabled) localStorage.setItem(key, crypto.randomUUID())
  else localStorage.removeItem(key)
  listeners.dispatchEvent(new Event(key))
}

export function listenOfflineOptIn(ownerId: string, listener: () => void) {
  const key = `${OPT_IN_KEY}:${ownerId}`
  const changed = (event: StorageEvent) => {
    if (event.key === key || event.key === null) listener()
  }
  listeners.addEventListener(key, listener)
  window.addEventListener('storage', changed)
  return () => {
    listeners.removeEventListener(key, listener)
    window.removeEventListener('storage', changed)
  }
}

export function offlineSignedOut() {
  if (!offlineStorageAvailable()) return false
  try {
    return localStorage.getItem(LOGOUT_KEY) === '1'
  } catch {
    return false
  }
}

export function markOfflineSignedOut() {
  if (offlineStorageAvailable()) localStorage.setItem(LOGOUT_KEY, '1')
}

export function offlineOwner() {
  try {
    return localStorage.getItem(OWNER_KEY)
  } catch {
    return null
  }
}

export function setOfflineOwner(ownerId: string) {
  try {
    if (offlineStorageAvailable()) localStorage.setItem(OWNER_KEY, ownerId)
  } catch {
    // Offline access still requires an account-scoped pack.
  }
}

export function offlineDiscardRequested(ownerId: string) {
  try {
    return localStorage.getItem(`${DISCARD_KEY}:${ownerId}`) === '1'
  } catch {
    return true
  }
}

export function requestOfflineDiscard(ownerId: string) {
  localStorage.setItem(`${DISCARD_KEY}:${ownerId}`, '1')
}

export function clearOfflineDiscard(ownerId: string) {
  localStorage.removeItem(`${DISCARD_KEY}:${ownerId}`)
}

export function clearOfflineSignedOut() {
  if (offlineStorageAvailable()) localStorage.removeItem(LOGOUT_KEY)
}

export function listenOfflineSignOut(signedOut: () => void, ownerId?: string) {
  const listener = (event: StorageEvent) => {
    if (
      (event.key === LOGOUT_KEY && event.newValue === '1') ||
      (event.key === OWNER_KEY && ownerId !== undefined && event.newValue !== ownerId)
    )
      signedOut()
  }
  window.addEventListener('storage', listener)
  return () => window.removeEventListener('storage', listener)
}

function changes() {
  if (!channel && typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel('lexicona-offline')
    channel.onmessage = () => listeners.dispatchEvent(new Event(EVENT))
  }
  return channel
}

export function listenOfflineStorage(listener: () => void) {
  changes()
  listeners.addEventListener(EVENT, listener)
  return () => listeners.removeEventListener(EVENT, listener)
}

function notify() {
  listeners.dispatchEvent(new Event(EVENT))
  changes()?.postMessage(EVENT)
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('lexicona-offline', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('practice')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
  })
}

export async function readOffline(): Promise<OfflineRecord | undefined> {
  const db = await open()
  return new Promise<OfflineRecord | undefined>((resolve, reject) => {
    const transaction = db.transaction('practice')
    const request = transaction.objectStore('practice').get(KEY)
    transaction.oncomplete = () => resolve(request.result as OfflineRecord | undefined)
    transaction.onabort = () => reject(transaction.error)
  }).finally(() => db.close())
}

export async function updateOffline(
  update: (record: OfflineRecord | undefined) => OfflineRecord | null | undefined,
): Promise<void> {
  const db = await open()
  let updated = false
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('practice', 'readwrite')
    const store = transaction.objectStore('practice')
    const request = store.get(KEY)
    request.onsuccess = () => {
      try {
        const record = request.result as OfflineRecord | undefined
        const next = update(record)
        if (next === undefined || next === record) return
        if (next === null) store.delete(KEY)
        else store.put(next, KEY)
        updated = true
      } catch (error) {
        transaction.abort()
        reject(error)
      }
    }
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error)
  }).finally(() => db.close())
  if (updated) notify()
}
