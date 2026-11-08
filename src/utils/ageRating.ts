export const AGE_RATING_CODES = ['G', 'PG', 'PG-13', 'R-17+', 'R+', 'Rx'] as const
export type AgeRatingCode = typeof AGE_RATING_CODES[number]

export function normalizeAgeRating(value: string | null | undefined): AgeRatingCode | 'NR' {
  if (!value) return 'NR'
  const normalized = value.trim().toUpperCase()
  if (/^R\s*-\s*17\+/.test(normalized)) return 'R-17+'
  if (/^PG\s*-\s*13/.test(normalized)) return 'PG-13'
  for (const code of ['RX', 'R+', 'PG', 'G'] as const) {
    if (normalized === code || normalized.startsWith(`${code} -`)) return code === 'RX' ? 'Rx' : code
  }
  return 'NR'
}
