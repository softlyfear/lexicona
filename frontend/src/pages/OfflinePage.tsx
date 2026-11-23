import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { SpeakButton } from '../components/ui'
import ui from '../components/ui.module.css'
import { confirmDraftLeave } from '../drafts'
import { type OfflineRecord } from '../offlineStorage'
import { cancelSpeech, setSpeechOwner, useSpeech } from '../speech'
import css from './OfflinePage.module.css'

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
  onSave: (itemId: string, answer: string | null) => Promise<void>
  ownsSpeech: boolean
}) {
  const ownerId = record?.ownerId
  const pack = record?.pack
  const position = record?.attempts.length ?? 0
  const current = pack?.items[position]
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
        <>
          {current ? (
            <OfflineExercise
              key={current.id}
              item={current}
              position={position}
              total={pack.items.length}
              onSave={onSave}
            />
          ) : (
            pack.items.length > 0 && (
              <section className={ui.card}>
                <h2>Упражнения закончены</h2>
                <p>Результаты появятся после подключения.</p>
              </section>
            )
          )}
          {pack.study.length > 0 && (
            <section className={ui.card}>
              <h2>Слова для повторения</h2>
              <ul className={css.words}>
                {pack.study.map(({ headword, translations }) => (
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
            </section>
          )}
        </>
      )}
    </main>
  )
}

function OfflineExercise({
  item,
  position,
  total,
  onSave,
}: {
  item: { id: string; prompt: string }
  position: number
  total: number
  onSave: (itemId: string, answer: string | null) => Promise<void>
}) {
  const [answer, setAnswer] = useState('')
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const text = answer.trim()
  const valid = text !== '' && text !== '.'

  async function save(text: string | null) {
    if (saving) return
    setSaving(true)
    setFailed(false)
    try {
      await onSave(item.id, text)
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (valid) void save(text)
  }

  return (
    <section className={ui.card} aria-labelledby="offline-exercise">
      <h2 id="offline-exercise">
        Перевод на русский {position + 1} из {total}
      </h2>
      <p>
        <strong lang="en">{item.prompt}</strong>
        <SpeakButton lang="en-US" text={item.prompt} offline />
      </p>
      <form className={css.form} onSubmit={submit}>
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
        <div className={css.actions}>
          <button type="submit" className={ui.primary} disabled={saving || !valid}>
            Сохранить ответ
          </button>
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
