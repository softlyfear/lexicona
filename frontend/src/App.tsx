import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { errorMessage } from './api'
import { Layout } from './components/Layout'
import ui from './components/ui.module.css'
import { LoginPage } from './pages/LoginPage'
import { SettingsPage } from './pages/SettingsPage'
import { TrainingPage } from './pages/TrainingPage'
import { WordsPage } from './pages/WordsPage'
import { useSession } from './session'

export function App() {
  const session = useSession()

  if (session.isPending) return null
  if (session.isError)
    return (
      <p className={ui.error} role="alert" style={{ padding: '1rem' }}>
        {errorMessage(session.error)}
      </p>
    )
  if (!session.data) return <LoginPage />

  const { user } = session.data
  return (
    // key: a different account gets a fresh tree with no leftover component state.
    <BrowserRouter key={user.id}>
      <Routes>
        <Route element={<Layout user={user} />}>
          <Route index element={<WordsPage />} />
          <Route path="training" element={<TrainingPage />} />
          <Route path="settings" element={<SettingsPage user={user} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
