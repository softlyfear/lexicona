import { useState, type FormEvent } from 'react'
import type { Word, WordInput } from '../api'
import { parseTranslations } from '../words'
import css from '../pages/pages.module.css'
import ui from './ui.module.css'

const optional = (value: string) => value.trim() || null

interface Props {
  word?: Word
  pending: boolean
  error: string | null
  onSubmit: (input: WordInput) => void
  onCancel: () => void
}

export function WordForm({ word, pending, error, onSubmit, onCancel }: Props) {
  const [headword, setHeadword] = useState(word?.headword ?? '')
  const [translations, setTranslations] = useState(word?.translations.join('\n') ?? '')
  const [transcription, setTranscription] = useState(word?.transcription ?? '')
  const [exampleEn, setExampleEn] = useState(word?.example_en ?? '')
  const [exampleRu, setExampleRu] = useState(word?.example_ru ?? '')
  const [note, setNote] = useState(word?.note ?? '')
  const [localError, setLocalError] = useState<string | null>(null)

  function submit(event: FormEvent) {
    event.preventDefault()
    const parsed = parseTranslations(translations)
    if (!headword.trim() || parsed.length === 0) {
      setLocalError('Нужно слово и хотя бы один перевод.')
      return
    }
    if (parsed.length > 10) {
      setLocalError('Не больше 10 переводов.')
      return
    }
    setLocalError(null)
    onSubmit({
      headword: headword.trim(),
      translations: parsed,
      transcription: optional(transcription),
      example_en: optional(exampleEn),
      example_ru: optional(exampleRu),
      note: optional(note),
    })
  }

  const message = localError ?? error
  return (
    <form className={`${ui.card} ${css.form}`} onSubmit={submit} aria-label="Слово">
      <div className={css.formRow}>
        <label className={ui.field}>
          <span className={ui.label}>Слово или выражение (EN)</span>
          <input
            className={ui.input}
            value={headword}
            onChange={(e) => setHeadword(e.target.value)}
            maxLength={200}
            lang="en"
            autoCapitalize="none"
            autoFocus
            required
          />
        </label>
        <label className={ui.field}>
          <span className={ui.label}>Транскрипция</span>
          <input
            className={ui.input}
            value={transcription}
            onChange={(e) => setTranscription(e.target.value)}
            maxLength={300}
          />
        </label>
      </div>
      <label className={ui.field}>
        <span className={ui.label}>Переводы — по одному в строке, первый основной</span>
        <textarea
          className={ui.input}
          value={translations}
          onChange={(e) => setTranslations(e.target.value)}
          rows={3}
          lang="ru"
          required
        />
      </label>
      <div className={css.formRow}>
        <label className={ui.field}>
          <span className={ui.label}>Пример (EN)</span>
          <textarea
            className={ui.input}
            value={exampleEn}
            onChange={(e) => setExampleEn(e.target.value)}
            rows={2}
            maxLength={2000}
            lang="en"
          />
        </label>
        <label className={ui.field}>
          <span className={ui.label}>Перевод примера</span>
          <textarea
            className={ui.input}
            value={exampleRu}
            onChange={(e) => setExampleRu(e.target.value)}
            rows={2}
            maxLength={2000}
            lang="ru"
          />
        </label>
      </div>
      <label className={ui.field}>
        <span className={ui.label}>Заметка</span>
        <textarea
          className={ui.input}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          maxLength={4000}
        />
      </label>
      {message && (
        <p className={ui.error} role="alert">
          {message}
        </p>
      )}
      <div className={css.actions}>
        <button className={ui.primary} disabled={pending}>
          {word ? 'Сохранить' : 'Добавить'}
        </button>
        <button type="button" className={ui.button} onClick={onCancel}>
          Отмена
        </button>
      </div>
    </form>
  )
}
