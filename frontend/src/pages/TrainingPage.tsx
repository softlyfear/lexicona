import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  ApiError,
  api,
  errorMessage,
  type CardGrade,
  type Direction,
  type TerminalResult,
  type NewTrainingMode,
  type ResumedItem,
  type TrainingPurpose,
  type TrainingSession,
  type TrainingSize,
} from '../api'
import { SpeakButton } from '../components/ui'
import ui from '../components/ui.module.css'
import { cancelSpeech, speak, speechEnabled, speechGeneration, useSpeech } from '../speech'
import { MatchingRun } from './MatchingRun'
import { resumedResult } from './resume'
import css from './pages.module.css'

const MODES: { mode: NewTrainingMode; direction: Direction; label: string }[] = [
  { mode: 'choice', direction: 'en_ru', label: 'Поиск перевода: EN → RU' },
  { mode: 'choice', direction: 'ru_en', label: 'Поиск слова: RU → EN' },
  { mode: 'matching', direction: 'en_ru', label: 'Сопоставление пар: EN → RU' },
  { mode: 'input', direction: 'en_ru', label: 'Написание перевода: EN → RU' },
  { mode: 'input', direction: 'ru_en', label: 'Написание слова: RU → EN' },
]
const SIZES = [5, 10, 20, 30, 50, 75, 100, 125, 150]
const CARD_GRADES: { value: CardGrade; label: string }[] = [
  { value: 'again', label: 'Повторить' },
  { value: 'hard', label: 'Трудно' },
  { value: 'good', label: 'Хорошо' },
  { value: 'easy', label: 'Легко' },
]

export function TrainingPage() {
  const { preferences } = useSpeech()
  const queryClient = useQueryClient()
  const latest = useQuery({
    queryKey: ['training', 'latest'],
    queryFn: api.latestTraining,
    retry: false,
    gcTime: 0,
    staleTime: 0,
  })
  const [setup, setSetup] = useState(false)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      cancelSpeech()
    }
  }, [])
  const [started, setStarted] = useState<{
    session: TrainingSession
    requestedSize: TrainingSize
  } | null>(null)
  const finish = useMutation({
    mutationFn: (id: string) => api.finishTraining(id),
    onSuccess: () => {
      setStarted(null)
      setSetup(true)
      queryClient.setQueryData(['training', 'latest'], null)
      void queryClient.invalidateQueries({ queryKey: ['words'] })
      void queryClient.invalidateQueries({ queryKey: ['statistics'] })
    },
  })
  if (started) {
    const props = {
      session: started.session,
      requestedSize: started.requestedSize,
      onFinish: () => finish.mutate(started.session.id),
      finishing: finish.isPending,
    }
    return (
      <>
        {finish.isError && (
          <p role="alert" className={ui.error}>
            Не удалось завершить занятие. {errorMessage(finish.error)} Попробуйте ещё раз.
          </p>
        )}
        {finish.isPending && <p role="status">Завершаем занятие…</p>}
        <div inert={finish.isPending}>
          {started.session.mode === 'matching' ? <MatchingRun {...props} /> : <Run {...props} />}
        </div>
      </>
    )
  }
  if (!setup && latest.isPending) return <p role="status">Загружаем последнее занятие…</p>
  if (!setup && latest.isError)
    return (
      <section className={css.stack}>
        <p role="alert">Не удалось загрузить последнее занятие. {errorMessage(latest.error)}</p>
        <button className={ui.button} onClick={() => void latest.refetch()}>
          Повторить
        </button>
      </section>
    )
  if (!setup && latest.data?.status === 'active')
    return (
      <section className={`${ui.card} ${css.stack}`}>
        <h1>Последнее занятие</h1>
        <p>
          {latest.data.resume_error
            ? 'Занятие нельзя продолжить из-за повреждённых данных.'
            : latest.data.mode === 'cards' || latest.data.mode === 'cloze'
              ? 'Этот режим больше недоступен для продолжения.'
              : 'Продолжите занятие или завершите его, чтобы начать новое.'}{' '}
          Завершение сохранит начисленный прогресс.
        </p>
        {finish.isError && (
          <p role="alert">Не удалось завершить занятие. {errorMessage(finish.error)}</p>
        )}
        <div className={css.actions}>
          {!latest.data.resume_error &&
            latest.data.mode !== 'cards' &&
            latest.data.mode !== 'cloze' && (
              <button
                className={ui.primary}
                disabled={finish.isPending}
                onClick={() =>
                  setStarted({
                    session: latest.data!,
                    requestedSize: latest.data!.requested_size ?? latest.data!.items.length,
                  })
                }
              >
                Продолжить
              </button>
            )}
          <button
            className={ui.button}
            disabled={finish.isPending}
            onClick={() => finish.mutate(latest.data!.id)}
          >
            Завершить и начать новое
          </button>
        </div>
        {finish.isPending && <p role="status">Завершаем занятие…</p>}
      </section>
    )
  return (
    <Setup
      onStart={(session, requestedSize) => {
        if (!active.current) return
        setStarted({ session, requestedSize })
        const promptLanguage = session.direction === 'ru_en' ? 'ru' : 'en'
        if (
          preferences.autoPrompt &&
          speechEnabled(promptLanguage, preferences) &&
          session.mode !== 'matching' &&
          session.items[0]
        )
          speak(session.items[0].prompt, promptLanguage)
      }}
    />
  )
}

function Setup({
  onStart,
}: {
  onStart: (session: TrainingSession, requestedSize: TrainingSize) => void
}) {
  const [direction, setDirection] = useState<Direction>('en_ru')
  const [mode, setMode] = useState<NewTrainingMode>('choice')
  const [purpose, setPurpose] = useState<TrainingPurpose>('free')
  const [includeNew, setIncludeNew] = useState(true)
  const [sizeText, setSizeText] = useState('10')
  const [sizeMode, setSizeMode] = useState<'number' | 'all'>('number')
  const [tagIds, setTagIds] = useState<string[]>([])
  const [minimum, setMinimum] = useState('')
  const [maximum, setMaximum] = useState('')
  const tags = useQuery({ queryKey: ['tags'], queryFn: api.listTags })
  const parseBound = (value: string) =>
    value === ''
      ? null
      : /^\d+$/u.test(value) && Number.isSafeInteger(Number(value))
        ? Number(value)
        : undefined
  const min = parseBound(minimum)
  const max = parseBound(maximum)
  const validBounds =
    min !== undefined && max !== undefined && (min === null || max === null || min <= max)
  const size = Number(sizeText)
  const validSize = /^\d+$/u.test(sizeText) && Number.isSafeInteger(size) && size >= 1
  const starting = useRef(false)
  const startScope = useRef(0)
  const start = useMutation({
    mutationFn: (requestedSize: TrainingSize) => {
      const filters =
        tagIds.length || min !== null || max !== null
          ? { tag_ids: tagIds, progress_min: min, progress_max: max }
          : undefined
      return api.startTraining(direction, requestedSize, mode, filters, purpose, includeNew)
    },
    onSuccess: (session, size) => {
      if (startScope.current === speechGeneration()) onStart(session, size)
    },
    onSettled: () => {
      starting.current = false
    },
  })

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if ((sizeMode === 'number' && !validSize) || !validBounds || starting.current) return
    cancelSpeech()
    startScope.current = speechGeneration()
    starting.current = true
    start.mutate(sizeMode === 'all' ? 'all' : size)
  }

  return (
    <section className={css.stack}>
      <h1 className={css.title}>Тренировка</h1>
      <form className={`${ui.card} ${css.form}`} onSubmit={submit} noValidate>
        <div className={css.group}>
          <h2 className={css.sectionTitle} id="training-purpose-title">
            Тип занятия
          </h2>
          <fieldset
            className={css.choices}
            disabled={start.isPending}
            aria-labelledby="training-purpose-title"
            aria-describedby="training-purpose-hint"
          >
            <label className={css.choice}>
              <input
                type="radio"
                name="purpose"
                checked={purpose === 'free'}
                onChange={() => {
                  start.reset()
                  setPurpose('free')
                }}
              />
              Свободная практика
            </label>
            <label className={css.choice}>
              <input
                type="radio"
                name="purpose"
                checked={purpose === 'scheduled'}
                onChange={() => {
                  start.reset()
                  setPurpose('scheduled')
                }}
              />
              По расписанию
            </label>
            {purpose === 'scheduled' && (
              <label className={css.choice}>
                <input
                  type="checkbox"
                  checked={includeNew}
                  onChange={(event) => {
                    start.reset()
                    setIncludeNew(event.target.checked)
                  }}
                />
                Включать новые слова
              </label>
            )}
            <p id="training-purpose-hint" className={ui.muted}>
              {purpose === 'scheduled'
                ? 'Сначала — слова с наступившим сроком повторения, затем — до 10 новых слов.'
                : 'Свободная практика не меняет расписание повторений.'}
            </p>
          </fieldset>
        </div>
        <div className={css.group}>
          <h2 className={css.sectionTitle} id="training-mode-title">
            Режим
          </h2>
          <fieldset
            className={css.choices}
            disabled={start.isPending}
            aria-labelledby="training-mode-title"
          >
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
        </div>
        <div className={css.group}>
          <h2 className={css.sectionTitle} id="training-size-title">
            Слов в занятии
          </h2>
          <fieldset
            className={css.choices}
            disabled={start.isPending}
            aria-labelledby="training-size-title"
          >
            <label className={css.choice}>
              <input
                type="radio"
                name="size-mode"
                checked={sizeMode === 'all'}
                onChange={() => setSizeMode('all')}
              />
              Все подходящие слова
            </label>
            <label className={css.choice}>
              <input
                type="radio"
                name="size-mode"
                checked={sizeMode === 'number'}
                onChange={() => setSizeMode('number')}
              />
              Заданное число слов
            </label>
            <div className={css.actions}>
              {SIZES.map((n) => (
                <button
                  key={n}
                  type="button"
                  disabled={sizeMode === 'all'}
                  className={
                    sizeMode === 'number' && validSize && n === size ? ui.primary : ui.button
                  }
                  aria-pressed={sizeMode === 'number' && validSize && n === size}
                  onClick={() => setSizeText(String(n))}
                >
                  {n}
                </button>
              ))}
            </div>
            <label className={`${ui.field} ${css.trainingSize}`}>
              <span className={ui.label}>Своё число слов</span>
              <input
                className={ui.input}
                type="text"
                inputMode="numeric"
                value={sizeText}
                disabled={sizeMode === 'all'}
                onChange={(event) => setSizeText(event.target.value)}
                aria-invalid={sizeMode === 'number' && !validSize}
                aria-describedby="training-size-hint"
              />
            </label>
            <p
              id="training-size-hint"
              className={sizeMode === 'all' || validSize ? ui.muted : ui.error}
            >
              Введите положительное целое число.
            </p>
          </fieldset>
        </div>
        <div className={css.group}>
          <h2 className={css.sectionTitle} id="training-filters-title">
            Фильтры слов
          </h2>
          <fieldset
            className={css.choices}
            disabled={start.isPending}
            aria-labelledby="training-filters-title"
          >
            <p className={ui.muted}>Теги: любой выбранный</p>
            {tags.isLoading && (
              <p role="status" className={ui.muted}>
                Загружаем теги…
              </p>
            )}
            {tags.isError && (
              <p role="alert" className={ui.error}>
                {errorMessage(tags.error)} Не удалось загрузить теги; можно начать без них.
              </p>
            )}
            <div className={css.tagList}>
              {tags.data?.map((tag) => (
                <label className={css.tag} key={tag.id}>
                  <input
                    type="checkbox"
                    checked={tagIds.includes(tag.id)}
                    disabled={!tagIds.includes(tag.id) && tagIds.length >= 20}
                    onChange={(event) =>
                      setTagIds((ids) =>
                        event.target.checked ? [...ids, tag.id] : ids.filter((id) => id !== tag.id),
                      )
                    }
                  />
                  {tag.name}
                </label>
              ))}
            </div>
            <p className={ui.muted}>Можно указать диапазон выученности</p>
            <div className={css.trainingBounds}>
              <label className={ui.field}>
                <span className={ui.label}>Прогресс от, %</span>
                <input
                  className={ui.input}
                  type="text"
                  inputMode="numeric"
                  value={minimum}
                  onChange={(event) => setMinimum(event.target.value)}
                  aria-invalid={!validBounds}
                  aria-describedby="training-progress-hint"
                />
              </label>
              <label className={ui.field}>
                <span className={ui.label}>Прогресс до, %</span>
                <input
                  className={ui.input}
                  type="text"
                  inputMode="numeric"
                  value={maximum}
                  onChange={(event) => setMaximum(event.target.value)}
                  aria-invalid={!validBounds}
                  aria-describedby="training-progress-hint"
                />
              </label>
            </div>
            <p id="training-progress-hint" className={validBounds ? ui.muted : ui.error}>
              {validBounds ? '' : 'Введите неотрицательные целые числа: от меньшего к большему.'}
            </p>
            <div>
              <button
                type="button"
                className={ui.button}
                onClick={() => {
                  setTagIds([])
                  setMinimum('')
                  setMaximum('')
                }}
              >
                Очистить фильтры
              </button>
            </div>
          </fieldset>
        </div>
        {purpose === 'free' && (
          <p className={ui.muted}>Подходящие слова выбираются и идут в случайном порядке.</p>
        )}
        {start.isError && (
          <p className={ui.error} role="alert">
            {mode !== 'choice' &&
            start.error instanceof ApiError &&
            start.error.message === 'not_enough_words'
              ? 'Добавьте хотя бы одно слово в словарь.'
              : errorMessage(start.error)}{' '}
            <a href="/">Перейти в словарь</a>
          </p>
        )}
        <div>
          <button
            className={ui.primary}
            type="submit"
            disabled={start.isPending || (sizeMode === 'number' && !validSize) || !validBounds}
          >
            Начать
          </button>
        </div>
      </form>
    </section>
  )
}

type Action =
  | { kind: 'choice'; option: number }
  | { kind: 'text'; text: string }
  | { kind: 'grade'; grade: CardGrade }
  | { kind: 'reveal' }
  | { kind: 'skip' }

export function Run({
  session,
  requestedSize,
  onFinish,
  finishing = false,
}: {
  session: TrainingSession
  requestedSize: TrainingSize
  onFinish: () => void
  finishing?: boolean
}) {
  const queryClient = useQueryClient()
  const { preferences } = useSpeech()
  const snapshots = session.items as (ResumedItem | undefined)[]
  const first = snapshots.findIndex((item) => item?.state !== 'done')
  const initialIndex = first < 0 ? session.items.length : first
  const initial = snapshots[initialIndex]
  const initialResult = initial && resumedResult(initial)
  const [index, setIndex] = useState(initialIndex)
  const [text, setText] = useState(
    initialResult && 'submitted_text' in initialResult ? initialResult.submitted_text : '',
  )
  const [revealed, setRevealed] = useState<string[] | null>(
    initial?.result?.outcome === 'revealed' ? initial.result.expected_answers : null,
  )
  const [results, setResults] = useState<TerminalResult[]>(() =>
    snapshots.flatMap((item) =>
      item?.state === 'done' && resumedResult(item) ? [resumedResult(item)!] : [],
    ),
  )
  const [attempt, setAttempt] = useState<TerminalResult | null>(initialResult ?? null)
  const locked = useRef(false)
  const item = session.items[index]
  const result = attempt ?? undefined
  const done = index >= session.items.length
  const canRetry = result?.outcome === 'answered' && 'correct' in result && !result.correct
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
        return
      }
      if (data.outcome === 'answered' && 'submitted_text' in data) setText(data.submitted_text)
      setAttempt(data)
      if (data.outcome === 'answered' && 'correct' in data && !data.correct) {
        locked.current = false
      } else {
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
    if (finishing || locked.current || (result && !canRetry)) return
    cancelSpeech()
    if (value.kind === 'choice' && session.mode === 'choice') {
      const spoken = item.options[value.option]
      const answerLanguage = session.direction === 'en_ru' ? 'ru' : 'en'
      if (spoken && speechEnabled(answerLanguage)) speak(spoken, answerLanguage)
    }
    locked.current = true
    action.mutate(value)
  }

  function next() {
    cancelSpeech()
    const following = snapshots.findIndex(
      (candidate, position) => position > index && candidate?.state !== 'done',
    )
    const nextIndex = following < 0 ? session.items.length : following
    const nextItem = session.items[nextIndex]
    const promptLanguage = session.direction === 'ru_en' ? 'ru' : 'en'
    if (preferences.autoPrompt && speechEnabled(promptLanguage, preferences) && nextItem)
      speak(nextItem.prompt, promptLanguage)
    locked.current = false
    action.reset()
    const snapshot = snapshots[nextIndex]
    const nextResult = snapshot && resumedResult(snapshot)
    setText(nextResult && 'submitted_text' in nextResult ? nextResult.submitted_text : '')
    setRevealed(snapshot?.result?.outcome === 'revealed' ? snapshot.result.expected_answers : null)
    setAttempt(nextResult ?? null)
    setIndex(nextIndex)
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!/^\s*\.?\s*$/u.test(text)) perform({ kind: 'text', text })
  }

  useEffect(() => {
    if (done || session.mode !== 'choice') return
    function onKey(event: KeyboardEvent) {
      if (finishing) return
      if (
        event.target instanceof HTMLElement &&
        event.target.closest('button') &&
        event.key === 'Enter'
      )
        return
      const n = Number(event.key)
      if ((!result || canRetry) && /^[1-6]$/.test(event.key) && n <= item.options.length)
        perform({ kind: 'choice', option: n - 1 })
      else if (result && !canRetry && (event.key === 'Enter' || event.key === ' ')) {
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
    const unavailable = results.filter((r) => r.outcome === 'unavailable').length
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
        <p>Недоступно: {unavailable}</p>
        <div className={css.actions}>
          <button className={ui.primary} onClick={onFinish} autoFocus>
            Завершить
          </button>
        </div>
      </section>
    )
  }

  const promptLang = session.direction === 'ru_en' ? 'ru' : 'en'
  const answerLang = session.direction === 'en_ru' ? 'ru' : 'en'
  const busy = action.isPending
  const disabled = busy || (!!result && !canRetry)
  const cardAnswer =
    result?.outcome === 'unavailable'
      ? null
      : (revealed ??
        (result?.outcome === 'answered' && 'grade' in result ? result.expected_answers : null))
  const revealedAnswers =
    result?.outcome === 'assisted' ||
    (result?.outcome === 'answered' &&
      'submitted_text' in result &&
      (!('correct' in result) || result.correct))
      ? result.expected_answers
      : null
  let label = ''
  if (result) {
    if (result.outcome === 'unavailable')
      label =
        result.reason === 'word_deleted'
          ? 'Задание недоступно: слово удалено'
          : 'Задание недоступно: слово исключалось из обучения'
    else if (result.outcome === 'skipped') label = 'Пропущено'
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
        <button
          className={ui.ghost}
          onClick={() => {
            cancelSpeech()
            onFinish()
          }}
          disabled={busy}
        >
          Завершить
        </button>
      </div>
      {requestedSize === 'all' && (
        <p className={ui.muted}>Все подходящие слова: {session.items.length}</p>
      )}
      {typeof requestedSize === 'number' && session.items.length < requestedSize && (
        <p className={ui.muted}>
          Доступно {session.items.length} из {requestedSize} запрошенных слов
        </p>
      )}
      <div
        className={`${ui.card} ${css.question} ${session.mode === 'cards' && cardAnswer ? css.cardRevealed : ''}`}
      >
        <span className={css.promptLine} lang={promptLang}>
          <span className={`${css.prompt} ${session.mode === 'cloze' ? css.examplePrompt : ''}`}>
            {item.prompt}
          </span>
          {item.transcription && <span className={css.transcription}>{item.transcription}</span>}
        </span>
        <SpeakButton text={item.prompt} lang={promptLang === 'en' ? 'en-US' : 'ru-RU'} />
        {session.mode === 'cards' && cardAnswer && (
          <div className={css.cardAnswer} role="group" aria-label="Ответ карточки">
            <span className={ui.label}>Ответ</span>
            <div className={css.cardAnswerValue}>
              <span className={css.prompt} lang={answerLang}>
                {cardAnswer.join(', ')}
              </span>
              <SpeakButton
                text={cardAnswer.join(', ')}
                lang={answerLang === 'en' ? 'en-US' : 'ru-RU'}
              />
            </div>
          </div>
        )}
      </div>
      {session.mode === 'choice' && (
        <div className={css.options} role="group" aria-label="Варианты ответа">
          {item.options.map((option, i) => {
            let state = ''
            if (
              result &&
              !canRetry &&
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
              <div key={i} className={css.optionRow}>
                <button
                  className={`${ui.button} ${css.option} ${state}`}
                  onClick={() => perform({ kind: 'choice', option: i })}
                  disabled={disabled}
                  lang={answerLang}
                >
                  <span className={css.optionKey}>{i + 1}</span>
                  <span className={css.optionText}>{option}</span>
                </button>
                <SpeakButton
                  className={css.optionSpeak}
                  text={option}
                  lang={answerLang === 'en' ? 'en-US' : 'ru-RU'}
                  aria-label={`Произнести вариант ${i + 1}`}
                />
              </div>
            )
          })}
        </div>
      )}
      {(session.mode === 'input' || session.mode === 'cloze') && (
        <form key={item.id} className={css.form} onSubmit={submit}>
          <label className={ui.field}>
            <span className={ui.label}>
              {session.mode === 'cloze'
                ? 'Введите пропущенное выражение'
                : session.direction === 'en_ru'
                  ? 'Введите перевод'
                  : 'Введите слово'}
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
          {errorMessage(action.error)}{' '}
          {!(action.error instanceof ApiError && action.error.message === 'PROGRESS_CHANGED') &&
            'Попробуйте ещё раз.'}
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
              {result.delta}){result.progress !== null && <> · прогресс {result.progress}%</>}
            </span>
            {!canRetry && (
              <button className={ui.primary} onClick={next} autoFocus>
                Далее
              </button>
            )}
          </div>
          {canRetry && <p>Попробуйте ещё раз. Повторного штрафа не будет.</p>}
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
