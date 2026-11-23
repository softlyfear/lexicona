import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { api } from '../api'
import { setSpeechOwner } from '../speech'
import { SettingsPage } from './SettingsPage'

afterEach(() => {
  act(() => setSpeechOwner(null))
  vi.restoreAllMocks()
  localStorage.clear()
  Reflect.deleteProperty(window, 'speechSynthesis')
})

it('shows the local EN and RU voice availability when offline practice is enabled', async () => {
  vi.spyOn(api, 'listSpeechVoices').mockResolvedValue({ available: false, voices: [] })
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: {
      getVoices: () => [
        { lang: 'en_US', voiceURI: 'local', name: 'English', localService: true },
        { lang: 'ru_RU', voiceURI: 'remote', name: 'Russian', localService: false },
      ],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      cancel: vi.fn(),
    },
  })
  await act(async () => setSpeechOwner('a'))
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SettingsPage
        user={{ id: 'a', login: 'a', is_admin: false, difficulty: 'medium' }}
        offline={{
          supported: true,
          optedIn: true,
          message: '',
          settingError: '',
          changeOptIn: vi.fn(),
        }}
      />
    </QueryClientProvider>,
  )
  expect(screen.getByText('Локальные голоса EN · English, RU · не найден.')).toBeVisible()
  expect(
    within(screen.getByLabelText('Голос US')).getByRole('option', {
      name: 'English (en_US, локальный)',
    }),
  ).toBeInTheDocument()
})

it('показывает установленные голоса по акценту и позволяет явно выбрать браузер', async () => {
  vi.spyOn(api, 'listSpeechVoices').mockResolvedValue({
    available: true,
    voices: [
      { id: 'us', name: 'Lessac', language: 'en-US', gender: 'female' },
      { id: 'sam', name: 'Sam', language: 'en-US', gender: 'nonbinary' },
      { id: 'gb', name: 'Alan', language: 'en-GB', gender: 'male' },
      { id: 'ru', name: 'Denis', language: 'ru-RU', gender: 'male' },
    ],
  })
  await act(async () => {
    setSpeechOwner('a')
    await Promise.resolve()
  })
  const client = new QueryClient()
  render(
    <QueryClientProvider client={client}>
      <SettingsPage user={{ id: 'a', login: 'a', is_admin: false, difficulty: 'medium' }} />
    </QueryClientProvider>,
  )
  const user = userEvent.setup()
  expect(screen.queryByText(/в этом браузере/)).not.toBeInTheDocument()
  expect(screen.getByLabelText('Источник EN')).toHaveValue('auto')
  expect(screen.getByLabelText('Источник RU')).toHaveValue('auto')
  expect(
    within(screen.getByLabelText('Источник EN')).getByRole('option', { name: 'Сервер' }),
  ).toBeInTheDocument()
  expect(
    within(screen.getByLabelText('Источник RU')).queryByRole('option', { name: 'Сервер' }),
  ).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Остановить речь' })).not.toBeInTheDocument()
  expect(
    within(screen.getByLabelText('Голос US')).getByRole('option', {
      name: 'Lessac (en-US, женский)',
    }),
  ).toBeInTheDocument()
  expect(
    within(screen.getByLabelText('Голос US')).getByRole('option', {
      name: 'Sam (en-US, небинарный)',
    }),
  ).toBeInTheDocument()
  expect(
    within(screen.getByLabelText('Голос RU')).getByRole('option', {
      name: 'Denis (ru-RU, мужской)',
    }),
  ).toBeInTheDocument()
  expect(
    within(screen.getByLabelText('Голос UK')).getByRole('option', {
      name: 'Alan (en-GB, мужской)',
    }),
  ).toBeInTheDocument()
  expect(
    within(screen.getByLabelText('Голос UK')).queryByRole('option', { name: /Lessac/ }),
  ).not.toBeInTheDocument()
  await user.selectOptions(screen.getByLabelText('Голос US'), 'sam')
  await user.selectOptions(screen.getByLabelText('Голос UK'), 'gb')
  await user.selectOptions(screen.getByLabelText('Вариант английского'), 'en-GB')
  expect(JSON.parse(localStorage.getItem('lexicona:speech:v1:a')!)).toMatchObject({
    serverEnUS: 'sam',
    serverEnGB: 'gb',
  })
  expect(screen.getByRole('option', { name: 'Очень медленная' })).toBeInTheDocument()
  expect(screen.getByRole('option', { name: 'Быстрая' })).toBeInTheDocument()
  await user.selectOptions(screen.getByLabelText('Скорость'), '1.5')
  expect(JSON.parse(localStorage.getItem('lexicona:speech:v1:a')!).rate).toBe(1.5)
  await user.selectOptions(screen.getByLabelText('Источник RU'), 'browser')
  expect(screen.getByLabelText('Источник EN')).toHaveValue('auto')
  expect(screen.getByLabelText('Источник RU')).toHaveValue('browser')
  expect(screen.getByLabelText('Голос US')).toHaveValue('sam')
  expect(screen.getByLabelText('Голос UK')).toHaveValue('gb')
  expect(screen.getByLabelText('Английский')).toBeChecked()
  expect(screen.getByLabelText('Русский')).toBeChecked()
  await user.click(screen.getByLabelText('Русский'))
  expect(screen.getByLabelText('Русский')).not.toBeChecked()
  expect(JSON.parse(localStorage.getItem('lexicona:speech:v1:a')!).speakRu).toBe(false)
  expect(screen.getByRole('button', { name: 'Проверить RU' })).toBeEnabled()
})

it('сохраняет два браузерных голоса при смене варианта английского', async () => {
  vi.spyOn(api, 'listSpeechVoices').mockResolvedValue({ available: false, voices: [] })
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: {
      getVoices: () => [
        { lang: 'en-US', voiceURI: 'browser-us', name: 'American', localService: true },
        { lang: 'en-GB', voiceURI: 'browser-gb', name: 'British', localService: true },
      ],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      cancel: vi.fn(),
    },
  })
  await act(async () => setSpeechOwner('a'))
  const client = new QueryClient()
  render(
    <QueryClientProvider client={client}>
      <SettingsPage user={{ id: 'a', login: 'a', is_admin: false, difficulty: 'medium' }} />
    </QueryClientProvider>,
  )
  const user = userEvent.setup()
  await user.selectOptions(screen.getByLabelText('Источник EN'), 'browser')
  const us = screen.getByLabelText('Голос US')
  const uk = screen.getByLabelText('Голос UK')
  expect(within(us).queryByRole('option', { name: /British/ })).not.toBeInTheDocument()
  expect(within(uk).queryByRole('option', { name: /American/ })).not.toBeInTheDocument()
  await user.selectOptions(us, 'browser-us')
  await user.selectOptions(uk, 'browser-gb')
  await user.selectOptions(screen.getByLabelText('Вариант английского'), 'en-GB')
  expect(us).toHaveValue('browser-us')
  expect(uk).toHaveValue('browser-gb')
  expect(JSON.parse(localStorage.getItem('lexicona:speech:v1:a')!)).toMatchObject({
    enLocale: 'en-GB',
    enUSVoiceURI: 'browser-us',
    enGBVoiceURI: 'browser-gb',
  })
})

it('показывает браузерный en-AU и серверный RU для старых настроек', async () => {
  localStorage.setItem(
    'lexicona:speech:v1:a',
    JSON.stringify({
      version: 1,
      enLocale: 'en-AU',
      enVoiceURI: 'au',
      ruVoiceURI: null,
      rate: 1,
      autoPrompt: true,
    }),
  )
  vi.spyOn(api, 'listSpeechVoices').mockResolvedValue({
    available: true,
    voices: [
      { id: 'us', name: 'Lessac', language: 'en-US', gender: 'female' },
      { id: 'ru', name: 'Denis', language: 'ru-RU', gender: 'male' },
    ],
  })
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: {
      getVoices: () => [
        { lang: 'en-AU', voiceURI: 'au', name: 'Australian', default: true, localService: true },
      ],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      cancel: vi.fn(),
    },
  })
  await act(async () => {
    setSpeechOwner('a')
    await Promise.resolve()
  })
  const client = new QueryClient()
  render(
    <QueryClientProvider client={client}>
      <SettingsPage user={{ id: 'a', login: 'a', is_admin: false, difficulty: 'medium' }} />
    </QueryClientProvider>,
  )
  expect(screen.getByLabelText('Вариант английского')).toHaveValue('en-AU')
  expect(screen.getByLabelText('Голос EN')).toHaveValue('au')
  expect(
    within(screen.getByLabelText('Голос EN')).getByRole('option', {
      name: 'Australian (en-AU, локальный)',
    }),
  ).toBeInTheDocument()
  expect(
    within(screen.getByLabelText('Голос RU')).getByRole('option', {
      name: 'Denis (ru-RU, мужской)',
    }),
  ).toBeInTheDocument()
  expect(
    screen.getByText('Для этого языка нет серверного голоса. Используется голос браузера.'),
  ).toBeInTheDocument()
})
