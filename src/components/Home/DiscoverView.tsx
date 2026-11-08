import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  CalendarDays,
  ChevronDown,
  Compass,
  Flame,
  LoaderCircle,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Sparkles,
  TrendingUp,
} from 'lucide-react'
import type { DiscoverAgeRating, DiscoverCatalogParams, DiscoverMode, DiscoverSeason, DiscoverSort, PlaybackProgress, UserLibraryEntry } from '../../types'
import { toRailItem, type RailItem } from '../../hooks/useCatalog'
import { useLocalStatus } from '../../hooks/useLocalStatus'
import { AnimeCard } from '../common/AnimeCard'
import { normalizeAgeRating } from '../../utils/ageRating'
import { useAgeRatings } from '../../hooks/useAgeRatings'

interface DiscoverViewProps {
  history: Record<string, PlaybackProgress>
  userEntries: Record<number, UserLibraryEntry>
  folders: Parameters<typeof useLocalStatus>[0]
  onSelectItem: (item: RailItem) => void
}

const SEASONS: Array<{ value: DiscoverSeason; label: string }> = [
  { value: 'WINTER', label: 'Winter' },
  { value: 'SPRING', label: 'Spring' },
  { value: 'SUMMER', label: 'Summer' },
  { value: 'FALL', label: 'Fall' },
]

const GENRES = ['Action', 'Adventure', 'Comedy', 'Drama', 'Fantasy', 'Horror', 'Mystery', 'Romance', 'Sci-Fi', 'Slice of Life', 'Sports', 'Supernatural', 'Thriller']
const FORMATS = [
  { value: 'TV', label: 'TV' },
  { value: 'TV_SHORT', label: 'TV short' },
  { value: 'MOVIE', label: 'Movie' },
  { value: 'OVA', label: 'OVA' },
  { value: 'ONA', label: 'ONA' },
  { value: 'SPECIAL', label: 'Special' },
  { value: 'MUSIC', label: 'Music' },
] as const
const STATUSES = [
  { value: 'RELEASING', label: 'Airing' },
  { value: 'FINISHED', label: 'Finished' },
  { value: 'NOT_YET_RELEASED', label: 'Not yet released' },
  { value: 'HIATUS', label: 'On hiatus' },
  { value: 'CANCELLED', label: 'Cancelled' },
] as const
const SORTS: Array<{ value: DiscoverSort; label: string }> = [
  { value: 'RECOMMENDATION', label: 'Recommended order' },
  { value: 'POPULARITY_DESC', label: 'Popularity' },
  { value: 'TRENDING_DESC', label: 'Trending' },
  { value: 'SCORE_DESC', label: 'Score' },
  { value: 'TITLE_ROMAJI', label: 'Title A–Z' },
  { value: 'SEARCH_MATCH', label: 'Best match' },
]

const MODE_OPTIONS: Array<{ value: Exclude<DiscoverMode, 'search'>; label: string; description: string; icon: React.ReactNode }> = [
  { value: 'season', label: 'Seasonal', description: 'Browse one season or turn off the season filter to explore across years.', icon: <CalendarDays className="h-4 w-4" /> },
  { value: 'trending', label: 'Trending', description: 'Japanese anime getting attention right now.', icon: <TrendingUp className="h-4 w-4" /> },
  { value: 'popular', label: 'Popular', description: 'Popular Japanese anime from every season.', icon: <Flame className="h-4 w-4" /> },
  { value: 'recommended', label: 'For you', description: 'Picked from anime on your watch list.', icon: <Sparkles className="h-4 w-4" /> },
]

function getCurrentSeason(): { season: DiscoverSeason; year: number } {
  const now = new Date()
  const month = now.getMonth()
  const year = now.getFullYear()
  if (month === 11) return { season: 'WINTER', year: year + 1 }
  if (month < 3) return { season: 'WINTER', year }
  if (month < 6) return { season: 'SPRING', year }
  if (month < 9) return { season: 'SUMMER', year }
  return { season: 'FALL', year }
}

function defaultSortForMode(mode: Exclude<DiscoverMode, 'search'>): DiscoverSort {
  if (mode === 'trending') return 'TRENDING_DESC'
  if (mode === 'recommended') return 'RECOMMENDATION'
  return 'POPULARITY_DESC'
}

function SelectField({ label, value, onChange, children, className = '', disabled = false }: {
  label: string
  value: string
  onChange: (value: string) => void
  children: React.ReactNode
  className?: string
  disabled?: boolean
}) {
  return (
    <label className={`relative flex min-w-0 flex-col gap-1.5 ${disabled ? 'opacity-45' : ''} ${className}`}>
      <span className="text-[9px] font-bold uppercase tracking-[0.15em] text-zinc-500">{label}</span>
      <span className="relative">
        <select disabled={disabled} value={value} onChange={(event) => onChange(event.target.value)} className="h-10 w-full appearance-none rounded-xl border border-white/[0.09] bg-[#11131a] px-3 pr-9 text-xs font-semibold text-zinc-200 outline-none transition focus:border-rose-400/50 focus:ring-2 focus:ring-rose-500/10 disabled:cursor-not-allowed disabled:bg-white/[0.015] disabled:text-zinc-500">
          {children}
        </select>
        <ChevronDown className={`pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500 ${disabled ? 'opacity-40' : ''}`} />
      </span>
    </label>
  )
}

export const DiscoverView: React.FC<DiscoverViewProps> = ({ history, userEntries, folders, onSelectItem }) => {
  const current = useMemo(getCurrentSeason, [])
  const [mode, setMode] = useState<Exclude<DiscoverMode, 'search'>>('season')
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [searchScope, setSearchScope] = useState<'all' | 'season'>('all')
  const [year, setYear] = useState(current.year)
  const [season, setSeason] = useState<DiscoverSeason>(current.season)
  const [seasonFilterEnabled, setSeasonFilterEnabled] = useState(true)
  const [genre, setGenre] = useState('')
  const [format, setFormat] = useState('')
  const [status, setStatus] = useState('')
  const [minScore, setMinScore] = useState(0)
  const [sort, setSort] = useState<DiscoverSort>('POPULARITY_DESC')
  const [ageRating, setAgeRating] = useState<DiscoverAgeRating>('ALL')
  const [items, setItems] = useState<RailItem[]>([])
  const [page, setPage] = useState(1)
  const [hasNextPage, setHasNextPage] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const loadingMoreRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const wasSearchingRef = useRef(false)
  const previousModeRef = useRef(mode)
  const requestGenerationRef = useRef(0)
  const autoRatingLoadRef = useRef({ key: '', pages: 0 })
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null)
  const statusResolver = useLocalStatus(folders, history, userEntries)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [query])

  useEffect(() => {
    const searching = debouncedQuery.length > 0
    if (searching && !wasSearchingRef.current) setSort('SEARCH_MATCH')
    if (!searching && wasSearchingRef.current) {
      setSort(defaultSortForMode(mode))
    } else if (!searching && previousModeRef.current !== mode) {
      setSort(defaultSortForMode(mode))
    }
    wasSearchingRef.current = searching
    previousModeRef.current = mode
  }, [debouncedQuery, mode])

  const requestParams = useMemo<DiscoverCatalogParams>(() => ({
    mode: debouncedQuery ? 'search' : mode,
    search: debouncedQuery || undefined,
    searchScope,
    seasonFilterEnabled: !debouncedQuery && mode === 'season' ? seasonFilterEnabled : false,
    year,
    season,
    genre: genre || undefined,
    format: format ? format as DiscoverCatalogParams['format'] : undefined,
    status: status ? status as DiscoverCatalogParams['status'] : undefined,
    minScore: minScore || undefined,
    ageRating,
    sort,
    page: 1,
  }), [debouncedQuery, mode, searchScope, seasonFilterEnabled, year, season, genre, format, status, minScore, ageRating, sort])

  useEffect(() => {
    let cancelled = false
    const generation = ++requestGenerationRef.current
    setLoading(true)
    setLoadingMore(false)
    loadingMoreRef.current = false
    setError(null)
    setItems([])
    setPage(1)
    setHasNextPage(false)

    const api = window.electronAPI
    if (!api?.getDiscoverCatalog) {
      setError('Discover catalog is unavailable in this app build.')
      setLoading(false)
      return () => { cancelled = true }
    }

    api.getDiscoverCatalog(requestParams)
      .then((result) => {
        if (cancelled || generation !== requestGenerationRef.current) return
        setItems((result?.items || []).map(toRailItem))
        setPage(result?.page || 1)
        setHasNextPage(Boolean(result?.hasNextPage))
      })
      .catch((err) => {
        if (!cancelled && generation === requestGenerationRef.current) setError(err instanceof Error ? err.message : 'Could not load the catalog.')
      })
      .finally(() => {
        if (!cancelled && generation === requestGenerationRef.current) setLoading(false)
      })

    return () => { cancelled = true }
  }, [requestParams, refreshKey])

  const { ratings: ageRatings, loadingIds: loadingAgeRatingIds } = useAgeRatings(items)
  const visibleItems = useMemo(() => {
    if (ageRating === 'ALL') return items
    return items.filter((item) => {
      if (item.idMal == null) return ageRating === 'NR'
      if (!Object.prototype.hasOwnProperty.call(ageRatings, item.idMal)) return false
      return normalizeAgeRating(ageRatings[item.idMal]) === ageRating
    })
  }, [items, ageRating, ageRatings])
  const ageRatingsPending = items.some((item) => item.idMal != null && loadingAgeRatingIds.includes(item.idMal))

  const loadMore = useCallback(async () => {
    const api = window.electronAPI
    if (!api?.getDiscoverCatalog || !hasNextPage || loadingMore || loading || loadingMoreRef.current) return
    const nextPage = page + 1
    const generation = requestGenerationRef.current
    loadingMoreRef.current = true
    setLoadingMore(true)
    setError(null)
    try {
      const result = await api.getDiscoverCatalog({ ...requestParams, page: nextPage })
      if (generation !== requestGenerationRef.current) return
      const newItems = (result?.items || []).map(toRailItem)
      setItems((previous) => {
        const merged = new Map(previous.map((item) => [item.anilistId, item]))
        newItems.forEach((item) => merged.set(item.anilistId, item))
        return [...merged.values()]
      })
      setPage(nextPage)
      setHasNextPage(Boolean(result?.hasNextPage))
    } catch (err) {
      if (generation === requestGenerationRef.current) setError(err instanceof Error ? err.message : 'Could not load more titles.')
    } finally {
      if (generation === requestGenerationRef.current) {
        loadingMoreRef.current = false
        setLoadingMore(false)
      }
    }
  }, [hasNextPage, loadingMore, loading, page, requestParams])

  const autoLoadKey = JSON.stringify({ mode, query: debouncedQuery, searchScope, seasonFilterEnabled, year, season, genre, format, status, minScore, sort, ageRating })
  useEffect(() => {
    if (autoRatingLoadRef.current.key !== autoLoadKey) {
      autoRatingLoadRef.current = { key: autoLoadKey, pages: 0 }
    }
    if (
      ageRating === 'ALL' || loading || loadingMore || !hasNextPage || ageRatingsPending ||
      visibleItems.length >= 24 || autoRatingLoadRef.current.pages >= 3
    ) return
    autoRatingLoadRef.current.pages += 1
    void loadMore()
  }, [autoLoadKey, ageRating, loading, loadingMore, hasNextPage, ageRatingsPending, visibleItems.length, page, loadMore])

  useEffect(() => {
    if (ageRating === 'ALL' || loading || loadingMore || !hasNextPage || !loadMoreSentinelRef.current) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore()
    }, { rootMargin: '700px 0px' })
    observer.observe(loadMoreSentinelRef.current)
    return () => observer.disconnect()
  }, [ageRating, loading, loadingMore, hasNextPage, visibleItems.length, loadMore])

  const clearFilters = () => {
    setGenre('')
    setFormat('')
    setStatus('')
    setMinScore(0)
    setSort(debouncedQuery ? 'SEARCH_MATCH' : defaultSortForMode(mode))
    setAgeRating('ALL')
  }

  const resetAll = () => {
    setMode('season')
    setQuery('')
    setSearchScope('all')
    setYear(current.year)
    setSeason(current.season)
    setSeasonFilterEnabled(true)
    clearFilters()
  }

  const hasFilters = Boolean(genre || format || status || minScore || ageRating !== 'ALL' || (!debouncedQuery && mode === 'season' && !seasonFilterEnabled))
  const seasonControlsVisible = mode === 'season' || Boolean(debouncedQuery)
  const seasonSelectionEnabled = debouncedQuery ? searchScope === 'season' : seasonFilterEnabled
  const activeMode = MODE_OPTIONS.find((option) => option.value === mode)!
  const selectedSeasonLabel = `${SEASONS.find((entry) => entry.value === season)?.label} ${year}`
  const availableYears = Array.from({ length: Math.max(1, current.year + 2 - 1970) }, (_, index) => current.year + 1 - index)

  return (
    <div className="mx-auto min-h-full w-full max-w-[1800px] px-6 py-7 2xl:px-12">
      <section className="relative mb-6 overflow-hidden rounded-[26px] border border-white/[0.08] bg-[#12141b] px-6 py-7 shadow-2xl shadow-black/20 md:px-9 md:py-8">
        <div className="pointer-events-none absolute -right-20 -top-32 h-80 w-80 rounded-full bg-rose-500/[0.08] blur-3xl" />
        <div className="pointer-events-none absolute -bottom-36 left-1/3 h-72 w-72 rounded-full bg-violet-500/[0.07] blur-3xl" />
        <div className="relative">
          <div>
            <div className="flex items-center gap-2 text-rose-300"><Compass className="h-4 w-4" /><span className="text-[10px] font-bold uppercase tracking-[0.22em]">Kaiko / Discover</span></div>
            <h1 className="mt-3 text-3xl font-black tracking-tight text-white md:text-4xl">Find your next anime</h1>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-zinc-400">Browse seasonal lineups, follow what’s trending, and filter the catalog down to exactly what you want.</p>
          </div>
        </div>
      </section>

      <div className="mb-5 flex flex-wrap items-center gap-2 rounded-2xl border border-white/[0.07] bg-white/[0.025] p-2">
        {MODE_OPTIONS.map((option) => (
          <button key={option.value} type="button" onClick={() => setMode(option.value)} className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-bold transition ${mode === option.value && !debouncedQuery ? 'bg-rose-500 text-white shadow-lg shadow-rose-950/30' : 'text-zinc-400 hover:bg-white/[0.05] hover:text-white'}`}>
            {option.icon}<span>{option.label}</span>
          </button>
        ))}
        <span className="ml-auto hidden pr-2 text-[10px] text-zinc-600 md:block">{debouncedQuery ? 'Search results' : activeMode.description}</span>
      </div>

      <section className="mb-5 rounded-2xl border border-white/[0.08] bg-[#111319]/90 p-4 shadow-xl shadow-black/10 md:p-5">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <label className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search titles, aliases, or Japanese names…" className="h-12 w-full rounded-xl border border-white/[0.09] bg-[#0b0c10] pl-11 pr-4 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-rose-400/50 focus:ring-2 focus:ring-rose-500/10" />
              {query && <button type="button" onClick={() => setQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-[10px] font-semibold text-zinc-500 hover:text-white">Clear</button>}
            </label>
          </div>

          {seasonControlsVisible && (
            <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-white/[0.07] bg-[#0d0f15] px-4 py-3">
              <div className="flex min-w-[220px] flex-1 items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-rose-300/15 bg-rose-400/[0.08] text-rose-200"><CalendarDays className="h-4 w-4" /></span>
                <span className="min-w-0">
                  <span className="block text-xs font-bold text-zinc-200">{debouncedQuery ? 'Limit search to a season' : 'Filter by season'}</span>
                  <span className="mt-0.5 block text-[10px] text-zinc-500">Choose one season or include releases from every year.</span>
                </span>
              </div>
              <div role="group" aria-label="Season filter" className="inline-flex shrink-0 items-center rounded-xl border border-white/[0.08] bg-[#090a0e] p-1">
                <button
                  type="button"
                  aria-pressed={seasonSelectionEnabled}
                  onClick={() => debouncedQuery ? setSearchScope('season') : setSeasonFilterEnabled(true)}
                  className={`rounded-lg px-3 py-2 text-[11px] font-bold transition ${seasonSelectionEnabled ? 'bg-rose-500 text-white shadow-md shadow-rose-950/30' : 'text-zinc-500 hover:text-zinc-200'}`}
                >{debouncedQuery ? 'In season' : 'One season'}</button>
                <button
                  type="button"
                  aria-pressed={!seasonSelectionEnabled}
                  onClick={() => debouncedQuery ? setSearchScope('all') : setSeasonFilterEnabled(false)}
                  className={`rounded-lg px-3 py-2 text-[11px] font-bold transition ${!seasonSelectionEnabled ? 'bg-rose-500 text-white shadow-md shadow-rose-950/30' : 'text-zinc-500 hover:text-zinc-200'}`}
                >{debouncedQuery ? 'All anime' : 'All seasons'}</button>
              </div>
              <div className="flex flex-wrap items-end gap-3 border-l border-white/[0.07] pl-4">
                <SelectField disabled={!seasonSelectionEnabled} label="Season" value={season} onChange={(value) => setSeason(value as DiscoverSeason)} className="w-[145px]">
                  {SEASONS.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
                </SelectField>
                <SelectField disabled={!seasonSelectionEnabled} label="Year" value={String(year)} onChange={(value) => setYear(Number(value))} className="w-[115px]">
                  {availableYears.map((value) => <option key={value} value={value}>{value}</option>)}
                </SelectField>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            <SelectField label="Genre" value={genre} onChange={setGenre}>
              <option value="">All genres</option>
              {GENRES.map((value) => <option key={value} value={value}>{value}</option>)}
            </SelectField>
            <SelectField label="Format" value={format} onChange={setFormat}>
              <option value="">All formats</option>
              {FORMATS.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
            </SelectField>
            <SelectField label="Status" value={status} onChange={setStatus}>
              <option value="">Any status</option>
              {STATUSES.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
            </SelectField>
            <SelectField label="Minimum score" value={String(minScore)} onChange={(value) => setMinScore(Number(value))}>
              <option value="0">Any score</option>
              {[60, 70, 75, 80, 85, 90].map((value) => <option key={value} value={value}>{value}+ / 100</option>)}
            </SelectField>
            <SelectField label="Sort by" value={sort} onChange={(value) => setSort(value as DiscoverSort)}>
              {SORTS.filter((entry) => {
                if (entry.value === 'SEARCH_MATCH') return Boolean(debouncedQuery)
                if (entry.value === 'RECOMMENDATION') return mode === 'recommended' && !debouncedQuery
                return true
              }).map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
            </SelectField>
            <SelectField label="Age rating" value={ageRating} onChange={(value) => setAgeRating(value as DiscoverAgeRating)}>
              <option value="ALL">Any rating</option>
              {['G', 'PG', 'PG-13', 'R-17+', 'R+', 'NR'].map((value) => (
                <option key={value} value={value}>{value === 'G' ? 'G · All ages' : value === 'PG' ? 'PG · Parental guidance' : value === 'NR' ? 'NR · Not rated' : value}</option>
              ))}
            </SelectField>
          </div>

          {(hasFilters || debouncedQuery || mode !== 'season' || year !== current.year || season !== current.season) && (
            <div className="flex items-center justify-between border-t border-white/[0.06] pt-3">
              <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-600"><SlidersHorizontal className="h-3 w-3" />Filters active</span>
              <button type="button" onClick={resetAll} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[10px] font-bold text-zinc-500 transition hover:bg-white/[0.05] hover:text-white"><RotateCcw className="h-3 w-3" />Reset all</button>
            </div>
          )}
        </div>
      </section>

      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-black text-white">{debouncedQuery ? `Results for “${debouncedQuery}”` : mode === 'season' ? (seasonFilterEnabled ? `${selectedSeasonLabel} anime` : 'All seasons') : activeMode.label}</h2>
          <p className="mt-1 text-xs text-zinc-500">{loading ? 'Loading catalog…' : `${visibleItems.length} titles loaded${hasNextPage ? ' · more available' : ''}`}</p>
        </div>
        {mode === 'recommended' && !debouncedQuery && userEntries && Object.keys(userEntries).length === 0 && (
          <span className="rounded-lg border border-violet-300/10 bg-violet-300/[0.04] px-3 py-2 text-[10px] text-zinc-500">Add titles to your list to improve recommendations.</span>
        )}
      </div>

      {error && items.length === 0 ? (
        <div className="rounded-2xl border border-rose-400/15 bg-rose-400/[0.04] px-6 py-14 text-center">
          <AlertCircle className="mx-auto h-7 w-7 text-rose-300" />
          <p className="mt-3 text-sm font-bold text-zinc-200">Couldn’t load this catalog</p>
          <p className="mx-auto mt-1 max-w-lg text-xs leading-relaxed text-zinc-500">{error}</p>
          <button type="button" onClick={() => setRefreshKey((value) => value + 1)} className="mt-4 rounded-xl bg-rose-500 px-4 py-2 text-xs font-bold text-white transition hover:bg-rose-400">Try again</button>
        </div>
      ) : loading ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,192px))] justify-between gap-x-4 gap-y-7">
          {Array.from({ length: 12 }, (_, index) => <div key={index} className="animate-pulse"><div className="aspect-[2/3] rounded-2xl bg-white/[0.045]" /><div className="mt-2 h-3 w-3/4 rounded bg-white/[0.04]" /></div>)}
        </div>
      ) : ageRating !== 'ALL' && ageRatingsPending && visibleItems.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.025] py-14 text-center text-xs text-zinc-500">Checking age ratings…</div>
      ) : visibleItems.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.025] py-20 text-center">
          <Compass className="mx-auto h-7 w-7 text-zinc-700" />
          <p className="mt-3 text-sm font-semibold text-zinc-300">{hasNextPage ? 'No matches on the loaded pages yet' : 'No anime found with these filters'}</p>
          <p className="mt-1 text-xs text-zinc-600">{hasNextPage ? 'More titles are available. Keep searching or adjust the filters.' : 'Try changing the season, search area, or filters.'}</p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-4">
            {hasNextPage && <button type="button" onClick={() => void loadMore()} disabled={loadingMore} className="inline-flex items-center gap-2 rounded-lg border border-white/[0.1] bg-white/[0.04] px-3 py-2 text-xs font-bold text-zinc-200 transition hover:border-rose-300/30 hover:bg-rose-500/10 disabled:cursor-wait disabled:opacity-60">{loadingMore ? <><LoaderCircle className="h-3.5 w-3.5 animate-spin" />Loading…</> : 'Search more titles'}</button>}
            <button type="button" onClick={clearFilters} className="text-xs font-bold text-rose-300 transition hover:text-rose-200">Clear filters</button>
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,192px))] justify-between gap-x-4 gap-y-7">
            {visibleItems.map((item) => <AnimeCard key={item.anilistId} item={item} showCatalogBadges ageRating={item.idMal != null ? ageRatings[item.idMal] : null} ageRatingLoaded={item.idMal == null || Object.prototype.hasOwnProperty.call(ageRatings, item.idMal)} badgeState={statusResolver.statusFor({ anilistId: item.anilistId, title: item.title, apiEpisodesCount: item.episodesCount ?? null })} onClick={onSelectItem} />)}
          </div>
          {error && <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-400/15 bg-rose-400/[0.04] px-4 py-3 text-xs text-rose-200"><span>{error}</span><button type="button" onClick={() => void loadMore()} disabled={loadingMore} className="font-bold hover:text-white">Retry</button></div>}
          {hasNextPage && ageRating !== 'ALL' && (
            <div ref={loadMoreSentinelRef} className="flex min-h-16 items-center justify-center py-4 text-xs text-zinc-500">
              {loadingMore && <><LoaderCircle className="mr-2 h-4 w-4 animate-spin" />Finding more matches…</>}
            </div>
          )}
          {hasNextPage && ageRating === 'ALL' && (
            <div className="flex justify-center py-9">
              <button type="button" onClick={() => void loadMore()} disabled={loadingMore} className="flex min-w-44 items-center justify-center gap-2 rounded-xl border border-white/[0.1] bg-white/[0.04] px-5 py-3 text-xs font-bold text-zinc-200 transition hover:border-rose-300/30 hover:bg-rose-500/10 hover:text-white disabled:cursor-wait disabled:opacity-60">
                {loadingMore ? <><LoaderCircle className="h-4 w-4 animate-spin" />Loading…</> : 'Load more anime'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
