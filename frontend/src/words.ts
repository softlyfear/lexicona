/** One translation per line; blank lines and repeats are dropped. */
export function parseTranslations(text: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const line of text.split('\n')) {
    const value = line.trim()
    const key = value.toLocaleLowerCase('ru').replaceAll('ё', 'е')
    if (value && !seen.has(key)) {
      seen.add(key)
      result.push(value)
    }
  }
  return result
}
