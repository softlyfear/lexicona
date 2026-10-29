import { useMutation } from '@tanstack/react-query'
import { api, errorMessage, type Difficulty, type User } from '../api'
import ui from '../components/ui.module.css'
import { queryClient } from '../session'
import css from './pages.module.css'

const LEVELS: { value: Difficulty; label: string; choice: number; typed: number }[] = [
  { value: 'very_easy', label: 'Очень легко', choice: 10, typed: 20 },
  { value: 'easy', label: 'Легко', choice: 7, typed: 14 },
  { value: 'medium', label: 'Средне', choice: 4, typed: 8 },
  { value: 'hard', label: 'Сложно', choice: 3, typed: 6 },
  { value: 'very_hard', label: 'Очень сложно', choice: 2, typed: 4 },
]

export function SettingsPage({ user }: { user: User }) {
  const update = useMutation({
    mutationFn: api.updateSettings,
    onSuccess: (next) =>
      queryClient.setQueryData(['session'], (prev: { user: User } | null) =>
        prev ? { ...prev, user: next } : prev,
      ),
  })

  return (
    <section className={css.stack}>
      <h1 className={css.title}>Настройки</h1>
      <div className={`${ui.card} ${css.form}`}>
        <fieldset className={css.choices} disabled={update.isPending}>
          <legend className={ui.label}>Сложность</legend>
          {LEVELS.map((level) => (
            <label key={level.value} className={css.choice}>
              <input
                type="radio"
                name="difficulty"
                checked={user.difficulty === level.value}
                onChange={() => update.mutate(level.value)}
              />
              <span className={css.levelName}>{level.label}</span>
              <span className={ui.muted}>
                выбор ±{level.choice} · ввод +{level.typed}/−{level.choice}
              </span>
            </label>
          ))}
        </fieldset>
        <p className={ui.muted}>
          Сложность определяет, на сколько процентов меняется прогресс слова за ответ. Новое
          значение действует со следующего занятия.
        </p>
        {update.isError && (
          <p className={ui.error} role="alert">
            {errorMessage(update.error)}
          </p>
        )}
      </div>
    </section>
  )
}
