import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '../api'
import { PHONEME_GROUPS, type PhonemeGroup } from '../phonemes'
import { isSpeechBusy, setSpeechOwner, updateSpeechPreferences } from '../speech'
import { SoundsPage } from './SoundsPage'

class FakeUtterance {
  static instances: FakeUtterance[] = []
  text: string
  voice: SpeechSynthesisVoice | null = null
  lang = ''
  rate = 1
  volume = 1
  pitch = 1
  onstart: ((event: SpeechSynthesisEvent) => void) | null = null
  onend: ((event: SpeechSynthesisEvent) => void) | null = null
  onerror: ((event: SpeechSynthesisEvent) => void) | null = null

  constructor(text: string) {
    this.text = text
    FakeUtterance.instances.push(this)
  }
}

const voices = [
  { lang: 'en-GB', voiceURI: 'gb', name: 'British', localService: true, default: false },
  { lang: 'en-US', voiceURI: 'us', name: 'American', localService: true, default: true },
]

function installSpeech() {
  const browser = {
    getVoices: () => voices,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    cancel: vi.fn(),
    speak: vi.fn(),
  }
  vi.stubGlobal('speechSynthesis', browser)
  vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance)
  return browser
}

function expectGroupCounts(vowels: number, diphthongs: number, consonants: number) {
  for (const [name, count] of [
    ['Гласные', vowels],
    ['Дифтонги', diphthongs],
    ['Согласные', consonants],
  ] as const) {
    const group = screen.getByRole('region', { name })
    expect(within(group).getAllByRole('button', { name: /^Прослушать / })).toHaveLength(count)
  }
}

beforeEach(() => {
  FakeUtterance.instances = []
  localStorage.clear()
  installSpeech()
  vi.spyOn(api, 'listSpeechVoices')
  vi.spyOn(api, 'synthesizeSpeech')
  act(() => {
    setSpeechOwner('a')
    updateSpeechPreferences({ enLocale: 'en-GB', engineEn: 'server' })
  })
})

afterEach(() => {
  cleanup()
  act(() => setSpeechOwner(null))
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('показывает британские группы 12 + 8 + 24 и только IPA в карточках без иконок', () => {
  render(<SoundsPage />)

  expect(screen.getByRole('heading', { name: 'Звуки' })).toBeInTheDocument()
  expect(screen.getByText('Слышно в слове')).toBeInTheDocument()
  expect(screen.getByRole('radio', { name: 'Британский' })).toBeChecked()
  expectGroupCounts(12, 8, 24)
  expect(screen.getByText('iː')).toBeInTheDocument()
  expect(screen.getByText('əʊ')).toBeInTheDocument()
  expect(screen.getByText('ɒ')).toBeInTheDocument()
  expect(screen.queryByText(/see|sheep|green|book|chair/)).not.toBeInTheDocument()
  expect(document.querySelector('details')).not.toBeInTheDocument()

  for (const button of screen.getAllByRole('button', { name: /^Прослушать / })) {
    const card = button.closest('li')!
    expect(card.children).toHaveLength(1)
    expect(card.firstElementChild).toBe(button)
    expect(button.children).toHaveLength(1)
    expect(button).toHaveTextContent(/^[^\s/]+$/)
    expect(button.querySelector('span')).toHaveTextContent(/^[^\s/]+$/)
    expect(button.querySelector('svg')).not.toBeInTheDocument()
    expect(button).not.toHaveAttribute('aria-pressed')
  }
})

it.each(['en-GB', 'en-US'] as const)('даёт каждому звуку короткое слово %s', (locale) => {
  const groups: readonly PhonemeGroup[] = PHONEME_GROUPS[locale]
  const sounds = groups.flatMap((group) => group.sounds)
  expect(sounds).toHaveLength(locale === 'en-GB' ? 44 : 41)
  expect(new Set(sounds.map((sound) => sound.id)).size).toBe(sounds.length)
  for (const sound of sounds) {
    expect(sound.speech).toMatch(/^[a-z]{2,6}$/)
    expect(sound.speech).not.toMatch(/^(ee|ih|uu|oo|eh|uh|aw|ae|ah|th|dh|sh|zh|ch|ng)$/)
  }
})

it('переключается на американский набор 12 + 5 + 24 и останавливает прежнюю речь', async () => {
  const user = userEvent.setup()
  render(<SoundsPage />)
  await user.click(screen.getByRole('button', { name: 'Прослушать /iː/, британский акцент' }))
  const first = FakeUtterance.instances[0]
  expect(first.text).toBe('see')
  expect(first.voice).toMatchObject({ voiceURI: 'gb' })
  expect(
    screen.getByRole('button', { name: 'Прослушать /iː/, британский акцент' }),
  ).toHaveAttribute('data-playing', 'true')
  expect(api.synthesizeSpeech).not.toHaveBeenCalled()
  expect(api.listSpeechVoices).not.toHaveBeenCalled()

  await user.click(screen.getByRole('radio', { name: 'Американский' }))

  expect(screen.getByRole('radio', { name: 'Американский' })).toBeChecked()
  expectGroupCounts(12, 5, 24)
  expect(screen.getByText('i')).toBeInTheDocument()
  expect(screen.getByText('oʊ')).toBeInTheDocument()
  expect(screen.getByText('ɝ')).toBeInTheDocument()
  expect(screen.queryByText('iː')).not.toBeInTheDocument()
  expect(document.querySelector('[data-playing]')).not.toBeInTheDocument()
  expect(isSpeechBusy()).toBe(false)

  await user.click(screen.getByRole('button', { name: 'Прослушать /i/, американский акцент' }))
  expect(FakeUtterance.instances[1]).toMatchObject({ text: 'see', voice: { voiceURI: 'gb' } })
  expect(api.synthesizeSpeech).not.toHaveBeenCalled()
})

it('читает слово сохранённым в настройках голосом акцента, а не первым голосом устройства', async () => {
  const user = userEvent.setup()
  const browser = {
    getVoices: () => [
      {
        lang: 'en-GB',
        voiceURI: 'gb-other',
        name: 'Other British',
        localService: true,
        default: true,
      },
      { lang: 'en-GB', voiceURI: 'gb', name: 'British', localService: true, default: false },
      {
        lang: 'en-US',
        voiceURI: 'us-other',
        name: 'Other American',
        localService: true,
        default: false,
      },
      { lang: 'en-US', voiceURI: 'us', name: 'American', localService: true, default: false },
    ],
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    cancel: vi.fn(),
    speak: vi.fn(),
  }
  vi.stubGlobal('speechSynthesis', browser)
  act(() =>
    updateSpeechPreferences({
      enLocale: 'en-US',
      enUSVoiceURI: 'us',
      enGBVoiceURI: 'gb',
    }),
  )
  render(<SoundsPage />)

  await user.click(screen.getByRole('button', { name: 'Прослушать /i/, американский акцент' }))
  expect(FakeUtterance.instances[0]).toMatchObject({ text: 'see', voice: { voiceURI: 'us' } })

  await user.click(screen.getByRole('radio', { name: 'Британский' }))
  await user.click(screen.getByRole('button', { name: 'Прослушать /iː/, британский акцент' }))
  expect(FakeUtterance.instances[1]).toMatchObject({ text: 'see', voice: { voiceURI: 'gb' } })
  expect(api.synthesizeSpeech).not.toHaveBeenCalled()
})

it('запускает речь символом и всей карточкой и поддерживает клавиатуру', async () => {
  const user = userEvent.setup()
  const browser = installSpeech()
  render(<SoundsPage />)
  const playback = screen.getByRole('button', {
    name: 'Прослушать /iː/, британский акцент',
  })
  const symbol = screen.getByText('iː')

  expect(playback.tagName).toBe('BUTTON')
  expect(playback).not.toHaveAttribute('data-playing')
  await user.click(symbol)
  expect(FakeUtterance.instances).toHaveLength(1)
  expect(browser.speak).toHaveBeenCalledTimes(1)
  expect(playback).toHaveAttribute('data-playing', 'true')

  await user.click(playback)
  expect(FakeUtterance.instances).toHaveLength(2)
  expect(browser.cancel).toHaveBeenCalled()
  expect(playback).toHaveAttribute('data-playing', 'true')

  playback.focus()
  await user.keyboard('{Enter}')
  expect(FakeUtterance.instances).toHaveLength(3)
  await user.keyboard(' ')
  expect(FakeUtterance.instances).toHaveLength(4)
  expect(playback).toHaveAttribute('data-playing', 'true')
  expect(api.synthesizeSpeech).not.toHaveBeenCalled()
})

it('снимает выделение после завершения речи браузера', async () => {
  const user = userEvent.setup()
  render(<SoundsPage />)
  const playback = screen.getByRole('button', {
    name: 'Прослушать /iː/, британский акцент',
  })
  await user.click(playback)
  expect(playback).toHaveAttribute('data-playing', 'true')

  act(() => FakeUtterance.instances[0].onend?.({} as SpeechSynthesisEvent))

  expect(playback).not.toHaveAttribute('data-playing')
  expect(isSpeechBusy()).toBe(false)
})

it('снимает выделение, если браузер не смог произнести слово', async () => {
  const user = userEvent.setup()
  render(<SoundsPage />)
  const playback = screen.getByRole('button', {
    name: 'Прослушать /iː/, британский акцент',
  })
  await user.click(playback)
  expect(playback).toHaveAttribute('data-playing', 'true')

  act(() => FakeUtterance.instances[0].onerror?.({} as SpeechSynthesisEvent))

  expect(playback).not.toHaveAttribute('data-playing')
  expect(isSpeechBusy()).toBe(false)
  expect(api.synthesizeSpeech).not.toHaveBeenCalled()
})

it('следует акценту настроек, пока пользователь не выбрал его на странице', async () => {
  render(<SoundsPage />)
  expect(screen.getByRole('radio', { name: 'Британский' })).toBeChecked()

  act(() => updateSpeechPreferences({ enLocale: 'en-US' }))

  expect(screen.getByRole('radio', { name: 'Американский' })).toBeChecked()
  expect(screen.queryByText('iː')).not.toBeInTheDocument()
})
