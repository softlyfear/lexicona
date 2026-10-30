import { describe, expect, it } from 'vitest'
import { normalizeTagName, tagKey } from './words'

describe('имена тегов', () => {
  it('нормализует Unicode, пробелы и полный casefold без замены ё и пунктуации', () => {
    expect(normalizeTagName('  Е\u0308\u0085дом  ')).toBe('Ё дом')
    expect(tagKey('  Работа ')).toBe(tagKey('работа'))
    expect(tagKey('Straße')).toBe(tagKey('STRASSE'))
    expect(tagKey('ΟΣ')).toBe(tagKey('ος'))
    expect(tagKey('ёлка')).not.toBe(tagKey('елка'))
    expect(tagKey('a-b')).not.toBe(tagKey('ab'))
  })
})
