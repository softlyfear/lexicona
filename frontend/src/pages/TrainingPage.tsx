import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  ApiError,
  api,
  errorMessage,
  type CardGrade,
  type Direction,
  type TerminalResult,
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

type Action =
  | { kind: 'choice'; option: number }
  | { kind: 'text'; text: string }
  | { kind: 'grade'; grade: CardGrade }
  | { kind: 'reveal' }
  | { kind: 'skip' }

function Run({ session, onFinish }: { session: TrainingSession; onFinish: () => void }) {
  const queryClient = useQueryClient()
  const [index, setIndex] = useState(0)
  const [text, setText] = useState('')
  const [revealed, setRevealed] = useState<string[] | null>(null)
  const [results, setResults] = useState<TerminalResult[]>([])
  const locked = useRef(false)
  const item = session.items[index]
  const result = results[index] as TerminalResult | undefined
  const done = index >= session.items.length
  const action = useMutation({
    mutationFn: (value: Action) => {
      switch (value.kind) {
        case 'choice':
          return api.answer(item.id, value.option)
        case 'text':
          return api.answerText(item.id, value.text)
        case 'grade':
          return api.answerCard(item.id, value.grade)
        case 'reveal':
          return session.mode === 'cards' ? api.revealCard(item.id) : api.revealAnswer(item.id)
        case 'skip':
          return api.skipItem(item.id)
      }
    },
    onSuccess: (data) => {
      if (data.outcome === 'revealed') {
        setRevealed(data.expected_answers)
        locked.current = false
      } else {
        if (data.outcome === 'answered' && 'submitted_text' in data) setText(data.submitted_text)
        setResults((previous) => [...previous, data])
      }
    },
    onError: () => {
      locked.current = false
    },
  })

  useEffect(() => {
    return () => void queryClient.invalidateQueries({ queryKey: ['words'] })
  }, [queryClient])

  function perform(value: Action) {
    if (locked.current || result) return
    locked.current = true
    action.mutate(value)
  }

  function next() {
    locked.current = false
    action.reset()
    setText('')
    setRevealed(null)
    setIndex((i) => i + 1)
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!/^\s*\.?\s*$/u.test(text)) perform({ kind: 'text', text })
  }

  useEffect(() => {
    if (done || session.mode !== 'choice') return
    function onKey(event: KeyboardEvent) {
      if (
        event.target instanceof HTMLElement &&
        event.target.closest('button') &&
        event.key === 'Enter'
      )
        return
      const n = Number(event.key)
      if (!result && n >= 1 && n <= 4) perform({ kind: 'choice', option: n - 1 })
      else if (result && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault()
        next()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (done) {
    const answers = results.filter((r) => r.outcome === 'answered' && 'correct' in r)
    const correct = answers.filter((r) => 'correct' in r && r.correct).length
    const assisted = results.filter((r) => r.outcome === 'assisted').length
    const skipped = results.filter((r) => r.outcome === 'skipped').length
    const graded = results.filter((r) => r.outcome === 'answered' && 'grade' in r).length
    return (
      <section className={`${ui.card} ${css.stack} ${css.summary}`}>
        <h1 className={css.title}>Готово</h1>
        {session.mode === 'cards' ? (
          <p>Оценено карточек: {graded}</p>
        ) : (
          <>
            {answers.length > 0 && (
              <p className={css.score}>
                {correct} из {answers.length}
              </p>
            )}
            <p>
              Верно: {correct} · Неверно: {answers.length - correct}
            </p>
            <p>С помощью: {assisted}</p>
          </>
        )}
        <p>Пропущено: {skipped}</p>
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
  const busy = action.isPending
  const disabled = busy || !!result
  const cardAnswer =
    revealed ??
    (result?.outcome === 'answered' && 'grade' in result ? result.expected_answers : null)
  const revealedAnswers =
    result?.outcome === 'assisted' || (result?.outcome === 'answered' && 'submitted_text' in result)
      ? result.expected_answers
      : null
  let label = ''
  if (result) {
    if (result.outcome === 'skipped') label = 'Пропущено'
    else if (result.outcome === 'assisted') label = 'С помощью'
    else if ('grade' in result)
      label = CARD_GRADES.find((option) => option.value === result.grade)?.label ?? ''
    else label = result.correct ? 'Верно' : 'Неверно'
  }

  return (
    <section className={css.stack}>
      <div className={css.toolbar}>
        <span className={ui.muted}>
          {index + 1} / {session.items.length}
        </span>
        <button className={ui.ghost} onClick={onFinish} disabled={busy}>
          Завершить
        </button>
      </div>
      <div className={`${ui.card} ${css.question}`}>
        <span className={css.prompt} lang={promptLang}>
          {item.prompt}
        </span>
        <SpeakButton text={item.prompt} lang={promptLang === 'en' ? 'en-US' : 'ru-RU'} />
      </div>
      {session.mode === 'choice' && (
        <div className={css.options} role="group" aria-label="Варианты ответа">
          {item.options.map((option, i) => {
            let state = ''
            if (
              result &&
              result.outcome !== 'skipped' &&
              'correct_option' in result &&
              i === result.correct_option
            )
              state = css.right
            else if (
              result?.outcome === 'answered' &&
              'chosen_option' in result &&
              i === result.chosen_option
            )
              state = css.wrong
            return (
              <button
                key={i}
                className={`${ui.button} ${css.option} ${state}`}
                onClick={() => perform({ kind: 'choice', option: i })}
                disabled={disabled}
                lang={answerLang}
              >
                <span className={css.optionKey}>{i + 1}</span>
                {option}
              </button>
            )
          })}
        </div>
      )}
      {session.mode === 'input' && (
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
              disabled={disabled}
              autoComplete="off"
              autoFocus
            />
          </label>
          <div>
            <button
              className={ui.primary}
              type="submit"
              disabled={disabled || /^\s*\.?\s*$/u.test(text)}
            >
              Проверить
            </button>
          </div>
        </form>
      )}
      {session.mode === 'cards' && cardAnswer && (
        <div className={css.stack}>
          <p className={ui.muted} lang={answerLang}>
            Ответ: {cardAnswer.join(', ')}
          </p>
          <fieldset className={css.choices}>
            <legend className={ui.label}>Как вы запомнили?</legend>
            <div className={css.actions}>
              {CARD_GRADES.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={ui.button}
                  onClick={() => perform({ kind: 'grade', grade: option.value })}
                  disabled={disabled}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </fieldset>
        </div>
      )}
      <div className={css.actions}>
        {(session.mode !== 'cards' || !cardAnswer) && (
          <button
            type="button"
            className={ui.button}
            onClick={() => perform({ kind: 'reveal' })}
            disabled={disabled}
          >
            Показать ответ
          </button>
        )}
        <button
          type="button"
          className={ui.button}
          onClick={() => perform({ kind: 'skip' })}
          disabled={disabled}
        >
          Пропустить
        </button>
      </div>
      {action.isError && (
        <p className={ui.error} role="alert">
          {errorMessage(action.error)} Попробуйте ещё раз.
        </p>
      )}
      {result && (
        <div className={css.stack} role="status">
          <div className={css.feedback}>
            <span
              className={
                result.outcome === 'answered' && 'correct' in result
                  ? result.correct
                    ? css.good
                    : css.bad
                  : undefined
              }
            >
              {label} ({result.delta > 0 ? '+' : ''}
              {result.delta}) · прогресс {result.progress}%
            </span>
            <button className={ui.primary} onClick={next} autoFocus>
              Далее
            </button>
          </div>
          {revealedAnswers && (
            <p className={ui.muted} lang={answerLang}>
              Ответ: {revealedAnswers.join(', ')}
            </p>
          )}
        </div>
      )}
    </section>
  )
}
