import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { api, type Statistics } from '../api'
import { StatisticsPage } from './StatisticsPage'

vi.mock('../api', async (original) => ({
  ...(await original<typeof import('../api')>()),
  api: { statistics: vi.fn() },
}))
const stats: Statistics = {
  period: '30d',
  history_started_at: '2026-11-01T00:00:00',
  total_words: 5,
  learned_words: 2,
  unlearned_words: 3,
  total_answers: 4,
  correct_answers: 3,
  accuracy_percent: 75,
  average_answers_per_day: 2,
  active_days: 1,
  days: [
    { date: '2026-11-01', answers: 0, correct: 0 },
    { date: '2026-11-02', answers: 4, correct: 3 },
  ],
}
function page() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <StatisticsPage />
    </QueryClientProvider>,
  )
}

it('показывает ошибки и повтор, итоги и доступную таблицу графика, меняет период', async () => {
  vi.mocked(api.statistics)
    .mockReset()
    .mockRejectedValueOnce(new TypeError('offline'))
    .mockResolvedValue(stats)
  const user = userEvent.setup()
  page()
  expect(await screen.findByRole('alert')).toHaveTextContent('Не удалось загрузить статистику')
  await user.click(screen.getByRole('button', { name: 'Повторить' }))
  const summary = await screen.findByRole('region', { name: 'Итоги за всё время' })
  expect(summary).toHaveTextContent('Всего слов5')
  expect(summary).toHaveTextContent('Правильных3')
  expect(summary).toHaveTextContent('Точность75%')
  expect(summary).toHaveTextContent('Первые попытки старых занятий неизвестны')
  await user.click(screen.getByText('Таблица по дням'))
  expect(within(screen.getByRole('table')).getByText('2026-11-01')).toBeInTheDocument()
  await user.click(screen.getByLabelText('Год'))
  expect(await screen.findByText('Всего слов')).toBeInTheDocument()
  expect(api.statistics).toHaveBeenCalledWith('year')
  await user.click(screen.getByLabelText('Всё время'))
  expect(api.statistics).toHaveBeenCalledWith('all')
})

it('показывает видимую единственную точку и подписи осей за один день', async () => {
  vi.mocked(api.statistics)
    .mockReset()
    .mockResolvedValue({ ...stats, days: [{ date: '2026-11-02', answers: 4, correct: 3 }] })
  page()
  const chart = await screen.findByRole('img', { name: /График первых ответов/ })
  expect(chart.querySelector('circle')).toHaveAttribute('cy', '25')
  expect(chart).toHaveTextContent('02.11.26')
  expect(chart).toHaveTextContent('4')
  await userEvent.click(screen.getByText('Таблица по дням'))
  expect(within(screen.getByRole('table')).getByText('2026-11-02')).toBeInTheDocument()
})

it('показывает загрузку и пустой период', async () => {
  let finish!: (value: Statistics) => void
  vi.mocked(api.statistics)
    .mockReset()
    .mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
  page()
  expect(screen.getByRole('status')).toHaveTextContent('Загружаем статистику')
  finish({ ...stats, days: [], history_started_at: null, total_answers: 0, accuracy_percent: null })
  expect(await screen.findByText('За этот период ответов нет.')).toBeInTheDocument()
  expect(screen.queryByRole('img', { name: /График первых ответов/ })).not.toBeInTheDocument()
  expect(screen.getByText(/история первых ответов ещё не началась/)).toBeInTheDocument()
})

it('рисует компактный график, когда за все дни периода ответов нет', async () => {
  vi.mocked(api.statistics)
    .mockReset()
    .mockResolvedValue({
      ...stats,
      total_answers: 0,
      correct_answers: 0,
      accuracy_percent: null,
      days: [
        { date: '2026-10-07', answers: 0, correct: 0 },
        { date: '2026-10-08', answers: 0, correct: 0 },
      ],
    })
  page()
  const chart = await screen.findByRole('img', { name: /График первых ответов/ })
  expect(chart.querySelector('polyline')).toHaveAttribute('points', '45,145 340,145')
  expect(chart.getAttribute('class')).toMatch(/chart/)
  expect(within(chart).queryByText('1')).not.toBeInTheDocument()
  expect(screen.getByText('За этот период ответов нет.')).toBeInTheDocument()
  expect(screen.getByText(/максимум за день: 0/)).toBeInTheDocument()
})
