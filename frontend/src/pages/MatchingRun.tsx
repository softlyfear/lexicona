import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import {
  ApiError,
  api,
  errorMessage,
  type TerminalResult,
  type TrainingItem,
  type TrainingSession,
  type TrainingSize,
} from '../api'
import ui from '../components/ui.module.css'
import { cancelSpeech } from '../speech'
import css from './pages.module.css'

function isTerminal(result: TerminalResult | undefined): result is TerminalResult {
  return !!result && (result.outcome !== 'answered' || !('correct' in result) || result.correct)
}

type MatchingAction =
  | { kind: 'answer'; item: TrainingItem; option: number }
  | { kind: 'reveal' | 'skip'; item: TrainingItem }

export function MatchingRun({
  session,
  requestedSize,
  onFinish,
}: {
  session: TrainingSession
  requestedSize: TrainingSize
  onFinish: () => void
}) {
  const queryClient = useQueryClient()
  const [batchIndex, setBatchIndex] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [answers, setAnswers] = useState<Record<string, TerminalResult>>({})
  const [notice, setNotice] = useState('')
  const [done, setDone] = useState(false)
  const locked = useRef(false)
  const batchCount = Math.ceil(session.items.length / 4)
  const batch = session.items.slice(batchIndex * 4, batchIndex * 4 + 4)
  const selected = batch.find((item) => item.id === selectedId)
  const selectedResult = selected ? answers[selected.id] : undefined
  const batchDone = batch.every((item) => isTerminal(answers[item.id]))

  const action = useMutation({
    mutationFn: (value: MatchingAction) => {
      if (value.kind === 'answer') return api.answer(value.item.id, value.option)
      if (value.kind === 'reveal') return api.revealAnswer(value.item.id)
      return api.skipItem(value.item.id)
    },
    onSuccess: (data, value) => {
      setAnswers((previous) => ({ ...previous, [value.item.id]: data }))
      setNotice('')
      locked.current = false
    },
    onError: () => {
      locked.current = false
    },
  })

  useEffect(() => {
    return () => void queryClient.invalidateQueries({ queryKey: ['words'] })
  }, [queryClient])

  function perform(value: MatchingAction) {
    if (locked.current || isTerminal(answers[value.item.id])) return
    cancelSpeech()
    setNotice('')
    locked.current = true
    action.mutate(value)
  }

  function chooseTranslation(option: number) {
    if (!selected) {
      setNotice('Сначала выберите английское слово.')
      return
    }
    perform({ kind: 'answer', item: selected, option })
  }

  function next() {
    cancelSpeech()
    action.reset()
    setSelectedId(null)
    setNotice('')
    if (batchIndex + 1 === batchCount) setDone(true)
    else setBatchIndex((index) => index + 1)
  }

  if (done) {
    const terminal = Object.values(answers).filter(isTerminal)
    const answered = terminal.filter(
      (result) => result.outcome === 'answered' && 'correct' in result,
    )
    const correct = answered.filter((result) => 'correct' in result && result.correct).length
    const assisted = terminal.filter((result) => result.outcome === 'assisted').length
    const skipped = terminal.filter((result) => result.outcome === 'skipped').length
    const unavailable = terminal.filter((result) => result.outcome === 'unavailable').length
    return (
      <section className={`${ui.card} ${css.stack} ${css.summary}`}>
        <h1 className={css.title}>Готово</h1>
        {answered.length > 0 && (
          <p className={css.score}>
            {correct} из {answered.length}
          </p>
        )}
        <p>
          Верно: {correct} · Неверно: {answered.length - correct}
        </p>
        <p>С помощью: {assisted}</p>
        <p>Пропущено: {skipped}</p>
        <p>Недоступно: {unavailable}</p>
        <div className={css.actions}>
          <button className={ui.primary} onClick={onFinish} autoFocus>
            Ещё занятие
          </button>
        </div>
      </section>
    )
  }

  const usedOptions = new Set(
    batch
      .map((item) => answers[item.id])
      .filter(isTerminal)
      .map((result) => ('correct_option' in result ? result.correct_option : undefined))
      .filter((option) => option !== undefined),
  )
  const busy = action.isPending

  return (
    <section className={css.stack}>
      <div className={css.toolbar}>
        <span className={ui.muted}>
          Группа {batchIndex + 1} / {batchCount}
        </span>
        <button className={ui.ghost} onClick={onFinish} disabled={busy}>
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
      <p className={ui.muted}>Выберите английское слово, а затем его русский перевод.</p>
      {busy && <p role="status">Проверяем…</p>}
      <div className={`${ui.card} ${css.matchingGrid}`}>
        <div className={css.matchingColumn} role="group" aria-label="Английские слова">
          {batch.map((item) => {
            const result = answers[item.id]
            const state =
              selectedId === item.id
                ? css.selected
                : result?.outcome === 'answered' && 'correct' in result
                  ? result.correct
                    ? css.right
                    : css.wrong
                  : ''
            return (
              <button
                key={item.id}
                type="button"
                className={`${ui.button} ${css.matchingCell} ${state}`}
                aria-pressed={selectedId === item.id}
                disabled={busy || isTerminal(result)}
                onClick={() => {
                  cancelSpeech()
                  action.reset()
                  setSelectedId(item.id)
                  setNotice('')
                }}
                lang="en"
              >
                {item.prompt}
              </button>
            )
          })}
        </div>
        <div className={css.matchingColumn} role="group" aria-label="Русские переводы">
          {batch[0]?.options.map((option, index) => {
            const wrong =
              selectedResult?.outcome === 'answered' &&
              'chosen_option' in selectedResult &&
              !selectedResult.correct &&
              selectedResult.chosen_option === index
            return (
              <button
                key={index}
                type="button"
                className={`${ui.button} ${css.matchingCell} ${wrong ? css.wrong : usedOptions.has(index) ? css.right : ''}`}
                disabled={busy || usedOptions.has(index)}
                onClick={() => chooseTranslation(index)}
                lang="ru"
              >
                {option}
              </button>
            )
          })}
        </div>
      </div>
      <div className={css.actions}>
        <button
          type="button"
          className={ui.button}
          onClick={() => selected && perform({ kind: 'reveal', item: selected })}
          disabled={busy || !selected || isTerminal(selectedResult)}
        >
          Показать ответ
        </button>
        <button
          type="button"
          className={ui.button}
          onClick={() => selected && perform({ kind: 'skip', item: selected })}
          disabled={busy || !selected || isTerminal(selectedResult)}
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
      {(notice || selectedResult) && (
        <div className={css.stack} role="status">
          {notice && <p>{notice}</p>}
          {selectedResult && (
            <>
              <p
                className={
                  selectedResult.outcome === 'answered' && 'correct' in selectedResult
                    ? selectedResult.correct
                      ? css.good
                      : css.bad
                    : undefined
                }
              >
                {selectedResult.outcome === 'unavailable'
                  ? 'Задание недоступно: слово исключалось из обучения'
                  : selectedResult.outcome === 'skipped'
                    ? 'Пропущено'
                    : selectedResult.outcome === 'assisted'
                      ? 'С помощью'
                      : 'correct' in selectedResult && selectedResult.correct
                        ? 'Верно'
                        : 'Неверно'}{' '}
                ({selectedResult.delta > 0 ? '+' : ''}
                {selectedResult.delta}) · прогресс {selectedResult.progress}%
              </p>
              {selectedResult.outcome === 'answered' &&
                'correct' in selectedResult &&
                !selectedResult.correct && (
                  <p>Выберите другой перевод. Повторного штрафа не будет.</p>
                )}
              {selectedResult.outcome === 'assisted' && (
                <p className={ui.muted}>Ответ: {selectedResult.expected_answers.join(', ')}</p>
              )}
            </>
          )}
        </div>
      )}
      {batchDone && (
        <div>
          <button className={ui.primary} onClick={next} autoFocus>
            {batchIndex + 1 === batchCount ? 'Завершить занятие' : 'Следующая группа'}
          </button>
        </div>
      )}
    </section>
  )
}
