import type { EnglishAccentLocale } from './speech'

export type Phoneme = {
  id: string
  symbol: string
  /** Short word that contains the sound. Spoken, not shown. */
  speech: string
}

export type PhonemeGroup = {
  id: 'vowels' | 'diphthongs' | 'consonants'
  title: string
  sounds: readonly Phoneme[]
}

const consonants = [
  { id: 'p', symbol: 'p', speech: 'pen' },
  { id: 'b', symbol: 'b', speech: 'bed' },
  { id: 't', symbol: 't', speech: 'ten' },
  { id: 'd', symbol: 'd', speech: 'dog' },
  { id: 'k', symbol: 'k', speech: 'cat' },
  { id: 'g', symbol: 'g', speech: 'go' },
  { id: 'f', symbol: 'f', speech: 'fan' },
  { id: 'v', symbol: 'v', speech: 'van' },
  { id: 'voiceless-th', symbol: 'θ', speech: 'thin' },
  { id: 'voiced-th', symbol: 'ð', speech: 'this' },
  { id: 's', symbol: 's', speech: 'sun' },
  { id: 'z', symbol: 'z', speech: 'zoo' },
  { id: 'sh', symbol: 'ʃ', speech: 'she' },
  { id: 'zh', symbol: 'ʒ', speech: 'beige' },
  { id: 'h', symbol: 'h', speech: 'hat' },
  { id: 'ch', symbol: 'tʃ', speech: 'chat' },
  { id: 'dzh', symbol: 'dʒ', speech: 'job' },
  { id: 'm', symbol: 'm', speech: 'man' },
  { id: 'n', symbol: 'n', speech: 'no' },
  { id: 'ng', symbol: 'ŋ', speech: 'sing' },
  { id: 'l', symbol: 'l', speech: 'let' },
  { id: 'r', symbol: 'r', speech: 'red' },
  { id: 'yod', symbol: 'j', speech: 'yes' },
  { id: 'w', symbol: 'w', speech: 'we' },
] as const satisfies readonly Phoneme[]

export const PHONEME_GROUPS = {
  'en-GB': [
    {
      id: 'vowels',
      title: 'Гласные',
      sounds: [
        { id: 'fleece', symbol: 'iː', speech: 'see' },
        { id: 'kit', symbol: 'ɪ', speech: 'sit' },
        { id: 'foot', symbol: 'ʊ', speech: 'book' },
        { id: 'goose', symbol: 'uː', speech: 'too' },
        { id: 'dress', symbol: 'e', speech: 'bed' },
        { id: 'comma', symbol: 'ə', speech: 'sofa' },
        { id: 'nurse', symbol: 'ɜː', speech: 'her' },
        { id: 'thought', symbol: 'ɔː', speech: 'law' },
        { id: 'trap', symbol: 'æ', speech: 'cat' },
        { id: 'strut', symbol: 'ʌ', speech: 'cup' },
        { id: 'palm', symbol: 'ɑː', speech: 'spa' },
        { id: 'lot', symbol: 'ɒ', speech: 'hot' },
      ],
    },
    {
      id: 'diphthongs',
      title: 'Дифтонги',
      sounds: [
        { id: 'face', symbol: 'eɪ', speech: 'day' },
        { id: 'price', symbol: 'aɪ', speech: 'my' },
        { id: 'choice', symbol: 'ɔɪ', speech: 'boy' },
        { id: 'goat', symbol: 'əʊ', speech: 'go' },
        { id: 'mouth', symbol: 'aʊ', speech: 'now' },
        { id: 'near', symbol: 'ɪə', speech: 'ear' },
        { id: 'square', symbol: 'eə', speech: 'air' },
        { id: 'cure', symbol: 'ʊə', speech: 'tour' },
      ],
    },
    { id: 'consonants', title: 'Согласные', sounds: consonants },
  ],
  'en-US': [
    {
      id: 'vowels',
      title: 'Гласные',
      sounds: [
        { id: 'fleece', symbol: 'i', speech: 'see' },
        { id: 'kit', symbol: 'ɪ', speech: 'sit' },
        { id: 'foot', symbol: 'ʊ', speech: 'book' },
        { id: 'goose', symbol: 'u', speech: 'too' },
        { id: 'dress', symbol: 'ɛ', speech: 'bed' },
        { id: 'comma', symbol: 'ə', speech: 'sofa' },
        { id: 'nurse', symbol: 'ɝ', speech: 'her' },
        { id: 'thought', symbol: 'ɔ', speech: 'law' },
        { id: 'trap', symbol: 'æ', speech: 'cat' },
        { id: 'strut', symbol: 'ʌ', speech: 'cup' },
        { id: 'palm', symbol: 'ɑ', speech: 'spa' },
        { id: 'letter', symbol: 'ɚ', speech: 'water' },
      ],
    },
    {
      id: 'diphthongs',
      title: 'Дифтонги',
      sounds: [
        { id: 'face', symbol: 'eɪ', speech: 'day' },
        { id: 'price', symbol: 'aɪ', speech: 'my' },
        { id: 'choice', symbol: 'ɔɪ', speech: 'boy' },
        { id: 'goat', symbol: 'oʊ', speech: 'go' },
        { id: 'mouth', symbol: 'aʊ', speech: 'now' },
      ],
    },
    { id: 'consonants', title: 'Согласные', sounds: consonants },
  ],
} as const satisfies Record<EnglishAccentLocale, readonly PhonemeGroup[]>
