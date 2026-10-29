import type { ComponentProps } from 'react'
import { canSpeak, speak } from '../speech'
import ui from './ui.module.css'

export function ProgressBar({ value }: { value: number }) {
  return (
    <div
      className={ui.progress}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      aria-label="Прогресс"
    >
      <div className={ui.progressFill} style={{ width: `${value}%` }} />
    </div>
  )
}

export function SpeakButton({
  text,
  lang,
  ...props
}: { text: string; lang: 'en-US' | 'ru-RU' } & ComponentProps<'button'>) {
  if (!canSpeak) return null
  return (
    <button
      type="button"
      className={ui.ghost}
      onClick={() => speak(text, lang)}
      aria-label={`Произнести «${text}»`}
      {...props}
    >
      🔊
    </button>
  )
}
