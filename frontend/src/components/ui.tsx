import type { ComponentProps } from 'react'
import { cancelSpeech, speak, speechEnabled, useSpeech } from '../speech'
import ui from './ui.module.css'

export function ProgressBar({ value }: { value: number }) {
  const fill = Math.max(0, Math.min(100, value))
  return (
    <div
      className={ui.progress}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={fill}
      aria-valuetext={`${value}%`}
      aria-label="Прогресс"
    >
      <div className={ui.progressFill} style={{ width: `${fill}%` }} />
    </div>
  )
}

export function SpeakButton({
  text,
  lang,
  className,
  ...props
}: { text: string; lang: 'en-US' | 'ru-RU' } & ComponentProps<'button'>) {
  const code = lang === 'en-US' ? 'en' : 'ru'
  const { preferences } = useSpeech()
  if (!speechEnabled(code, preferences)) return null
  return (
    <button
      type="button"
      className={className ? `${ui.ghost} ${className}` : ui.ghost}
      onClick={(event) => {
        event.stopPropagation()
        speak(text, code)
      }}
      aria-label={`Произнести ${lang === 'en-US' ? 'EN' : 'RU'} «${text}»`}
      {...props}
    >
      🔊
    </button>
  )
}

export function SpeechStatus() {
  const { status } = useSpeech()
  return (
    <div>
      <button type="button" className={ui.button} onClick={cancelSpeech}>
        Остановить речь
      </button>
      {status && <p role="status">{status}</p>}
    </div>
  )
}
