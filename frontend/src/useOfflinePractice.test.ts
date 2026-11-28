import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useOfflinePractice } from './useOfflinePractice'

it('retries failed shell registration on reconnect and reuses the active worker', async () => {
  let rejectPending!: (error: Error) => void
  const pending = new Promise<ServiceWorkerRegistration>((_, reject) => {
    rejectPending = reject
  })
  const register = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('offline'))
    .mockReturnValueOnce(pending)
    .mockRejectedValueOnce(new TypeError('still unavailable'))
    .mockResolvedValue({
      active: { state: 'activated' },
    })
  vi.stubEnv('PROD', true)
  vi.stubGlobal('indexedDB', {})
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { register } })
  const session = {
    data: undefined,
    error: null,
    isError: false,
    isPending: false,
    refetch: vi.fn(),
  }
  const hook = renderHook(() => useOfflinePractice(session))
  try {
    await act(async () => {})
    expect(hook.result.current.settings.supported).toBe(true)
    expect(register).toHaveBeenCalledTimes(1)
    await act(async () => {
      window.dispatchEvent(new Event('online'))
    })
    expect(register).toHaveBeenCalledTimes(2)
    await act(async () => {
      window.dispatchEvent(new Event('online'))
      window.dispatchEvent(new Event('online'))
    })
    expect(register).toHaveBeenCalledTimes(2)
    await act(async () => {
      rejectPending(new TypeError('failed after reconnect'))
    })
    expect(register).toHaveBeenCalledTimes(3)
    await act(async () => {
      window.dispatchEvent(new Event('online'))
    })
    expect(register).toHaveBeenCalledTimes(4)
    await act(async () => {
      window.dispatchEvent(new Event('online'))
    })
    expect(register).toHaveBeenCalledTimes(4)
  } finally {
    hook.unmount()
    Reflect.deleteProperty(navigator, 'serviceWorker')
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  }
})
