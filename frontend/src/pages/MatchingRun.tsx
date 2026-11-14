import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Fragment, useEffect, useRef, useState } from 'react'
import {
  ApiError,
  api,
  errorMessage,
  type TerminalResult,
  type ResumedItem,
  type TrainingItem,
  type TrainingSession,
  type TrainingSize,
} from '../api'
import { EditWordButton, TrainingWordEditor } from '../components/TrainingWordEdit'
import { SpeakButton } from '../components/ui'
import { wordEditOutcome } from '../wordEdit'
import ui from '../components/ui.module.css'
import { cancelSpeech } from '../speech'
import css from './pages.module.css'
import { resumedResult } from './resume'
import { TrainingSummary } from './TrainingSummary'
import { useAutoAdvance } from './useAutoAdvance'

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
  finishing = false,
  autoAdvance = false,
}: {
  session: TrainingSession
  requestedSize: TrainingSize
  onFinish: () => void
  finishing?: boolean
  autoAdvance?: boolean
}) {
  const queryClient = useQueryClient()
  const batches: TrainingItem[][] = []
  for (let offset = 0; offset < session.items.length;) {
    const size = Math.max(1, session.items[offset].options.length)
    batches.push(session.items.slice(offset, offset + size))
    offset += size
  }
  const firstBatch = batches.findIndex((batch) =>
    batch.some((item) => (item as ResumedItem).state !== 'done'),
  )
  const [batchIndex, setBatchIndex] = useState(
    firstBatch < 0 ? Math.max(0, batches.length - 1) : firstBatch,
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [answers, setAnswers] = useState<Record<string, TerminalResult>>(() =>
    Object.fromEntries(
      (session.items as ResumedItem[]).flatMap((item) => {
        const result = resumedResult(item)
        return result ? [[item.id, result]] : []
      }),
    ),
  )
  const [notice, setNotice] = useState('')
  const [done, setDone] = useState(firstBatch < 0)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editNote, setEditNote] = useState('')
  const locked = useRef(false)
  const [autoCandidate, setAutoCandidate] = useState<string | null>(null)
  const advancedBatch = useRef<string | null>(null)
  const batchCount = batches.length
  const batch = batches[batchIndex] ?? []
  const selected = batch.find((item) => item.id === selectedId)
  const selectedResult = selected ? answers[selected.id] : undefined
  const answerText =
    selectedResult?.outcome === 'assisted'
      ? selectedResult.expected_answers.join(', ')
      : selectedResult?.outcome === 'answered' &&
          'correct' in selectedResult &&
          selectedResult.correct &&
          'correct_option' in selectedResult
        ? selected?.options[selectedResult.correct_option]
        : undefined
  const batchDone = batch.every((item) => isTerminal(answers[item.id]))
  const batchKey = `${session.id}:${batchIndex}`
  const batchCorrect =
    batch.length > 0 &&
    batch.every((item) => {
      const result = answers[item.id]
      return result?.outcome === 'answered' && 'correct' in result && result.correct
    })
  const cancelAuto = useAutoAdvance(
    !done && batchCorrect && autoCandidate === batchKey ? batchKey : null,
    autoAdvance,
    finishing || editingId !== null,
    next,
  )

  const action = useMutation({
    mutationFn: (value: MatchingAction) => {
      if (value.kind === 'answer') return api.answer(value.item.id, value.option)
      if (value.kind === 'reveal') return api.revealAnswer(value.item.id)
      return api.skipItem(value.item.id)
    },
    onSuccess: (data, value) => {
      setAnswers((previous) => ({ ...previous, [value.item.id]: data }))
      setAutoCandidate(
        autoAdvance && data.outcome === 'answered' && 'correct' in data && data.correct
          ? batchKey
          : null,
      )
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
    if (finishing || locked.current || isTerminal(answers[value.item.id])) return
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
    if (!batchDone || advancedBatch.current === batchKey || finishing || editingId) return
    advancedBatch.current = batchKey
    cancelAuto()
    setAutoCandidate(null)
    cancelSpeech()
    action.reset()
    setSelectedId(null)
    setNotice('')
    const following = batches.findIndex(
      (group, index) => index > batchIndex && group.some((item) => !isTerminal(answers[item.id])),
    )
    setEditNote('')
    if (following < 0) setDone(true)
    else setBatchIndex(following)
  }

  if (done) {
    return <TrainingSummary sessionId={session.id} onFinish={onFinish} finishing={finishing} />
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
      <div className={css.sessionBar}>
        <span className={ui.muted}>
          Группа {batchIndex + 1} / {batchCount}
        </span>
        <button
          className={ui.button}
          onClick={() => {
            cancelAuto()
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
      {editingId ? (
        <TrainingWordEditor
          wordId={editingId}
          onClose={() => setEditingId(null)}
          onSaved={(before, saved) => {
            setEditNote(wordEditOutcome(session, before, saved).note)
            setEditingId(null)
          }}
        />
      ) : (
        <>
          <p className={ui.muted}>Выберите английское слово, а затем его русский перевод.</p>
          {busy && <p role="status">Проверяем…</p>}
          <div
            className={`${ui.card} ${css.matchingGrid}`}
            style={{
              gridTemplateRows: `repeat(${Math.max(batch.length, batch[0]?.options.length ?? 0, 1)}, auto)`,
            }}
          >
            <div className={css.matchingColumn} role="group" aria-label="Английские слова">
              {batch.map((item) => {
                const result = answers[item.id]
                const answered =
                  result?.outcome === 'answered' && 'correct' in result ? result : undefined
                const state = answered
                  ? answered.correct
                    ? css.right
                    : css.wrong
                  : selectedId === item.id
                    ? css.selected
                    : ''
                const wordButton = (
                  <button
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
                if (!item.word_id) return <Fragment key={item.id}>{wordButton}</Fragment>
                return (
                  <div key={item.id} className={css.matchingWord}>
                    {wordButton}
                    <EditWordButton
                      name={item.prompt}
                      disabled={busy}
                      onEdit={() => {
                        cancelAuto()
                        cancelSpeech()
                        setEditingId(item.word_id ?? null)
                      }}
                    />
                  </div>
                )
              })}
            </div>
            <div className={css.matchingColumn} role="group" aria-label="Русские переводы">
              {batch[0]?.options.map((option, index) => {
                const matched = usedOptions.has(index)
                const wrong =
                  !matched &&
                  selectedResult?.outcome === 'answered' &&
                  'chosen_option' in selectedResult &&
                  !selectedResult.correct &&
                  selectedResult.chosen_option === index
                return (
                  <button
                    key={index}
                    type="button"
                    className={`${ui.button} ${css.matchingCell} ${wrong ? css.wrong : matched ? css.right : ''}`}
                    disabled={busy || matched}
                    onClick={() => chooseTranslation(index)}
                    lang="ru"
                  >
                    {option}
                  </button>
                )
              })}
            </div>
          </div>
          <div className={css.trainingActions}>
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
                      ? selectedResult.reason === 'word_deleted'
                        ? 'Задание недоступно: слово удалено'
                        : 'Задание недоступно: слово больше не в обучении'
                      : selectedResult.outcome === 'skipped'
                        ? 'Пропущено'
                        : selectedResult.outcome === 'assisted'
                          ? 'С помощью'
                          : 'correct' in selectedResult && selectedResult.correct
                            ? 'Верно'
                            : 'Неверно'}{' '}
                    ({selectedResult.delta > 0 ? '+' : ''}
                    {selectedResult.delta})
                    {selectedResult.progress !== null && (
                      <> · прогресс {selectedResult.progress}%</>
                    )}
                  </p>
                  {selectedResult.outcome === 'answered' &&
                    'correct' in selectedResult &&
                    !selectedResult.correct && (
                      <p>Выберите другой перевод. Повторного штрафа не будет.</p>
                    )}
                  {answerText && (
                    <div className={css.revealedAnswer} role="group" aria-label="Ответ">
                      <p className={css.answerText} lang="ru">
                        <span className={css.answerLabel}>Ответ: </span>
                        {answerText}
                      </p>
                      <SpeakButton className={css.answerSpeak} text={answerText} lang="ru-RU" />
                    </div>
                  )}
                </>
              )}
            </div>
          )}
          {batchDone && (
            <div className={css.trainingActions}>
              <button className={ui.primary} onClick={next} autoFocus>
                {batchIndex + 1 === batchCount ? 'Завершить занятие' : 'Следующая группа'}
              </button>
            </div>
          )}
          {editNote && <p className={ui.muted}>{editNote}</p>}
        </>
      )}
    </section>
  )
}
