import { afterEach, describe, expect, it } from 'vitest'
import {
  cancelTrainingSync,
  parseTrainingPreferences,
  speechFromAccount,
  speechToDto,
} from './accountPreferences'
import type { SpeechPreferences } from './speech'

afterEach(() => {
  cancelTrainingSync()
})

const speech: SpeechPreferences = {
  enLocale: 'en-AU',
  enVoiceURI: null,
  ruVoiceURI: 'ru',
  rate: 1,
  autoPrompt: false,
  speakEn: true,
  speakRu: false,
  engineEn: 'server',
  engineRu: 'browser',
  serverEnUS: 'en_US-lessac-high',
  serverEnGB: null,
  serverRu: null,
}

describe('настройки аккаунта', () => {
  it('принимает полную тренировку и отбрасывает direction en_en и matching вне EN→RU', () => {
    const training = {
      mode: 'input',
      direction: 'ru_en',
      purpose: 'scheduled',
      include_new: false,
      size: 25,
      tag_ids: ['b', 'a', 'a'],
      progress_min: 0,
      progress_max: 100,
      order: 'created_asc',
      shuffle: true,
    }
    expect(parseTrainingPreferences(training)?.tag_ids).toEqual(['a', 'b'])
    expect(parseTrainingPreferences(training)?.include_learned).toBe(false)
    expect(parseTrainingPreferences({ ...training, include_learned: true })?.include_learned).toBe(
      true,
    )
    expect(parseTrainingPreferences({ ...training, include_learned: 'yes' })).toBeNull()
    expect(parseTrainingPreferences({ ...training, direction: 'en_en' })).toBeNull()
    expect(parseTrainingPreferences({ ...training, mode: 'matching' })).toBeNull()
    expect(parseTrainingPreferences({ ...training, size: 0 })).toBeNull()
    expect(parseTrainingPreferences({ ...training, progress_max: 1, progress_min: 2 })).toBeNull()
  })

  it('переводит озвучивание в поля API и обратно', () => {
    const dto = speechToDto(speech)
    expect(dto.en_locale).toBe('en-AU')
    expect(dto.rate).toBe(1)
    expect(speechFromAccount(dto)).toEqual(speech)
    expect(speechFromAccount({ ...dto, en_locale: 'fr-FR' })).toBeNull()
    expect(speechFromAccount({ ...dto, en_voice_uri: '' })).toBeNull()
    expect(speechFromAccount({ ...dto, rate: 2 })).toBeNull()
  })
})
