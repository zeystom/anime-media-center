import { useCallback, useEffect, useState } from 'react'
import type { AiringEntry, CatalogItem, GenrePickRail } from '../types'

/**
 * Normalized rail/card item shared by catalog rails, the airing schedule and
 * catalog search. Optional fields degrade gracefully so cards can render
 * partial data without special cases.
 */
export interface RailItem {
  anilistId: number
  idMal?: number | null
  title: string
  posterUrl: string | null
  bannerUrl?: string | null
  averageScore?: number | null
  episodesCount?: number | null
  format?: string
  status?: string
  isAdult?: boolean
  genres?: string[]
  seasonYear?: number | null
  airingAt?: number | null
  airingEpisode?: number | null
}

export type CatalogSection = 'trending' | 'season' | 'allTime' | 'airingToday' | 'recommended'

interface CatalogSectionState {
  items: RailItem[]
  loading: boolean
  error: string | null
  refresh: () => void
}

interface AiringScheduleState {
  entries: AiringEntry[]
  loading: boolean
  error: string | null
  refresh: () => void
}

interface CatalogSearchState {
  results: RailItem[]
  loading: boolean
}

interface GenrePicksState {
  rails: { genre: string; items: RailItem[] }[]
  loading: boolean
  error: string | null
}

const DEFAULT_SEARCH_DEBOUNCE_MS = 300

function toErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  if (typeof err === 'string' && err) return err
  return 'Something went wrong while loading the catalog'
}

/**
 * Converts a catalog list/search result (CatalogItem) or an airing schedule
 * entry (AiringEntry) into the shared RailItem shape. The two are told apart
 * structurally: AiringEntry carries a top-level `airingAt` unix timestamp
 * while CatalogItem nests its airing info under `nextAiringEpisode`.
 */
export function toRailItem(item: CatalogItem | AiringEntry): RailItem {
  if ('airingAt' in item) {
    const entry = item
    return {
      anilistId: entry.anilistId,
      title: entry.title,
      posterUrl: entry.posterUrl,
      airingAt: entry.airingAt,
      airingEpisode: entry.episode ?? undefined,
    }
  }
  const catalog = item
  return {
    anilistId: catalog.anilistId,
    idMal: catalog.idMal,
    title: catalog.title.english || catalog.title.romaji || '',
    posterUrl: catalog.posterUrl,
    bannerUrl: catalog.bannerUrl,
    averageScore: catalog.averageScore,
    episodesCount: catalog.episodesCount,
    format: catalog.format ?? undefined,
    status: catalog.status ?? undefined,
    isAdult: catalog.isAdult,
    genres: catalog.genres,
    seasonYear: catalog.seasonYear ?? catalog.startDate?.year ?? null,
    airingAt: catalog.nextAiringEpisode ? catalog.nextAiringEpisode.airingAt : null,
    airingEpisode: catalog.nextAiringEpisode ? catalog.nextAiringEpisode.episode : null,
  }
}

/**
 * Filters the current week's schedule down to entries airing within TODAY's
 * local calendar day (unix seconds, inclusive start / exclusive end), keeping
 * only the earliest airing per anilistId, sorted by airing time.
 */
function pickAiringToday(entries: AiringEntry[]): RailItem[] {
  const now = new Date()
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const from = Math.floor(dayStart.getTime() / 1000)
  const to = from + 24 * 60 * 60

  const earliestByAnime = new Map<number, AiringEntry>()
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry.airingAt !== 'number' || !Number.isFinite(entry.airingAt)) continue
    if (entry.airingAt < from || entry.airingAt >= to) continue
    const existing = earliestByAnime.get(entry.anilistId)
    if (!existing || entry.airingAt < existing.airingAt) {
      earliestByAnime.set(entry.anilistId, entry)
    }
  }

  return Array.from(earliestByAnime.values())
    .sort((a, b) => a.airingAt - b.airingAt)
    .map(toRailItem)
}

async function fetchSectionItems(section: CatalogSection): Promise<RailItem[]> {
  if (!window.electronAPI) return []
  switch (section) {
    case 'trending':
      return (await window.electronAPI.getCatalogTrending()).map(toRailItem)
    case 'season':
      return (await window.electronAPI.getCatalogSeason()).map(toRailItem)
    case 'allTime':
      return (await window.electronAPI.getCatalogAllTime()).map(toRailItem)
    case 'recommended':
      // No explicit seeds: the main process derives personal seeds from the
      // user library.
      return (await window.electronAPI.getCatalogRecommendations()).map(toRailItem)
    case 'airingToday':
      return pickAiringToday(await window.electronAPI.getAiringSchedule(0))
    default:
      return []
  }
}

/**
 * Loads one catalog rail section. Never throws: failures set `error` and
 * empty the rail. `refresh` re-fetches the same section.
 */
export function useCatalogSection(section: CatalogSection): CatalogSectionState {
  const [items, setItems] = useState<RailItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const next = await fetchSectionItems(section)
        if (!cancelled) setItems(next)
      } catch (err) {
        if (!cancelled) {
          setItems([])
          setError(toErrorMessage(err))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [section, refreshTick])

  const refresh = useCallback(() => setRefreshTick((t) => t + 1), [])

  return { items, loading, error, refresh }
}

/** Loads the home genre rails; the main process persists a three-day snapshot. */
export function useGenrePicks(): GenrePicksState {
  const [rails, setRails] = useState<GenrePicksState['rails']>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const data: GenrePickRail[] = window.electronAPI ? await window.electronAPI.getCatalogGenrePicks() : []
        if (!cancelled) {
          setRails((Array.isArray(data) ? data : []).map((rail) => ({
            genre: rail.genre,
            items: (Array.isArray(rail.items) ? rail.items : []).map(toRailItem),
          })))
        }
      } catch (err) {
        if (!cancelled) {
          setRails([])
          setError(toErrorMessage(err))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  return { rails, loading, error }
}

/**
 * Airing schedule entries for the calendar week (Monday-Sunday, local time)
 * `weekOffset` weeks from the current one. Never throws: failures set `error`
 * and empty the list. `refresh` re-fetches.
 */
export function useAiringSchedule(weekOffset?: number): AiringScheduleState {
  const offset = weekOffset ?? 0
  const [entries, setEntries] = useState<AiringEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        if (!window.electronAPI) {
          setEntries([])
        } else {
          const data = await window.electronAPI.getAiringSchedule(offset)
          if (!cancelled) setEntries(Array.isArray(data) ? data : [])
        }
      } catch (err) {
        if (!cancelled) {
          setEntries([])
          setError(toErrorMessage(err))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [offset, refreshTick])

  const refresh = useCallback(() => setRefreshTick((t) => t + 1), [])

  return { entries, loading, error, refresh }
}

/**
 * Debounced catalog search. An empty/whitespace query clears the results and
 * is never sent over IPC. Search failures degrade to an empty result set
 * (no error state per contract, loading still settles to false).
 */
export function useCatalogSearch(query: string, debounceMs?: number): CatalogSearchState {
  const [results, setResults] = useState<RailItem[]>([])
  const [loading, setLoading] = useState(false)
  const delay =
    typeof debounceMs === 'number' && Number.isFinite(debounceMs) && debounceMs >= 0
      ? debounceMs
      : DEFAULT_SEARCH_DEBOUNCE_MS

  useEffect(() => {
    const trimmed = (query || '').trim()
    if (!trimmed) {
      setResults([])
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    const timer = setTimeout(async () => {
      try {
        if (!window.electronAPI) {
          if (!cancelled) setResults([])
          return
        }
        const data = await window.electronAPI.searchCatalog(trimmed)
        if (!cancelled) setResults((Array.isArray(data) ? data : []).map(toRailItem))
      } catch {
        if (!cancelled) setResults([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, delay)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, delay])

  return { results, loading }
}
