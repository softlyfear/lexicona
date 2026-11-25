import { useEffect, useEffectEvent, useState } from 'react'
import { isSpeechBusy, useSpeech } from '../speech'

export function useAutoAdvance(
  target: string | null,
  enabled: boolean,
  suspended: boolean,
  next: () => void,
) {
  const { busy } = useSpeech()
  const [elapsed, setElapsed] = useState<string | null>(null)
  const [cancelled, setCancelled] = useState<string | null>(null)

  function cancel() {
    setCancelled(target)
  }

  const feedbackElapsed = useEffectEvent((key: string) => {
    if (key === target && enabled && !suspended && cancelled !== key) setElapsed(key)
  })
  const advance = useEffectEvent(() => {
    if (target && enabled && !suspended && cancelled !== target && !isSpeechBusy()) next()
  })

  useEffect(() => {
    if (!enabled || suspended || !target || cancelled === target) return
    const timer = setTimeout(() => feedbackElapsed(target), 1500)
    return () => clearTimeout(timer)
  }, [target, enabled, suspended, cancelled])

  useEffect(() => {
    // Speech keeps its own end/failure watchdog and clears busy. Advancing on a
    // fixed timer cuts off a long utterance that is still playing.
    if (!target || elapsed !== target || cancelled === target || busy) return
    advance()
  }, [target, elapsed, busy, cancelled, enabled, suspended])

  return {
    cancel,
    // A target stays set only while auto-next is armed for the current answer.
    pending: !!target && enabled && !suspended && cancelled !== target,
  }
}
