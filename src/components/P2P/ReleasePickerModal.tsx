/**
 * ReleasePickerModal: searches the user's own RSS/Torznab indexers for a given
 * anime title (optionally scoped to a single episode) and shows the ranked
 * results. Purely a picker — the parent performs addDownload via onPicked and
 * owns toasts / library refresh.
 *
 * Results area is a small state machine driven by the per-provider reports
 * from ReleaseSearchResponse: loading skeleton -> no indexers (amber) ->
 * every provider failed (red card + query editor) -> some ok but zero results
 * (query editor + hint) -> results list (+ amber strip when some providers
 * failed). The query editor lets the user fix the search string and re-run
 * with queryOverride when a tracker finds nothing.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Download,
  Info,
  Package,
  Search,
  X,
} from 'lucide-react'
import type { ProviderReport, ReleaseSearchResult } from '../../types'
import type { ParsedRelease } from '../../lib/releaseParser/types.ts'
import { formatEpisodeNumberPart, parseReleaseCore } from '../../lib/releaseParser/regexEngine.ts'
import { classifyRelease, TORRENT_LANGUAGES, type ReleaseClassification, type ReleaseKind, type TorrentLanguageCode } from '../../lib/releaseParser/releaseClassification.ts'
import { formatFileSize } from '../../utils/format'

interface ReleasePickerModalProps {
  open: boolean
  /** Display title of the anime to search for. */
  title: string
  anilistId: number | null
  season?: number | null
  /** null = whole season / pack. */
  episode?: number | null
  /** Episode count of the season when known — extra context for the search. */
  episodeCount?: number | null
  episodeDurationMinutes?: number | null
  /** Alternative titles (romaji/english) tried alongside the main query. */
  aliases?: string[]
  onCancel: () => void
  onPicked: (result: ReleaseSearchResult) => void
}

const SKELETON_ROWS = 6
type ReleaseTab = 'all' | 'batches' | 'episodes'
type ReleaseTypeFilter = 'all' | ReleaseKind
type ReleaseLanguageFilter = 'all' | 'unknown' | TorrentLanguageCode

const RELEASE_TABS: Array<{ id: ReleaseTab; label: string }> = [
  { id: 'all', label: 'All Releases' },
  { id: 'batches', label: 'Batches' },
  { id: 'episodes', label: 'Episodes' },
]

const TAB_EMPTY_TEXT: Record<ReleaseTab, string> = {
  all: 'No releases match your filter',
  batches: 'No batches in results',
  episodes: 'No episodes in results',
}

interface ClassifiedRelease {
  result: ReleaseSearchResult
  parsed: ParsedRelease
  classification: ReleaseClassification
  kind: 'batch' | 'episode' | 'other'
}

/** Sky chip label for episode info: "EP 05" for a single, "E 01-12" for a range. */
/** Technical tags only; language and release kind are classified separately. */
function buildReleaseChips(parsed: ParsedRelease): Array<{ label: string; className: string }> {
  const chips: Array<{ label: string; className: string }> = []
  if (parsed.releaseGroup) {
    chips.push({
      label: parsed.releaseGroup,
      className: 'border border-indigo-400/30 bg-indigo-500/15 text-indigo-300',
    })
  }
  if (parsed.resolution) {
    chips.push({ label: parsed.resolution, className: 'bg-zinc-800 text-zinc-400' })
  }
  if (parsed.videoTerm) {
    chips.push({ label: parsed.videoTerm, className: 'bg-zinc-800 text-zinc-400' })
  }
  return chips.slice(0, 3)
}

const TYPE_FILTERS: Array<{ value: ReleaseTypeFilter; label: string }> = [
  { value: 'all', label: 'All release types' },
  { value: 'episode', label: 'Single episodes' },
  { value: 'episode-range', label: 'Episode ranges' },
  { value: 'season-pack', label: 'Season packs' },
  { value: 'movie', label: 'Movies' },
  { value: 'ova', label: 'OVA / OAD' },
  { value: 'special', label: 'Specials' },
  { value: 'unknown', label: 'Unknown type' },
]

export const ReleasePickerModal: React.FC<ReleasePickerModalProps> = ({
  open,
  title,
  anilistId,
  season,
  episode,
  episodeCount,
  episodeDurationMinutes,
  aliases,
  onCancel,
  onPicked,
}) => {
  const [loading, setLoading] = useState(false)
  const [results, setResults] = useState<ReleaseSearchResult[]>([])
  const [reports, setReports] = useState<ProviderReport[]>([])
  /** IPC / API-level failure — per-provider failures live in `reports` instead. */
  const [fatalError, setFatalError] = useState<string | null>(null)
  /** What the user is searching with; kept in sync with the response's primary query. */
  const [activeQuery, setActiveQuery] = useState('')
  const [filter, setFilter] = useState('')
  const [tab, setTab] = useState<ReleaseTab>('all')
  const [typeFilter, setTypeFilter] = useState<ReleaseTypeFilter>('all')
  const [audioFilter, setAudioFilter] = useState<ReleaseLanguageFilter>('all')
  const [subtitleFilter, setSubtitleFilter] = useState<ReleaseLanguageFilter>('all')
  const [inspectionState, setInspectionState] = useState<Record<string, { loading?: boolean; error?: string }>>({})

  const searchGenRef = useRef(0)

  // Escape closes the picker. Capture phase + preventDefault so it wins over
  // the detail overlay's own Escape handler (which skips defaultPrevented
  // events) and the global player rescue listener in App.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onCancel])

  // Shared search runner: initial/param-driven searches omit queryOverride;
  // the query editor re-search passes the edited string through.
  const runSearch = useCallback(
    (queryOverride?: string) => {
      const api = window.electronAPI
      if (!api?.searchReleases) {
        setResults([])
        setReports([])
        setActiveQuery(queryOverride || title)
        setFatalError('Release search is unavailable in this build of the app.')
        setLoading(false)
        return
      }
      const gen = ++searchGenRef.current
      setLoading(true)
      setFatalError(null)
      api
        .searchReleases({
          title,
          aliases: aliases ?? [],
          anilistId,
          season: season ?? null,
          episode: episode ?? null,
          episodeCount: episodeCount ?? null,
          episodeDurationMinutes: episodeDurationMinutes ?? null,
          queryOverride,
        })
        .then((res) => {
          if (gen !== searchGenRef.current) return
          setResults(Array.isArray(res?.results) ? res.results : [])
          setReports(Array.isArray(res?.reports) ? res.reports : [])
          setActiveQuery(res?.queries?.[0] || queryOverride || title)
          setTab('all')
          setTypeFilter('all')
          setAudioFilter('all')
          setSubtitleFilter('all')
          setLoading(false)
        })
        .catch((err) => {
          if (gen !== searchGenRef.current) return
          console.error('Release search failed:', err)
          setResults([])
          setReports([])
          setActiveQuery(queryOverride || title)
          setTab('all')
          setTypeFilter('all')
          setAudioFilter('all')
          setSubtitleFilter('all')
          setFatalError(err instanceof Error && err.message ? err.message : 'Release search failed.')
          setLoading(false)
        })
    },
    [title, aliases, anilistId, season, episode, episodeCount, episodeDurationMinutes],
  )

  // Reset the client-side filter each time the picker opens.
  useEffect(() => {
    if (open) {
      setFilter('')
      setTypeFilter('all')
      setAudioFilter('all')
      setSubtitleFilter('all')
      setInspectionState({})
    }
  }, [open])

  // Search while open; re-runs when the key params change (e.g. the picker is
  // kept mounted for another episode of the same title).
  useEffect(() => {
    if (!open) return
    runSearch()
  }, [open, runSearch])

  const okReports = useMemo(() => reports.filter((r) => r.ok), [reports])
  const failedReports = useMemo(() => reports.filter((r) => !r.ok), [reports])
  const firstFailure = failedReports.length > 0 ? (failedReports[0].error ?? 'unknown error') : null

  // Client-side classification uses the same explicit-token parser as main-process ranking.
  const classified = useMemo<ClassifiedRelease[]>(
    () =>
      results.map((result) => {
        const parsed = parseReleaseCore(result.title || '')
        const classification = classifyRelease(result.title || '', result.description)
        const kind: ClassifiedRelease['kind'] = classification.kind === 'season-pack' || classification.kind === 'episode-range'
          ? 'batch'
          : classification.kind === 'episode'
            ? 'episode'
            : 'other'
        return { result, parsed, classification, kind }
      }),
    [results],
  )

  // Preserve backend's match ordering inside each audio/subtitle priority group.
  const languageSorted = useMemo(() => [...classified].sort((a, b) => {
    const priorityDiff = a.classification.rank - b.classification.rank
    if (priorityDiff) return priorityDiff
    if (!!a.result.sizeWarning !== !!b.result.sizeWarning) return a.result.sizeWarning ? 1 : -1
    if (episode != null) {
      const aMatch = a.parsed.episodeNumbers.includes(episode) ? 1 : 0
      const bMatch = b.parsed.episodeNumbers.includes(episode) ? 1 : 0
      if (aMatch !== bMatch) return bMatch - aMatch
    }
    if (season != null) {
      const aMatch = a.parsed.season === season ? 1 : 0
      const bMatch = b.parsed.season === season ? 1 : 0
      if (aMatch !== bMatch) return bMatch - aMatch
    }
    return (b.result.seeders ?? -1) - (a.result.seeders ?? -1)
  }), [classified, episode, season])

  // Local search and controls compose; unclassified items naturally stay last.
  const normalizedFilter = filter.trim().toLowerCase()
  const filterMatched = useMemo(() => {
    return languageSorted.filter((item) => {
      if (normalizedFilter && !(item.result.title || '').toLowerCase().includes(normalizedFilter)
        && !(item.result.description || '').toLowerCase().includes(normalizedFilter)) return false
      if (audioFilter === 'unknown' && item.classification.audioLanguageCodes.length > 0) return false
      if (audioFilter !== 'all' && audioFilter !== 'unknown' && !item.classification.audioLanguageCodes.includes(audioFilter)) return false
      if (subtitleFilter === 'unknown' && item.classification.subtitleLanguageCodes.length > 0) return false
      if (subtitleFilter !== 'all' && subtitleFilter !== 'unknown' && !item.classification.subtitleLanguageCodes.includes(subtitleFilter)) return false
      if (typeFilter !== 'all' && item.classification.kind !== typeFilter) return false
      return true
    })
  }, [languageSorted, normalizedFilter, audioFilter, subtitleFilter, typeFilter])

  const tabCounts = useMemo(
    () => ({
      all: filterMatched.length,
      batches: filterMatched.filter((c) => c.kind === 'batch').length,
      episodes: filterMatched.filter((c) => c.kind === 'episode').length,
    }),
    [filterMatched],
  )

  const visible = useMemo(() => {
    if (tab === 'all') return filterMatched
    const kind: ClassifiedRelease['kind'] = tab === 'batches' ? 'batch' : 'episode'
    return filterMatched.filter((c) => c.kind === kind)
  }, [filterMatched, tab])

  if (!open) return null

  const scopeLabel =
    episode != null ? `Episode ${episode}` : season != null ? `Season ${season}` : 'Season pack'

  // Results-area state machine (see file header): loading -> fatal / all
  // providers failed -> no indexers -> some ok but zero results -> results.
  const allProvidersFailed = reports.length > 0 && okReports.length === 0
  const fatalOrAllFailed = fatalError != null || allProvidersFailed
  const errorHeadline = fatalError ?? 'Indexer request failed'
  const errorDetail = fatalError ?? firstFailure ?? 'The request did not return an error detail.'
  const showQueryEditor = fatalOrAllFailed || (okReports.length > 0 && results.length === 0)

  const submitQuery = () => {
    const query = activeQuery.trim()
    if (!query || loading) return
    runSearch(query)
  }

  const checkReleaseDescription = async (release: ReleaseSearchResult) => {
    if (!release.detailsUrl || !window.electronAPI?.fetchReleaseDescription) return
    const key = `${release.providerId}|${release.downloadUrl}`
    setInspectionState((previous) => ({ ...previous, [key]: { loading: true } }))
    try {
      const description = await window.electronAPI.fetchReleaseDescription({ providerId: release.providerId, url: release.detailsUrl })
      const before = classifyRelease(release.title, release.description)
      const after = classifyRelease(release.title, description)
      const addedAudioInfo = after.audioLabels.some((label) => !before.audioLabels.includes(label))
      const addedSubtitleInfo = before.subtitleLabel == null && after.subtitleLabel != null
      if (!addedAudioInfo && !addedSubtitleInfo) {
        throw new Error('No additional explicit audio or subtitle information was found on this page.')
      }
      setResults((previous) => previous.map((item) => item.providerId === release.providerId && item.downloadUrl === release.downloadUrl
        ? { ...item, description }
        : item))
      setInspectionState((previous) => ({ ...previous, [key]: {} }))
    } catch (error) {
      setInspectionState((previous) => ({
        ...previous,
        [key]: { error: error instanceof Error ? error.message : 'Could not inspect the release page.' },
      }))
    }
  }

  const renderQueryEditor = () => (
    <form
      className="flex w-full items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        submitQuery()
      }}
    >
      <input
        type="text"
        value={activeQuery}
        onChange={(e) => setActiveQuery(e.target.value)}
        placeholder="Search query"
        spellCheck={false}
        className="min-w-0 flex-1 rounded-lg border border-zinc-700/60 bg-zinc-800/80 px-3 py-1.5 font-mono text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-red-600/40"
      />
      <button
        type="submit"
        disabled={loading || !activeQuery.trim()}
        className="flex shrink-0 select-none items-center gap-1.5 rounded-lg border border-indigo-500/40 bg-indigo-500/15 px-3 py-1.5 text-xs font-bold text-indigo-200 transition-colors hover:bg-indigo-500/25 active:scale-[0.98] disabled:opacity-50"
      >
        <Search className="h-3.5 w-3.5" />
        <span>Search</span>
      </button>
    </form>
  )

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 animate-in fade-in duration-150"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        data-modal="true"
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-white/10 bg-[#141418] shadow-2xl animate-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-white/10 px-5 py-4">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-sm font-bold text-white">
              <Download className="h-4 w-4 shrink-0 text-indigo-400" />
              <span className="truncate" title={title}>
                {title}
              </span>
            </h2>
            <p className="mt-0.5 text-[11px] text-zinc-500">
              Pick a release to download · {scopeLabel}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            title="Close (Esc)"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/5 text-zinc-300 transition-colors hover:bg-white/10 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Filter + result count */}
        <div className="flex items-center gap-3 px-5 pt-3">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter releases…"
              className="w-full rounded-lg border border-zinc-700/60 bg-zinc-800/80 py-1.5 pl-8 pr-3 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-red-600/40"
            />
          </div>
          <span className="shrink-0 text-[11px] text-zinc-500">
            {loading
              ? 'Searching…'
              : results.length > 0
                ? `${visible.length} of ${results.length} releases`
                : ''}
          </span>
        </div>

        {/* Tabs: All / Batches / Episodes — counts reflect the active filter */}
        {!loading && results.length > 0 && (
          <div className="flex items-center gap-1.5 px-5 pt-2">
            {RELEASE_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={
                  tab === t.id
                    ? 'rounded-full bg-zinc-600 px-3 py-1 text-[11px] font-bold text-white transition-colors'
                    : 'rounded-full bg-zinc-800/70 px-3 py-1 text-[11px] font-semibold text-zinc-400 transition-colors hover:bg-zinc-700/80 hover:text-zinc-200'
                }
              >
                {t.label} ({tabCounts[t.id]})
              </button>
            ))}
          </div>
        )}

        {!loading && results.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 px-5 pt-2">
            <select
              aria-label="Filter by release type"
              value={typeFilter}
              onChange={(event) => setTypeFilter(event.target.value as ReleaseTypeFilter)}
              className="min-w-40 rounded-lg border border-white/10 bg-zinc-900 px-2.5 py-1.5 text-[11px] font-semibold text-zinc-200 outline-none focus:border-indigo-400/50"
            >
              {TYPE_FILTERS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <select
              aria-label="Filter by audio language"
              value={audioFilter}
              onChange={(event) => setAudioFilter(event.target.value as ReleaseLanguageFilter)}
              className="min-w-36 rounded-lg border border-white/10 bg-zinc-900 px-2.5 py-1.5 text-[11px] font-semibold text-zinc-200 outline-none focus:border-indigo-400/50"
            >
              <option value="all">Any audio</option><option value="unknown">Audio not listed</option>
              {TORRENT_LANGUAGES.map((option) => <option key={option.code} value={option.code}>{option.label} audio</option>)}
            </select>
            <select
              aria-label="Filter by subtitle language"
              value={subtitleFilter}
              onChange={(event) => setSubtitleFilter(event.target.value as ReleaseLanguageFilter)}
              className="min-w-36 rounded-lg border border-white/10 bg-zinc-900 px-2.5 py-1.5 text-[11px] font-semibold text-zinc-200 outline-none focus:border-indigo-400/50"
            >
              <option value="all">Any subtitles</option><option value="unknown">Subtitles not listed</option>
              {TORRENT_LANGUAGES.map((option) => <option key={option.code} value={option.code}>{option.label} subtitles</option>)}
            </select>
            <span className="ml-auto text-[10px] text-zinc-500">Language filters use release title and details</span>
          </div>
        )}

        {/* Results */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          {loading ? (
            <div className="flex flex-col gap-1.5">
              {Array.from({ length: SKELETON_ROWS }, (_, i) => (
                <div
                  key={i}
                  className="animate-pulse rounded-xl border border-white/5 bg-zinc-900/60 px-3 py-2.5"
                >
                  <div className="h-3.5 w-3/4 rounded bg-zinc-800" />
                  <div className="mt-2 flex gap-2">
                    <div className="h-2.5 w-16 rounded bg-zinc-800/80" />
                    <div className="h-2.5 w-10 rounded bg-zinc-800/80" />
                    <div className="h-2.5 w-14 rounded bg-zinc-800/80" />
                  </div>
                </div>
              ))}
            </div>
          ) : fatalOrAllFailed ? (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3">
              <div className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0 text-red-400" />
                <p className="text-sm font-bold text-red-300">{errorHeadline}</p>
              </div>
              <p className="mt-1 break-words text-xs text-red-300/90">{errorDetail}</p>
              {reports.length > 0 && (
                <ul className="mt-2 space-y-0.5">
                  {reports.map((r) => (
                    <li key={r.providerId} className="break-words text-[11px] text-zinc-500">
                      {r.providerName}: {r.error ?? 'failed'}
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-3 border-t border-white/10 pt-3">{renderQueryEditor()}</div>
            </div>
          ) : reports.length === 0 ? (
            <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
              <Info className="h-4 w-4 shrink-0 text-amber-400" />
              <div className="min-w-0">
                <p className="text-sm font-bold text-amber-200">No active indexers.</p>
                <p className="mt-0.5 text-xs leading-relaxed text-amber-200/70">
                  Add RSS/Torznab providers in Settings → P2P &amp; Downloads.
                </p>
              </div>
            </div>
          ) : results.length === 0 ? (
            <div className="flex flex-col px-2 py-6">
              <div className="flex flex-col items-center text-center">
                <Search className="h-8 w-8 text-zinc-700" />
                <p className="mt-2 max-w-md break-words text-sm font-semibold text-zinc-400">
                  No torrents found for query: &ldquo;{activeQuery}&rdquo;
                </p>
                <p className="mt-1 text-xs text-zinc-500">
                  Try the Romaji title or remove episode numbers
                </p>
              </div>
              <div className="mt-4">{renderQueryEditor()}</div>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {failedReports.length > 0 && (
                <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                  <span
                    className="min-w-0 flex-1 truncate text-[11px] font-semibold text-amber-300"
                    title={`${failedReports.length} provider(s) failed: ${firstFailure}`}
                  >
                    {failedReports.length} provider{failedReports.length === 1 ? '' : 's'} failed:{' '}
                    {firstFailure}
                  </span>
                </div>
              )}
              {visible.length === 0 ? (
                <div className="flex flex-col items-center px-4 py-10 text-center">
                  {tab === 'batches' ? (
                    <Package className="h-8 w-8 text-zinc-700" />
                  ) : (
                    <Search className="h-8 w-8 text-zinc-700" />
                  )}
                  <p className="mt-2 text-sm font-semibold text-zinc-400">{TAB_EMPTY_TEXT[tab]}</p>
                </div>
              ) : (
                visible.map((item, index) => {
                  const { result, parsed, classification } = item
                  const chips = buildReleaseChips(parsed)
                  const inspectionKey = `${result.providerId}|${result.downloadUrl}`
                  const inspection = inspectionState[inspectionKey]
                  const needsInspection = classification.audioLabels.length === 0 || classification.subtitleLabel == null
                  const languageBadges = classification.languageGroup === 'eng-dub-dubtitles'
                    ? ['English Dub', 'Dubtitles']
                    : classification.languageGroup === 'eng-dub-subs'
                      ? ['English Dub', 'English Subs']
                      : classification.languageGroup === 'eng-dub'
                        ? ['English Dub']
                        : classification.languageGroup === 'japanese'
                          ? ['Japanese Audio']
                          : classification.languageGroup === 'other'
                            ? [...classification.audioLabels, ...(classification.subtitleLabel ? [classification.subtitleLabel] : [])]
                            : []
                  const languageBadgeClass = classification.rank <= 1
                    ? 'border border-emerald-400/25 bg-emerald-500/15 text-emerald-200'
                    : classification.languageGroup === 'eng-dub'
                      ? 'border border-sky-400/25 bg-sky-500/15 text-sky-200'
                      : classification.languageGroup === 'japanese'
                        ? 'border border-violet-400/25 bg-violet-500/15 text-violet-200'
                        : 'border border-amber-400/25 bg-amber-500/10 text-amber-200'
                  return (
                    <div
                      key={`${result.providerId}-${result.downloadUrl}-${index}`}
                      onClick={() => onPicked(result)}
                      className="cursor-pointer rounded-xl border border-white/10 bg-zinc-900/70 px-3 py-2.5 transition-colors hover:border-zinc-600/80 hover:bg-zinc-800/70"
                    >
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <p
                            className="line-clamp-2 text-sm font-medium text-zinc-100"
                            title={result.title}
                          >
                            {result.title}
                          </p>
                          {classification.hasLanguageInfo && (
                            <div className="mt-1.5 flex flex-wrap items-center gap-1">
                              {classification.kindLabel && (
                                <span className="rounded border border-indigo-300/25 bg-indigo-500/15 px-1.5 py-0.5 text-[10px] font-bold text-indigo-200">
                                  {classification.kindLabel}
                                </span>
                              )}
                              {languageBadges.map((label) => (
                                <span key={label} className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${languageBadgeClass}`}>
                                  {label}
                                </span>
                              ))}
                            </div>
                          )}
                          {classification.hasLanguageInfo && chips.length > 0 && (
                            <div className="mt-1 flex flex-wrap items-center gap-1">
                              {chips.map((chip, chipIndex) => (
                                <span
                                  key={`${chip.label}-${chipIndex}`}
                                  className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${chip.className}`}
                                >
                                  {chip.label}
                                </span>
                              ))}
                            </div>
                          )}
                          {result.sizeWarning && (
                            <p className="mt-1.5 flex items-center gap-1 text-[10px] font-semibold text-amber-300" title={result.sizeWarning}>
                              <AlertTriangle className="h-3 w-3 shrink-0" />
                              {result.sizeWarning}
                            </p>
                          )}
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
                            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-400">
                              {result.providerName}
                            </span>
                            <span
                              className="flex items-center gap-0.5 font-semibold text-emerald-400"
                              title="Seeders"
                            >
                              <ArrowDown className="h-3 w-3" />
                              {result.seeders != null ? result.seeders : '—'}
                            </span>
                            {result.leechers != null && (
                              <span
                                className="flex items-center gap-0.5 text-zinc-500"
                                title="Leechers"
                              >
                                <ArrowUp className="h-3 w-3" />
                                {result.leechers}
                              </span>
                            )}
                            <span className="text-zinc-400">
                              {result.sizeBytes != null ? formatFileSize(result.sizeBytes) : '—'}
                            </span>
                          </div>
                          {needsInspection && result.detailsUrl && (
                            <div className="mt-1.5">
                              <button
                                type="button"
                                disabled={inspection?.loading}
                                onClick={(event) => { event.stopPropagation(); void checkReleaseDescription(result) }}
                                className="rounded-md border border-indigo-400/25 bg-indigo-500/10 px-2 py-1 text-[10px] font-bold text-indigo-200 transition hover:bg-indigo-500/20 disabled:cursor-wait disabled:opacity-60"
                              >
                                {inspection?.loading ? 'Checking description…' : inspection?.error ? 'Retry description check' : 'Check release description'}
                              </button>
                              {inspection?.error && <p className="mt-1 text-[10px] leading-snug text-amber-300/90">{inspection.error}</p>}
                            </div>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            onPicked(result)
                          }}
                          className="flex shrink-0 select-none items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-bold text-red-300 transition-colors hover:bg-red-500/20 active:scale-[0.98]"
                        >
                          <Download className="h-3.5 w-3.5" />
                          <span>Download</span>
                        </button>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          )}
        </div>

        {/* Footer note */}
        <div className="border-t border-white/10 px-5 py-3">
          <p className="text-[11px] text-zinc-500">
            Downloads go to your library folder on disk. Files are never streamed.
          </p>
        </div>
      </div>
    </div>
  )
}
