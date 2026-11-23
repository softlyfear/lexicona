import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { type OfflineRecord } from '../offlineStorage'
import * as speech from '../speech'
import { OfflinePage } from './OfflinePage'

afterEach(() => vi.restoreAllMocks())

it('plays the selected choice once, keeps each exercise position, and reviews cards without saving', async () => {
  const speak = vi.spyOn(speech, 'speak').mockImplementation(() => {})
  const cancel = vi.spyOn(speech, 'cancelSpeech')
  const record: OfflineRecord = {
    ownerId: 'owner',
    key: 'key',
    nextKey: null,
    preparedAt: Date.now(),
    pack: {
      id: 'pack',
      version: 3,
      owner_id: 'owner',
      expires_at: '2027-08-02T00:00:00Z',
      requested_size: 10,
      study: Array.from({ length: 51 }, (_, index) => ({
        headword: `word-${index + 1}`,
        translations: ['слово'],
      })),
      exercises: [
        {
          id: 'written',
          mode: 'input',
          direction: 'ru_en',
          items: [
            { id: 'written-1', prompt: 'чернила', options: [] },
            { id: 'written-2', prompt: 'бумага', options: [] },
          ],
        },
        {
          id: 'choice-en',
          mode: 'choice',
          direction: 'en_ru',
          items: [
            { id: 'choice-en-1', prompt: 'pen', options: ['перо', 'стол'] },
            { id: 'choice-en-2', prompt: 'table', options: ['стол', 'перо'] },
          ],
        },
        {
          id: 'choice-ru',
          mode: 'choice',
          direction: 'ru_en',
          items: [{ id: 'choice-ru-1', prompt: 'кошка', options: ['cat', 'dog'] }],
        },
      ],
    },
    attempts: [{ itemId: 'written-1', text: 'ink', result: 'pending' }],
    report: null,
  }
  let complete!: () => void
  const onSave = vi
    .fn()
    .mockResolvedValue(undefined)
    .mockReturnValueOnce(
      new Promise<void>((resolve) => {
        complete = resolve
      }),
    )
  const page = () => (
    <OfflinePage
      record={record}
      loading={false}
      message=""
      onLogout={vi.fn()}
      onSave={onSave}
      ownsSpeech={false}
    />
  )
  const { rerender } = render(page())
  const user = userEvent.setup()
  const section = screen.getByRole('combobox', { name: 'Офлайн-раздел' })
  expect(screen.getByRole('heading', { name: 'Перевод на английский 2 из 2' })).toBeVisible()

  await user.selectOptions(section, screen.getByRole('option', { name: 'Выбор EN → RU' }))
  cancel.mockClear()
  const choice = screen.getByRole('button', { name: 'перо' })
  act(() => {
    fireEvent.click(choice)
    fireEvent.click(choice)
  })
  expect(onSave).toHaveBeenCalledExactlyOnceWith('choice-en', 'choice-en-1', 0)
  expect(speak).toHaveBeenCalledExactlyOnceWith('перо', 'ru', { offline: true })
  record.attempts.push({ itemId: 'choice-en-1', text: null, option: 0, result: 'pending' })
  rerender(page())
  await act(async () => complete())
  expect(screen.getByText('table')).toBeVisible()
  expect(cancel).not.toHaveBeenCalled()

  await user.selectOptions(section, screen.getByRole('option', { name: 'Выбор RU → EN' }))
  expect(screen.getByRole('heading', { name: 'Перевод на английский 1 из 1' })).toBeVisible()
  expect(screen.getByRole('button', { name: 'Произнести RU «кошка»' })).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'cat' }))
  expect(speak).toHaveBeenLastCalledWith('cat', 'en', { offline: true })
  await user.click(screen.getByRole('button', { name: 'Пропустить' }))
  expect(onSave).toHaveBeenLastCalledWith('choice-ru', 'choice-ru-1', null)
  expect(speak).toHaveBeenCalledTimes(2)

  await user.selectOptions(section, screen.getByRole('option', { name: 'Слова для повторения' }))
  expect(screen.getByRole('heading', { name: 'Слова для повторения' })).toBeVisible()
  expect(screen.queryByText('word-51')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Показать ещё' }))
  expect(screen.getByText('word-51')).toBeVisible()

  onSave.mockClear()
  await user.selectOptions(section, screen.getByRole('option', { name: 'Карточки' }))
  expect(screen.getByRole('heading', { name: 'Карточки' })).toBeVisible()
  expect(screen.getByRole('button', { name: 'Назад' })).toBeDisabled()
  expect(screen.getByText('word-1')).toBeVisible()
  expect(screen.queryByText('слово')).not.toBeInTheDocument()
  const reveal = screen.getByRole('button', { name: 'Показать перевод' })
  await user.click(reveal)
  expect(reveal).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByText('слово')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Дальше' }))
  expect(screen.getByText('word-2')).toBeVisible()
  expect(screen.queryByText('слово')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Назад' }))
  expect(screen.getByText('word-1')).toBeVisible()
  expect(onSave).not.toHaveBeenCalled()

  await user.selectOptions(section, screen.getByRole('option', { name: 'Письменно RU → EN' }))
  expect(screen.getByRole('heading', { name: 'Перевод на английский 2 из 2' })).toBeVisible()
  expect(screen.getByText('бумага')).toBeVisible()

  if (!record.pack) throw new Error('missing offline fixture')
  record.pack.study = []
  rerender(page())
  expect(screen.queryByRole('option', { name: 'Карточки' })).not.toBeInTheDocument()
})
