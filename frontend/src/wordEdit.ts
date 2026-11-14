import type { Word } from './api'
import { normalizedAnswer } from './words'

export function wordEditOutcome(
  session: { mode: string; direction: string },
  before: Word,
  saved: Word,
): { note: string; transcription: string | null | undefined } {
  const sameHeadword = normalizedAnswer(before.headword) === normalizedAnswer(saved.headword)
  const sameTranslations =
    before.translations.map(normalizedAnswer).sort().join('\0') ===
    saved.translations.map(normalizedAnswer).sort().join('\0')
  // IPA belongs to the English prompt. A new headword still shows the old question.
  const showTranscription =
    sameHeadword && session.mode !== 'cloze' && session.direction !== 'ru_en'
  return {
    note:
      sameHeadword && sameTranslations
        ? 'Правка сохранена в словаре.'
        : 'Правка сохранена в словаре. Это задание остаётся с прежним вопросом.',
    transcription: showTranscription ? saved.transcription?.trim() || null : undefined,
  }
}
