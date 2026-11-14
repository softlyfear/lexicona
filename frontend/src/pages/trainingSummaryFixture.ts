import type { TrainingSummary } from '../api'

export function summaryFixture(
  completion: Partial<TrainingSummary['completion']> = {},
  firstAttempt: Partial<TrainingSummary['first_attempt']> = {},
): TrainingSummary {
  const counts = { answered: 0, assisted: 0, skipped: 0, unavailable: 0, pending: 0, ...completion }
  return {
    id: 's',
    total: Object.values(counts).reduce((sum, count) => sum + count, 0),
    completion: counts,
    first_attempt: {
      correct: 0,
      incorrect: 0,
      unknown: 0,
      not_attempted: 0,
      not_applicable: 0,
      accuracy_percent: null,
      ...firstAttempt,
    },
  }
}
