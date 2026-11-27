import { useEffect, useRef, useState } from 'react'
import { PHONEME_GROUPS, type Phoneme } from '../phonemes'
import {
  cancelSpeech,
  englishAccentLocale,
  speak,
  useSpeech,
  type EnglishAccentLocale,
} from '../speech'
import css from './SoundsPage.module.css'

const ACCENTS = [
  ['en-GB', 'Британский'],
  ['en-US', 'Американский'],
] as const

export function SoundsPage() {
  const { preferences, busy } = useSpeech()
  const preferredLocale = englishAccentLocale(preferences.enLocale) ?? 'en-US'
  const [locale, setLocale] = useState<EnglishAccentLocale>(preferredLocale)
  const selectedLocally = useRef(false)
  const [playingId, setPlayingId] = useState<string | null>(null)

  useEffect(() => {
    if (selectedLocally.current || preferredLocale === locale) return
    cancelSpeech()
    setPlayingId(null)
    setLocale(preferredLocale)
  }, [locale, preferredLocale])

  const selectLocale = (next: EnglishAccentLocale) => {
    selectedLocally.current = true
    if (next === locale) return
    cancelSpeech()
    setPlayingId(null)
    setLocale(next)
  }

  const play = (phoneme: Phoneme) => {
    setPlayingId(phoneme.id)
    speak(phoneme.speech, 'en', { force: true, locale, browser: true })
  }

  const accentName = locale === 'en-GB' ? 'британский' : 'американский'
  return (
    <div className={css.page}>
      <header className={css.header}>
        <h1 className={css.title}>Звуки</h1>
        <fieldset className={css.accent}>
          <legend className={css.visuallyHidden}>Акцент</legend>
          {ACCENTS.map(([value, label]) => (
            <label key={value}>
              <input
                type="radio"
                name="sounds-accent"
                value={value}
                checked={locale === value}
                onChange={() => selectLocale(value)}
              />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
      </header>
      {PHONEME_GROUPS[locale].map((group) => (
        <section className={css.group} key={group.id} aria-labelledby={`sounds-${group.id}`}>
          <h2 className={css.groupTitle} id={`sounds-${group.id}`}>
            {group.title}
          </h2>
          <ul className={css.grid}>
            {group.sounds.map((phoneme) => (
              <SoundCard
                key={phoneme.id}
                phoneme={phoneme}
                accentName={accentName}
                playing={busy && playingId === phoneme.id}
                onPlay={() => play(phoneme)}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function SoundCard({
  phoneme,
  accentName,
  playing,
  onPlay,
}: {
  phoneme: Phoneme
  accentName: string
  playing: boolean
  onPlay: () => void
}) {
  return (
    <li>
      <button
        type="button"
        className={css.card}
        aria-label={`Прослушать /${phoneme.symbol}/, ${accentName} акцент`}
        data-playing={playing ? 'true' : undefined}
        onClick={onPlay}
      >
        <span className={css.phoneme} lang="en">
          {phoneme.symbol}
        </span>
        <span className={css.word} lang="en">
          {phoneme.before}
          <span className={css.hit}>{phoneme.symbol}</span>
          {phoneme.after}
        </span>
      </button>
    </li>
  )
}
