import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useDeferredValue, useState } from 'react'
import { useSearchParams } from 'react-router'
import { api, errorMessage, type Word, type WordInput, type WordSort } from '../api'
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

export function WordsPage() {
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const search = searchParams.get('q') ?? ''
  const requestedSort = searchParams.get('sort')
  const sort =
    SORT_OPTIONS.find((option) => option.value === requestedSort)?.value ?? 'created_desc'
  const query = useDeferredValue(search.trim())
  const [editing, setEditing] = useState<Editing>(null)

  const words = useQuery({
    queryKey: ['words', query, sort],
    queryFn: () => api.listWords(query, sort),
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

  function startEditing(next: Editing) {
    save.reset()
    setEditing(next)
  }

  function updateParameter(key: 'q' | 'sort', value: string) {
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      if (!value || (key === 'sort' && value === 'created_desc')) next.delete(key)
      else next.set(key, value)
      return next
    })
  }

  function confirmDelete(word: Word) {
    if (window.confirm(`Удалить «${word.headword}»? Прогресс по слову тоже удалится.`))
      remove.mutate(word.id)
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

      {editing !== null && (
        <WordForm
          key={editing.kind === 'edit' ? editing.word.id : 'new'}
          word={editing.kind === 'edit' ? editing.word : undefined}
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
          {query ? 'Ничего не найдено.' : 'Словарь пуст. Добавьте первые слова.'}
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
            </div>
            <div className={css.wordSide}>
              <span className={css.percent}>{word.progress}%</span>
              <ProgressBar value={word.progress} />
              <div className={css.rowActions}>
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
