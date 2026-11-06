import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  api,
  ApiError,
  errorMessage,
  type DictionaryLookup,
  type SourceRef,
  type Tag,
  type Word,
  type WordInput,
} from '../api'
import { forgetSession, getSessionRevision } from '../session'
import { normalizeTagName, parseTranslations, tagKey } from '../words'
import css from '../pages/pages.module.css'
import { SpeakButton } from './ui'
import ui from './ui.module.css'
import formCss from './WordForm.module.css'

const sourceId = 'freedict-wikdict-eng-rus-2025.11.23' as const
const partsOfSpeech: Record<string, string> = {
  n: 'существительное',
  noun: 'существительное',
  pn: 'имя собственное',
  v: 'глагол',
  verb: 'глагол',
  adj: 'прилагательное',
  adjective: 'прилагательное',
  adv: 'наречие',
  adverb: 'наречие',
  pron: 'местоимение',
  pronoun: 'местоимение',
  prep: 'предлог',
  preposition: 'предлог',
  postposition: 'послелог',
  symbol: 'символ',
  conj: 'союз',
  conjunction: 'союз',
  int: 'междометие',
  interj: 'междометие',
  interjection: 'междометие',
  num: 'числительное',
  numeral: 'числительное',
  art: 'артикль',
  determiner: 'определитель',
  particle: 'частица',
  participle: 'причастие',
  phraseologicalunit: 'фразеологизм',
  proverb: 'пословица',
  abbreviation: 'аббревиатура',
  prefix: 'приставка',
  suffix: 'суффикс',
}
const partOfSpeech = (value: string) => partsOfSpeech[value.toLowerCase()] ?? value
const translationKey = (value: string) =>
  tagKey(value)
    .replaceAll('ё', 'е')
    .replace(/[’‘ʼ`]/g, "'")
    .replace(/(?<!\.)\.$/, '')
    .trimEnd()

const optional = (value: string) => value.trim() || null
const americanScore = (value: string) => Number(/[ɹrɚɝ]/.test(value)) + Number(value.includes('oʊ'))

function preferredTranscription(matches: DictionaryLookup['matches']) {
  const match = matches.find((item) => item.transcriptions.length > 0)
  if (!match) return null
  const value = match.transcriptions.reduce((preferred, candidate) =>
    americanScore(candidate) > americanScore(preferred) ? candidate : preferred,
  )
  return { entryId: match.entry_id, value }
}

interface Props {
  word?: Word
  pending: boolean
  error: string | null
  onSubmit: (input: WordInput) => void
  onCancel: () => void
  availableTags: Tag[]
  tagsLoading: boolean
  tagsError: string | null
}

export function WordForm({
  word,
  pending,
  error,
  onSubmit,
  onCancel,
  availableTags,
  tagsLoading,
  tagsError,
}: Props) {
  const [headword, setHeadword] = useState(word?.headword ?? '')
  const [translations, setTranslations] = useState(word?.translations.join('\n') ?? '')
  const [transcription, setTranscription] = useState(word?.transcription ?? '')
  const [exampleEn, setExampleEn] = useState(word?.example_en ?? '')
  const [exampleRu, setExampleRu] = useState(word?.example_ru ?? '')
  const [note, setNote] = useState(word?.note ?? '')
  const [localError, setLocalError] = useState<string | null>(null)
  const [tags, setTags] = useState<string[]>(word?.tags.map((tag) => tag.name) ?? [])
  const [tagInput, setTagInput] = useState('')
  const [tagError, setTagError] = useState<string | null>(null)
  const [refs, setRefs] = useState<SourceRef[]>(word?.source_refs ?? [])
  const [lookup, setLookup] = useState<DictionaryLookup | null>(null)
  const [lookupState, setLookupState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [lookupError, setLookupError] = useState<string | null>(null)
  const [choiceError, setChoiceError] = useState<string | null>(null)
  const [exampleState, setExampleState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [exampleGenerated, setExampleGenerated] = useState(false)
  const [exampleError, setExampleError] = useState<string | null>(null)
  const lookupRequestId = useRef(0)
  const exampleRequestId = useRef(0)
  const revision = useRef(getSessionRevision())
  useEffect(
    () => () => {
      lookupRequestId.current++
      exampleRequestId.current++
    },
    [],
  )

  function changeHeadword(value: string) {
    lookupRequestId.current++
    exampleRequestId.current++
    setHeadword(value)
    setLookup(null)
    setLookupState('idle')
    setLookupError(null)
    setExampleState('idle')
    setExampleGenerated(false)
    setExampleError(null)
    setChoiceError(null)
  }

  async function findSuggestions(value = headword) {
    const id = ++lookupRequestId.current
    const currentRevision = getSessionRevision()
    revision.current = currentRevision
    setLookup(null)
    setChoiceError(null)
    setLookupState('loading')
    setLookupError(null)
    try {
      const result = await api.lookupDictionary(value.trim())
      if (id !== lookupRequestId.current || currentRevision !== getSessionRevision()) return
      const matches = result.matches.map((match) => ({
        ...match,
        translations: [
          ...new Set(match.translations.map((value) => value.replaceAll('\u0301', ''))),
        ],
      }))
      let machineTranslation = result.machine_translation
      if (machineTranslation) {
        const values = [
          ...new Set(
            [machineTranslation.text, ...(machineTranslation.alternatives ?? [])].map((value) =>
              value.replaceAll('\u0301', ''),
            ),
          ),
        ]
        machineTranslation = {
          ...machineTranslation,
          text: values[0],
          alternatives: values.slice(1),
        }
      }
      setLookup({ ...result, matches, machine_translation: machineTranslation })
      const preferred = preferredTranscription(matches)
      if (preferred) {
        setTranscription(preferred.value)
        setRefs((current) =>
          [
            ...current.filter((ref) => ref.field !== 'transcription'),
            {
              source_id: sourceId,
              entry_id: preferred.entryId,
              field: 'transcription' as const,
              value: preferred.value,
            },
          ].slice(0, 20),
        )
      } else if (machineTranslation?.transcription) {
        setTranscription(machineTranslation.transcription)
        setRefs((current) => current.filter((ref) => ref.field !== 'transcription'))
      }
      setLookupState('idle')
    } catch (error) {
      if (id !== lookupRequestId.current || currentRevision !== getSessionRevision()) return
      if (error instanceof ApiError && error.status === 401) {
        forgetSession()
        return
      }
      if (error instanceof ApiError && error.message === 'dictionary_timeout')
        setLookupError(errorMessage(error))
      setLookupState('error')
    }
  }

  async function selectSpelling(value: string) {
    changeHeadword(value)
    await findSuggestions(value)
  }

  async function addExample(mode: 'append' | 'replace' = 'replace') {
    const id = ++exampleRequestId.current
    const currentRevision = getSessionRevision()
    revision.current = currentRevision
    setExampleState('loading')
    setExampleError(null)
    try {
      const previousExamples = exampleEn
        .split(/\n\s*\n/u)
        .map((example) => example.trim())
        .filter(Boolean)
      const result = await api.generateExample(headword.trim(), previousExamples)
      if (id !== exampleRequestId.current || currentRevision !== getSessionRevision()) return
      if (
        previousExamples.some(
          (example) => example.toLocaleLowerCase() === result.example_en.toLocaleLowerCase(),
        )
      ) {
        setExampleState('error')
        setExampleError('DeepSeek повторил прежний пример. Попробуйте ещё раз; текст не изменён.')
        return
      }
      const append = (current: string, addition: string) =>
        mode === 'append' && current.trim() ? `${current.trimEnd()}\n\n${addition}` : addition
      const nextEn = append(exampleEn, result.example_en)
      const nextRu = append(exampleRu, result.example_ru)
      if (nextEn.length > 2000 || nextRu.length > 2000) {
        setExampleState('error')
        setExampleError('Примеры не помещаются в поля: максимум 2000 символов. Текст не изменён.')
        return
      }
      setExampleEn(nextEn)
      setExampleRu(nextRu)
      setExampleGenerated(true)
      setExampleState('idle')
    } catch (error) {
      if (id !== exampleRequestId.current || currentRevision !== getSessionRevision()) return
      if (error instanceof ApiError && error.status === 401) {
        forgetSession()
        return
      }
      if (error instanceof ApiError && error.message === 'examples_timeout')
        setExampleError(errorMessage(error))
      setExampleState('error')
    }
  }

  function chooseTranslation(value: string, entryId: number | null) {
    if (revision.current !== getSessionRevision()) return
    const current = parseTranslations(translations)
    if (current.some((item) => translationKey(item) === translationKey(value))) {
      setChoiceError('Такой перевод уже добавлен.')
      return
    }
    if (current.length >= 10) {
      setChoiceError('Можно добавить не больше 10 переводов.')
      return
    }
    setTranslations([...current, value].join('\n'))
    setChoiceError(null)
    if (entryId !== null) {
      setRefs((current) =>
        [
          ...current,
          { source_id: sourceId, entry_id: entryId, field: 'translation' as const, value },
        ].slice(0, 20),
      )
    }
  }

  function addTag(raw: string) {
    const name = normalizeTagName(raw)
    if (!name || Array.from(name).length > 80) {
      setTagError('Имя тега должно содержать от 1 до 80 символов.')
      return
    }
    if (tags.some((tag) => tagKey(tag) === tagKey(name))) {
      setTagError('Этот тег уже выбран.')
      return
    }
    if (tags.length >= 20) {
      setTagError('Можно выбрать не больше 20 тегов.')
      return
    }
    const existing = availableTags.find((tag) => tagKey(tag.name) === tagKey(name))
    setTags((current) => [...current, existing?.name ?? name])
    setTagInput('')
    setTagError(null)
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    const parsed = parseTranslations(translations)
    if (!headword.trim() || parsed.length === 0) {
      setLocalError('Нужно слово и хотя бы один перевод.')
      return
    }
    if (parsed.length > 10) {
      setLocalError('Не больше 10 переводов.')
      return
    }
    setLocalError(null)
    onSubmit({
      headword: headword.trim(),
      translations: parsed,
      transcription: optional(transcription),
      example_en: optional(exampleEn),
      example_ru: optional(exampleRu),
      note: optional(note),
      tags,
      source_refs: refs.filter((ref) =>
        ref.field === 'translation'
          ? parsed.includes(ref.value)
          : optional(transcription) === ref.value,
      ),
    })
  }

  const selectedTranslations = new Set(parseTranslations(translations).map(translationKey))
  const machine = lookup?.machine_translation
  const machineChoices = machine ? [machine.text, ...(machine.alternatives ?? [])] : []
  function translationChoice(value: string, entryId: number | null) {
    const added = selectedTranslations.has(translationKey(value))
    return (
      <button
        type="button"
        className={`${ui.button} ${formCss.dictionaryButton}`}
        key={value}
        disabled={added}
        aria-pressed={added}
        title={added ? 'Уже в списке' : 'Добавить перевод'}
        onClick={() => chooseTranslation(value, entryId)}
      >
        {value}
      </button>
    )
  }
  const message = localError ?? error
  return (
    <form className={`${ui.card} ${css.form}`} onSubmit={submit} aria-label="Слово">
      <div className={css.formRow}>
        <div className={formCss.headword}>
          <label className={ui.field}>
            <span className={ui.label}>Слово или выражение (EN)</span>
            <input
              className={ui.input}
              value={headword}
              onChange={(e) => changeHeadword(e.target.value)}
              maxLength={200}
              lang="en"
              autoCapitalize="none"
              autoFocus
              required
            />
          </label>
          <SpeakButton text={headword.trim()} lang="en-US" disabled={!headword.trim()} />
        </div>
        <label className={ui.field}>
          <span className={ui.label}>Транскрипция</span>
          <input
            className={ui.input}
            value={transcription}
            onChange={(e) => {
              setTranscription(e.target.value)
              setRefs((current) =>
                current.filter(
                  (ref) => ref.field !== 'transcription' || ref.value === e.target.value.trim(),
                ),
              )
            }}
            maxLength={300}
          />
        </label>
      </div>
      <div className={formCss.dictionary}>
        <button
          type="button"
          className={`${ui.button} ${formCss.dictionaryButton}`}
          disabled={!headword.trim() || lookupState === 'loading'}
          onClick={() => findSuggestions()}
        >
          Подобрать перевод и транскрипцию
        </button>
        {lookupState === 'loading' && <p role="status">Ищем в словаре…</p>}
        {lookupState === 'error' && (
          <p role="alert">
            {lookupError ?? 'Словарь недоступен. Попробуйте ещё раз или введите данные вручную.'}
          </p>
        )}
        {lookup &&
          lookup.matches.length === 0 &&
          lookup.spelling_suggestions &&
          lookup.spelling_suggestions.length > 0 && (
            <section aria-label="Возможные исправления">
              <p>Точного совпадения нет. Возможно, вы имели в виду:</p>
              <div className={formCss.choices}>
                {lookup.spelling_suggestions.map((value) => (
                  <button
                    type="button"
                    className={`${ui.button} ${formCss.dictionaryButton}`}
                    key={value}
                    onClick={() => selectSpelling(value)}
                  >
                    {value}
                  </button>
                ))}
              </div>
            </section>
          )}
        {lookup &&
          lookup.matches.length === 0 &&
          !lookup.spelling_suggestions?.length &&
          (lookup.machine_translation ? (
            <p role="status">
              Слова нет в локальном словаре. Проверьте написание или используйте машинный перевод.
            </p>
          ) : (
            <p role="status">Слово не найдено. Проверьте написание или введите перевод вручную.</p>
          ))}
        {machine && machineChoices.length > 0 && (
          <section aria-label="Машинный перевод">
            <p>
              Машинный перевод · {machine.provider === 'deepl' ? 'DeepL' : 'DeepSeek · OpenRouter'}
            </p>
            <div className={formCss.choices}>
              {machineChoices.map((value) => translationChoice(value, null))}
            </div>
          </section>
        )}
        {lookup && lookup.matches.length > 0 && (
          <div>
            <p>Варианты из словаря в порядке источника.</p>
            {lookup.matches.map((match) => (
              <section
                key={match.entry_id}
                aria-label={`${match.headword}${match.part_of_speech ? `, ${partOfSpeech(match.part_of_speech)}` : ''}`}
              >
                <p>
                  <strong>{match.headword}</strong>
                  {match.part_of_speech && ` — ${partOfSpeech(match.part_of_speech)}`}
                  {match.match === 'normalized' && ' (нормализованное совпадение)'}
                </p>
                <div className={formCss.choices}>
                  {match.translations.map((value) => translationChoice(value, match.entry_id))}
                </div>
              </section>
            ))}
          </div>
        )}
        {choiceError && (
          <p role="alert" className={ui.error}>
            {choiceError}
          </p>
        )}
      </div>
      <label className={ui.field}>
        <span className={ui.label}>Переводы — по одному в строке, первый основной</span>
        <textarea
          className={ui.input}
          value={translations}
          onChange={(e) => {
            setTranslations(e.target.value)
            const values = parseTranslations(e.target.value)
            setRefs((current) =>
              current.filter((ref) => ref.field !== 'translation' || values.includes(ref.value)),
            )
          }}
          rows={3}
          lang="ru"
          required
        />
      </label>
      <fieldset className={css.tagField}>
        <legend className={ui.label}>Теги</legend>
        <p className={ui.muted}>До 20 тегов, каждый — до 80 символов.</p>
        {tagsLoading && (
          <p role="status" className={ui.muted}>
            Загружаем теги…
          </p>
        )}
        {tagsError && (
          <p role="alert" className={ui.error}>
            {tagsError} Можно ввести тег вручную.
          </p>
        )}
        {availableTags.length > 0 && (
          <label className={ui.field}>
            <span className={ui.label}>Выбрать существующий тег</span>
            <select className={ui.input} value="" onChange={(event) => addTag(event.target.value)}>
              <option value="">Выберите тег</option>
              {availableTags
                .filter((tag) => !tags.some((selected) => tagKey(selected) === tagKey(tag.name)))
                .map((tag) => (
                  <option key={tag.id} value={tag.name}>
                    {tag.name}
                  </option>
                ))}
            </select>
          </label>
        )}
        <div className={css.tagEntry}>
          <label className={ui.field}>
            <span className={ui.label}>Новый тег</span>
            <input
              className={ui.input}
              value={tagInput}
              onChange={(event) => setTagInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  addTag(tagInput)
                }
              }}
            />
          </label>
          <button type="button" className={ui.button} onClick={() => addTag(tagInput)}>
            Добавить тег
          </button>
        </div>
        {tagError && (
          <p role="alert" className={ui.error}>
            {tagError}
          </p>
        )}
        <div className={css.tagList}>
          {tags.map((tag) => (
            <span className={css.tag} key={tag}>
              {tag}
              <button
                type="button"
                className={ui.ghost}
                aria-label={`Снять тег «${tag}»`}
                onClick={() => {
                  setTags((current) => current.filter((item) => item !== tag))
                  setTagError(null)
                }}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      </fieldset>
      <div>
        <div className={css.actions}>
          {exampleGenerated ? (
            <>
              <button
                type="button"
                className={ui.button}
                disabled={!headword.trim() || exampleState === 'loading'}
                onClick={() => addExample('append')}
              >
                Добавить ещё 1 пример
              </button>
              <button
                type="button"
                className={ui.button}
                disabled={!headword.trim() || exampleState === 'loading'}
                onClick={() => addExample('replace')}
              >
                Заменить все примеры
              </button>
            </>
          ) : (
            <button
              type="button"
              className={ui.button}
              disabled={!headword.trim() || exampleState === 'loading'}
              onClick={() => addExample()}
            >
              Добавить пример
            </button>
          )}
        </div>
        {exampleState === 'loading' && <p role="status">DeepSeek составляет пример…</p>}
        {exampleState === 'error' && (
          <p role="alert" className={ui.error}>
            {exampleError ??
              'Не удалось составить пример. Попробуйте ещё раз или введите его вручную.'}
          </p>
        )}
      </div>
      <div className={css.formRow}>
        <label className={ui.field}>
          <span className={ui.label}>Пример (EN)</span>
          <textarea
            className={ui.input}
            value={exampleEn}
            onChange={(e) => setExampleEn(e.target.value)}
            rows={6}
            maxLength={2000}
            lang="en"
          />
        </label>
        <label className={ui.field}>
          <span className={ui.label}>Перевод примера</span>
          <textarea
            className={ui.input}
            value={exampleRu}
            onChange={(e) => setExampleRu(e.target.value)}
            rows={6}
            maxLength={2000}
            lang="ru"
          />
        </label>
      </div>
      <label className={ui.field}>
        <span className={ui.label}>Заметка</span>
        <textarea
          className={ui.input}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          maxLength={4000}
        />
      </label>
      {message && (
        <p className={ui.error} role="alert">
          {message}
        </p>
      )}
      <div className={css.actions}>
        <button className={ui.primary} disabled={pending}>
          {word ? 'Сохранить' : 'Добавить'}
        </button>
        <button type="button" className={ui.button} onClick={onCancel}>
          Отмена
        </button>
      </div>
    </form>
  )
}
