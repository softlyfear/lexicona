import { useMutation } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { ApiError, api, errorMessage, type Difficulty, type Session, type User } from '../api'
import ui from '../components/ui.module.css'
import { SpeechStatus } from '../components/ui'
import {
  hasServerLocale,
  languageEngine,
  refreshServerVoices,
  selectServerVoice,
  selectVoice,
  SPEECH_RATES,
  speak,
  updateSpeechPreferences,
  useSpeech,
  type SpeechRate,
} from '../speech'
import { forgetSession, getSessionRevision, isCurrentSession, queryClient } from '../session'
import css from './pages.module.css'

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

export function SettingsPage({ user }: { user: User }) {
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
      <SpeechSettings />
    </section>
  )
}

function SpeechSettings() {
  const { preferences, voices, voiceState, storageError, syncError, serverVoices, serverState } =
    useSpeech()
  const serverReady = serverState === 'ready'
  const locales = [
    ...new Set([
      'en-US',
      'en-GB',
      ...(preferences.engineEn === 'server'
        ? []
        : voices.filter((v) => v.lang.toLowerCase().split('-')[0] === 'en').map((v) => v.lang)),
    ]),
  ]
  const describe = (v: SpeechSynthesisVoice) =>
    `${v.name} (${v.lang}, ${v.localService ? 'локальный' : 'сетевой'})`
  const englishVariant = (
    <label className={css.setting}>
      <span className={css.settingLabel}>Вариант английского</span>
      <select
        className={ui.input}
        value={preferences.enLocale}
        onChange={(e) => updateSpeechPreferences({ enLocale: e.target.value, enVoiceURI: null })}
      >
        {!locales.includes(preferences.enLocale) && (
          <option value={preferences.enLocale}>{preferences.enLocale}</option>
        )}
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
      {(['en', 'ru'] as const).map((lang) => {
        const choice = languageEngine(lang, preferences)
        const useServer =
          choice !== 'browser' &&
          serverReady &&
          (choice === 'server' || hasServerLocale(serverVoices, lang, preferences))
        const source = (
          <label className={css.setting}>
            <span className={css.settingLabel}>Источник {lang.toUpperCase()}</span>
            <select
              className={ui.input}
              value={choice}
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
        const check = (
          <div>
            <button
              type="button"
              className={ui.button}
              onClick={() =>
                speak(
                  lang === 'en'
                    ? 'Hello. This is an English voice test.'
                    : 'Проверка русского голоса.',
                  lang,
                  { force: true },
                )
              }
            >
              Проверить {lang.toUpperCase()}
            </button>
          </div>
        )
        if (choice === 'server' && !serverReady) {
          return (
            <div key={lang} className={css.group}>
              {lang === 'en' && englishVariant}
              {source}
              <p className={ui.muted}>
                {serverState === 'loading'
                  ? 'Загружаем серверные голоса…'
                  : 'Серверный голос недоступен. Можно выбрать браузер.'}
              </p>
              {check}
            </div>
          )
        }
        if (useServer) {
          const locale = lang === 'ru' ? 'ru-RU' : preferences.enLocale
          const key =
            lang === 'ru'
              ? 'serverRu'
              : locale.toLowerCase() === 'en-gb'
                ? 'serverEnGB'
                : 'serverEnUS'
          const uri = preferences[key]
          const available = serverVoices.filter(
            (voice) => voice.language.toLowerCase() === locale.toLowerCase(),
          )
          const selected = selectServerVoice(serverVoices, lang, preferences)
          const storedMissing = Boolean(uri && !available.some((voice) => voice.id === uri))
          const upgraded = storedMissing && selected ? selected.id : null
          const genderLabel = {
            female: 'женский',
            male: 'мужской',
            nonbinary: 'небинарный',
          } as const
          const describeServer = (voice: (typeof serverVoices)[number]) =>
            `${voice.name} (${voice.language}, ${genderLabel[voice.gender]})`
          return (
            <div key={lang} className={css.group}>
              {lang === 'en' && englishVariant}
              {source}
              <label className={css.setting}>
                <span className={css.settingLabel}>Голос {lang.toUpperCase()}</span>
                <select
                  className={ui.input}
                  value={upgraded ?? uri ?? ''}
                  onChange={(event) =>
                    updateSpeechPreferences({ [key]: event.target.value || null })
                  }
                >
                  <option value="">Автоматически</option>
                  {uri && storedMissing && !upgraded && (
                    <option value={uri}>Сохранённый голос недоступен</option>
                  )}
                  {available.map((voice) => (
                    <option key={voice.id} value={voice.id}>
                      {describeServer(voice)}
                    </option>
                  ))}
                </select>
              </label>
              <p className={ui.muted}>
                {selected
                  ? `Используется: ${describeServer(selected)}`
                  : `Подходящий серверный ${lang.toUpperCase()} голос не найден.`}
              </p>
              {check}
            </div>
          )
        }
        const uri = lang === 'en' ? preferences.enVoiceURI : preferences.ruVoiceURI
        const exactLocale =
          choice === 'auto' && serverReady && !hasServerLocale(serverVoices, lang, preferences)
        const locale = lang === 'ru' ? 'ru-RU' : preferences.enLocale
        const available = voices.filter((v) =>
          exactLocale
            ? v.lang.toLowerCase() === locale.toLowerCase()
            : v.lang.toLowerCase().split('-')[0] === lang,
        )
        const selected = selectVoice(available, lang, preferences)
        return (
          <div key={lang} className={css.group}>
            {lang === 'en' && englishVariant}
            {source}
            {exactLocale && (
              <p className={ui.muted}>
                Для этого языка нет серверного голоса. Используется голос браузера.
              </p>
            )}
            <label className={css.setting}>
              <span className={css.settingLabel}>Голос {lang.toUpperCase()}</span>
              <select
                className={ui.input}
                value={uri ?? ''}
                onChange={(e) =>
                  updateSpeechPreferences(
                    lang === 'en'
                      ? { enVoiceURI: e.target.value || null }
                      : { ruVoiceURI: e.target.value || null },
                  )
                }
              >
                <option value="">Автоматически</option>
                {uri && !available.some((v) => v.voiceURI === uri) && (
                  <option value={uri}>Сохранённый голос недоступен</option>
                )}
                {available.map((v) => (
                  <option key={v.voiceURI} value={v.voiceURI}>
                    {describe(v)}
                  </option>
                ))}
              </select>
            </label>
            <p className={ui.muted}>
              {selected
                ? `${uri && selected.voiceURI !== uri ? 'Запрошенный голос недоступен. ' : ''}Используется: ${describe(selected)}`
                : voiceState === 'loading'
                  ? 'Ожидание голосов…'
                  : `Подходящий ${lang.toUpperCase()} голос не найден.`}
            </p>
            {check}
          </div>
        )
      })}
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
        <p className={ui.muted}>
          Снятый язык не озвучивается в словаре и на тренировке. Кнопка «Проверить» выше по-прежнему
          произносит образец.
        </p>
        <label className={css.choice}>
          <input
            type="checkbox"
            checked={preferences.autoPrompt}
            onChange={(e) => updateSpeechPreferences({ autoPrompt: e.target.checked })}
          />{' '}
          Автоматически озвучивать задание
        </label>
        <SpeechStatus />
      </div>
    </section>
  )
}
