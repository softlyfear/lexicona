import { isStandalone, requestInstall, useInstallState } from '../install'
import ui from './ui.module.css'
import css from './InstallSettings.module.css'

export function InstallSettings() {
  const { prompt, installed } = useInstallState()
  if (installed || isStandalone() || !prompt) return null
  return (
    <section className={css.panel} aria-labelledby="install-heading">
      <div className={css.copy}>
        <h2 id="install-heading" className={css.title}>
          Установка
        </h2>
        <p className={ui.muted}>Добавить Lexicona на экран этого устройства.</p>
      </div>
      <button
        type="button"
        className={ui.primary}
        onClick={() => void requestInstall().catch(() => undefined)}
      >
        Установить
      </button>
    </section>
  )
}
