import type { ResumedItem, RetryableResult, TerminalResult } from '../api'

export function resumedResult(item: ResumedItem): TerminalResult | undefined {
  if (!item.result || item.result.outcome === 'revealed') return undefined
  if (item.result.outcome !== 'retryable') return item.result
  const result: RetryableResult = item.result
  if (result.submitted_text !== undefined)
    return {
      ...result,
      outcome: 'answered',
      submitted_text: result.submitted_text,
      expected_answers: [],
    }
  return {
    ...result,
    outcome: 'answered',
    chosen_option: result.chosen_option ?? -1,
    correct_option: -1,
  }
}
