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
          <section aria-label="Первые ответы" className={css.stack}>
            <h2 className={css.sectionTitle}>Первые ответы</h2>
            <p>
              Верно: {data.first_attempt.correct} · Неверно: {data.first_attempt.incorrect}
            </p>
            <p className={css.score}>
              Точность:{' '}
              {data.first_attempt.accuracy_percent === null
                ? 'неизвестна'
                : `${data.first_attempt.accuracy_percent}%`}
            </p>
            <p>Неизвестно: {data.first_attempt.unknown}</p>
            <p>Без ответа: {data.first_attempt.not_attempted}</p>
            <p>Не применяется: {data.first_attempt.not_applicable}</p>
            <p className={ui.muted}>
              Учитывается первый отправленный ответ, в том числе после подсказки. Исправления не
              меняют первую попытку. Первые ответы старых занятий могут быть неизвестны.
            </p>
          </section>
          <section aria-label="Завершение заданий" className={css.stack}>
            <h2 className={css.sectionTitle}>Завершение заданий</h2>
            <p>Всего заданий: {data.total}</p>
            <p>С ответом: {data.completion.answered}</p>
            <p>С помощью: {data.completion.assisted}</p>
            <p>Пропущено: {data.completion.skipped}</p>
            <p>Недоступно: {data.completion.unavailable}</p>
            <p>Не завершено: {data.completion.pending}</p>
            <p className={ui.muted}>
              Способ завершения не определяет точность: ошибка сохраняется и после показа ответа или
              пропуска.
            </p>
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
