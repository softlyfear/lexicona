import { useMutation } from '@tanstack/react-query'
import { NavLink, Outlet } from 'react-router'
import { api, type User } from '../api'
import { forgetSession } from '../session'
import css from './Layout.module.css'
import ui from './ui.module.css'

const LINKS = [
  { to: '/', label: 'Словарь' },
  { to: '/training', label: 'Тренировка' },
  { to: '/settings', label: 'Настройки' },
]

export function Layout({ user }: { user: User }) {
  const logout = useMutation({ mutationFn: api.logout, onSettled: forgetSession })

  return (
    <>
      <header className={css.header}>
        <div className={css.bar}>
          <span className={css.brand}>Lexicona</span>
          <nav className={css.nav} aria-label="Разделы">
            {LINKS.map(({ to, label }) => (
              <NavLink
                key={to}
                to={to}
                end
                className={({ isActive }) => (isActive ? css.active : css.link)}
              >
                {label}
              </NavLink>
            ))}
          </nav>
          <div className={css.user}>
            {user.login}
            <button
              type="button"
              className={ui.ghost}
              onClick={() => logout.mutate()}
              disabled={logout.isPending}
            >
              Выйти
            </button>
          </div>
        </div>
      </header>
      <main className={css.main}>
        <Outlet />
      </main>
    </>
  )
}
