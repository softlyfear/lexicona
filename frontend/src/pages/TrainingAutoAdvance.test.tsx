import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import { api, type TerminalResult, type TrainingSession } from '../api'
import { isSpeechBusy, setSpeechOwner, updateSpeechPreferences } from '../speech'
import { MatchingRun } from './MatchingRun'
import { Run } from './TrainingPage'
import { summaryFixture } from './trainingSummaryFixture'

vi.mock('../api', async (original) => {
  const actual = await original<typeof import('../api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      answerText: vi.fn(),
      answer: vi.fn(),
      revealAnswer: vi.fn(),
      skipItem: vi.fn(),
      revealCard: vi.fn(),
      answerCard: vi.fn(),
      getWord: vi.fn(),
      trainingSummary: vi.fn(),
      listSpeechVoices: vi.fn(),
      synthesizeSpeech: vi.fn(),
    },
  }
})

const session: TrainingSession = {
  id: 's',
  mode: 'input',
  direction: 'ru_en',
  purpose: 'free',
  items: ['cat', 'dog', 'fox'].map((name, i) => ({
    id: `i${i}`,
    word_id: `w${i}`,
    prompt: name,
    options: [],
  })),
}
const right: TerminalResult = {
  outcome: 'answered',
  correct: true,
  submitted_text: 'answer',
  expected_answers: ['authorized answer'],
  delta: 0,
  progress: 5,
}
async function tick(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}
function run(initialSession = session, initialEnabled = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const finish = vi.fn()
  const tree = (current = initialSession, enabled = initialEnabled, finishing = false) => (
    <StrictMode>
      <QueryClientProvider client={client}>
        <Run
          key={current.id}
          session={current}
          requestedSize={3}
          onFinish={finish}
          autoAdvance={enabled}
          finishing={finishing}
        />
      </QueryClientProvider>
    </StrictMode>
  )
  const view = render(tree())
  return {
    ...view,
    finish,
    update: (current = initialSession, enabled = initialEnabled, finishing = false) =>
      view.rerender(tree(current, enabled, finishing)),
  }
}
async function submit() {
  const input = screen.getByRole('textbox')
  fireEvent.change(input, { target: { value: 'answer' } })
  fireEvent.submit(input.closest('form')!)
  await tick()
}
function browser() {
  const utterances: SpeechSynthesisUtterance[] = []
  vi.stubGlobal(
    'SpeechSynthesisUtterance',
    class {
      text: string
      constructor(text: string) {
        this.text = text
      }
    },
  )
  vi.stubGlobal('speechSynthesis', {
    getVoices: () => [{ lang: 'en-US', voiceURI: 'en', name: 'English' }],
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    cancel: vi.fn(),
    speak: vi.fn((utterance: SpeechSynthesisUtterance) => utterances.push(utterance)),
  })
  act(() => {
    setSpeechOwner('a')
    updateSpeechPreferences({ engineEn: 'browser', autoPrompt: false })
  })
  return utterances
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  localStorage.clear()
  vi.mocked(api.listSpeechVoices).mockResolvedValue({ available: false, voices: [] })
  vi.mocked(api.answerText).mockResolvedValue(right)
  vi.mocked(api.trainingSummary).mockResolvedValue(
    summaryFixture({ answered: 1 }, { correct: 1, accuracy_percent: 100 }),
  )
  vi.mocked(api.getWord).mockResolvedValue({
    id: 'w0',
    headword: 'cat',
    translations: ['кот'],
    progress: 5,
    is_excluded: false,
    is_learned: false,
    transcription: null,
    example_en: null,
    example_ru: null,
    note: null,
    tags: [],
    created_at: '',
    updated_at: '',
  })
  act(() => {
    setSpeechOwner('a')
    updateSpeechPreferences({ engineEn: 'browser', engineRu: 'browser', autoPrompt: false })
  })
})
afterEach(() => {
  act(() => setSpeechOwner(null))
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('defaults off and never arms from a correct result received while disabled', async () => {
  const view = run(session, false)
  await submit()
  await tick(5000)
  expect(screen.getByText('1 / 3')).toBeInTheDocument()
  view.update(session, true)
  await tick(5000)
  expect(screen.getByText('1 / 3')).toBeInTheDocument()
})

it('waits 1.5s after fresh correct retry with delta zero, advances once without answering the next item', async () => {
  vi.mocked(api.answerText)
    .mockResolvedValueOnce({ ...right, correct: false } as TerminalResult)
    .mockResolvedValueOnce(right)
  run()
  await submit()
  await tick(3000)
  expect(screen.getByText('1 / 3')).toBeInTheDocument()
  await submit()
  expect(screen.getByRole('status')).toHaveTextContent('Верно (0)')
  await tick(1499)
  expect(screen.getByText('1 / 3')).toBeInTheDocument()
  await tick(1)
  expect(screen.getByText('2 / 3')).toBeInTheDocument()
  await tick(5000)
  expect(screen.getByText('2 / 3')).toBeInTheDocument()
  expect(api.answerText).toHaveBeenCalledTimes(2)
})

it.each(['assisted', 'skipped', 'unavailable'] as const)(
  'never auto-advances after %s',
  async (outcome) => {
    const result: TerminalResult =
      outcome === 'assisted'
        ? { outcome, expected_answers: ['answer'], delta: 0, progress: 5 }
        : outcome === 'unavailable'
          ? { outcome, reason: 'word_deleted', delta: 0, progress: null }
          : { outcome, delta: 0, progress: 5 }
    vi.mocked(api.revealAnswer).mockResolvedValue(result)
    run()
    fireEvent.click(screen.getByRole('button', { name: 'Показать ответ' }))
    await tick()
    await tick(5000)
    expect(screen.getByText('1 / 3')).toBeInTheDocument()
  },
)

it('does not auto-advance card self-assessment', async () => {
  vi.mocked(api.revealCard).mockResolvedValue({ outcome: 'revealed', expected_answers: ['answer'] })
  vi.mocked(api.answerCard).mockResolvedValue({
    outcome: 'answered',
    grade: 'good',
    expected_answers: ['answer'],
    delta: 4,
    progress: 5,
  })
  run({ ...session, mode: 'cards' })
  fireEvent.click(screen.getByRole('button', { name: 'Показать ответ' }))
  await tick()
  fireEvent.click(screen.getByRole('button', { name: 'Хорошо' }))
  await tick()
  await tick(5000)
  expect(screen.getByText('1 / 3')).toBeInTheDocument()
})

it.each(['manual-first', 'timer-first'] as const)(
  'manual/Enter/timer race advances only one item: %s',
  async (order) => {
    run()
    await submit()
    const next = screen.getByRole('button', { name: 'Далее' })
    act(() => {
      if (order === 'timer-first') vi.advanceTimersByTime(1500)
      fireEvent.click(next)
      fireEvent.click(next)
      fireEvent.keyDown(window, { key: 'Enter' })
      if (order === 'manual-first') vi.advanceTimersByTime(1500)
    })
    await tick()
    expect(screen.getByText('2 / 3')).toBeInTheDocument()
    expect(api.answerText).toHaveBeenCalledOnce()
  },
)

it('last item opens existing authoritative summary once', async () => {
  run({ ...session, items: session.items.slice(0, 1) })
  await submit()
  await tick(1500)
  await tick()
  expect(screen.getByRole('heading', { name: 'Готово' })).toBeInTheDocument()
  await tick(5000)
  expect(api.trainingSummary).toHaveBeenCalledExactlyOnceWith('s')
})

it('choice Enter at the timer deadline cannot skip an extra item', async () => {
  vi.mocked(api.answer).mockResolvedValue({
    outcome: 'answered',
    correct: true,
    chosen_option: 0,
    correct_option: 0,
    delta: 4,
    progress: 5,
  })
  run({
    ...session,
    mode: 'choice',
    items: session.items.map((item) => ({ ...item, options: ['right', 'wrong'] })),
  })
  fireEvent.keyDown(window, { key: '1' })
  await tick()
  act(() => {
    vi.advanceTimersByTime(1500)
    fireEvent.keyDown(window, { key: 'Enter' })
    fireEvent.keyDown(window, { key: 'Enter' })
  })
  await tick()
  expect(screen.getByText('2 / 3')).toBeInTheDocument()
  expect(api.answer).toHaveBeenCalledOnce()
})

it.each(['editor', 'finish', 'finishing', 'disable', 'session', 'unmount'] as const)(
  'cancels pending auto-next permanently on %s',
  async (reason) => {
    const view = run()
    await submit()
    await tick(1000)
    if (reason === 'editor') {
      fireEvent.click(screen.getByRole('button', { name: 'Редактировать слово «cat»' }))
      await tick()
      fireEvent.click(screen.getByRole('button', { name: 'Отмена' }))
    }
    if (reason === 'finish') fireEvent.click(screen.getByRole('button', { name: 'Завершить' }))
    if (reason === 'finishing') {
      view.update(session, true, true)
      view.update(session, true, false)
    }
    if (reason === 'disable') {
      view.update(session, false)
      view.update(session, true)
    }
    if (reason === 'session') view.update({ ...session, id: 'other' })
    if (reason === 'unmount') view.unmount()
    await tick(5000)
    if (reason !== 'unmount') expect(screen.getByText('1 / 3')).toBeInTheDocument()
    expect(api.trainingSummary).not.toHaveBeenCalled()
    expect(api.answerText).toHaveBeenCalledOnce()
    expect(view.finish).toHaveBeenCalledTimes(reason === 'finish' ? 1 : 0)
  },
)

it.each(['end', 'error', 'watchdog'] as const)(
  'waits for long manually replayed speech and then advances on %s',
  async (ending) => {
    const utterances = browser()
    run()
    await submit()
    expect(utterances).toHaveLength(0)
    await tick(1000)
    fireEvent.click(within(screen.getByRole('group', { name: 'Ответ' })).getByRole('button'))
    expect(isSpeechBusy()).toBe(true)
    await tick(4000)
    expect(screen.getByText('1 / 3')).toBeInTheDocument()
    if (ending === 'watchdog') await tick(20000)
    else
      act(() => {
        if (ending === 'end') utterances[0].onend?.({} as SpeechSynthesisEvent)
        else utterances[0].onerror?.({} as SpeechSynthesisErrorEvent)
      })
    await tick()
    expect(isSpeechBusy()).toBe(false)
    expect(screen.getByText('2 / 3')).toBeInTheDocument()
    expect(api.answerText).toHaveBeenCalledOnce()
  },
)

it('waits for a second manual replay and ignores the first utterance late completion', async () => {
  const utterances = browser()
  run()
  await submit()
  const playback = within(screen.getByRole('group', { name: 'Ответ' })).getByRole('button')
  fireEvent.click(playback)
  await tick(500)
  act(() => utterances[0].onend?.({} as SpeechSynthesisEvent))
  await tick(500)
  fireEvent.click(playback)
  await tick(600)
  act(() => utterances[0].onend?.({} as SpeechSynthesisEvent))
  expect(isSpeechBusy()).toBe(true)
  expect(screen.getByText('1 / 3')).toBeInTheDocument()
  act(() => utterances[1].onend?.({} as SpeechSynthesisEvent))
  await tick()
  expect(screen.getByText('2 / 3')).toBeInTheDocument()
})

it.each(['autoplay', 'watchdog'] as const)(
  'waits for server synthesis without a short fallback, then proceeds on %s',
  async (ending) => {
    vi.mocked(api.listSpeechVoices).mockResolvedValue({
      available: true,
      voices: [{ id: 'voice', language: 'en-US', name: 'Voice', gender: 'female' }],
    })
    let resolve!: (blob: Blob) => void
    vi.mocked(api.synthesizeSpeech).mockReturnValue(
      new Promise((done) => {
        resolve = done
      }),
    )
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn().mockReturnValue('blob:test'),
        revokeObjectURL: vi.fn(),
      }),
    )
    vi.stubGlobal(
      'Audio',
      class {
        pause = vi.fn()
        removeAttribute = vi.fn()
        play = vi.fn().mockRejectedValue(new DOMException('gesture required', 'NotAllowedError'))
      },
    )
    act(() => {
      setSpeechOwner('a')
      updateSpeechPreferences({ engineEn: 'server', autoPrompt: false })
    })
    await tick()
    run()
    await submit()
    fireEvent.click(within(screen.getByRole('group', { name: 'Ответ' })).getByRole('button'))
    await tick(5000)
    expect(isSpeechBusy()).toBe(true)
    expect(screen.getByText('1 / 3')).toBeInTheDocument()
    if (ending === 'autoplay') {
      await act(async () => resolve(new Blob(['wav'])))
      await tick()
    } else {
      await tick(85000)
      expect(vi.mocked(api.synthesizeSpeech).mock.calls[0][3].aborted).toBe(true)
    }
    expect(isSpeechBusy()).toBe(false)
    expect(screen.getByText('2 / 3')).toBeInTheDocument()
    expect(api.answerText).toHaveBeenCalledOnce()
  },
)

it.each(['correct', 'assisted', 'skipped', 'unavailable'] as const)(
  'matching waits for every pair and only auto-advances an all-correct group (ending=%s)',
  async (ending) => {
    const assisted = ending !== 'correct'
    const matching: TrainingSession = {
      ...session,
      mode: 'matching',
      direction: 'en_ru',
      items: ['cat', 'dog', 'fox', 'owl'].map((prompt, index) => ({
        id: `i${index}`,
        prompt,
        options: index < 2 ? ['кот', 'пёс'] : ['лиса', 'сова'],
      })),
    }
    vi.mocked(api.answer).mockResolvedValue({
      outcome: 'answered',
      correct: true,
      chosen_option: 0,
      correct_option: 0,
      delta: 0,
      progress: 5,
    })
    vi.mocked(api.revealAnswer).mockResolvedValue({
      outcome: 'assisted',
      expected_answers: ['пёс'],
      correct_option: 1,
      delta: 0,
      progress: 5,
    })
    vi.mocked(api.skipItem).mockResolvedValue(
      ending === 'unavailable'
        ? { outcome: 'unavailable', reason: 'word_deleted', delta: 0, progress: null }
        : { outcome: 'skipped', delta: 0, progress: 5 },
    )
    const client = new QueryClient()
    render(
      <QueryClientProvider client={client}>
        <MatchingRun session={matching} requestedSize={4} onFinish={vi.fn()} autoAdvance />
      </QueryClientProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'cat' }))
    fireEvent.click(screen.getByRole('button', { name: 'кот' }))
    await tick()
    await tick(5000)
    expect(screen.getByText('Группа 1 / 2')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'dog' }))
    if (ending === 'assisted')
      fireEvent.click(screen.getByRole('button', { name: 'Показать ответ' }))
    else if (assisted) fireEvent.click(screen.getByRole('button', { name: 'Пропустить' }))
    else {
      vi.mocked(api.answer).mockResolvedValueOnce({
        outcome: 'answered',
        correct: false,
        chosen_option: 1,
        correct_option: 1,
        delta: -4,
        progress: 0,
      })
      fireEvent.click(screen.getByRole('button', { name: 'пёс' }))
      await tick()
      await tick(2000)
      expect(screen.getByText('Группа 1 / 2')).toBeInTheDocument()
      vi.mocked(api.answer).mockResolvedValueOnce({
        outcome: 'answered',
        correct: true,
        chosen_option: 1,
        correct_option: 1,
        delta: 0,
        progress: 0,
      })
      fireEvent.click(screen.getByRole('button', { name: 'пёс' }))
    }
    await tick()
    await tick(1499)
    expect(screen.getByText('Группа 1 / 2')).toBeInTheDocument()
    await tick(1)
    expect(screen.getByText(assisted ? 'Группа 1 / 2' : 'Группа 2 / 2')).toBeInTheDocument()
    if (assisted) {
      await tick(5000)
      expect(screen.getByText('Группа 1 / 2')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Следующая группа' }))
      expect(screen.getByText('Группа 2 / 2')).toBeInTheDocument()
    }
  },
)
