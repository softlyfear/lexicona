import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { isSpeechBusy, useSpeech } from '../speech'

export function useAutoAdvance(
  target: string | null,
  enabled: boolean,
  suspended: boolean,
  next: () => void,
) {
  const { busy } = useSpeech()
  const [elapsed, setElapsed] = useState<string | null>(null)
  const cancelled = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  function cancel() {
    cancelled.current = target
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }

  const feedbackElapsed = useEffectEvent((key: string) => {
    if (key === target && enabled && !suspended && cancelled.current !== key) setElapsed(key)
  })
  const advance = useEffectEvent(() => {
    if (target && enabled && !suspended && cancelled.current !== target && !isSpeechBusy()) {
      cancelled.current = target
      next()
    }
  })

  useEffect(() => {
    if (!enabled || suspended) {
      if (target) cancelled.current = target
      return
    }
    if (!target || cancelled.current === target) return
    timer.current = setTimeout(() => feedbackElapsed(target), 1500)
    return () => {
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = null
    }
  }, [target, enabled, suspended])

  useEffect(() => {
    if (target && elapsed === target && !busy) advance()
  }, [target, elapsed, busy, enabled, suspended])

  return cancel
}
