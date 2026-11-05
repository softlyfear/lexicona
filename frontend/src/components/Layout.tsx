import { useEffect } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router'
import { cancelSpeech, setSpeechOwner, useSpeech } from '../speech'
import { type User } from '../api'
import { logoutSession } from '../session'
import css from './Layout.module.css'
import ui from './ui.module.css'

const LINKS = [
  { to: '/', label: 'Словарь' },
  { to: '/training', label: 'Тренировка' },
  { to: '/statistics', label: 'Статистика' },
  { to: '/settings', label: 'Настройки' },
]

export function Layout({ user }: { user: User }) {
  const location = useLocation()
  const { pathname } = location
  // Another section opens the dictionary at `/`. While it is already open, these links
  // keep the current filters instead of dropping them.
  const dictionaryTo = pathname === '/' ? `/${location.search}` : '/'
  const { notice } = useSpeech()
  useEffect(() => {
    setSpeechOwner(user.id)
    const hide = () => {
      if (document.hidden) cancelSpeech()
    }
    document.addEventListener('visibilitychange', hide)
    return () => {
      document.removeEventListener('visibilitychange', hide)
      setSpeechOwner(null)
    }
  }, [user.id])
  useEffect(() => () => cancelSpeech(), [pathname])
  return (
    <>
      <header className={css.header}>
        <div className={css.bar}>
          <NavLink to={dictionaryTo} className={css.brand}>
            Lexicona
          </NavLink>
          <nav className={css.nav} aria-label="Разделы">
            {LINKS.map(({ to, label }) => (
              <NavLink
                key={to}
                to={to === '/' ? dictionaryTo : to}
                end
                className={({ isActive }) => (isActive ? css.active : css.link)}
              >
                {label}
              </NavLink>
            ))}
          </nav>
          <div className={css.user}>
            <NavLink to="/account" className={({ isActive }) => (isActive ? css.active : css.link)}>
              {user.login}
            </NavLink>
            <button type="button" className={ui.ghost} onClick={() => void logoutSession()}>
              Выйти
            </button>
          </div>
        </div>
        {notice && pathname !== '/settings' && (
          <div className={css.speechStatus}>
            <p role="status">{notice}</p>
          </div>
        )}
      </header>
      <main className={css.main}>
        <Outlet />
      </main>
    </>
  )
}
