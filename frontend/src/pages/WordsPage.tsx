import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useDeferredValue, useState } from 'react'
import { useSearchParams } from 'react-router'
import {
  api,
  errorMessage,
  type Word,
  type WordInput,
  type WordSort,
  type WordTrainingFilter,
} from '../api'
import { WordForm } from '../components/WordForm'
import { ProgressBar, SpeakButton } from '../components/ui'
import ui from '../components/ui.module.css'
import css from './pages.module.css'

type Editing = { kind: 'new' } | { kind: 'edit'; word: Word } | null

const SORT_OPTIONS: { value: WordSort; label: string }[] = [
  { value: 'created_desc', label: 'Сначала новые' },
  { value: 'created_asc', label: 'Сначала старые' },
  { value: 'headword_asc', label: 'Слово: А–Я' },
  { value: 'headword_desc', label: 'Слово: Я–А' },
  { value: 'progress_asc', label: 'Прогресс: по возрастанию' },
  { value: 'progress_desc', label: 'Прогресс: по убыванию' },
]
const TRAINING_OPTIONS: { value: WordTrainingFilter; label: string }[] = [
  { value: 'active', label: 'В обучении' },
  { value: 'excluded', label: 'Исключённые' },
  { value: 'all', label: 'Все слова' },
]

export function WordsPage() {
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const search = searchParams.get('q') ?? ''
  const requestedSort = searchParams.get('sort')
  const sort =
    SORT_OPTIONS.find((option) => option.value === requestedSort)?.value ?? 'created_desc'
  const training =
    TRAINING_OPTIONS.find((option) => option.value === searchParams.get('training'))?.value ??
    'active'
  const query = useDeferredValue(search.trim())
  const [editing, setEditing] = useState<Editing>(null)

  const words = useQuery({
    queryKey: ['words', query, sort, training],
    queryFn: () => api.listWords(query, sort, training),
    placeholderData: keepPreviousData,
  })

  const save = useMutation({
    mutationFn: (input: WordInput) =>
      editing?.kind === 'edit' ? api.updateWord(editing.word.id, input) : api.createWord(input),
    onSuccess: () => {
      setEditing(null)
      return queryClient.invalidateQueries({ queryKey: ['words'] })
    },
  })

  const remove = useMutation({
    mutationFn: api.deleteWord,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['words'] }),
  })

  const trainingState = useMutation({
    mutationFn: ({ id, isExcluded }: { id: string; isExcluded: boolean }) =>
      api.setWordTraining(id, isExcluded),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['words'] }),
  })

  function startEditing(next: Editing) {
    save.reset()
    setEditing(next)
  }

  function updateParameter(key: 'q' | 'sort' | 'training', value: string) {
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      if (
        !value ||
        (key === 'sort' && value === 'created_desc') ||
        (key === 'training' && value === 'active')
      )
        next.delete(key)
      else next.set(key, value)
      return next
    })
  }

  function confirmDelete(word: Word) {
    if (window.confirm(`Удалить «${word.headword}»? Прогресс по слову тоже удалится.`))
      remove.mutate(word.id)
  }

  if (editing?.kind === 'new') {
    return (
      <section className={css.stack}>
        <h1 className={css.title}>Добавить слово</h1>
        <WordForm
          pending={save.isPending}
          error={save.isError ? errorMessage(save.error) : null}
          onSubmit={(input) => save.mutate(input)}
          onCancel={() => setEditing(null)}
        />
      </section>
    )
  }

  return (
    <section className={css.stack}>
      <div className={css.toolbar}>
        <h1 className={css.title}>Словарь</h1>
        <input
          className={`${ui.input} ${css.search}`}
          type="search"
          placeholder="Поиск по слову или переводу"
          aria-label="Поиск"
          value={search}
          onChange={(e) => updateParameter('q', e.target.value)}
        />
        {editing === null && (
          <button className={ui.primary} onClick={() => startEditing({ kind: 'new' })}>
            Добавить слово
          </button>
        )}
      </div>

      <div className={css.filters}>
        <label className={`${ui.field} ${css.sort}`}>
          <span className={ui.label}>Сортировка</span>
          <select
            className={ui.input}
            value={sort}
            onChange={(event) => updateParameter('sort', event.target.value)}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className={`${ui.field} ${css.sort}`}>
          <span className={ui.label}>Обучение</span>
          <select
            className={ui.input}
            value={training}
            onChange={(event) => updateParameter('training', event.target.value)}
          >
            {TRAINING_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {editing !== null && (
        <WordForm
          key={editing.word.id}
          word={editing.word}
          pending={save.isPending}
          error={save.isError ? errorMessage(save.error) : null}
          onSubmit={(input) => save.mutate(input)}
          onCancel={() => setEditing(null)}
        />
      )}

      {remove.isError && (
        <p className={ui.error} role="alert">
          {errorMessage(remove.error)}
        </p>
      )}
      {trainingState.isError && (
        <p className={ui.error} role="alert">
          {errorMessage(trainingState.error)} Повторите действие.
        </p>
      )}
      {words.isError && (
        <p className={ui.error} role="alert">
          {errorMessage(words.error)}
        </p>
      )}
      {(words.isFetching || query !== search.trim()) && (
        <p className={ui.muted} role="status">
          {words.data ? 'Обновляем список…' : 'Загружаем слова…'}
        </p>
      )}
      {words.data?.length === 0 && (
        <p className={ui.muted}>
          {query
            ? 'Ничего не найдено.'
            : training === 'excluded'
              ? 'Нет исключённых слов.'
              : training === 'active'
                ? 'Нет слов в обучении. Добавьте слово или верните исключённые.'
                : 'Словарь пуст. Добавьте первые слова.'}
        </p>
      )}

      <ul className={css.wordList}>
        {words.data?.map((word) => (
          <li key={word.id} className={css.wordRow}>
            <div className={css.wordMain}>
              <div className={css.wordHead}>
                <strong lang="en">{word.headword}</strong>
                {word.transcription && <span className={ui.muted}>{word.transcription}</span>}
                <SpeakButton text={word.headword} lang="en-US" />
              </div>
              <div lang="ru">{word.translations.join(', ')}</div>
              {word.example_en && (
                <div className={`${ui.muted} ${css.example}`} lang="en">
                  {word.example_en}
                </div>
              )}
              {word.is_excluded && <p className={ui.muted}>Исключено из обучения</p>}
            </div>
            <div className={css.wordSide}>
              <span className={css.percent}>{word.progress}%</span>
              <ProgressBar value={word.progress} />
              <div className={css.rowActions}>
                <button
                  type="button"
                  className={ui.ghost}
                  disabled={trainingState.isPending}
                  onClick={() =>
                    trainingState.mutate({ id: word.id, isExcluded: !word.is_excluded })
                  }
                  aria-label={`${word.is_excluded ? 'Вернуть в обучение' : 'Исключить из обучения'} «${word.headword}»`}
                  title={word.is_excluded ? 'Вернуть в обучение' : 'Исключить из обучения'}
                >
                  {trainingState.isPending && trainingState.variables?.id === word.id
                    ? '…'
                    : word.is_excluded
                      ? '↩'
                      : '⊘'}
                </button>
                <button
                  className={ui.ghost}
                  onClick={() => startEditing({ kind: 'edit', word })}
                  aria-label={`Изменить «${word.headword}»`}
                >
                  ✎
                </button>
                <button
                  className={ui.ghost}
                  onClick={() => confirmDelete(word)}
                  aria-label={`Удалить «${word.headword}»`}
                >
                  ✕
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
