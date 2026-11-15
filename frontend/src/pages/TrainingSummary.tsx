import { useQuery } from '@tanstack/react-query'
import { api, errorMessage } from '../api'
import ui from '../components/ui.module.css'
import css from './pages.module.css'

export function TrainingSummary({
  sessionId,
  onFinish,
  finishing,
}: {
  sessionId: string
  onFinish: () => void
  finishing: boolean
}) {
  const summary = useQuery({
    queryKey: ['training', sessionId, 'summary'],
    queryFn: () => api.trainingSummary(sessionId),
    retry: false,
    refetchOnMount: 'always',
  })
  const data = summary.data
  return (
    <section className={`${ui.card} ${css.stack} ${css.summary}`}>
      {summary.isFetching && <p role="status">Загружаем итоги…</p>}
      {summary.isError && (
        <div className={css.stack}>
          <p className={ui.error} role="alert">
            Не удалось загрузить итоги. {errorMessage(summary.error)}
          </p>
          <button
            className={ui.button}
            onClick={() => void summary.refetch()}
            disabled={summary.isFetching}
          >
            Повторить
          </button>
        </div>
      )}
      {data && !summary.isError && (
        <section aria-label="Первые ответы">
          <dl className={css.statsList}>
            <div className={css.statsRow}>
              <dt>Точность</dt>
              <dd>
                {data.first_attempt.accuracy_percent === null
                  ? '—'
                  : `${data.first_attempt.accuracy_percent}%`}
              </dd>
            </div>
            <div className={css.statsRow}>
              <dt>Верно</dt>
              <dd>{data.first_attempt.correct}</dd>
            </div>
            <div className={css.statsRow}>
              <dt>Неверно</dt>
              <dd>{data.first_attempt.incorrect}</dd>
            </div>
            <div className={css.statsRow}>
              <dt>С помощью</dt>
              <dd>{data.first_attempt.assisted}</dd>
            </div>
          </dl>
        </section>
      )}
      <div className={css.actions}>
        <button className={ui.primary} onClick={onFinish} disabled={finishing} autoFocus>
          Завершить
        </button>
      </div>
    </section>
  )
}
