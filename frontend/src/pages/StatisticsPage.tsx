import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api, errorMessage, type StatisticsPeriod } from '../api'
import ui from '../components/ui.module.css'
import css from './pages.module.css'

export function StatisticsPage() {
  const [period, setPeriod] = useState<StatisticsPeriod>('30d')
  const stats = useQuery({
    queryKey: ['statistics', period],
    queryFn: () => api.statistics(period),
    retry: false,
  })
  return (
    <section className={css.stack}>
      <h1 className={css.title}>Статистика</h1>
      <p>
        Учитывается первый ответ на слово в каждом занятии. Дни показаны по московскому времени.
      </p>
      <fieldset className={`${css.choices} ${css.periodChoices}`}>
        <legend className={ui.label}>Период графика</legend>
        {(
          [
            ['30d', '30 дней'],
            ['year', 'Год'],
            ['all', 'Всё время'],
          ] as const
        ).map(([value, label]) => (
          <label key={value}>
            <input
              type="radio"
              name="statistics-period"
              checked={period === value}
              onChange={() => setPeriod(value)}
            />{' '}
            {label}
          </label>
        ))}
      </fieldset>
      {stats.isPending && <p role="status">Загружаем статистику…</p>}
      {stats.isError && (
        <div role="alert">
          <p>Не удалось загрузить статистику. {errorMessage(stats.error)}</p>
          <button className={ui.button} onClick={() => void stats.refetch()}>
            Повторить
          </button>
        </div>
      )}
      {stats.data && (
        <>
          <section className={`${ui.card} ${css.stack}`} aria-label="Итоги за всё время">
            <h2>Итоги за всё время</h2>
            <dl className={css.statsList}>
              {[
                ['Всего слов', stats.data.total_words],
                ['Выучено', stats.data.learned_words],
                ['Не выучено', stats.data.unlearned_words],
                ['Ответов', stats.data.total_answers],
                ['Правильных', stats.data.correct_answers],
                [
                  'Точность',
                  stats.data.accuracy_percent == null ? '—' : `${stats.data.accuracy_percent}%`,
                ],
                ['В среднем за календарный день', stats.data.average_answers_per_day],
                ['Активных дней', stats.data.active_days],
              ].map(([label, value]) => (
                <div key={label} className={css.statsRow}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <p className={ui.muted}>
              {stats.data.history_started_at
                ? `Достоверная история первых ответов начинается ${new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'medium' }).format(new Date(stats.data.history_started_at.endsWith('Z') ? stats.data.history_started_at : `${stats.data.history_started_at}Z`))}.`
                : 'Достоверная история первых ответов ещё не началась.'}{' '}
              Первые попытки старых занятий неизвестны и не учитываются.
            </p>
          </section>
          <section className={`${ui.card} ${css.stack}`} aria-label="График">
            {stats.data.days.length === 0 || stats.data.days.every((day) => day.answers === 0) ? (
              <p>За этот период ответов нет.</p>
            ) : null}
            {stats.data.days.length > 0 && <Chart days={stats.data.days} />}
          </section>
        </>
      )}
    </section>
  )
}

function Chart({ days }: { days: { date: string; answers: number; correct: number }[] }) {
  const peak = days.reduce((highest, day) => Math.max(highest, day.answers), 0)
  const max = Math.max(1, peak)
  const x = (i: number) => (days.length === 1 ? 195 : 45 + (i / (days.length - 1)) * 295)
  const y = (value: number) => 145 - (value / max) * 120
  const points = days.map((day, i) => `${x(i)},${y(day.answers)}`).join(' ')
  const ticks = peak === 0 ? [0] : max >= 2 ? [0, Math.floor(max / 2), max] : [0, max]
  const dates =
    days.length === 1
      ? [0]
      : days.length === 2
        ? [0, 1]
        : [0, Math.floor((days.length - 1) / 2), days.length - 1]
  const shortDate = (date: string) => `${date.slice(8, 10)}.${date.slice(5, 7)}.${date.slice(2, 4)}`
  return (
    <>
      <svg
        className={css.chart}
        role="img"
        aria-label="График первых ответов по дням; подробные значения приведены в таблице ниже"
        viewBox="0 0 360 180"
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1="45"
              x2="340"
              y1={y(tick)}
              y2={y(tick)}
              stroke="var(--border)"
              strokeWidth="1"
            />
            <text x="39" y={y(tick) + 4} textAnchor="end" fill="var(--text-muted)" fontSize="11">
              {tick}
            </text>
          </g>
        ))}
        {dates.map((index) => (
          <text
            key={index}
            x={x(index)}
            y="165"
            textAnchor={
              index === 0 && days.length > 1
                ? 'start'
                : index === days.length - 1 && days.length > 1
                  ? 'end'
                  : 'middle'
            }
            fill="var(--text-muted)"
            fontSize="10"
          >
            {shortDate(days[index].date)}
          </text>
        ))}
        <polyline
          points={points}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
        {days.map(
          (day, index) =>
            (day.answers > 0 || days.length === 1) && (
              <circle key={day.date} cx={x(index)} cy={y(day.answers)} r="3" fill="var(--accent)">
                <title>
                  {day.date}: {day.answers} ответов, {day.correct} правильных
                </title>
              </circle>
            ),
        )}
      </svg>
      <p className={ui.muted}>
        От {days[0].date} до {days[days.length - 1].date}; максимум за день: {peak}.
      </p>
      <details>
        <summary>Таблица по дням</summary>
        <div className={css.dayTableWrap}>
          <table className={css.dayTable}>
            <thead>
              <tr>
                <th>Дата</th>
                <th>Ответы</th>
                <th>Правильные</th>
              </tr>
            </thead>
            <tbody>
              {days.map((day) => (
                <tr key={day.date}>
                  <td>{day.date}</td>
                  <td>{day.answers}</td>
                  <td>{day.correct}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  )
}
