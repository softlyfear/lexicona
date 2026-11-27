import type { EnglishAccentLocale } from './speech'

export type Phoneme = {
  id: string
  symbol: string
  /** Short word spoken by the browser or device. */
  speech: string
  /** Letters of `speech` before the target sound. */
  before: string
  /** Letters of `speech` after the target sound. */
  after: string
}

export type PhonemeGroup = {
  id: 'vowels' | 'diphthongs' | 'consonants'
  title: string
  sounds: readonly Phoneme[]
}

const consonants = [
  { id: 'p', symbol: 'p', speech: 'pen', before: '', after: 'en' },
  { id: 'b', symbol: 'b', speech: 'big', before: '', after: 'ig' },
  { id: 't', symbol: 't', speech: 'ten', before: '', after: 'en' },
  { id: 'd', symbol: 'd', speech: 'dog', before: '', after: 'og' },
  { id: 'k', symbol: 'k', speech: 'key', before: '', after: 'ey' },
  { id: 'g', symbol: 'g', speech: 'get', before: '', after: 'et' },
  { id: 'f', symbol: 'f', speech: 'fan', before: '', after: 'an' },
  { id: 'v', symbol: 'v', speech: 'van', before: '', after: 'an' },
  { id: 'voiceless-th', symbol: 'θ', speech: 'thin', before: '', after: 'in' },
  { id: 'voiced-th', symbol: 'ð', speech: 'this', before: '', after: 'is' },
  { id: 's', symbol: 's', speech: 'sun', before: '', after: 'un' },
  { id: 'z', symbol: 'z', speech: 'zoo', before: '', after: 'oo' },
  { id: 'sh', symbol: 'ʃ', speech: 'she', before: '', after: 'e' },
  { id: 'zh', symbol: 'ʒ', speech: 'beige', before: 'bei', after: '' },
  { id: 'h', symbol: 'h', speech: 'hat', before: '', after: 'at' },
  { id: 'ch', symbol: 'tʃ', speech: 'chat', before: '', after: 'at' },
  { id: 'dzh', symbol: 'dʒ', speech: 'job', before: '', after: 'ob' },
  { id: 'm', symbol: 'm', speech: 'man', before: '', after: 'an' },
  { id: 'n', symbol: 'n', speech: 'no', before: '', after: 'o' },
  { id: 'ng', symbol: 'ŋ', speech: 'sing', before: 'si', after: '' },
  { id: 'l', symbol: 'l', speech: 'let', before: '', after: 'et' },
  { id: 'r', symbol: 'r', speech: 'red', before: '', after: 'ed' },
  { id: 'yod', symbol: 'j', speech: 'yes', before: '', after: 'es' },
  { id: 'w', symbol: 'w', speech: 'we', before: '', after: 'e' },
] as const satisfies readonly Phoneme[]

export const PHONEME_GROUPS = {
  'en-GB': [
    {
      id: 'vowels',
      title: 'Гласные',
      sounds: [
        { id: 'fleece', symbol: 'iː', speech: 'see', before: 's', after: '' },
        { id: 'kit', symbol: 'ɪ', speech: 'sit', before: 's', after: 't' },
        { id: 'foot', symbol: 'ʊ', speech: 'book', before: 'b', after: 'k' },
        { id: 'goose', symbol: 'uː', speech: 'too', before: 't', after: '' },
        { id: 'dress', symbol: 'e', speech: 'bed', before: 'b', after: 'd' },
        { id: 'comma', symbol: 'ə', speech: 'sofa', before: 'sof', after: '' },
        { id: 'nurse', symbol: 'ɜː', speech: 'her', before: 'h', after: '' },
        { id: 'thought', symbol: 'ɔː', speech: 'law', before: 'l', after: '' },
        { id: 'trap', symbol: 'æ', speech: 'cat', before: 'c', after: 't' },
        { id: 'strut', symbol: 'ʌ', speech: 'cup', before: 'c', after: 'p' },
        { id: 'palm', symbol: 'ɑː', speech: 'spa', before: 'sp', after: '' },
        { id: 'lot', symbol: 'ɒ', speech: 'hot', before: 'h', after: 't' },
      ],
    },
    {
      id: 'diphthongs',
      title: 'Дифтонги',
      sounds: [
        { id: 'face', symbol: 'eɪ', speech: 'day', before: 'd', after: '' },
        { id: 'price', symbol: 'aɪ', speech: 'my', before: 'm', after: '' },
        { id: 'choice', symbol: 'ɔɪ', speech: 'boy', before: 'b', after: '' },
        { id: 'goat', symbol: 'əʊ', speech: 'go', before: 'g', after: '' },
        { id: 'mouth', symbol: 'aʊ', speech: 'now', before: 'n', after: '' },
        { id: 'near', symbol: 'ɪə', speech: 'ear', before: '', after: '' },
        { id: 'square', symbol: 'eə', speech: 'air', before: '', after: '' },
        { id: 'cure', symbol: 'ʊə', speech: 'tour', before: 't', after: '' },
      ],
    },
    { id: 'consonants', title: 'Согласные', sounds: consonants },
  ],
  'en-US': [
    {
      id: 'vowels',
      title: 'Гласные',
      sounds: [
        { id: 'fleece', symbol: 'i', speech: 'see', before: 's', after: '' },
        { id: 'kit', symbol: 'ɪ', speech: 'sit', before: 's', after: 't' },
        { id: 'foot', symbol: 'ʊ', speech: 'book', before: 'b', after: 'k' },
        { id: 'goose', symbol: 'u', speech: 'too', before: 't', after: '' },
        { id: 'dress', symbol: 'ɛ', speech: 'bed', before: 'b', after: 'd' },
        { id: 'comma', symbol: 'ə', speech: 'sofa', before: 'sof', after: '' },
        { id: 'nurse', symbol: 'ɝ', speech: 'her', before: 'h', after: '' },
        { id: 'thought', symbol: 'ɔ', speech: 'law', before: 'l', after: '' },
        { id: 'trap', symbol: 'æ', speech: 'cat', before: 'c', after: 't' },
        { id: 'strut', symbol: 'ʌ', speech: 'cup', before: 'c', after: 'p' },
        { id: 'palm', symbol: 'ɑ', speech: 'spa', before: 'sp', after: '' },
        { id: 'letter', symbol: 'ɚ', speech: 'water', before: 'wat', after: '' },
      ],
    },
    {
      id: 'diphthongs',
      title: 'Дифтонги',
      sounds: [
        { id: 'face', symbol: 'eɪ', speech: 'day', before: 'd', after: '' },
        { id: 'price', symbol: 'aɪ', speech: 'my', before: 'm', after: '' },
        { id: 'choice', symbol: 'ɔɪ', speech: 'boy', before: 'b', after: '' },
        { id: 'goat', symbol: 'oʊ', speech: 'go', before: 'g', after: '' },
        { id: 'mouth', symbol: 'aʊ', speech: 'now', before: 'n', after: '' },
      ],
    },
    { id: 'consonants', title: 'Согласные', sounds: consonants },
  ],
} as const satisfies Record<EnglishAccentLocale, readonly PhonemeGroup[]>
