import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, errorMessage, type AnswerResult, type Direction, type TrainingSession } from '../api'
import { SpeakButton } from '../components/ui'
import ui from '../components/ui.module.css'
import css from './pages.module.css'

const DIRECTIONS: { value: Direction; label: string }[] = [
  { value: 'en_ru', label: 'Поиск перевода: EN → RU' },
  { value: 'ru_en', label: 'Поиск слова: RU → EN' },
]
const SIZES = [5, 10, 20, 30]

export function TrainingPage() {
  const [session, setSession] = useState<TrainingSession | null>(null)
  if (session) return <Run session={session} onFinish={() => setSession(null)} />
  return <Setup onStart={setSession} />
}

function Setup({ onStart }: { onStart: (session: TrainingSession) => void }) {
  const [direction, setDirection] = useState<Direction>('en_ru')
  const [size, setSize] = useState(10)
  const start = useMutation({
    mutationFn: () => api.startTraining(direction, size),
    onSuccess: onStart,
  })

  return (
    <section className={css.stack}>
      <h1 className={css.title}>Тренировка</h1>
      <div className={`${ui.card} ${css.form}`}>
        <fieldset className={css.choices}>
          <legend className={ui.label}>Режим</legend>
          {DIRECTIONS.map((d) => (
            <label key={d.value} className={css.choice}>
              <input
                type="radio"
                name="direction"
                checked={direction === d.value}
                onChange={() => setDirection(d.value)}
              />
              {d.label}
            </label>
          ))}
        </fieldset>
        <fieldset className={css.choices}>
          <legend className={ui.label}>Слов в занятии</legend>
          <div className={css.actions}>
            {SIZES.map((n) => (
              <button
                key={n}
                type="button"
                className={n === size ? ui.primary : ui.button}
                aria-pressed={n === size}
                onClick={() => setSize(n)}
              >
                {n}
              </button>
            ))}
          </div>
        </fieldset>
        <p className={ui.muted}>Сначала идут слова с наименьшим прогрессом.</p>
        {start.isError && (
          <p className={ui.error} role="alert">
            {errorMessage(start.error)}
          </p>
        )}
        <div>
          <button className={ui.primary} onClick={() => start.mutate()} disabled={start.isPending}>
            Начать
          </button>
        </div>
      </div>
    </section>
  )
}

function Run({ session, onFinish }: { session: TrainingSession; onFinish: () => void }) {
  const queryClient = useQueryClient()
  const [index, setIndex] = useState(0)
  const [results, setResults] = useState<AnswerResult[]>([])
  const item = session.items[index]
  const result = results[index] as AnswerResult | undefined
  const done = index >= session.items.length

  const answer = useMutation({
    mutationFn: (option: number) => api.answer(item.id, option),
    onSuccess: (data) => setResults((prev) => [...prev, data]),
  })

  // Progress changed on the server: the word list must refetch next time.
  useEffect(() => {
    return () => void queryClient.invalidateQueries({ queryKey: ['words'] })
  }, [queryClient])

  function choose(option: number) {
    if (!result && !answer.isPending) answer.mutate(option)
  }

  function next() {
    answer.reset()
    setIndex((i) => i + 1)
  }

  useEffect(() => {
    if (done) return
    function onKey(event: KeyboardEvent) {
      if (
        event.target instanceof HTMLElement &&
        event.target.closest('button') &&
        event.key === 'Enter'
      )
        return // let the focused button handle Enter itself
      const n = Number(event.key)
      if (!result && n >= 1 && n <= 4) choose(n - 1)
      else if (result && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault()
        next()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (done) {
    const correct = results.filter((r) => r.correct).length
    return (
      <section className={`${ui.card} ${css.stack} ${css.summary}`}>
        <h1 className={css.title}>Готово</h1>
        <p className={css.score}>
          {correct} из {results.length}
        </p>
        <div className={css.actions}>
          <button className={ui.primary} onClick={onFinish} autoFocus>
            Ещё занятие
          </button>
        </div>
      </section>
    )
  }

  const promptLang = session.direction === 'en_ru' ? 'en' : 'ru'
  return (
    <section className={css.stack}>
      <div className={css.toolbar}>
        <span className={ui.muted}>
          {index + 1} / {session.items.length}
        </span>
        <button className={ui.ghost} onClick={onFinish}>
          Завершить
        </button>
      </div>
      <div className={`${ui.card} ${css.question}`}>
        <span className={css.prompt} lang={promptLang}>
          {item.prompt}
        </span>
        <SpeakButton text={item.prompt} lang={promptLang === 'en' ? 'en-US' : 'ru-RU'} />
      </div>
      <div className={css.options} role="group" aria-label="Варианты ответа">
        {item.options.map((option, i) => {
          let state = ''
          if (result && i === result.correct_option) state = css.right
          else if (result && i === result.chosen_option) state = css.wrong
          return (
            <button
              key={i}
              className={`${ui.button} ${css.option} ${state}`}
              onClick={() => choose(i)}
              disabled={!!result || answer.isPending}
              lang={promptLang === 'en' ? 'ru' : 'en'}
            >
              <span className={css.optionKey}>{i + 1}</span>
              {option}
            </button>
          )
        })}
      </div>
      {answer.isError && (
        <p className={ui.error} role="alert">
          {errorMessage(answer.error)} Попробуйте ещё раз.
        </p>
      )}
      {result && (
        <div className={css.feedback} role="status">
          <span className={result.correct ? css.good : css.bad}>
            {result.correct ? 'Верно' : 'Неверно'}
            {result.delta !== 0 && ` (${result.delta > 0 ? '+' : ''}${result.delta})`} · прогресс{' '}
            {result.progress}%
          </span>
          <button className={ui.primary} onClick={next} autoFocus>
            Далее
          </button>
        </div>
      )}
    </section>
  )
}
