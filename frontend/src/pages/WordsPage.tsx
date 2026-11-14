import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router'
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
import { cancelSpeech } from '../speech'
import { readWordFilters, writeWordFilters } from '../wordFilters'
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
const SORT_SUMMARY: Record<WordSort, string> = {
  created_desc: 'Новые',
  created_asc: 'Старые',
  headword_asc: 'Слово А–Я',
  headword_desc: 'Слово Я–А',
  progress_asc: 'Прогресс ↑',
  progress_desc: 'Прогресс ↓',
}
const TRAINING_OPTIONS: { value: WordTrainingFilter; label: string }[] = [
  { value: 'active', label: 'В обучении' },
  { value: 'excluded', label: 'Исключённые' },
  { value: 'learned', label: 'Выученные' },
  { value: 'all', label: 'Все слова' },
]

export function WordsPage({ userId }: { userId: string }) {
  const queryClient = useQueryClient()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const [stored, setStored] = useState(() => readWordFilters(userId))
  const [settled, setSettled] = useState(false)
  const [storedUserId, setStoredUserId] = useState(userId)
  if (storedUserId !== userId) {
    setStoredUserId(userId)
    setStored(readWordFilters(userId))
    setSettled(false)
  }
  const search = searchParams.get('q') ?? ''
  const specifiesSort = searchParams.has('sort')
  const specifiesTraining = searchParams.has('training')
  const specifiesTags = searchParams.has('tag_id')
  const urlSort = SORT_OPTIONS.find((option) => option.value === searchParams.get('sort'))?.value
  const sort =
    urlSort ?? (specifiesSort || settled ? 'created_desc' : (stored?.sort ?? 'created_desc'))
  const urlTraining = TRAINING_OPTIONS.find(
    (option) => option.value === searchParams.get('training'),
  )?.value
  const training =
    urlTraining ?? (specifiesTraining || settled ? 'active' : (stored?.training ?? 'active'))
  const query = useDeferredValue(search.trim())
  const urlTagKey = [...new Set(searchParams.getAll('tag_id'))].sort().join('\0')
  const tagIds = useMemo(() => {
    if (specifiesTags || settled) return urlTagKey ? urlTagKey.split('\0') : []
    return stored?.tagIds ?? []
  }, [settled, specifiesTags, stored, urlTagKey])
  const [editing, setEditing] = useState<Editing>(null)
  const [editingLocationKey, setEditingLocationKey] = useState(location.key)
  // A link can navigate to the same URL. Drafts belong to the previous visit,
  // not to the dictionary location reached by that navigation.
  if (editingLocationKey !== location.key) {
    setEditingLocationKey(location.key)
    setEditing(null)
  }
  const pageRef = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const main = pageRef.current?.closest('main')
    if (main) main.scrollTop = 0
  }, [editing])
  const urlReflectsFilters =
    (specifiesSort || sort === 'created_desc') &&
    (specifiesTraining || training === 'active') &&
    (specifiesTags || tagIds.length === 0)
  if (!settled && urlReflectsFilters) setSettled(true)

  useEffect(() => {
    writeWordFilters(userId, { sort, training, tagIds })
    if (settled || urlReflectsFilters) return
    setSearchParams(
      (current) => {
        const result = new URLSearchParams(current)
        if (!current.has('sort') && sort !== 'created_desc') result.set('sort', sort)
        if (!current.has('training') && training !== 'active') result.set('training', training)
        if (!current.has('tag_id')) for (const id of tagIds) result.append('tag_id', id)
        return result
      },
      { replace: true },
    )
  }, [setSearchParams, settled, sort, tagIds, training, urlReflectsFilters, userId])

  const tags = useQuery({ queryKey: ['tags'], queryFn: api.listTags })
  const words = useQuery({
    queryKey: ['words', query, sort, training, tagIds],
    queryFn: () => api.listWords(query, sort, training, tagIds),
    placeholderData: keepPreviousData,
  })
  const countReady =
    words.isSuccess &&
    words.fetchStatus === 'idle' &&
    !words.isPlaceholderData &&
    query === search.trim()

  const save = useMutation({
    mutationFn: (input: WordInput) =>
      editing?.kind === 'edit' ? api.updateWord(editing.word.id, input) : api.createWord(input),
    onSuccess: () => {
      setEditing(null)
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: ['words'] }),
        queryClient.invalidateQueries({ queryKey: ['tags'] }),
      ])
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

  const learnedState = useMutation({
    mutationFn: ({ id, isLearned }: { id: string; isLearned: boolean }) =>
      api.setWordLearned(id, isLearned),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['words'] }),
  })

  function startEditing(next: Editing) {
    cancelSpeech()
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

  function updateTags(ids: string[]) {
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      next.delete('tag_id')
      for (const id of [...new Set(ids)].sort()) next.append('tag_id', id)
      return next
    })
  }

  const tagFormProps = {
    availableTags: tags.data ?? [],
    tagsLoading: tags.isLoading,
    tagsError: tags.isError ? errorMessage(tags.error) : null,
  }

  if (editing) {
    return (
      <section ref={pageRef} className={css.stack}>
        <h1 className={css.title}>
          {editing.kind === 'new' ? 'Добавить слово' : 'Редактировать слово'}
        </h1>
        <WordForm
          {...tagFormProps}
          key={editing.kind === 'edit' ? editing.word.id : 'new'}
          word={editing.kind === 'edit' ? editing.word : undefined}
          pending={save.isPending}
          error={save.isError ? errorMessage(save.error) : null}
          onSubmit={(input) => save.mutate(input)}
          onCancel={() => setEditing(null)}
        />
      </section>
    )
  }

  return (
    <section ref={pageRef} className={`${css.stack} ${css.dictionaryPage}`}>
      <div className={`${css.stack} ${css.dictionaryControls}`}>
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
          <button
            className={`${ui.primary} ${css.addWord}`}
            onClick={() => startEditing({ kind: 'new' })}
          >
            Добавить слово
          </button>
        </div>

        <details className={css.filterDisclosure}>
          <summary className={css.disclosureSummary}>
            <span className={css.filterSummaryContent}>
              <span className={css.filterSummaryText}>
                <strong>Фильтры</strong>{' '}
                <span className={ui.muted}>
                  {SORT_SUMMARY[sort]} ·{' '}
                  {TRAINING_OPTIONS.find((option) => option.value === training)?.label}
                  {tagIds.length > 0 &&
                    ` · Теги: ${tagIds.map((id) => tags.data?.find((tag) => tag.id === id)?.name ?? id).join(', ')}`}
                </span>
              </span>
              <span className={css.wordCount} aria-label="Количество слов" aria-live="polite">
                Слов: {countReady ? words.data.length : words.isError ? '—' : '…'}
              </span>
            </span>
          </summary>
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

          <fieldset className={css.tagField}>
            <legend className={ui.label}>Теги: любой выбранный</legend>
            {tags.isLoading && (
              <p role="status" className={ui.muted}>
                Загружаем теги…
              </p>
            )}
            {tags.isError && (
              <p role="alert" className={ui.error}>
                {errorMessage(tags.error)} Не удалось загрузить теги.
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
                      updateTags(
                        event.target.checked
                          ? [...tagIds, tag.id]
                          : tagIds.filter((id) => id !== tag.id),
                      )
                    }
                  />
                  {tag.name}
                </label>
              ))}
            </div>
            {tagIds.length > 0 && (
              <button type="button" className={ui.button} onClick={() => updateTags([])}>
                Снять фильтр тегов
              </button>
            )}
          </fieldset>
        </details>

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
        {learnedState.isError && (
          <p className={ui.error} role="alert">
            {errorMessage(learnedState.error)} Повторите действие.
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
            {query || tagIds.length > 0
              ? 'Ничего не найдено.'
              : training === 'excluded'
                ? 'Нет исключённых слов.'
                : training === 'learned'
                  ? 'Нет выученных слов.'
                  : training === 'active'
                    ? 'Нет слов в обучении. Добавьте слово или верните исключённые.'
                    : 'Словарь пуст. Добавьте первые слова.'}
          </p>
        )}
      </div>

      <ul className={css.wordList}>
        {words.data?.map((word) => (
          <li key={word.id} className={css.wordRow}>
            <div className={css.wordMain}>
              <div className={css.wordHead}>
                <strong lang="en">{word.headword}</strong>
                {word.transcription && <span className={ui.muted}>{word.transcription}</span>}
                <SpeakButton text={word.headword} lang="en-US" />
              </div>
              <div lang="ru">
                {word.translations.map((translation, i) => (
                  <span key={`${translation}-${i}`}>
                    {i > 0 && ', '}
                    {translation}
                    <SpeakButton text={translation} lang="ru-RU" />
                  </span>
                ))}
              </div>
              {word.tags.length > 0 && (
                <div className={css.wordTags} aria-label="Теги слова">
                  {word.tags.map((tag) => (
                    <span className={css.wordTag} key={tag.id}>
                      {tag.name}
                    </span>
                  ))}
                </div>
              )}
              {word.example_en && (
                <div className={`${ui.muted} ${css.example}`} lang="en">
                  {word.example_en}
                </div>
              )}
              {word.is_excluded && <p className={ui.muted}>Исключено из обучения</p>}
              {word.is_learned && <p className={ui.muted}>Выучено</p>}
            </div>
            <details className={css.wordActions}>
              <summary
                className={css.actionSummary}
                aria-label={`Действия со словом «${word.headword}»`}
                title={`Действия со словом «${word.headword}»`}
              >
                ⋯
              </summary>
              <div className={css.rowActions}>
                <button
                  type="button"
                  className={
                    word.is_learned
                      ? `${ui.ghost} ${css.actionButton} ${css.learnedOn}`
                      : `${ui.ghost} ${css.actionButton}`
                  }
                  disabled={learnedState.isPending && learnedState.variables?.id === word.id}
                  aria-pressed={word.is_learned}
                  aria-label={
                    word.is_learned
                      ? `Снять отметку «выучено» с «${word.headword}»`
                      : `Отметить «${word.headword}» как выученное`
                  }
                  title={word.is_learned ? 'Снять отметку «выучено»' : 'Отметить как выученное'}
                  onClick={() => learnedState.mutate({ id: word.id, isLearned: !word.is_learned })}
                >
                  <span aria-hidden="true">
                    {learnedState.isPending && learnedState.variables?.id === word.id ? '…' : '✓'}
                  </span>
                  <span>{word.is_learned ? 'Снять' : 'Выучено'}</span>
                </button>
                <button
                  type="button"
                  className={`${ui.ghost} ${css.actionButton}`}
                  disabled={trainingState.isPending}
                  onClick={() =>
                    trainingState.mutate({ id: word.id, isExcluded: !word.is_excluded })
                  }
                  aria-label={`${word.is_excluded ? 'Вернуть в обучение' : 'Исключить из обучения'} «${word.headword}»`}
                  title={word.is_excluded ? 'Вернуть в обучение' : 'Исключить из обучения'}
                >
                  <span aria-hidden="true">
                    {trainingState.isPending && trainingState.variables?.id === word.id
                      ? '…'
                      : word.is_excluded
                        ? '↩'
                        : '⊘'}
                  </span>
                  <span>{word.is_excluded ? 'Вернуть' : 'Исключить'}</span>
                </button>
                <button
                  className={`${ui.ghost} ${css.actionButton}`}
                  onClick={() => startEditing({ kind: 'edit', word })}
                  aria-label={`Изменить «${word.headword}»`}
                  title="Изменить"
                >
                  <span aria-hidden="true">✎</span>
                  <span>Изменить</span>
                </button>
                <button
                  className={`${ui.ghost} ${css.actionButton}`}
                  disabled={remove.isPending}
                  onClick={() => confirmDelete(word)}
                  aria-label={`Удалить «${word.headword}»`}
                  title="Удалить"
                >
                  <span aria-hidden="true">✕</span>
                  <span>Удалить</span>
                </button>
              </div>
            </details>
            <div className={css.wordSide}>
              <span className={css.percent}>{word.progress}%</span>
              <div className={css.meter}>
                <ProgressBar value={word.progress} />
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
