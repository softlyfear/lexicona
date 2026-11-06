import { useMutation } from '@tanstack/react-query'
import { useRef, useState, type FormEvent } from 'react'
import { ApiError, errorMessage, type User } from '../api'
import { InstallSettings } from '../components/InstallSettings'
import ui from '../components/ui.module.css'
import {
  changePasswordSession,
  forgetSession,
  getSessionRevision,
  isCurrentSession,
} from '../session'
import css from './pages.module.css'

export function AccountPage({ user }: { user: User }) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [validation, setValidation] = useState('')
  const [passwordError, setPasswordError] = useState('')
  const [success, setSuccess] = useState('')
  const locked = useRef(false)

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

  function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (locked.current || change.isPending) return
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
      <h1 className={css.title}>Аккаунт</h1>
      <p>
        Логин: <strong>{user.login}</strong>
      </p>
      <InstallSettings />
      <form className={`${ui.card} ${css.form}`} onSubmit={submitPassword} noValidate>
        <h2>Смена пароля</h2>
        <fieldset className={css.choices} disabled={change.isPending}>
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
        <div className={css.actions}>
          <button type="submit" className={ui.primary} disabled={change.isPending}>
            Сменить пароль
          </button>
        </div>
      </form>
    </section>
  )
}
