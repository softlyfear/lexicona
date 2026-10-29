import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useDeferredValue, useState } from 'react'
import { api, errorMessage, type Word, type WordInput } from '../api'
import { WordForm } from '../components/WordForm'
import { ProgressBar, SpeakButton } from '../components/ui'
import ui from '../components/ui.module.css'
import css from './pages.module.css'

type Editing = { kind: 'new' } | { kind: 'edit'; word: Word } | null

export function WordsPage() {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const query = useDeferredValue(search.trim())
  const [editing, setEditing] = useState<Editing>(null)

  const words = useQuery({
    queryKey: ['words', query],
    queryFn: () => api.listWords(query),
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
          onChange={(e) => setSearch(e.target.value)}
        />
        {editing === null && (
          <button className={ui.primary} onClick={() => startEditing({ kind: 'new' })}>
            Добавить слово
          </button>
        )}
      </div>

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
