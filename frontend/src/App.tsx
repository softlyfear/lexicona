import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { errorMessage } from './api'
import { Layout } from './components/Layout'
import ui from './components/ui.module.css'
import { AccountPage } from './pages/AccountPage'
import { LoginPage } from './pages/LoginPage'
import { OfflinePage } from './pages/OfflinePage'
import { SettingsPage } from './pages/SettingsPage'
import { StatisticsPage } from './pages/StatisticsPage'
import { TrainingPage } from './pages/TrainingPage'
import { WordsPage } from './pages/WordsPage'
import { getSessionRevision, requiresExplicitLogin, useSession } from './session'
import { useOfflinePractice } from './useOfflinePractice'

export function App() {
  const session = useSession()
  const offline = useOfflinePractice(session)

  const offlinePage = offline.offline && !requiresExplicitLogin() && session.data !== null && (
    <OfflinePage
      record={offline.readyPack}
      loading={offline.loadingPack}
      message={offline.message}
      onSave={offline.save}
      onLogout={offline.signOut}
      ownsSpeech={!session.data}
    />
  )
  if (!session.data && offlinePage) return offlinePage
  if (session.isPending)
    return (
      <main style={{ padding: '1rem' }}>
        <p role="status">Открываем Lexicona…</p>
      </main>
    )
  if (session.isError && !offlinePage)
    return (
      <div style={{ padding: '1rem' }}>
        <p className={ui.error} role="alert">
          {errorMessage(session.error)}
        </p>
        <button className={ui.button} onClick={() => void session.refetch()}>
          Повторить
        </button>
      </div>
    )
  if (!session.data) return <LoginPage />

  const { user } = session.data
  return (
    <>
      <div hidden={Boolean(offlinePage)}>
        {/* A different account gets a fresh tree with no leftover component state. */}
        <BrowserRouter key={user.id}>
          <Routes>
            <Route element={<Layout user={user} onLogout={offline.signOut} />}>
              <Route index element={<WordsPage userId={user.id} />} />
              <Route
                path="training"
                element={
                  <TrainingPage
                    key={getSessionRevision()}
                    userId={user.id}
                    accountTraining={user.preferences?.training}
                    autoAdvance={user.preferences?.training_auto_advance === true}
                    autoCheck={user.preferences?.training_auto_check === true}
                  />
                }
              />
              <Route path="statistics" element={<StatisticsPage />} />
              <Route path="account" element={<AccountPage user={user} />} />
              <Route
                path="settings"
                element={<SettingsPage user={user} offline={offline.settings} />}
              />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </div>
      {offlinePage}
    </>
  )
}
