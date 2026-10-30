import { useMutation } from '@tanstack/react-query'
import { useRef, useState, type FormEvent } from 'react'
import { ApiError, api, errorMessage, type Difficulty, type Session, type User } from '../api'
import ui from '../components/ui.module.css'
import {
  changePasswordSession,
  forgetSession,
  getSessionRevision,
  isCurrentSession,
  queryClient,
} from '../session'
import css from './pages.module.css'

const LEVELS: { value: Difficulty; label: string; choice: number; typed: number }[] = [
  { value: 'very_easy', label: 'Очень легко', choice: 10, typed: 20 },
  { value: 'easy', label: 'Легко', choice: 7, typed: 14 },
  { value: 'medium', label: 'Средне', choice: 4, typed: 8 },
  { value: 'hard', label: 'Сложно', choice: 3, typed: 6 },
  { value: 'very_hard', label: 'Очень сложно', choice: 2, typed: 4 },
]

type Result<T> = { data: T } | { error: unknown }

export function SettingsPage({ user }: { user: User }) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [validation, setValidation] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const [success, setSuccess] = useState('')
  const [difficultyError, setDifficultyError] = useState('')
  const locked = useRef(false)

  const update = useMutation({
    mutationFn: async ({
      difficulty,
    }: {
      difficulty: Difficulty
      revision: number
    }): Promise<Result<User>> => {
      try {
        return { data: await api.updateSettings(difficulty) }
      } catch (error) {
        return { error }
      }
    },
    onSuccess: (result, { revision }) => {
      if (!isCurrentSession(revision, user.id)) return
      if ('error' in result) {
        if (result.error instanceof ApiError && result.error.status === 401) forgetSession()
        else setDifficultyError(errorMessage(result.error))
        return
      }
      if (result.data.id !== user.id) return
      queryClient.setQueryData(['session'], (prev: Session | null) =>
        prev?.user.id === user.id ? { ...prev, user: result.data } : prev,
      )
    },
    onSettled: () => {
      locked.current = false
    },
  })

  const change = useMutation({
    mutationFn: (revision: number) =>
      changePasswordSession(revision, user.id, currentPassword, newPassword),
    onSuccess: (result, revision) => {
      if (result.kind === 'stale') return
      if (result.kind === 'success') {
        setCurrentPassword('')
        setNewPassword('')
        setConfirmation('')
        setValidation('')
        setSuccess('Пароль изменён. Остальные сеансы завершены.')
        return
      }
      if (result.kind === 'uncertain') {
        if (result.recovered)
          setPasswordError(
            'Не удалось подтвердить смену пароля. Проверьте пароль при следующем входе.',
          )
        return
      }
      if (!isCurrentSession(revision, user.id)) return
      if (result.error instanceof ApiError && result.error.status === 401) forgetSession()
      else setPasswordError(errorMessage(result.error))
    },
    onSettled: () => {
      locked.current = false
    },
  })

  const busy = update.isPending || change.isPending
  function updateDifficulty(difficulty: Difficulty) {
    if (locked.current) return
    locked.current = true
    setDifficultyError('')
    update.mutate({ difficulty, revision: getSessionRevision() })
  }

  function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (locked.current) return
    setValidation('')
    setPasswordError('')
    setSuccess('')
    const currentLength = [...currentPassword].length
    const length = [...newPassword].length
    if (currentLength < 1 || currentLength > 256) {
      setValidation('Введите текущий пароль длиной от 1 до 256 символов.')
      return
    }
    if (length < 12 || length > 128) {
      setValidation('Новый пароль должен содержать от 12 до 128 символов.')
      return
    }
    if (newPassword !== confirmation) {
      setValidation('Пароли не совпадают.')
      return
    }
    locked.current = true
    change.mutate(getSessionRevision())
  }

  return (
    <section className={css.stack}>
      <h1 className={css.title}>Настройки</h1>
      <p>
        Аккаунт: <strong>{user.login}</strong>
      </p>
      <div className={`${ui.card} ${css.form}`}>
        <fieldset className={css.choices} disabled={busy}>
          <legend className={ui.label}>Сложность</legend>
          {LEVELS.map((level) => (
            <label key={level.value} className={css.choice}>
              <input
                type="radio"
                name="difficulty"
                checked={user.difficulty === level.value}
                onChange={() => updateDifficulty(level.value)}
              />
              <span className={css.levelName}>{level.label}</span>
              <span className={ui.muted}>
                выбор ±{level.choice}% · ввод +{level.typed}%/−{level.choice}%
              </span>
            </label>
          ))}
        </fieldset>
        <p className={ui.muted}>
          Сложность определяет, на сколько процентов меняется прогресс слова за ответ. Новое
          значение действует со следующего занятия.
        </p>
        {difficultyError && (
          <p className={ui.error} role="alert">
            {difficultyError}
          </p>
        )}
      </div>
      <form className={`${ui.card} ${css.form}`} onSubmit={submitPassword} noValidate>
        <h2>Смена пароля</h2>
        <fieldset className={css.choices} disabled={busy}>
          <label className={ui.field}>
            <span className={ui.label}>Текущий пароль</span>
            <input
              className={ui.input}
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </label>
          <label className={ui.field}>
            <span className={ui.label}>Новый пароль</span>
            <input
              className={ui.input}
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              aria-describedby="password-hint"
            />
          </label>
          <p id="password-hint" className={ui.muted}>
            От 12 до 128 символов, включая пробелы.
          </p>
          <label className={ui.field}>
            <span className={ui.label}>Повторите новый пароль</span>
            <input
              className={ui.input}
              type="password"
              autoComplete="new-password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </label>
        </fieldset>
        {(validation || passwordError) && (
          <p className={ui.error} role="alert">
            {validation || passwordError}
          </p>
        )}
        {success && <p role="status">{success}</p>}
        <div>
          <button type="submit" className={ui.primary} disabled={busy}>
            Сменить пароль
          </button>
        </div>
      </form>
    </section>
  )
}
