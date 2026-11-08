import { useEffect, useMemo, useState } from 'react'
import ageRatingsByMalId from '../data/age-ratings.json'
import { AGE_RATING_CODES } from '../utils/ageRating'

const ageRatingIndex = ageRatingsByMalId as Record<string, number>
let sharedUpdatedIndex: Record<string, number> | null = null
let sharedLoad: Promise<void> | null = null
let unsubscribeFromUpdates: (() => void) | null = null
const indexSubscribers = new Set<(index: Record<string, number>) => void>()

function publishUpdatedIndex(index: Record<string, number>): void {
  if (!index || Object.keys(index).length === 0) return
  sharedUpdatedIndex = index
  for (const subscriber of indexSubscribers) subscriber(index)
}

function ensureAgeRatingIndexLoaded(): void {
  const api = window.electronAPI
  if (!api?.getUpdatedAgeRatings || !api?.onAgeRatingsUpdated) return
  if (!unsubscribeFromUpdates) {
    unsubscribeFromUpdates = api.onAgeRatingsUpdated(publishUpdatedIndex)
  }
  if (sharedUpdatedIndex || sharedLoad) return
  sharedLoad = api.getUpdatedAgeRatings()
    .then(publishUpdatedIndex)
    .catch(() => {})
    .finally(() => { sharedLoad = null })
}

/** Uses the bundled offline index immediately, then adopts the refreshed local copy if available. */
export function useAgeRatings(items: ReadonlyArray<{ idMal?: number | null }>) {
  const [updatedIndex, setUpdatedIndex] = useState<Record<string, number> | null>(null)

  useEffect(() => {
    const subscriber = (index: Record<string, number>) => setUpdatedIndex(index)
    indexSubscribers.add(subscriber)
    if (sharedUpdatedIndex) setUpdatedIndex(sharedUpdatedIndex)
    ensureAgeRatingIndexLoaded()
    return () => { indexSubscribers.delete(subscriber) }
  }, [])

  const ratings = useMemo(() => {
    const result: Record<number, string | null> = {}
    const index = updatedIndex || ageRatingIndex
    for (const item of items) {
      const id = item.idMal
      if (id == null || id <= 0 || Object.prototype.hasOwnProperty.call(result, id)) continue
      const code = index[String(id)]
      result[id] = code == null ? null : AGE_RATING_CODES[code] ?? null
    }
    return result
  }, [items, updatedIndex])

  return { ratings, loadingIds: [] as number[] }
}
