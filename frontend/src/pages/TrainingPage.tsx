import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, type FormEvent } from 'react'
import {
  ApiError,
  api,
  errorMessage,
  type AnswerResult,
  type CardGrade,
  type Direction,
  type TextAnswerResult,
  type TrainingMode,
  type TrainingSession,
} from '../api'
import { SpeakButton } from '../components/ui'
import ui from '../components/ui.module.css'
import css from './pages.module.css'

const MODES: { mode: TrainingMode; direction: Direction; label: string }[] = [
  { mode: 'choice', direction: 'en_ru', label: 'Поиск перевода: EN → RU' },
  { mode: 'choice', direction: 'ru_en', label: 'Поиск слова: RU → EN' },
  { mode: 'input', direction: 'en_ru', label: 'Написание перевода: EN → RU' },
  { mode: 'input', direction: 'ru_en', label: 'Написание слова: RU → EN' },
  { mode: 'cards', direction: 'en_ru', label: 'Карточки: EN → RU' },
  { mode: 'cards', direction: 'ru_en', label: 'Карточки: RU → EN' },
]
const SIZES = [5, 10, 20, 30]
const CARD_GRADES: { value: CardGrade; label: string }[] = [
  { value: 'again', label: 'Повторить' },
  { value: 'hard', label: 'Трудно' },
  { value: 'good', label: 'Хорошо' },
  { value: 'easy', label: 'Легко' },
]

export function TrainingPage() {
  const [session, setSession] = useState<TrainingSession | null>(null)
  if (session?.mode === 'cards')
    return <CardsRun session={session} onFinish={() => setSession(null)} />
  if (session?.mode === 'input')
    return <InputRun session={session} onFinish={() => setSession(null)} />
  if (session) return <Run session={session} onFinish={() => setSession(null)} />
  return <Setup onStart={setSession} />
}

function Setup({ onStart }: { onStart: (session: TrainingSession) => void }) {
  const [direction, setDirection] = useState<Direction>('en_ru')
  const [mode, setMode] = useState<TrainingMode>('choice')
  const [size, setSize] = useState(10)
  const start = useMutation({
    mutationFn: () =>
      mode === 'choice'
        ? api.startTraining(direction, size)
        : api.startTraining(direction, size, mode),
    onSuccess: onStart,
  })

  return (
    <section className={css.stack}>
      <h1 className={css.title}>Тренировка</h1>
      <div className={`${ui.card} ${css.form}`}>
        <fieldset className={css.choices}>
          <legend className={ui.label}>Режим</legend>
          {MODES.map((d) => (
            <label key={`${d.mode}-${d.direction}`} className={css.choice}>
              <input
                type="radio"
                name="direction"
                checked={mode === d.mode && direction === d.direction}
                onChange={() => {
                  start.reset()
                  setMode(d.mode)
                  setDirection(d.direction)
                }}
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
            {mode !== 'choice' &&
            start.error instanceof ApiError &&
            start.error.message === 'not_enough_words'
              ? 'Добавьте хотя бы одно слово в словарь.'
              : errorMessage(start.error)}
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

function CardsRun({ session, onFinish }: { session: TrainingSession; onFinish: () => void }) {
  const queryClient = useQueryClient()
  const [index, setIndex] = useState(0)
  const item = session.items[index]
  const done = index >= session.items.length
  const reveal = useMutation({ mutationFn: () => api.revealCard(item.id) })
  const answer = useMutation({ mutationFn: (grade: CardGrade) => api.answerCard(item.id, grade) })

  useEffect(() => {
    return () => void queryClient.invalidateQueries({ queryKey: ['words'] })
  }, [queryClient])

  function grade(value: CardGrade) {
    if (reveal.data && !answer.data && !answer.isPending) answer.mutate(value)
  }

  function next() {
    reveal.reset()
    answer.reset()
    setIndex((i) => i + 1)
  }

  if (done) {
    return (
      <section className={`${ui.card} ${css.stack} ${css.summary}`}>
        <h1 className={css.title}>Готово</h1>
        <p>Оценено карточек: {index}</p>
        <div className={css.actions}>
          <button className={ui.primary} onClick={onFinish} autoFocus>
            Ещё занятие
          </button>
        </div>
      </section>
    )
  }

  const promptLang = session.direction === 'en_ru' ? 'en' : 'ru'
  const answerLang = promptLang === 'en' ? 'ru' : 'en'
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
      {!reveal.data && (
        <div>
          <button
            className={ui.primary}
            onClick={() => reveal.mutate()}
            disabled={reveal.isPending}
          >
            Показать ответ
          </button>
        </div>
      )}
      {reveal.isError && (
        <p className={ui.error} role="alert">
          {errorMessage(reveal.error)} Попробуйте ещё раз.
        </p>
      )}
      {reveal.data && (
        <div className={css.stack}>
          <p className={ui.muted} lang={answerLang}>
            Ответ: {(answer.data?.expected_answers ?? reveal.data.expected_answers).join(', ')}
          </p>
          <fieldset className={css.choices}>
            <legend className={ui.label}>Как вы запомнили?</legend>
            <div className={css.actions}>
              {CARD_GRADES.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={ui.button}
                  onClick={() => grade(option.value)}
                  disabled={!!answer.data || answer.isPending}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </fieldset>
        </div>
      )}
      {answer.isError && (
        <p className={ui.error} role="alert">
          {errorMessage(answer.error)} Попробуйте ещё раз.
        </p>
      )}
      {answer.data && (
        <div className={css.feedback} role="status">
          <span>
            {CARD_GRADES.find((option) => option.value === answer.data.grade)?.label} (
            {answer.data.delta > 0 ? '+' : ''}
            {answer.data.delta}) · прогресс {answer.data.progress}%
          </span>
          <button className={ui.primary} onClick={next} autoFocus>
            Далее
          </button>
        </div>
      )}
    </section>
  )
}

function InputRun({ session, onFinish }: { session: TrainingSession; onFinish: () => void }) {
  const queryClient = useQueryClient()
  const [index, setIndex] = useState(0)
  const [text, setText] = useState('')
  const [results, setResults] = useState<TextAnswerResult[]>([])
  const item = session.items[index]
  const result = results[index] as TextAnswerResult | undefined
  const done = index >= session.items.length
  const answer = useMutation({
    mutationFn: (value: string) => api.answerText(item.id, value),
    onSuccess: (data) => {
      setText(data.submitted_text)
      setResults((prev) => [...prev, data])
    },
  })

  useEffect(() => {
    return () => void queryClient.invalidateQueries({ queryKey: ['words'] })
  }, [queryClient])

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!result && !answer.isPending && !/^\s*\.?\s*$/u.test(text)) answer.mutate(text)
  }

  function next() {
    answer.reset()
    setText('')
    setIndex((i) => i + 1)
  }

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
  const answerLang = promptLang === 'en' ? 'ru' : 'en'
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
      <form key={item.id} className={css.form} onSubmit={submit}>
        <label className={ui.field}>
          <span className={ui.label}>
            {session.direction === 'en_ru' ? 'Введите перевод' : 'Введите слово'}
          </span>
          <input
            className={ui.input}
            type="text"
            lang={answerLang}
            value={text}
            onChange={(event) => setText(event.target.value)}
            maxLength={200}
            disabled={!!result || answer.isPending}
            autoComplete="off"
            autoFocus
          />
        </label>
        <div>
          <button
            className={ui.primary}
            type="submit"
            disabled={!!result || answer.isPending || /^\s*\.?\s*$/u.test(text)}
          >
            Проверить
          </button>
        </div>
      </form>
      {answer.isError && (
        <p className={ui.error} role="alert">
          {errorMessage(answer.error)} Попробуйте ещё раз.
        </p>
      )}
      {result && (
        <div className={css.stack} role="status">
          <div className={css.feedback}>
            <span className={result.correct ? css.good : css.bad}>
              {result.correct ? 'Верно' : 'Неверно'} ({result.delta > 0 ? '+' : ''}
              {result.delta}) · прогресс {result.progress}%
            </span>
            <button className={ui.primary} onClick={next} autoFocus>
              Далее
            </button>
          </div>
          <p className={ui.muted} lang={answerLang}>
            Ответ: {result.expected_answers.join(', ')}
          </p>
        </div>
      )}
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
