import { useMutation } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { errorMessage } from '../api'
import ui from '../components/ui.module.css'
import { loginSession, requiresExplicitLogin } from '../session'
import css from './pages.module.css'

export function LoginPage() {
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const mutation = useMutation({
    mutationFn: () => loginSession(login.trim(), password),
    onSuccess: (result) => {
      if (result.kind === 'error') setError(errorMessage(result.error))
    },
  })

  function submit(event: FormEvent) {
    event.preventDefault()
    if (mutation.isPending) return
    setError('')
    mutation.mutate()
  }

  return (
    <main className={css.center}>
      <form className={`${ui.card} ${css.loginForm}`} onSubmit={submit}>
        <h1 className={css.logo}>Lexicona</h1>
        {requiresExplicitLogin() && (
          <p className={ui.muted}>Сессия завершена. Для продолжения войдите снова.</p>
        )}
        <label className={ui.field}>
          <span className={ui.label}>Логин</span>
          <input
            className={ui.input}
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            required
          />
        </label>
        <label className={ui.field}>
          <span className={ui.label}>Пароль</span>
          <input
            className={ui.input}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error && (
          <p className={ui.error} role="alert">
            {error}
          </p>
        )}
        <button className={ui.primary} disabled={mutation.isPending}>
          Войти
        </button>
      </form>
    </main>
  )
}
