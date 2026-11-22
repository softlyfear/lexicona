import { useMutation } from '@tanstack/react-query'
import { useRef, useState, type ReactNode } from 'react'
import { ApiError, api, errorMessage, type Difficulty, type Session, type User } from '../api'
import ui from '../components/ui.module.css'
import { SpeechStatus } from '../components/ui'
import {
  browserVoiceKey,
  englishAccentLocale,
  languageEngine,
  refreshServerVoices,
  selectServerVoice,
  selectVoice,
  serverVoiceKey,
  SPEECH_RATES,
  speak,
  updateSpeechPreferences,
  useSpeech,
  type SpeechRate,
} from '../speech'
import { forgetSession, getSessionRevision, isCurrentSession, queryClient } from '../session'
import css from './pages.module.css'
import { putTrainingFlag } from '../accountPreferences'

const LEVELS: { value: Difficulty; label: string; choice: number; typed: number }[] = [
  { value: 'very_easy', label: 'Очень легко', choice: 10, typed: 20 },
  { value: 'easy', label: 'Легко', choice: 7, typed: 14 },
  { value: 'medium', label: 'Средне', choice: 4, typed: 8 },
  { value: 'hard', label: 'Сложно', choice: 3, typed: 6 },
  { value: 'very_hard', label: 'Очень сложно', choice: 2, typed: 4 },
]

function levelRates(choice: number, typed: number) {
  const pairs = Math.max(1, Math.floor(choice / 2))
  return [
    ['выбор', choice, choice],
    ['пары', pairs, choice],
    ['ввод', typed, choice],
  ] as const
}

type Result<T> = { data: T } | { error: unknown }

interface OfflineSetting {
  supported: boolean
  optedIn: boolean
  message: string
  settingError: string
  changeOptIn: (enabled: boolean) => void
}

export function SettingsPage({ user, offline }: { user: User; offline?: OfflineSetting }) {
  const [difficultyError, setDifficultyError] = useState('')
  const locked = useRef(false)

  const update = useMutation({
    mutationFn: async ({
      difficulty,
    }: {
      difficulty: Difficulty
      revision: number
    }): Promise<Result<User>> => {
      try {
        return { data: await api.updateSettings({ difficulty }) }
      } catch (error) {
        return { error }
      }
    },
    onSuccess: (result, { revision }) => {
      if (!isCurrentSession(revision, user.id)) return
      if ('error' in result) {
        if (result.error instanceof ApiError && result.error.status === 401) forgetSession()
        else setDifficultyError(errorMessage(result.error))
        return
      }
      if (result.data.id !== user.id) return
      queryClient.setQueryData(['session'], (prev: Session | null) =>
        prev?.user.id === user.id
          ? { ...prev, user: { ...prev.user, difficulty: result.data.difficulty } }
          : prev,
      )
    },
    onSettled: () => {
      locked.current = false
    },
  })

  const busy = update.isPending
  const savedLevel = LEVELS.find((level) => level.value === user.difficulty) ?? LEVELS[2]
  function updateDifficulty(difficulty: Difficulty) {
    if (locked.current) return
    locked.current = true
    setDifficultyError('')
    update.mutate({ difficulty, revision: getSessionRevision() })
  }

  return (
    <section className={css.stack}>
      <h1 className={css.title}>Настройки</h1>
      {offline && (
        <div className={`${ui.card} ${css.stack}`}>
          <label className={css.choice}>
            <input
              type="checkbox"
              checked={offline.optedIn}
              disabled={!offline.supported}
              onChange={(event) => offline.changeOptIn(event.target.checked)}
            />
            Офлайн-режим
          </label>
          {!offline.supported && (
            <p className={ui.muted}>Офлайн-режим недоступен в этом браузере.</p>
          )}
          {offline.settingError && (
            <p className={ui.error} role="alert">
              {offline.settingError}
            </p>
          )}
          {offline.message && (
            <p className={ui.muted} role="status">
              {offline.message}
            </p>
          )}
        </div>
      )}
      <div className={`${ui.card} ${css.difficultyPanel}`}>
        <div className={css.difficultyControl}>
          <label className={ui.field}>
            <span className={ui.label}>Сложность</span>
            <select
              className={ui.input}
              value={user.difficulty}
              disabled={busy}
              onChange={(event) => updateDifficulty(event.target.value as Difficulty)}
            >
              {LEVELS.map((level) => (
                <option key={level.value} value={level.value}>
                  {level.label}
                </option>
              ))}
            </select>
          </label>
          {busy && <p role="status">Сохраняем сложность…</p>}
          <p className={ui.muted}>
            Сложность применяется к новым занятиям. Текущее занятие сохраняет прежние настройки.
          </p>
          {difficultyError && (
            <p className={ui.error} role="alert">
              {difficultyError}
            </p>
          )}
        </div>
        <table className={css.ratesTable}>
          <caption>Прогресс для уровня «{savedLevel.label}»</caption>
          <thead>
            <tr>
              <th scope="col">Упражнение</th>
              <th scope="col">Верно</th>
              <th scope="col">Ошибка</th>
            </tr>
          </thead>
          <tbody>
            {levelRates(savedLevel.choice, savedLevel.typed).map(([kind, gain, loss]) => (
              <tr key={kind}>
                <th scope="row">{kind}</th>
                <td>+{gain}%</td>
                <td>−{loss}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <SpeechSettings
        trainingControls={
          <>
            <TrainingFlagControl
              user={user}
              field="training_auto_advance"
              label="Автоматически переходить после верного ответа"
              pendingLabel="Сохраняем автоматический переход…"
            />
            <TrainingFlagControl
              user={user}
              field="training_auto_check"
              label="Автоматически проверять ввод после паузы"
              pendingLabel="Сохраняем автопроверку…"
            />
          </>
        }
      />
    </section>
  )
}

function TrainingFlagControl({
  user,
  field,
  label,
  pendingLabel,
}: {
  user: User
  field: 'training_auto_advance' | 'training_auto_check'
  label: string
  pendingLabel: string
}) {
  const locked = useRef(false)
  const [error, setError] = useState('')
  const update = useMutation({
    mutationFn: ({ enabled, revision }: { enabled: boolean; revision: number }) =>
      putTrainingFlag(user.id, field, enabled, revision),
    onSuccess: (result, { revision }) => {
      if (!isCurrentSession(revision, user.id)) return
      if (result.status === 'error') {
        if (result.error instanceof ApiError && result.error.status === 401) forgetSession()
        else setError(errorMessage(result.error))
      }
    },
    onSettled: () => {
      locked.current = false
    },
  })
  return (
    <div className={css.stack}>
      <label className={css.choice}>
        <input
          type="checkbox"
          checked={user.preferences?.[field] === true}
          disabled={update.isPending}
          onChange={(event) => {
            if (locked.current) return
            locked.current = true
            setError('')
            update.mutate({ enabled: event.target.checked, revision: getSessionRevision() })
          }}
        />
        {label}
      </label>
      {update.isPending && <p role="status">{pendingLabel}</p>}
      {error && (
        <p className={ui.error} role="alert">
          {error} Повторите действие.
        </p>
      )}
    </div>
  )
}

function SpeechSettings({ trainingControls }: { trainingControls: ReactNode }) {
  const { preferences, voices, voiceState, storageError, syncError, serverVoices, serverState } =
    useSpeech()
  const serverReady = serverState === 'ready'
  const englishLocale = englishAccentLocale(preferences.enLocale) ?? preferences.enLocale
  const locales = [
    ...new Set([
      'en-US',
      'en-GB',
      ...(preferences.engineEn === 'server'
        ? []
        : voices
            .filter((v) => v.lang.toLowerCase().split('-')[0] === 'en')
            .map((v) => englishAccentLocale(v.lang) ?? v.lang)),
    ]),
  ]
  const describe = (v: SpeechSynthesisVoice) =>
    `${v.name} (${v.lang}, ${v.localService ? 'локальный' : 'сетевой'})`
  const englishVariant = (
    <label className={css.setting}>
      <span className={css.settingLabel}>Вариант английского</span>
      <select
        className={ui.input}
        value={englishLocale}
        onChange={(e) => updateSpeechPreferences({ enLocale: e.target.value, enVoiceURI: null })}
      >
        {!locales.includes(englishLocale) && <option value={englishLocale}>{englishLocale}</option>}
        {locales.map((locale) => (
          <option key={locale} value={locale}>
            {locale === 'en-US'
              ? 'Американский (en-US)'
              : locale === 'en-GB'
                ? 'Британский (en-GB)'
                : locale}
          </option>
        ))}
      </select>
    </label>
  )
  function source(lang: 'en' | 'ru') {
    return (
      <label className={css.setting}>
        <span className={css.settingLabel}>Источник {lang.toUpperCase()}</span>
        <select
          className={ui.input}
          value={languageEngine(lang, preferences)}
          onChange={(event) => {
            const next = event.target.value
            if (next !== 'auto' && next !== 'browser' && !(lang === 'en' && next === 'server'))
              return
            updateSpeechPreferences(lang === 'en' ? { engineEn: next } : { engineRu: next })
          }}
        >
          <option value="auto">Автоматически</option>
          {lang === 'en' && <option value="server">Сервер</option>}
          <option value="browser">Браузер</option>
        </select>
      </label>
    )
  }

  function voiceSettings(lang: 'en' | 'ru', locale: string, label: string) {
    const accent = englishAccentLocale(locale)
    const choice = languageEngine(lang, preferences)
    const isLocale = (voiceLocale: string) => voiceLocale.toLowerCase() === locale.toLowerCase()
    const serverOptions = serverVoices.filter((voice) => isLocale(voice.language))
    const check = (
      <div>
        <button
          type="button"
          className={ui.button}
          onClick={() =>
            speak(
              lang === 'en' ? 'Hello. This is an English voice test.' : 'Проверка русского голоса.',
              lang,
              { force: true, locale: accent },
            )
          }
        >
          Проверить {label}
        </button>
      </div>
    )
    if (choice === 'server' && !serverReady) return check
    if (choice !== 'browser' && serverReady && (choice === 'server' || serverOptions.length)) {
      const key = serverVoiceKey(lang, locale)
      const uri = preferences[key]
      const selected = selectServerVoice(serverVoices, lang, preferences, locale)
      const storedMissing = Boolean(uri && !serverOptions.some((voice) => voice.id === uri))
      const upgraded = storedMissing && selected ? selected.id : null
      const genderLabel = { female: 'женский', male: 'мужской', nonbinary: 'небинарный' } as const
      const describeServer = (voice: (typeof serverVoices)[number]) =>
        `${voice.name} (${voice.language}, ${genderLabel[voice.gender]})`
      return (
        <>
          <label className={css.setting}>
            <span className={css.settingLabel}>Голос {label}</span>
            <select
              className={ui.input}
              value={upgraded ?? uri ?? ''}
              onChange={(event) => updateSpeechPreferences({ [key]: event.target.value || null })}
            >
              <option value="">Автоматически</option>
              {uri && storedMissing && !upgraded && (
                <option value={uri}>Сохранённый голос недоступен</option>
              )}
              {serverOptions.map((voice) => (
                <option key={voice.id} value={voice.id}>
                  {describeServer(voice)}
                </option>
              ))}
            </select>
          </label>
          <p className={ui.muted}>
            {selected
              ? `Используется: ${describeServer(selected)}`
              : `Подходящий серверный ${label} голос не найден.`}
          </p>
          {check}
        </>
      )
    }

    const key = browserVoiceKey(lang, locale)
    const uri = preferences[key]
    const serverAccentMissing = choice === 'auto' && serverReady && !serverOptions.length
    const options = voices.filter((voice) =>
      accent || serverAccentMissing
        ? isLocale(voice.lang)
        : voice.lang.toLowerCase().split('-')[0] === lang,
    )
    const selected = selectVoice(
      serverAccentMissing && !accent ? options : voices,
      lang,
      preferences,
      locale,
    )
    return (
      <>
        {serverAccentMissing && (
          <p className={ui.muted}>
            Для {accent ? label : 'этого языка'} нет серверного голоса. Используется голос браузера.
          </p>
        )}
        <label className={css.setting}>
          <span className={css.settingLabel}>Голос {label}</span>
          <select
            className={ui.input}
            value={uri ?? ''}
            onChange={(event) => updateSpeechPreferences({ [key]: event.target.value || null })}
          >
            <option value="">Автоматически</option>
            {uri && !options.some((voice) => voice.voiceURI === uri) && (
              <option value={uri}>Сохранённый голос недоступен</option>
            )}
            {options.map((voice) => (
              <option key={voice.voiceURI} value={voice.voiceURI}>
                {describe(voice)}
              </option>
            ))}
          </select>
        </label>
        <p className={ui.muted}>
          {selected
            ? `${uri && selected.voiceURI !== uri ? 'Запрошенный голос недоступен. ' : ''}Используется: ${describe(selected)}`
            : voiceState === 'loading'
              ? 'Ожидание голосов…'
              : `Подходящий ${label} голос не найден.`}
        </p>
        {check}
      </>
    )
  }

  return (
    <section className={`${ui.card} ${css.form}`} aria-labelledby="speech-heading">
      <h2 id="speech-heading">Озвучивание</h2>
      {serverState === 'loading' && <p role="status">Загружаем серверные голоса…</p>}
      {serverState === 'unavailable' &&
        (languageEngine('en', preferences) !== 'browser' ||
          languageEngine('ru', preferences) !== 'browser') && (
          <div>
            <p>
              Серверные голоса недоступны. Для автоматического источника используется голос
              браузера.
            </p>
            <button type="button" className={ui.button} onClick={refreshServerVoices}>
              Повторить загрузку голосов
            </button>
          </div>
        )}
      {storageError && (
        <p role="alert" className={ui.error}>
          Не удалось прочитать или сохранить настройки браузера; они действуют только до закрытия
          страницы.
        </p>
      )}
      {syncError && (
        <p role="alert" className={ui.error}>
          Не удалось сохранить озвучивание для других устройств. На этом устройстве настройки
          сохранены.
        </p>
      )}
      <div className={css.group}>
        {englishVariant}
        {source('en')}
        {voiceSettings('en', 'en-US', 'US')}
        {voiceSettings('en', 'en-GB', 'UK')}
        {!englishAccentLocale(englishLocale) && voiceSettings('en', englishLocale, 'EN')}
      </div>
      <div className={css.group}>
        {source('ru')}
        {voiceSettings('ru', 'ru-RU', 'RU')}
      </div>
      {voiceState === 'unavailable' && voices.length === 0 && <p>Голоса не найдены.</p>}
      <div className={css.group}>
        <label className={css.setting}>
          <span className={css.settingLabel}>Скорость</span>
          <select
            className={ui.input}
            value={preferences.rate}
            onChange={(event) => {
              const rate = Number(event.target.value)
              if ((SPEECH_RATES as readonly number[]).includes(rate))
                updateSpeechPreferences({ rate: rate as SpeechRate })
            }}
          >
            <option value="0.5">Очень медленная</option>
            <option value="0.75">Медленная</option>
            <option value="1">Обычная</option>
            <option value="1.25">Быстрее</option>
            <option value="1.5">Быстрая</option>
          </select>
        </label>
        <fieldset className={css.choices}>
          <legend className={css.settingLabel}>Какие языки озвучивать</legend>
          <label className={css.choice}>
            <input
              type="checkbox"
              checked={preferences.speakEn}
              onChange={(event) => updateSpeechPreferences({ speakEn: event.target.checked })}
            />
            Английский
          </label>
          <label className={css.choice}>
            <input
              type="checkbox"
              checked={preferences.speakRu}
              onChange={(event) => updateSpeechPreferences({ speakRu: event.target.checked })}
            />
            Русский
          </label>
        </fieldset>
        <p className={ui.muted}>Снятый язык не озвучивается в словаре и на тренировке.</p>
        <label className={css.choice}>
          <input
            type="checkbox"
            checked={preferences.autoPrompt}
            onChange={(e) => updateSpeechPreferences({ autoPrompt: e.target.checked })}
          />{' '}
          Автоматически озвучивать задание
        </label>
        {trainingControls}
        <SpeechStatus />
      </div>
    </section>
  )
}
