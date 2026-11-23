import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { type OfflineExercise as Exercise } from '../api'
import { SpeakButton } from '../components/ui'
import ui from '../components/ui.module.css'
import { confirmDraftLeave } from '../drafts'
import { type OfflineRecord } from '../offlineStorage'
import { offlineExercises } from '../offlineSync'
import { cancelSpeech, setSpeechOwner, speak, useSpeech } from '../speech'
import css from './OfflinePage.module.css'

type SaveAnswer = (
  exerciseId: string,
  itemId: string,
  answer: string | number | null,
) => Promise<void>

const REVIEW = 'review'
const FLASHCARDS = 'flashcards'
const REVIEW_PAGE_SIZE = 50

export function OfflinePage({
  record,
  loading,
  message,
  onLogout,
  onSave,
  ownsSpeech,
}: {
  record?: OfflineRecord
  loading: boolean
  message: ReactNode
  onLogout: () => Promise<void>
  onSave: SaveAnswer
  ownsSpeech: boolean
}) {
  const ownerId = record?.ownerId
  const pack = record?.pack
  const { notice } = useSpeech()

  useEffect(() => {
    if (ownerId && ownsSpeech) {
      setSpeechOwner(ownerId, { speech: null, offline: true })
      return () => setSpeechOwner(null)
    }
    cancelSpeech()
    return cancelSpeech
  }, [ownerId, ownsSpeech])

  return (
    <main className={css.page}>
      <header className={css.header}>
        <h1>Lexicona · Офлайн</h1>
        <button
          type="button"
          className={ui.ghost}
          onClick={() => {
            if (confirmDraftLeave()) void onLogout()
          }}
        >
          Выйти
        </button>
      </header>
      {message && (
        <p className={ui.muted} role="status">
          {message}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {loading ? (
        <p role="status">Загружаем офлайн-упражнения…</p>
      ) : !pack ? (
        <p>Подключитесь к интернету, чтобы подготовить слова и упражнения.</p>
      ) : (
        <OfflinePackage key={pack.id} pack={pack} attempts={record.attempts} onSave={onSave} />
      )}
    </main>
  )
}

function OfflinePackage({
  pack,
  attempts,
  onSave,
}: {
  pack: NonNullable<OfflineRecord['pack']>
  attempts: OfflineRecord['attempts']
  onSave: SaveAnswer
}) {
  const exercises = offlineExercises(pack).filter(({ items }) => items.length > 0)
  const [selection, setSelection] = useState(() => exercises[0]?.id ?? REVIEW)
  const exercise = exercises.find(({ id }) => id === selection)
  const attempted = new Set(attempts.map(({ itemId }) => itemId))
  const position = exercise?.items.findIndex(({ id }) => !attempted.has(id)) ?? -1
  const current = exercise?.items[position]

  return (
    <>
      <label className={ui.field}>
        <span className={ui.label}>Офлайн-раздел</span>
        <select
          className={ui.input}
          value={selection}
          onChange={(event) => {
            cancelSpeech()
            setSelection(event.target.value)
          }}
        >
          {exercises.map(({ id, mode, direction }) => (
            <option key={id} value={id}>
              {mode === 'input' ? 'Письменно' : 'Выбор'}{' '}
              {direction === 'en_ru' ? 'EN → RU' : 'RU → EN'}
            </option>
          ))}
          {pack.study.length > 0 && <option value={REVIEW}>Слова для повторения</option>}
          {pack.study.length > 0 && <option value={FLASHCARDS}>Карточки</option>}
        </select>
      </label>
      {selection === REVIEW ? (
        <OfflineReview words={pack.study} />
      ) : selection === FLASHCARDS && pack.study.length > 0 ? (
        <OfflineFlashcards words={pack.study} />
      ) : exercise && current ? (
        <OfflineExercise
          key={current.id}
          exercise={exercise}
          item={current}
          position={position}
          total={exercise.items.length}
          onSave={onSave}
        />
      ) : (
        <section className={ui.card}>
          <h2>Упражнение закончено</h2>
          <p>Ответы проверяются после подключения.</p>
        </section>
      )}
    </>
  )
}

function OfflineFlashcards({ words }: { words: NonNullable<OfflineRecord['pack']>['study'] }) {
  const [position, setPosition] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const index = Math.min(position, words.length - 1)
  const { headword, translations } = words[index]!
  const translation = translations.join(', ')

  function move(next: number) {
    cancelSpeech()
    setPosition(next)
    setRevealed(false)
  }

  return (
    <section className={`${ui.card} ${css.flashcard}`} aria-labelledby="offline-flashcards">
      <h2 id="offline-flashcards">Карточки</h2>
      <p className={ui.muted} role="status">
        {index + 1} из {words.length}
      </p>
      <p className={css.prompt}>
        <strong lang="en">{headword}</strong>
        <SpeakButton lang="en-US" text={headword} offline />
      </p>
      <p id="offline-card-translation" className={css.prompt} hidden={!revealed}>
        {revealed && (
          <>
            <span lang="ru">{translation}</span>
            <SpeakButton lang="ru-RU" text={translation} offline />
          </>
        )}
      </p>
      <div className={css.cardActions}>
        <button
          type="button"
          className={ui.button}
          onClick={() => move(index - 1)}
          disabled={index === 0}
        >
          Назад
        </button>
        <button
          type="button"
          className={ui.primary}
          aria-expanded={revealed}
          aria-controls="offline-card-translation"
          onClick={() => setRevealed(!revealed)}
        >
          {revealed ? 'Скрыть перевод' : 'Показать перевод'}
        </button>
        <button
          type="button"
          className={ui.button}
          onClick={() => move(index + 1)}
          disabled={index === words.length - 1}
        >
          Дальше
        </button>
      </div>
    </section>
  )
}

function OfflineReview({ words }: { words: NonNullable<OfflineRecord['pack']>['study'] }) {
  const [visible, setVisible] = useState(REVIEW_PAGE_SIZE)
  return (
    <section className={ui.card} aria-labelledby="offline-review">
      <h2 id="offline-review">Слова для повторения</h2>
      <ul className={css.words}>
        {words.slice(0, visible).map(({ headword, translations }) => (
          <li key={headword}>
            <strong lang="en">{headword}</strong>
            <SpeakButton lang="en-US" text={headword} offline />
            <div lang="ru">
              {translations.join(', ')}
              <SpeakButton lang="ru-RU" text={translations.join(', ')} offline />
            </div>
          </li>
        ))}
      </ul>
      {visible < words.length && (
        <button
          type="button"
          className={`${ui.button} ${css.more}`}
          onClick={() => setVisible((count) => count + REVIEW_PAGE_SIZE)}
        >
          Показать ещё
        </button>
      )}
    </section>
  )
}

function OfflineExercise({
  exercise,
  item,
  position,
  total,
  onSave,
}: {
  exercise: Omit<Exercise, 'items'>
  item: { id: string; prompt: string; options?: string[] }
  position: number
  total: number
  onSave: SaveAnswer
}) {
  const [answer, setAnswer] = useState('')
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const savingRef = useRef(false)
  const text = answer.trim()
  const valid = text !== '' && text !== '.'
  const toRussian = exercise.direction === 'en_ru'

  async function save(value: string | number | null) {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setFailed(false)
    try {
      if (typeof value === 'number') {
        const option = item.options?.[value]
        if (option !== undefined) speak(option, toRussian ? 'ru' : 'en', { offline: true })
      }
      await onSave(exercise.id, item.id, value)
    } catch {
      setFailed(true)
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (exercise.mode === 'input' && valid) void save(text)
  }

  return (
    <section className={ui.card} aria-labelledby="offline-exercise">
      <h2 id="offline-exercise">
        Перевод на {toRussian ? 'русский' : 'английский'} {position + 1} из {total}
      </h2>
      <p className={css.prompt}>
        <strong lang={toRussian ? 'en' : 'ru'}>{item.prompt}</strong>
        <SpeakButton lang={toRussian ? 'en-US' : 'ru-RU'} text={item.prompt} offline />
      </p>
      <form className={css.form} onSubmit={submit}>
        {exercise.mode === 'input' ? (
          <label className={ui.field}>
            <span className={ui.label}>Ответ</span>
            <input
              className={ui.input}
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              maxLength={200}
              autoComplete="off"
              disabled={saving}
            />
          </label>
        ) : (
          <div className={css.options}>
            {item.options?.map((option, index) => (
              <button
                key={option}
                type="button"
                className={ui.button}
                disabled={saving}
                lang={toRussian ? 'ru' : 'en'}
                onClick={() => void save(index)}
              >
                {option}
              </button>
            ))}
          </div>
        )}
        <div className={css.actions}>
          {exercise.mode === 'input' && (
            <button type="submit" className={ui.primary} disabled={saving || !valid}>
              Сохранить ответ
            </button>
          )}
          <button
            type="button"
            className={ui.button}
            disabled={saving}
            onClick={() => void save(null)}
          >
            Пропустить
          </button>
        </div>
        {failed && (
          <p className={ui.error} role="alert">
            Не удалось сохранить ответ на устройстве. Попробуйте ещё раз.
          </p>
        )}
      </form>
    </section>
  )
}
