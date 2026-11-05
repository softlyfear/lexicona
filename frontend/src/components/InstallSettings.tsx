import { isStandalone, requestInstall, useInstallState } from '../install'
import ui from './ui.module.css'

export function InstallSettings() {
  const { prompt, installed } = useInstallState()
  if (installed || isStandalone() || !prompt) return null
  return (
    <section className={ui.card} aria-label="Установка">
      <button
        type="button"
        className={ui.button}
        onClick={() => void requestInstall().catch(() => undefined)}
      >
        Установка
      </button>
    </section>
  )
}
