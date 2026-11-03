import { useState } from 'react'
import { isStandalone, requestInstall, useInstallState } from '../install'
import css from '../pages/pages.module.css'
import ui from './ui.module.css'

export function InstallSettings() {
  const { prompt, installed } = useInstallState()
  const [error, setError] = useState(false)
  return (
    <section className={`${ui.card} ${css.form}`} aria-labelledby="install-heading">
      <h2 id="install-heading">Установка приложения</h2>
      {installed || isStandalone() ? (
        <p>Приложение открыто или установлено на этом устройстве.</p>
      ) : (
        <>
          <p>Для работы приложения требуется подключение к интернету.</p>
          {prompt && (
            <div>
              <button
                type="button"
                className={ui.button}
                onClick={() => {
                  setError(false)
                  void requestInstall().catch(() => setError(true))
                }}
              >
                Установить приложение
              </button>
            </div>
          )}
          {error && <p role="alert">Не удалось открыть установку. Используйте меню браузера.</p>}
          <p>
            Android, Chrome: откройте меню ⋮ и выберите «Установить приложение» или «Добавить на
            главный экран».
          </p>
          <p>iPhone или iPad, Safari: нажмите «Поделиться», затем «На экран Домой» и «Добавить».</p>
          <p className={ui.muted}>
            Для установки откройте сайт по HTTPS (для разработки также подходит localhost).
          </p>
        </>
      )}
    </section>
  )
}
