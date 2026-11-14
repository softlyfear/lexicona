import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, errorMessage, type Word, type WordInput } from '../api'
import { WordForm } from './WordForm'
import ui from './ui.module.css'
import css from '../pages/pages.module.css'

export function EditWordButton({
  name,
  disabled,
  onEdit,
}: {
  name: string
  disabled?: boolean
  onEdit: () => void
}) {
  return (
    <button
      type="button"
      className={css.editWord}
      aria-label={`Редактировать слово «${name}»`}
      title="Редактировать слово"
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation()
        onEdit()
      }}
    >
      <span aria-hidden="true">✎</span>
    </button>
  )
}

export function TrainingWordEditor({
  wordId,
  onClose,
  onSaved,
}: {
  wordId: string
  onClose: () => void
  onSaved: (before: Word, saved: Word) => void
}) {
  const queryClient = useQueryClient()
  const tags = useQuery({ queryKey: ['tags'], queryFn: api.listTags })
  const word = useQuery({ queryKey: ['word', wordId], queryFn: () => api.getWord(wordId) })
  const save = useMutation({
    mutationFn: (input: WordInput) => api.updateWord(wordId, input),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['words'] }),
        queryClient.invalidateQueries({ queryKey: ['tags'] }),
        queryClient.invalidateQueries({ queryKey: ['word', wordId] }),
      ]),
  })
  const loaded = word.data

  return (
    <section className={css.stack}>
      <h1 className={css.title}>Редактировать слово</h1>
      {word.isPending && (
        <p role="status" className={ui.muted}>
          Загружаем слово…
        </p>
      )}
      {word.isError && (
        <>
          <p role="alert" className={ui.error}>
            {errorMessage(word.error)}
          </p>
          <div className={css.actions}>
            <button type="button" className={ui.button} onClick={onClose}>
              Вернуться к заданию
            </button>
          </div>
        </>
      )}
      {loaded && (
        <WordForm
          key={loaded.id}
          word={loaded}
          pending={save.isPending}
          error={save.isError ? errorMessage(save.error) : null}
          onSubmit={(input) => save.mutate(input, { onSuccess: (saved) => onSaved(loaded, saved) })}
          onCancel={onClose}
          availableTags={tags.data ?? []}
          tagsLoading={tags.isLoading}
          tagsError={tags.isError ? errorMessage(tags.error) : null}
        />
      )}
    </section>
  )
}
