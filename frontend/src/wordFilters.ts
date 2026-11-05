import type { WordSort, WordTrainingFilter } from './api'

const SORTS = new Set<WordSort>([
  'created_desc',
  'created_asc',
  'headword_asc',
  'headword_desc',
  'progress_asc',
  'progress_desc',
])
const TRAININGS = new Set<WordTrainingFilter>(['active', 'excluded', 'learned', 'all'])

export type WordListFilters = {
  sort: WordSort
  training: WordTrainingFilter
  tagIds: string[]
}

function storageKey(userId: string) {
  return `lexicona:words:v1:${userId}`
}

function isTagId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
}

export function readWordFilters(userId: string): WordListFilters | null {
  try {
    const raw = localStorage.getItem(storageKey(userId))
    if (!raw) return null
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return null
    const record = value as Record<string, unknown>
    if (
      record.version !== 1 ||
      typeof record.sort !== 'string' ||
      !SORTS.has(record.sort as WordSort) ||
      typeof record.training !== 'string' ||
      !TRAININGS.has(record.training as WordTrainingFilter) ||
      !Array.isArray(record.tagIds) ||
      record.tagIds.length > 20 ||
      record.tagIds.some((id) => !isTagId(id))
    )
      return null
    return {
      sort: record.sort as WordSort,
      training: record.training as WordTrainingFilter,
      tagIds: [...new Set(record.tagIds)].sort(),
    }
  } catch {
    return null
  }
}

// Search text is word content and stays in the address only.
export function writeWordFilters(userId: string, filters: WordListFilters) {
  try {
    localStorage.setItem(
      storageKey(userId),
      JSON.stringify({
        version: 1,
        sort: filters.sort,
        training: filters.training,
        tagIds: [...new Set(filters.tagIds)].sort(),
      }),
    )
  } catch {
    // The address bar still shows the current filters.
  }
}
