import { NavLink, Outlet } from 'react-router'
import { type User } from '../api'
import { logoutSession } from '../session'
import css from './Layout.module.css'
import ui from './ui.module.css'

const LINKS = [
  { to: '/', label: 'Словарь' },
  { to: '/training', label: 'Тренировка' },
  { to: '/settings', label: 'Настройки' },
]

export function Layout({ user }: { user: User }) {
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
            <NavLink to="/settings" className={css.link}>
              {user.login}
            </NavLink>
            <button type="button" className={ui.ghost} onClick={() => void logoutSession()}>
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
