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
      className={`${ui.ghost} ${ui.speak} ${className ?? ''}`}
      onClick={(event) => {
        event.stopPropagation()
        speak(text, code)
      }}
      aria-label={`Произнести ${lang === 'en-US' ? 'EN' : 'RU'} «${text}»`}
      {...props}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M11 5 6 9H3v6h3l5 4V5Z" />
        <path d="M15 9a4 4 0 0 1 0 6M18 6a8 8 0 0 1 0 12" />
      </svg>
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
