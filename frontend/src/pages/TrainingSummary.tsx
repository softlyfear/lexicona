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
      <h1 className={css.title}>Готово</h1>
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
        <>
          <section aria-label="Первые ответы" className={css.summaryResults}>
            <p className={css.summaryAccuracy}>
              Точность:{' '}
              {data.first_attempt.accuracy_percent === null
                ? '—'
                : `${data.first_attempt.accuracy_percent}%`}
            </p>
            <p className={css.summaryCounts}>
              Верно: {data.first_attempt.correct} · Неверно: {data.first_attempt.incorrect}
            </p>
            <p className={css.summaryAssisted}>С помощью: {data.first_attempt.assisted}</p>
          </section>
        </>
      )}
      <div className={css.actions}>
        <button className={ui.primary} onClick={onFinish} disabled={finishing} autoFocus>
          Завершить
        </button>
      </div>
    </section>
  )
}
