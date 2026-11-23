import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { type OfflineRecord } from '../offlineStorage'
import { OfflinePage } from './OfflinePage'

it('offers the prepared exercises and review list separately, preserving each exercise position', async () => {
  const record: OfflineRecord = {
    ownerId: 'owner',
    key: 'key',
    nextKey: null,
    preparedAt: Date.now(),
    pack: {
      id: 'pack',
      version: 2,
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
          direction: 'en_ru',
          items: [
            { id: 'written-1', prompt: 'ink', options: [] },
            { id: 'written-2', prompt: 'paper', options: [] },
          ],
        },
        {
          id: 'choice-en',
          mode: 'choice',
          direction: 'en_ru',
          items: [{ id: 'choice-en-1', prompt: 'pen', options: ['перо', 'стол'] }],
        },
        {
          id: 'choice-ru',
          mode: 'choice',
          direction: 'ru_en',
          items: [{ id: 'choice-ru-1', prompt: 'кошка', options: ['cat', 'dog'] }],
        },
      ],
    },
    attempts: [{ itemId: 'written-1', text: 'чернила', result: 'pending' }],
    report: null,
  }
  const onSave = vi.fn().mockResolvedValue(undefined)
  render(
    <OfflinePage
      record={record}
      loading={false}
      message=""
      onLogout={vi.fn()}
      onSave={onSave}
      ownsSpeech={false}
    />,
  )
  const user = userEvent.setup()
  const section = screen.getByRole('combobox', { name: 'Офлайн-раздел' })
  expect(screen.getByRole('heading', { name: 'Перевод на русский 2 из 2' })).toBeVisible()

  await user.selectOptions(section, screen.getByRole('option', { name: 'Выбор EN → RU' }))
  await user.click(screen.getByRole('button', { name: 'перо' }))
  expect(onSave).toHaveBeenLastCalledWith('choice-en', 'choice-en-1', 0)

  await user.selectOptions(section, screen.getByRole('option', { name: 'Выбор RU → EN' }))
  expect(screen.getByRole('heading', { name: 'Перевод на английский 1 из 1' })).toBeVisible()
  expect(screen.getByRole('button', { name: 'Произнести RU «кошка»' })).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Пропустить' }))
  expect(onSave).toHaveBeenLastCalledWith('choice-ru', 'choice-ru-1', null)

  await user.selectOptions(section, screen.getByRole('option', { name: 'Слова для повторения' }))
  expect(screen.getByRole('heading', { name: 'Слова для повторения' })).toBeVisible()
  expect(screen.queryByText('word-51')).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Показать ещё' }))
  expect(screen.getByText('word-51')).toBeVisible()

  await user.selectOptions(section, screen.getByRole('option', { name: 'Письменно EN → RU' }))
  expect(screen.getByRole('heading', { name: 'Перевод на русский 2 из 2' })).toBeVisible()
  expect(screen.getByText('paper')).toBeVisible()
})
