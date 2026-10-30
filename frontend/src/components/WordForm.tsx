import { useState, type FormEvent } from 'react'
import type { Tag, Word, WordInput } from '../api'
import { normalizeTagName, parseTranslations, tagKey } from '../words'
import css from '../pages/pages.module.css'
import ui from './ui.module.css'

const optional = (value: string) => value.trim() || null

interface Props {
  word?: Word
  pending: boolean
  error: string | null
  onSubmit: (input: WordInput) => void
  onCancel: () => void
  availableTags: Tag[]
  tagsLoading: boolean
  tagsError: string | null
}

export function WordForm({
  word,
  pending,
  error,
  onSubmit,
  onCancel,
  availableTags,
  tagsLoading,
  tagsError,
}: Props) {
  const [headword, setHeadword] = useState(word?.headword ?? '')
  const [translations, setTranslations] = useState(word?.translations.join('\n') ?? '')
  const [transcription, setTranscription] = useState(word?.transcription ?? '')
  const [exampleEn, setExampleEn] = useState(word?.example_en ?? '')
  const [exampleRu, setExampleRu] = useState(word?.example_ru ?? '')
  const [note, setNote] = useState(word?.note ?? '')
  const [localError, setLocalError] = useState<string | null>(null)
  const [tags, setTags] = useState<string[]>(word?.tags.map((tag) => tag.name) ?? [])
  const [tagInput, setTagInput] = useState('')
  const [tagError, setTagError] = useState<string | null>(null)

  function addTag(raw: string) {
    const name = normalizeTagName(raw)
    if (!name || Array.from(name).length > 80) {
      setTagError('Имя тега должно содержать от 1 до 80 символов.')
      return
    }
    if (tags.some((tag) => tagKey(tag) === tagKey(name))) {
      setTagError('Этот тег уже выбран.')
      return
    }
    if (tags.length >= 20) {
      setTagError('Можно выбрать не больше 20 тегов.')
      return
    }
    const existing = availableTags.find((tag) => tagKey(tag.name) === tagKey(name))
    setTags((current) => [...current, existing?.name ?? name])
    setTagInput('')
    setTagError(null)
  }

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
      tags,
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
      <fieldset className={css.tagField}>
        <legend className={ui.label}>Теги</legend>
        <p className={ui.muted}>До 20 тегов, каждый — до 80 символов.</p>
        {tagsLoading && (
          <p role="status" className={ui.muted}>
            Загружаем теги…
          </p>
        )}
        {tagsError && (
          <p role="alert" className={ui.error}>
            {tagsError} Можно ввести тег вручную.
          </p>
        )}
        {availableTags.length > 0 && (
          <label className={ui.field}>
            <span className={ui.label}>Выбрать существующий тег</span>
            <select className={ui.input} value="" onChange={(event) => addTag(event.target.value)}>
              <option value="">Выберите тег</option>
              {availableTags
                .filter((tag) => !tags.some((selected) => tagKey(selected) === tagKey(tag.name)))
                .map((tag) => (
                  <option key={tag.id} value={tag.name}>
                    {tag.name}
                  </option>
                ))}
            </select>
          </label>
        )}
        <div className={css.tagEntry}>
          <label className={ui.field}>
            <span className={ui.label}>Новый тег</span>
            <input
              className={ui.input}
              value={tagInput}
              onChange={(event) => setTagInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  addTag(tagInput)
                }
              }}
            />
          </label>
          <button type="button" className={ui.button} onClick={() => addTag(tagInput)}>
            Добавить тег
          </button>
        </div>
        {tagError && (
          <p role="alert" className={ui.error}>
            {tagError}
          </p>
        )}
        <div className={css.tagList}>
          {tags.map((tag) => (
            <span className={css.tag} key={tag}>
              {tag}
              <button
                type="button"
                className={ui.ghost}
                aria-label={`Снять тег «${tag}»`}
                onClick={() => {
                  setTags((current) => current.filter((item) => item !== tag))
                  setTagError(null)
                }}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      </fieldset>
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
