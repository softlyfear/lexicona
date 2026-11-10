import { useEffect, type ReactNode } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router'
import { cancelSpeech, setSpeechOwner, useSpeech } from '../speech'
import { type User } from '../api'
import { logoutSession } from '../session'
import css from './Layout.module.css'
import ui from './ui.module.css'

const LINKS = [
  { to: '/', label: 'Словарь', icon: 'book' },
  { to: '/training', label: 'Тренировка', icon: 'practice' },
  { to: '/statistics', label: 'Статистика', icon: 'chart' },
  { to: '/settings', label: 'Настройки', icon: 'settings' },
] as const

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
    <div className={css.shell}>
      <header className={css.header}>
        <div className={css.bar}>
          <NavLink to={dictionaryTo} className={css.brand}>
            Lexicona
          </NavLink>
          <nav className={css.nav} aria-label="Разделы">
            {LINKS.map(({ to, label, icon }) => (
              <NavLink
                key={to}
                to={to === '/' ? dictionaryTo : to}
                end
                className={({ isActive }) => (isActive ? css.active : css.link)}
              >
                <SectionIcon name={icon} />
                <span className={css.navLabel}>{label}</span>
              </NavLink>
            ))}
          </nav>
          <div className={css.user}>
            <NavLink to="/account" className={({ isActive }) => (isActive ? css.active : css.link)}>
              {user.login}
            </NavLink>
            <button
              type="button"
              className={`${ui.ghost} ${css.logout}`}
              onClick={() => void logoutSession()}
            >
              <SectionIcon name="logout" />
              <span className={css.logoutText}>Выйти</span>
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
    </div>
  )
}

function SectionIcon({ name }: { name: (typeof LINKS)[number]['icon'] | 'logout' }) {
  const className = name === 'logout' ? css.logoutIcon : css.navIcon
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths(name)}
    </svg>
  )
}

function paths(name: (typeof LINKS)[number]['icon'] | 'logout'): ReactNode {
  if (name === 'book')
    return (
      <>
        <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5Z" />
        <path d="M4 5.5A2.5 2.5 0 0 1 6.5 8H20" />
      </>
    )
  if (name === 'practice')
    return (
      <>
        <rect x="4" y="3.5" width="16" height="17" rx="2" />
        <path d="m8.5 12 2.4 2.4 4.6-5" />
      </>
    )
  if (name === 'chart')
    return (
      <>
        <path d="M4 19V5" />
        <path d="M4 19h16" />
        <path d="M8 16v-4" />
        <path d="M12 16V8" />
        <path d="M16 16v-6" />
      </>
    )
  if (name === 'settings')
    return (
      <>
        <path d="M4 7h16" />
        <path d="M4 12h16" />
        <path d="M4 17h16" />
        <circle cx="8" cy="7" r="1.7" fill="currentColor" stroke="none" />
        <circle cx="15" cy="12" r="1.7" fill="currentColor" stroke="none" />
        <circle cx="10" cy="17" r="1.7" fill="currentColor" stroke="none" />
      </>
    )
  return (
    <>
      <path d="M10 7V5.5A1.5 1.5 0 0 1 11.5 4H20v16h-8.5A1.5 1.5 0 0 1 10 18.5V17" />
      <path d="M14 12H3" />
      <path d="m6 9-3 3 3 3" />
    </>
  )
}
