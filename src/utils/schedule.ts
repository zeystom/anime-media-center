import type { FollowedAnime } from '../types/notifications'

export interface FollowedScheduleLookup {
  idSet: Set<number>
  keySet: Set<string>
}

/** Normalize anime title for season-insensitive schedule follow matching. */
export function normalizeScheduleTitleKey(value: string): string {
  return value.toLocaleLowerCase().replace(/\b(season|s)\s*\d+\b/g, '').replace(/[^\p{L}\p{N}]+/gu, '')
}

/** Build O(1) AniList ID and normalized-title lookups for followed anime. */
export function buildFollowedScheduleLookup(followedAnime?: FollowedAnime[]): FollowedScheduleLookup | null {
  if (!followedAnime || followedAnime.length === 0) return null
  const idSet = new Set<number>()
  const keySet = new Set<string>()
  for (const item of followedAnime) {
    if (item.anilistId) idSet.add(item.anilistId)
    if (item.title) {
      const key = normalizeScheduleTitleKey(item.title)
      if (key) keySet.add(key)
    }
  }
  return { idSet, keySet }
}

/** Check whether a scheduled entry matches any user-followed anime by ID or title key. */
export function isFollowedScheduleEntry(
  lookup: FollowedScheduleLookup | null,
  anilistId?: number | null,
  ...titles: (string | null | undefined)[]
): boolean {
  if (!lookup) return false
  if (anilistId && lookup.idSet.has(anilistId)) return true
  for (const raw of titles) {
    if (!raw) continue
    const key = normalizeScheduleTitleKey(raw)
    if (key && lookup.keySet.has(key)) return true
  }
  return false
}
