/**
 * AnimeDetailView: the unified full-screen title page of the hybrid design.
 * Merges local library data (scanned folders, playback history, user list)
 * with remote catalog details (AniList) and remote episode metadata (ani.zip):
 * hero banner/poster, meta chips, local tech tags, list-status + score
 * controls, and a single episode list merging local files with remote rows.
 * Purely local titles (no AniList id) render without any remote fetches.
 */
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { AlertTriangle, Bell, BellRing, Check, CheckCircle, ChevronDown, Compass, Copy, Download, Film, Heart, Play, Plus, Star, Trash2, Wand2, X } from 'lucide-react'
import { DownloadFolderMenu } from '../common/DownloadFolderMenu'
import type {
  AnimeFolder,
  AppSettings,
  CatalogItem,
  CatalogRelatedTitle,
  FranchiseSeasonInfo,
  Episode,
  HeroBannerSources,
  P2pState,
  PlaybackProgress,
  ReleaseSearchResult,
  RemoteEpisodeInfo,
  UserLibraryEntry,
  UserListStatus,
} from '../../types'
import type { RailItem } from '../../hooks/useCatalog'
import type { FavouriteAnime, FollowedAnime } from '../../types/notifications'
import { findAllLocalFolders, mergeLocalFolders, useLocalStatus } from '../../hooks/useLocalStatus'
import { useUserLibrary } from '../../hooks/useUserLibrary'
import { StatusBadges } from '../common/StatusBadges'
import { DownloadActionButton } from '../common/DownloadActionButton'
import { ReleasePickerModal } from '../P2P/ReleasePickerModal'
import { detectSeasonFromTitle } from '../../lib/releaseParser/releaseClassification.ts'
import { EpisodeRow } from './EpisodeRow'
import { resolveAnimeTitle } from '../../utils/title'
import {
  buildCatalogSearchAliases,
  computeOngoingDownloadPlan,
  inferReleasePreferenceFromEpisodes,
  parseNumericEpisodeNumber,
  pickAutomaticSeasonRelease,
  readAnimeReleasePreference,
  recordPickedReleasePreference,
  type QueuedEpisodeDownload,
} from '../../utils/releaseSelection'
import { buildHeroBannerCandidates, invalidateResolvedHeroBanner, useResolvedHeroBanner } from '../../utils/heroBanner'
// CRITICAL: import the wasm-free regex engine directly — never from
// ../../lib/releaseParser/index.ts, which pulls native/wasm deps unsuitable
// for the renderer process.
import { parseReleaseCore } from '../../lib/releaseParser/regexEngine.ts'
import { formatFileSize, formatRelativeAirDate, formatTime, isFolderMovie } from '../../utils/format'
import { normalizeAgeRating } from '../../utils/ageRating'
import { useAgeRatings } from '../../hooks/useAgeRatings'
import { showGlobalToast } from '../Toast'

export type DetailSource = { kind: 'catalog'; item: RailItem } | { kind: 'local'; folder: AnimeFolder }

type CachedRemoteArtwork = {
  bannerUrl: string | null
  fallbackBannerUrl: string | null
  kitsuBannerUrl: string | null
  tvdbSeasonBannerUrl: string | null
  aniListBannerUrl: string | null
  posterUrl: string | null
}
const EMPTY_REMOTE_ARTWORK: CachedRemoteArtwork = {
  bannerUrl: null,
  fallbackBannerUrl: null,
  kitsuBannerUrl: null,
  tvdbSeasonBannerUrl: null,
  aniListBannerUrl: null,
  posterUrl: null,
}
const remoteArtworkCache = new Map<number, CachedRemoteArtwork>()

export interface AnimeDetailViewProps {
  source: DetailSource
  folders: AnimeFolder[]
  history: Record<string, PlaybackProgress>
  userEntries: Record<number, UserLibraryEntry>
  onClose: () => void
  onPlayEpisode: (episode: Episode, startAt?: number) => void
  onLibraryChanged?: () => void
  onOpenWhisper: (folder: AnimeFolder) => void
  initialDownloadEpisode?: number | null
  settings: AppSettings
  p2pState: P2pState | null
  onOpenRelated: (item: CatalogRelatedTitle) => void
  isFollowing: boolean
  followEntry?: FollowedAnime | null
  onToggleFollow: (anime: FollowedAnime, follow: boolean) => void
  onToggleFollowAutoDownload?: (anilistId: number, autoDownload: boolean, preferredDownloadRoot?: string | null) => void
  enqueueEpisodeDownloads?: (items: QueuedEpisodeDownload[]) => void
  queuedEpisodeNumbers?: number[]
  manualPickRequestEpisode?: number | null
  onClearManualPickRequest?: () => void
  isFavourite: boolean
  onToggleFavourite: (anime: FavouriteAnime, favourite: boolean) => void
  onUserEntryChange?: (entry: UserLibraryEntry) => void
  onUserEntryRemove?: (anilistId: number) => void
  onBackdropProgressChange?: (progress: number) => void
  onSelectGenre?: (genre: string) => void
}

interface MergedEpisodeRow {
  num: number
  local?: Episode
  remote?: RemoteEpisodeInfo
}

// Episode grid page size: 4 rows of 4 tiles at full width.
const EPISODES_PER_PAGE = 16

const STATUS_OPTIONS: { value: UserListStatus; label: string }[] = [
  { value: 'watching', label: 'Watching' },
  { value: 'completed', label: 'Completed' },
  { value: 'planning', label: 'Planning' },
  { value: 'paused', label: 'Paused' },
  { value: 'dropped', label: 'Dropped' },
]

const STATUS_THEME: Record<
  UserListStatus,
  { label: string; dotColor: string; activeBorder: string; activeBg: string; activeText: string }
> = {
  watching: {
    label: 'Watching',
    dotColor: 'bg-emerald-400',
    activeBorder: 'border-emerald-500/35',
    activeBg: 'bg-gradient-to-r from-emerald-500/20 to-teal-500/20',
    activeText: 'text-emerald-200',
  },
  completed: {
    label: 'Completed',
    dotColor: 'bg-violet-400',
    activeBorder: 'border-violet-500/35',
    activeBg: 'bg-gradient-to-r from-violet-500/20 to-purple-500/20',
    activeText: 'text-violet-200',
  },
  planning: {
    label: 'Planning',
    dotColor: 'bg-amber-400',
    activeBorder: 'border-amber-500/35',
    activeBg: 'bg-gradient-to-r from-amber-500/20 to-yellow-500/20',
    activeText: 'text-amber-200',
  },
  paused: {
    label: 'Paused',
    dotColor: 'bg-orange-400',
    activeBorder: 'border-orange-500/35',
    activeBg: 'bg-gradient-to-r from-orange-500/20 to-amber-500/20',
    activeText: 'text-orange-200',
  },
  dropped: {
    label: 'Dropped',
    dotColor: 'bg-rose-400',
    activeBorder: 'border-rose-500/35',
    activeBg: 'bg-gradient-to-r from-rose-500/20 to-red-500/20',
    activeText: 'text-rose-200',
  },
}

const DOWNLOAD_TOOLTIP = 'Connect the P2P indexers in Settings to download this title'

function statusChipClass(status: string): string {
  switch (status) {
    case 'RELEASING':
      return 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300'
    case 'FINISHED':
      return 'border-zinc-500/30 bg-zinc-500/15 text-zinc-300'
    case 'NOT_YET_RELEASED':
      return 'border-sky-500/30 bg-sky-500/15 text-sky-300'
    case 'HIATUS':
      return 'border-amber-500/30 bg-amber-500/15 text-amber-300'
    default:
      return 'border-zinc-700/60 bg-zinc-800/80 text-zinc-300'
  }
}

/** Strips AniList HTML markup (<br>, <i>, ...) from descriptions. */
function stripHtml(raw: string | null | undefined): string | null {
  if (!raw) return null
  const text = raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return text || null
}

function animeTitleKey(value: string): string {
  return value.toLocaleLowerCase().replace(/\b(season|s)\s*\d+\b/g, '').replace(/[^\p{L}\p{N}]+/gu, '')
}

function torrentJobForEpisode(jobs: P2pState['jobs'], anilistId: number | null, episode: number) {
  if (anilistId == null) return undefined
  return jobs.find((job) => {
    if (job.anilistId !== anilistId) return false
    if (job.episodes?.includes(episode) || job.episode === episode) return true
    if (job.episode == null && !job.episodes) return true
    return job.episode == null && (job.filesProgress || []).some((file) => {
      const parsed = parseReleaseCore(file.name)
      return parsed.episodeNumbers.includes(episode) || parsed.episodeNumber === episode
    })
  })
}

const MetaChip: React.FC<{ children: React.ReactNode; className?: string; title?: string }> = ({ children, className, title }) => (
  <span
    title={title}
    className={`inline-flex items-center gap-1 rounded-full border border-white/10 bg-black/40 px-2 py-0.5 text-xs font-semibold text-zinc-200 backdrop-blur-sm ${className || ''}`}
  >
    {children}
  </span>
)

const AnimeDetailViewImpl: React.FC<AnimeDetailViewProps> = ({
  source,
  folders,
  history,
  userEntries,
  onClose,
  onPlayEpisode,
  onLibraryChanged,
  onOpenWhisper,
  initialDownloadEpisode,
  settings,
  p2pState,
  onOpenRelated,
  isFollowing,
  followEntry,
  onToggleFollow,
  onToggleFollowAutoDownload,
  enqueueEpisodeDownloads,
  queuedEpisodeNumbers,
  manualPickRequestEpisode,
  onClearManualPickRequest,
  isFavourite,
  onToggleFavourite,
  onUserEntryChange,
  onUserEntryRemove,
  onBackdropProgressChange,
  onSelectGenre,
}) => {
  const [details, setDetails] = useState<CatalogItem | null>(null)
  // Hero description expand-on-click (clamped to 3 lines by default). The
  // marker lives OUTSIDE the clamped paragraph — an inline "…more" span sits
  // past the clamp cut and would never be visible.
  const descriptionRef = useRef<HTMLParagraphElement | null>(null)
  const [descriptionClamped, setDescriptionClamped] = useState(false)
  const [descriptionReaderOpen, setDescriptionReaderOpen] = useState(false)
  const [relatedTitles, setRelatedTitles] = useState<CatalogRelatedTitle[]>([])
  const [franchiseSeasonInfo, setFranchiseSeasonInfo] = useState<FranchiseSeasonInfo | null>(null)
  const [franchiseSeasonLoaded, setFranchiseSeasonLoaded] = useState(false)
  const [relatedLoading, setRelatedLoading] = useState(false)
  const [remoteEpisodes, setRemoteEpisodes] = useState<RemoteEpisodeInfo[]>([])
  // Airing pointer shipped with the episodes payload (computed at fetch time,
  // refreshed when an episode boundary passes). Keeps the grid capped even
  // when the separate details request fails or is still in flight.
  const [remoteAiredThrough, setRemoteAiredThrough] = useState<number | null>(null)
  // Series artwork from the episodes payload (Kitsu/AniList/Metahub/TVDB) —
  // resolved cleanly via shared useResolvedHeroBanner so Home & Card show the exact
  // same crisp artwork with zero pop-in replacement jumps.
  const [remoteArtworkState, setRemoteArtworkState] = useState<{ id: number | null } & CachedRemoteArtwork>({ id: null, ...EMPTY_REMOTE_ARTWORK })
  const [copiedTitleText, setCopiedTitleText] = useState<string | null>(null)
  const copyResetTimerRef = useRef<number | null>(null)
  const relatedWarmTimerRef = useRef<number | null>(null)
  const [remoteEpisodesLoading, setRemoteEpisodesLoading] = useState(false)
  const [settledBannerAnimeId, setSettledBannerAnimeId] = useState<number | null>(null)
  const [detailsLoading, setDetailsLoading] = useState(false)
  const [bannerFailed, setBannerFailed] = useState(false)
  const [posterBgFailed, setPosterBgFailed] = useState(false)
  const [posterFailed, setPosterFailed] = useState(false)
  const [posterAspect, setPosterAspect] = useState<{ url: string; ratio: number } | null>(null)
  const [artworkHue, setArtworkHue] = useState<number | null>(null)
  // Episodes are shown in pages of 16 (4 rows) so a 100-episode season does
  // not mean 100 API-driven tiles and endless scrolling.
  const [episodePage, setEpisodePage] = useState(1)

  // Files-only deletion state (season or single episode). Deleted episode
  // paths are filtered out of the merged list immediately; the library refresh
  // syncs the rest of the app with the new on-disk reality.
  const [confirmDeleteSeason, setConfirmDeleteSeason] = useState(false)
  const [confirmDeleteEpisode, setConfirmDeleteEpisode] = useState<Episode | null>(null)
  const [removedPaths, setRemovedPaths] = useState<Set<string>>(() => new Set())
  const [deleteBusy, setDeleteBusy] = useState(false)
  // Inline 'Completed!' suggestion after picking the Completed list status.
  const [completedSuggestion, setCompletedSuggestion] = useState(false)
  const completedPromptedRef = useRef(false)

  // Release picker: null = closed; { episode: null } = whole season / pack.
  const [pickerState, setPickerState] = useState<{ episode: number | null } | null>(null)
  const [queueing, setQueueing] = useState(false)
  const [selectedDownloadRoot, setSelectedDownloadRoot] = useState<string | null>(null)
  const initialDownloadStartedRef = useRef<string | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  // Episodes section heading; page changes scroll back here so the first rows
  // of the new page are visible instead of the pager at the bottom.
  const episodesSectionRef = useRef<HTMLElement>(null)
  // Set by the pager buttons; the post-render effect below consumes it, so the
  // scroll happens against the already-rendered new page (a synchronous
  // scrollIntoView in onClick gets cancelled by the grid re-render).
  const scrollEpisodesOnPageChange = useRef(false)

  const railItem = source.kind === 'catalog' ? source.item : null

  // Merge local folders matching this title across all configured library roots
  // so downloading newer ongoing episodes to a second drive keeps one list.
  const matchedLocalFolders = useMemo(() => {
    if (source.kind === 'local') {
      const id = source.folder.anilistId
      const title = source.folder.canonicalTitle || source.folder.folderName
      const matches = findAllLocalFolders(folders, { anilistId: id, title })
      if (matches.length === 0) return [source.folder]
      return [source.folder, ...matches.filter((f) => f.folderPath !== source.folder.folderPath)]
    }
    return findAllLocalFolders(folders, { anilistId: source.item.anilistId, title: source.item.title })
  }, [source, folders])

  const localFolder = useMemo(
    () => mergeLocalFolders(matchedLocalFolders),
    [matchedLocalFolders],
  )

  // Remote fetches happen for catalog items and for local folders that carry
  // an AniList id; purely local titles skip all network calls.
  const anilistId =
    source.kind === 'catalog' ? source.item.anilistId : (localFolder?.anilistId ?? null)

  // The detail overlay is reused for new titles, so reset its own scroll offset
  // synchronously. Otherwise a previously scrolled page can open with the hero
  // heading hidden underneath the fixed navbar.
  useLayoutEffect(() => {
    if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0
  }, [anilistId, source.kind])

  // P2P download flows: enabled only when the renderer API exposes release
  // search AND the title resolves to an AniList id for the indexer queries.
  const p2pAvailable =
    typeof window.electronAPI?.searchReleases === 'function' &&
    typeof window.electronAPI?.addDownload === 'function'
  const canDownload = p2pAvailable && anilistId != null

  // Season hint for release searches: parsed from the first local file name
  // (catalog-only titles search without a season filter).
  const parsedSeason = useMemo(() => {
    const firstFile = localFolder?.episodes.find((ep) => !!ep?.fileName)
    if (!firstFile?.fileName) return null
    return parseReleaseCore(firstFile.fileName).season
  }, [localFolder])

  const { statusFor } = useLocalStatus(folders, history, userEntries)
  // Mutators only: reads come from the userEntries prop (plus this instance's
  // optimistic entries so the score control enables right after a status pick).
  const userLibrary = useUserLibrary()

  // Escape closes the overlay (unless a consumer already handled the event).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return

      // Do not close AnimeDetailView if a modal or dialog is open (e.g. SettingsModal)
      const isModalOpen = Boolean(
        document.querySelector('[role="dialog"]') ||
        document.querySelector('[data-modal="true"]') ||
        document.querySelector('.glass-dropdown')
      )
      if (isModalOpen) return

      if (descriptionReaderOpen) {
        e.preventDefault()
        e.stopImmediatePropagation()
        setDescriptionReaderOpen(false)
        return
      }
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, descriptionReaderOpen])

  // Reset per-title deletion / suggestion state when another title is opened.
  useEffect(() => {
    setConfirmDeleteSeason(false)
    setConfirmDeleteEpisode(null)
    setCompletedSuggestion(false)
    setRemovedPaths(new Set())
    setPickerState(null)
    setQueueing(false)
    setEpisodePage(1)
    setDescriptionReaderOpen(false)
    completedPromptedRef.current = false
  }, [source])

  // Remote details + episode metadata for the resolved AniList id.
  useEffect(() => {
    if (anilistId == null) {
      setDetails(null)
      setRelatedTitles([])
      setFranchiseSeasonInfo(null)
      setFranchiseSeasonLoaded(false)
      setRemoteEpisodes([])
      setRemoteAiredThrough(null)
      setRemoteArtworkState({ id: null, ...EMPTY_REMOTE_ARTWORK })
      setCopiedTitleText(null)
      setDetailsLoading(false)
      setRelatedLoading(false)
      setEpisodePage(1)
      return
    }
    let cancelled = false
    let unsubscribeUpdates: (() => void) | undefined
    const cachedArtwork = remoteArtworkCache.get(anilistId) ?? EMPTY_REMOTE_ARTWORK
    setDetails(null)
    setRelatedTitles([])
    setFranchiseSeasonInfo(null)
    setFranchiseSeasonLoaded(false)
    setRemoteEpisodes([])
    setRemoteAiredThrough(null)
    setRemoteArtworkState({ id: anilistId, ...cachedArtwork })
    setCopiedTitleText(null)
    setDetailsLoading(true)
    setRemoteEpisodesLoading(true)
    setRelatedLoading(true)
    setEpisodePage(1)
    const load = async () => {
      const api = window.electronAPI
      if (!api) {
        if (!cancelled) {
          setDetails(null)
          setRelatedTitles([])
          setRemoteEpisodes([])
          setFranchiseSeasonLoaded(true)
          setDetailsLoading(false)
          setRemoteEpisodesLoading(false)
          setSettledBannerAnimeId(anilistId)
          setRelatedLoading(false)
        }
        return
      }
      const applyArtwork = (sourceData?: Partial<HeroBannerSources> | null) => {
        if (cancelled || !sourceData) return
        setRemoteArtworkState((prev) => {
          const sameId = prev.id === anilistId
          const artwork: CachedRemoteArtwork = {
            bannerUrl: sourceData.bannerUrl ?? (sameId ? prev.bannerUrl : null),
            fallbackBannerUrl: sourceData.fallbackBannerUrl ?? (sameId ? prev.fallbackBannerUrl : null),
            kitsuBannerUrl: sourceData.kitsuBannerUrl ?? (sameId ? prev.kitsuBannerUrl : null),
            tvdbSeasonBannerUrl: sourceData.tvdbSeasonBannerUrl ?? (sameId ? prev.tvdbSeasonBannerUrl : null),
            aniListBannerUrl: sourceData.aniListBannerUrl ?? (sameId ? prev.aniListBannerUrl : null),
            posterUrl: sourceData.posterUrl ?? (sameId ? prev.posterUrl : null),
          }
          if (artwork.bannerUrl || artwork.fallbackBannerUrl || artwork.kitsuBannerUrl || artwork.tvdbSeasonBannerUrl || artwork.aniListBannerUrl || artwork.posterUrl) {
            remoteArtworkCache.set(anilistId, artwork)
          }
          return { id: anilistId, ...artwork }
        })
      }
      const hasFastHeroApi = Boolean(api.getFastHeroBannerSources)
      if (api.getFastHeroBannerSources) {
        void api.getFastHeroBannerSources(anilistId)
          .then((result) => applyArtwork(result))
          .catch(() => {})
          .finally(() => {
            if (!cancelled) setSettledBannerAnimeId(anilistId)
          })
      }
      void api.getCatalogDetails(anilistId).then((result) => {
        if (!cancelled) setDetails(result ?? null)
      }).catch((error) => {
        console.warn('[Anime overview] AniList details failed:', error)
      }).finally(() => {
        if (!cancelled) setDetailsLoading(false)
      })
      void api.getRemoteEpisodes(anilistId).then((result) => {
        if (cancelled) return
        setRemoteEpisodes(Array.isArray(result?.episodes) ? result.episodes : [])
        setRemoteAiredThrough(typeof result?.airedThrough === 'number' ? result.airedThrough : null)
        applyArtwork(result)
      }).catch((error) => {
        console.warn('[Anime overview] Episode metadata failed:', error)
      }).finally(() => {
        if (!cancelled) {
          setRemoteEpisodesLoading(false)
          if (!hasFastHeroApi) setSettledBannerAnimeId(anilistId)
        }
      })
      // Progressive pushes: the pipeline delivers its first usable snapshot
      // (~1 s), then hedge/retry/fallback improvements — apply each payload
      // in place so titles/thumbnails pop in without blocking the page.
      unsubscribeUpdates = api.onRemoteEpisodesUpdated?.((updatedId, result) => {
        if (cancelled || updatedId !== anilistId || !result) return
        setRemoteEpisodes(Array.isArray(result.episodes) ? result.episodes : [])
        setRemoteAiredThrough(typeof result.airedThrough === 'number' ? result.airedThrough : null)
        applyArtwork(result)
      })
      void api.getCatalogFranchise(anilistId).then((result) => {
        if (!cancelled) setRelatedTitles(Array.isArray(result) ? result : [])
      }).catch((error) => {
        console.warn('[Anime overview] Related titles failed:', error)
        if (!cancelled) setRelatedTitles([])
      }).finally(() => {
        if (!cancelled) setRelatedLoading(false)
      })
      if (api.getCatalogFranchiseSeasons) {
        void api.getCatalogFranchiseSeasons(anilistId).then((result) => {
          if (!cancelled) setFranchiseSeasonInfo(result ?? null)
        }).catch((error) => {
          console.warn('[Anime overview] Franchise season chain failed:', error)
          if (!cancelled) setFranchiseSeasonInfo(null)
        }).finally(() => {
          if (!cancelled) setFranchiseSeasonLoaded(true)
        })
      } else {
        setFranchiseSeasonLoaded(true)
      }
    }
    void load()
    return () => {
      cancelled = true
      unsubscribeUpdates?.()
    }
  }, [anilistId])

  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current != null) window.clearTimeout(copyResetTimerRef.current)
    }
  }, [])

  const handleCopyTitle = (text: string, label: string) => {
    const clean = text.trim()
    if (!clean) return
    navigator.clipboard?.writeText(clean)
      .then(() => {
        setCopiedTitleText(clean)
        if (copyResetTimerRef.current != null) window.clearTimeout(copyResetTimerRef.current)
        copyResetTimerRef.current = window.setTimeout(() => setCopiedTitleText(null), 1600)
        showGlobalToast(`${label} copied to clipboard`, 'success', 1800)
      })
      .catch(() => {})
  }

  // Unified hero backdrop resolution (shared with UpNextWidget): prioritizes
  // crisp >=680px per-season artwork (Kitsu HD / AniList HD), then Full-HD
  // franchise backdrops (Metahub 1080p-4K / TVDB Fanart), settling cleanly
  // before display so uncached pages never flash Banner A -> Banner B.
  const entryIdMal = anilistId != null ? userEntries[anilistId]?.idMal ?? null : null
  const resolvedRemoteArtwork = (remoteArtworkState.id === anilistId ? remoteArtworkState : null) ??
    (anilistId != null ? remoteArtworkCache.get(anilistId) ?? null : null)
  const heroBannerCandidates = useMemo(
    () =>
      buildHeroBannerCandidates(
        [
          resolvedRemoteArtwork?.kitsuBannerUrl,
          resolvedRemoteArtwork?.tvdbSeasonBannerUrl,
          resolvedRemoteArtwork?.aniListBannerUrl,
          details?.bannerUrl,
          railItem?.bannerUrl,
          localFolder?.bannerUrl,
        ],
        [
          resolvedRemoteArtwork?.bannerUrl,
          resolvedRemoteArtwork?.fallbackBannerUrl,
        ],
      ),
    [resolvedRemoteArtwork, details?.bannerUrl, railItem?.bannerUrl, localFolder?.bannerUrl],
  )
  const { bannerUrl: resolvedBannerUrl, ready: bannerReady } = useResolvedHeroBanner({
    anilistId,
    settled: anilistId == null || typeof window === 'undefined' || settledBannerAnimeId === anilistId,
    candidates: heroBannerCandidates,
  })
  const activeBannerUrl = !bannerFailed ? resolvedBannerUrl : null

  const hero = useMemo(() => {
    const fallbackTitle = railItem?.title || localFolder?.canonicalTitle || localFolder?.folderName || ''
    const titlePreference = settings?.animeTitleLanguage ?? 'english'
    const title = details
      ? resolveAnimeTitle(details.title, details.synonyms, titlePreference) || fallbackTitle
      : fallbackTitle

    const secondaryTitles: string[] = []
    if (details?.title) {
      const ordered = titlePreference === 'english'
        ? [details.title.romaji, details.title.native]
        : titlePreference === 'romaji'
          ? [details.title.english, details.title.native]
          : [details.title.english, details.title.romaji]
      const seen = new Set<string>([title.trim().toLowerCase()])
      for (const candidate of ordered) {
        const clean = candidate?.trim()
        if (!clean) continue
        const key = clean.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        secondaryTitles.push(clean)
      }
    }
    const secondaryTitle = secondaryTitles.length > 0 ? secondaryTitles.join(' · ') : null

    return {
      title,
      secondaryTitle,
      secondaryTitles,
      bannerUrl: activeBannerUrl,
      posterUrl: details?.posterUrl ?? railItem?.posterUrl ?? localFolder?.posterUrl ?? resolvedRemoteArtwork?.posterUrl ?? null,
      averageScore: details?.averageScore ?? railItem?.averageScore ?? localFolder?.averageScore ?? null,
      episodesCount: details?.episodesCount ?? railItem?.episodesCount ?? null,
      totalEpisodes: localFolder?.totalEpisodes ?? 0,
      format: details?.format ?? railItem?.format ?? null,
      status: details?.status ?? railItem?.status ?? null,
      seasonYear: details?.seasonYear ?? railItem?.seasonYear ?? null,
      nextAiringEpisodeNumber: details?.nextAiringEpisode?.episode ?? railItem?.airingEpisode ?? null,
      genres: details?.genres ?? localFolder?.genres ?? [],
      description: stripHtml(details?.description ?? localFolder?.synopsis ?? null),
      idMal: details?.idMal ?? railItem?.idMal ?? entryIdMal ?? null,
    }
  }, [details, railItem, localFolder, activeBannerUrl, resolvedRemoteArtwork, entryIdMal, settings?.animeTitleLanguage])
  const posterAspectRatio = posterAspect?.url === hero.posterUrl ? posterAspect.ratio : 2 / 3

  // Read a tiny downsample of the banner when the image host permits canvas
  // access. If it does not, the deterministic title hue below remains the
  // fallback and the actual banner still renders normally.
  useEffect(() => {
    setArtworkHue(null)
    const source = hero.bannerUrl || hero.posterUrl
    if (!source) return
    let cancelled = false
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = 24
        canvas.height = 24
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (!context) return
        context.drawImage(image, 0, 0, 24, 24)
        const pixels = context.getImageData(0, 0, 24, 24).data
        const bins = Array.from({ length: 18 }, () => 0)
        for (let i = 0; i < pixels.length; i += 4) {
          const r = pixels[i] / 255, g = pixels[i + 1] / 255, b = pixels[i + 2] / 255
          const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min
          const light = (max + min) / 2
          if (delta < 0.08 || light < 0.14 || light > 0.9) continue
          let hue = 0
          if (max === r) hue = ((g - b) / delta) % 6
          else if (max === g) hue = (b - r) / delta + 2
          else hue = (r - g) / delta + 4
          hue = (hue * 60 + 360) % 360
          const saturation = delta / (1 - Math.abs(2 * light - 1))
          bins[Math.floor(hue / 20) % bins.length] += saturation * (1 - Math.abs(light - 0.5))
        }
        const strongest = bins.indexOf(Math.max(...bins))
        if (!cancelled && strongest >= 0 && bins[strongest] > 0) setArtworkHue(strongest * 20 + 10)
      } catch {
        // Cross-origin hosts may deny canvas reads. Keep the fallback hue.
      }
    }
    image.src = source
    return () => { cancelled = true }
  }, [hero.bannerUrl, hero.posterUrl])

  // Give each title a stable accent so the detail page borrows its own
  // atmosphere instead of using the same violet treatment for every anime.
  const animeHue = useMemo(() => {
    const seed = `${anilistId ?? ''}:${hero.title}`
    let hash = 2166136261
    for (let i = 0; i < seed.length; i++) hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619)
    return (hash >>> 0) % 360
  }, [anilistId, hero.title])
  const themeHue = artworkHue ?? animeHue
  const animeThemeStyle = {
    '--anime-hue': themeHue,
      '--anime-accent': `hsl(${themeHue} 78% 62%)`,
      '--anime-accent-soft': `hsla(${themeHue} 78% 62% / .16)`,
  } as React.CSSProperties
  const isFeatureFilm = hero.format
    ? hero.format.toUpperCase() === 'MOVIE'
    : Boolean(localFolder && isFolderMovie(localFolder))

  const ageRatingItems = useMemo(() => [{ idMal: hero.idMal }], [hero.idMal])
  const { ratings: ageRatings } = useAgeRatings(ageRatingItems)
  const ageRating = normalizeAgeRating(hero.idMal == null ? null : ageRatings[hero.idMal])

  // Detect whether the synopsis needs a separate reader, leaving the hero
  // height and action row fixed regardless of the full text length.
  useEffect(() => {
    const el = descriptionRef.current;
    if (!el) {
      setDescriptionClamped(false)
      return
    }
    const updateOverflow = () => setDescriptionClamped(el.scrollHeight > el.clientHeight + 1)
    updateOverflow()
    const observer = new ResizeObserver(updateOverflow)
    observer.observe(el)
    return () => observer.disconnect()
  }, [hero.description]);

  const seasonHint = useMemo(() => {
    if (isFeatureFilm) return null
    return franchiseSeasonInfo?.ownSeason ?? detectSeasonFromTitle(hero.title) ?? parsedSeason
  }, [isFeatureFilm, parsedSeason, hero.title, franchiseSeasonInfo?.ownSeason])

  const franchiseSeasonTitles = useMemo(
    () => (isFeatureFilm ? [] : (franchiseSeasonInfo?.chain ?? [])),
    [isFeatureFilm, franchiseSeasonInfo],
  )

  const partHint = useMemo(() => {
    const match = /\b(?:part|cour)\s*0*(\d{1,2})\b/i.exec(hero.title)
    const part = Number(match?.[1])
    return Number.isInteger(part) && part > 0 ? part : null
  }, [hero.title])

  // Alias titles (romaji/english) for release searches: deduped case-
  // insensitively and minus the display title that is already searched as the
  // primary query. Memoized so ReleasePickerModal's search effect (which keys
  // on the aliases identity) does not re-run on every render.
  const searchAliases = useMemo(
    () => buildCatalogSearchAliases(hero.title, details, relatedTitles),
    [details, hero.title, relatedTitles],
  )

  const contentTitleAliases = useMemo(() => {
    if (!details) return []
    return Array.from(new Set([details.title.english, details.title.romaji, ...(details.synonyms || [])]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)))
  }, [details])

  useEffect(() => {
    setBannerFailed(false)
  }, [resolvedBannerUrl])

  useEffect(() => {
    setPosterBgFailed(false)
    setPosterFailed(false)
  }, [hero.posterUrl])

  useEffect(() => () => {
    if (relatedWarmTimerRef.current != null) window.clearTimeout(relatedWarmTimerRef.current)
  }, [])

  const episodeTotal = hero.episodesCount ?? Math.max(
    hero.totalEpisodes,
    hero.nextAiringEpisodeNumber ? hero.nextAiringEpisodeNumber - 1 : 0,
  )

  // Episodes that have actually aired: ongoing titles announce the full season
  // (AniList `episodes` is the planned count), but only the episodes before
  // nextAiringEpisode exist — later rows have no releases yet. The episodes
  // payload carries its own airing pointer computed at fetch time and
  // refreshed at every episode boundary, so it wins over the 24 h-cached
  // details snapshot; the details fallback keeps the cap when that request
  // failed outright (e.g. AniList rate limiting at startup) — without it the
  // grid once filled the whole planned season with downloadable unaired rows.
  const detailsAiredThrough = useMemo(() => {
    if (details?.status === 'NOT_YET_RELEASED') return 0
    if (details?.status === 'RELEASING') {
      const next = details.nextAiringEpisode?.episode
      if (Number.isInteger(next) && (next as number) >= 1) return (next as number) - 1
    }
    return null
  }, [details])
  const airedThrough = remoteAiredThrough ?? detailsAiredThrough
  const ongoing = airedThrough != null || details?.status === 'RELEASING'
  const dateAiredThrough = useMemo(() => remoteEpisodes.reduce((max, episode) => {
    const airTime = episode.airDate ? Date.parse(episode.airDate) : Number.NaN
    return Number.isFinite(airTime) && airTime <= Date.now() ? Math.max(max, episode.number) : max
  }, 0), [remoteEpisodes])
  const releasedEpisodeCount = hero.status === 'FINISHED'
    ? (episodeTotal || dateAiredThrough)
    : hero.status === 'NOT_YET_RELEASED'
      ? 0
      : airedThrough ?? (dateAiredThrough > 0 ? dateAiredThrough : null)
  const followEligible = hero.status === 'RELEASING' || hero.status === 'NOT_YET_RELEASED'

  // Local episodes keyed by their parsed release number (fallback: index+1),
  // sorted ascending for both the merge and the resume target. Rows whose
  // files were deleted this session (removedPaths) drop out immediately.
  const localRows = useMemo(() => {
    return (localFolder?.episodes ?? [])
      .filter((episode) => !episode || !removedPaths.has(episode.filePath))
      .flatMap((episode, index) => {
        const parsed = episode?.fileName ? parseReleaseCore(episode.fileName) : null
        const num =
          typeof parsed?.episodeNumber === 'number' && Number.isFinite(parsed.episodeNumber)
            ? parsed.episodeNumber
            : index + 1
        if (episodeTotal > 0 && num > episodeTotal) return []
        if (seasonHint != null && parsed?.season != null && parsed.season !== seasonHint) return []
        return [{ episode, num }]
      })
      .sort((a, b) => a.num - b.num)
  }, [localFolder, removedPaths, episodeTotal, seasonHint])

  // Disk space the remaining local files occupy (drives the delete confirms).
  const seasonSizeBytes = useMemo(
    () => localRows.reduce((acc, row) => acc + (row.episode?.size || 0), 0),
    [localRows]
  )
  const downloadedCount = localRows.filter((row) => row.episode && !row.episode.isDownloading).length
  const downloadingCount = localRows.filter((row) => row.episode?.isDownloading).length
  const downloadedSeason = episodeTotal > 0 && downloadedCount >= episodeTotal && downloadingCount === 0
  const notYetReleased =
    !downloadedSeason &&
    downloadedCount === 0 &&
    (hero.status === 'NOT_YET_RELEASED' || releasedEpisodeCount === 0)

  // Resume target: first non-completed local episode, falling back to the
  // first episode for a full rewatch.
  const resumeEpisode = useMemo(() => {
    for (const row of localRows) {
      const ep = row.episode
      if (!ep || ep.isDownloading) continue
      if (!history[ep.filePath]?.completed) return ep
    }
    return localRows.map((row) => row.episode).find((ep) => ep && !ep.isDownloading) ?? null
  }, [localRows, history])

  const resumeProgress = resumeEpisode ? history[resumeEpisode.filePath] : undefined
  const resumeStartAt =
    resumeProgress && !resumeProgress.completed && resumeProgress.currentTime > 0
      ? resumeProgress.currentTime
      : undefined

  // Grid page number of the current (resume) episode, for auto-pagination.
  const resumeEpisodeNumber = useMemo(() => {
    if (!resumeEpisode) return null
    return localRows.find((row) => row.episode === resumeEpisode)?.num ?? null
  }, [resumeEpisode, localRows])

  // Jump the episode grid straight to the page holding the user's current
  // episode (first unfinished local file), so an 80-episode season does not
  // demand hunting through pages after every visit. Keyed on the title so it
  // re-runs on every open, after the page reset in the [source] effect above.
  useEffect(() => {
    if (!resumeEpisodeNumber) return
    const page = Math.floor((resumeEpisodeNumber - 1) / EPISODES_PER_PAGE) + 1
    if (page > 1) setEpisodePage(page)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, resumeEpisodeNumber])

  // Pre-warm subtitles and fonts for the target resume episode in background while browsing
  useEffect(() => {
    if (!resumeEpisode?.filePath || !window.electronAPI?.warmSubtitles) return;
    const timer = setTimeout(() => {
      window.electronAPI.warmSubtitles?.(resumeEpisode.filePath).catch(() => {});
    }, 600);
    return () => clearTimeout(timer);
  }, [resumeEpisode?.filePath]);

  // Merge local + remote by episode number: local supplies the file, remote
  // fills title/thumbnail/air date (whole rows for fileless episodes).
  const mergedRows = useMemo<MergedEpisodeRow[]>(() => {
    const byNum = new Map<number, MergedEpisodeRow>()
    for (const { episode, num } of localRows) {
      if (!episode) continue
      const existing = byNum.get(num)
      if (existing) existing.local = episode
      else byNum.set(num, { num, local: episode })
    }
    for (const remote of remoteEpisodes) {
      if (!remote || !Number.isFinite(remote.number)) continue
      // The payload is pre-curated upstream (aired rows + future schedule
      // rows; junk and wrong-season crosswalks already dropped), so past-the-
      // pointer rows render as unaired placeholders instead of disappearing.
      // Already-downloaded files stay visible even past the airing pointer.
      const existing = byNum.get(remote.number)
      if (existing) existing.remote = remote
      else byNum.set(remote.number, { num: remote.number, remote })
    }
    // AniList/ani.zip sometimes has no per-episode records for a title.
    // Render every planned episode as a numbered row so aired ones can be
    // downloaded instead of showing an empty season; for ongoing titles the
    // rows past the airing pointer become unaired schedule placeholders. The
    // fill waits for the airing pointer so a slow details request cannot
    // flash the whole unaired season with download buttons (the old bug) —
    // except for finished shows, where a long season renders its numbered
    // grid immediately instead of an empty "no episodes" stub (Black Clover:
    // 170 episodes took seconds of blank space before the payload landed).
    const finishedKnown = details?.status === 'FINISHED'
    if (episodeTotal > 0 && (airedThrough != null || finishedKnown || (!detailsLoading && !remoteEpisodesLoading))) {
      for (let number = 1; number <= episodeTotal; number += 1) {
        if (!byNum.has(number)) byNum.set(number, { num: number })
      }
    }
    return Array.from(byNum.values()).sort((a, b) => a.num - b.num)
  }, [localRows, remoteEpisodes, episodeTotal, airedThrough, details, detailsLoading, remoteEpisodesLoading])

  // Paged slice of the merged rows (4 rows of 4 tiles).
  const episodePageCount = Math.max(1, Math.ceil(mergedRows.length / EPISODES_PER_PAGE))
  const safeEpisodePage = Math.min(episodePage, episodePageCount)
  const visibleEpisodeRows = useMemo(
    () => mergedRows.slice((safeEpisodePage - 1) * EPISODES_PER_PAGE, safeEpisodePage * EPISODES_PER_PAGE),
    [mergedRows, safeEpisodePage]
  )

  // One-episode entries of ANY format (OVAs, specials, music videos, 1-ep
  // TV shorts) get the film treatment: the hero Play/Resume + Download
  // actions carry everything and a one-card "Episodes" grid would only
  // repeat them. Multi-episode OVAs keep the full episode grid — the
  // mergedRows guard makes the actual payload win over a bad AniList count.
  const isSingleEpisodeEntry = !isFeatureFilm && episodeTotal === 1 && mergedRows.length <= 1

  const queuedEpisodeSet = useMemo(() => new Set(queuedEpisodeNumbers ?? []), [queuedEpisodeNumbers])

  const ongoingPlan = useMemo(() => {
    const downloadedEpisodeNums = localRows
      .filter((row) => row.episode && !row.episode.isDownloading)
      .map((row) => row.num)

    const activeEpisodeNums = new Set<number>(queuedEpisodeSet)
    for (const row of localRows) {
      if (row.episode?.isDownloading) activeEpisodeNums.add(row.num)
    }
    if (anilistId != null) {
      for (const job of p2pState?.jobs || []) {
        if (job.anilistId !== anilistId || job.status === 'error' || job.status === 'completed' || job.status === 'seeding') {
          continue
        }
        if (typeof job.episode === 'number') activeEpisodeNums.add(job.episode)
        for (const ep of job.episodes || []) activeEpisodeNums.add(ep)
        for (const file of job.filesProgress || []) {
          const parsed = parseReleaseCore(file.name)
          for (const n of parsed.episodeNumbers) activeEpisodeNums.add(n)
          if (parsed.episodeNumber != null) activeEpisodeNums.add(parsed.episodeNumber)
        }
      }
    }

    const watchedEpisodeNums = new Set<number>()
    for (const row of localRows) {
      if (row.episode && history[row.episode.filePath]?.completed) {
        watchedEpisodeNums.add(row.num)
      }
    }
    const matchedFolderPaths = new Set(matchedLocalFolders.map((folder) => folder.folderPath.toLowerCase()))
    for (const entry of Object.values(history)) {
      if (!entry?.completed || !entry.folderPath) continue
      if (!matchedFolderPaths.has(entry.folderPath.toLowerCase())) continue
      const num = parseNumericEpisodeNumber(entry.fileName, entry.episodeNumber)
      if (num != null) watchedEpisodeNums.add(num)
    }

    const watchedMaxProgress = anilistId != null ? (userEntries[anilistId]?.progress ?? 0) : 0
    return computeOngoingDownloadPlan({
      status: hero.status,
      isFeatureFilm,
      isSingleEpisodeEntry,
      releasedEpisodeCount,
      episodeTotal,
      downloadedEpisodeNums,
      activeEpisodeNums,
      watchedEpisodeNums,
      watchedMaxProgress,
    })
  }, [
    localRows,
    queuedEpisodeSet,
    anilistId,
    p2pState?.jobs,
    history,
    matchedLocalFolders,
    userEntries,
    hero.status,
    isFeatureFilm,
    isSingleEpisodeEntry,
    releasedEpisodeCount,
    episodeTotal,
  ])

  // After the new page renders, bring the top of the episode section back into
  // view (only for explicit pager clicks, not the auto-jump on open).
  useEffect(() => {
    if (!scrollEpisodesOnPageChange.current) return
    scrollEpisodesOnPageChange.current = false
    episodesSectionRef.current?.scrollIntoView({ block: 'start' })
  }, [safeEpisodePage])

  // Related grid: the currently open title is inserted in chronological
  // position (the backend excludes it from the franchise graph) as a
  // highlighted, non-clickable card so the user sees where they are.
  const orderedRelated = useMemo<CatalogRelatedTitle[]>(() => {
    if (!details) return relatedTitles
    const current: CatalogRelatedTitle = { ...details, relationType: 'CURRENT' }
    const list = [...relatedTitles.filter((item) => item.anilistId !== details.anilistId), current]
    return list.sort((a, b) => {
      const yearA = a.startDate?.year ?? a.seasonYear ?? Number.MAX_SAFE_INTEGER
      const yearB = b.startDate?.year ?? b.seasonYear ?? Number.MAX_SAFE_INTEGER
      if (yearA !== yearB) return yearA - yearB
      const monthA = a.startDate?.month ?? 0
      const monthB = b.startDate?.month ?? 0
      if (monthA !== monthB) return monthA - monthB
      const dayA = a.startDate?.day ?? 0
      const dayB = b.startDate?.day ?? 0
      if (dayA !== dayB) return dayA - dayB
      return a.anilistId - b.anilistId
    })
  }, [relatedTitles, details])

  // Tech tag chips (LOCAL only): release tags from the first local file plus
  // folder-level subtitle flags.
  const techChips = useMemo(() => {
    if (!localFolder) return []
    const chips: string[] = []
    const firstFile = localFolder.episodes.find((ep) => !!ep?.fileName)
    if (firstFile?.fileName) {
      const parsed = parseReleaseCore(firstFile.fileName)
      if (parsed.resolution) chips.push(parsed.resolution)
      if (parsed.videoTerm) chips.push(parsed.videoTerm)
      if (parsed.audioTerm) chips.push(parsed.audioTerm)
    }
    if (localFolder.hasEmbeddedSubtitles) chips.push('Embedded Subtitles')
    if ((localFolder.hasExtSubCount ?? 0) > 0) chips.push('External Subs')
    if ((localFolder.hasDubtitlesCount ?? 0) > 0) chips.push('Dubtitles')
    return chips
  }, [localFolder])

  // List status + score: initialized from the user's library entry.
  const currentEntry =
    anilistId != null ? (userLibrary.entries[anilistId] ?? userEntries[anilistId]) : undefined
  const statusValue: string = currentEntry?.status ?? ''
  const scoreValue: string = currentEntry?.score != null ? String(Math.round(currentEntry.score)) : '0'

  const badgeState = useMemo(() => {
    const raw = statusFor({
      anilistId: anilistId ?? null,
      title: hero.title,
      apiEpisodesCount: hero.episodesCount ?? null,
    })
    if (!raw) return null
    // If the title is completed in My List, suppress "Watched" badge to avoid duplicate status and layout shifts.
    if (statusValue === 'completed' && raw.isWatched) {
      return { ...raw, isWatched: false }
    }
    return raw
  }, [statusFor, anilistId, hero.title, hero.episodesCount, statusValue])

  const [statusDropdownOpen, setStatusDropdownOpen] = useState(false)
  const [scoreDropdownOpen, setScoreDropdownOpen] = useState(false)
  const statusDropdownRef = useRef<HTMLDivElement | null>(null)
  const scoreDropdownRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node
      if (statusDropdownRef.current && !statusDropdownRef.current.contains(target)) {
        setStatusDropdownOpen(false)
      }
      if (scoreDropdownRef.current && !scoreDropdownRef.current.contains(target)) {
        setScoreDropdownOpen(false)
      }
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && (statusDropdownOpen || scoreDropdownOpen)) {
        e.stopPropagation()
        setStatusDropdownOpen(false)
        setScoreDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [statusDropdownOpen, scoreDropdownOpen])

  const handleStatusSelect = async (status: UserListStatus | '') => {
    if (anilistId == null) return
    if (!status) {
      onUserEntryRemove?.(anilistId)
      await userLibrary.remove(anilistId)
      return
    }
    const updated = await userLibrary.setStatus(
      anilistId,
      hero.idMal,
      hero.title,
      status,
      hero.posterUrl,
      hero.episodesCount
    )
    if (updated) {
      onUserEntryChange?.(updated)
    }

    // Suggest freeing the downloaded files once per session when the user
    // marks a locally downloaded title as Completed.
    if (
      status === 'completed' &&
      localFolder &&
      localRows.length > 0 &&
      !completedPromptedRef.current
    ) {
      completedPromptedRef.current = true
      setCompletedSuggestion(true)
    }
  }

  const handleScoreSelect = async (score: number | null) => {
    if (anilistId == null) return
    const updated = await userLibrary.setScore(anilistId, score)
    if (updated) {
      onUserEntryChange?.(updated)
    }
  }

  // Deletes every remaining local file of this title. History and list
  // progress are untouched; the folder disappears from the PC, so the overlay
  // closes after the library refresh kicks off.
  const handleDeleteSeasonConfirmed = async () => {
    if (!localFolder || deleteBusy) return
    setDeleteBusy(true)
    try {
      const p2p = await window.electronAPI.getP2pState().catch(() => null)
      const normalizedFolder = localFolder.folderPath.replace(/[\\/]+$/, '').toLocaleLowerCase()
      const activeJobs = (p2p?.jobs ?? []).filter(
        (job) => job.targetFolder.replace(/[\\/]+$/, '').toLocaleLowerCase() === normalizedFolder,
      )
      for (const job of activeJobs) {
        const stopped = await window.electronAPI.cancelDownload(job.infoHash, true)
        if (!stopped?.success) {
          throw new Error(`Could not stop the active download before deleting the anime folder: ${stopped?.error || 'unknown error'}`)
        }
      }
      const res = await window.electronAPI.deleteAnimeFromPC(localFolder.folderPath)
      if (res?.success) {
        showGlobalToast(`Deleted anime folder and stopped ${activeJobs.length} active download(s). Freed ${formatFileSize(res.deletedBytes ?? seasonSizeBytes)}.`, 'success')
        setConfirmDeleteSeason(false)
        setCompletedSuggestion(false)
        onLibraryChanged?.()
        onClose()
      } else {
        showGlobalToast(res?.error || 'Failed to delete files from PC', 'error')
      }
    } catch (err) {
      console.error('Failed to delete anime from PC:', err)
      showGlobalToast(err instanceof Error ? err.message : 'Failed to delete files from PC', 'error')
    } finally {
      setDeleteBusy(false)
    }
  }

  const handleDeleteEpisodeConfirmed = async () => {
    const ep = confirmDeleteEpisode
    if (!ep || deleteBusy) return
    setDeleteBusy(true)
    try {
      const res = await window.electronAPI.deleteEpisodesFromPC([ep.filePath])
      if (res?.success) {
        showGlobalToast(`Freed ${formatFileSize(res.deletedBytes ?? ep.size)}`, 'success')
        setRemovedPaths((prev) => new Set(prev).add(ep.filePath))
        setConfirmDeleteEpisode(null)
        onLibraryChanged?.()
      } else {
        showGlobalToast(res?.error || 'Failed to delete files from PC', 'error')
      }
    } catch (err) {
      console.error('Failed to delete episodes from PC:', err)
      showGlobalToast('Failed to delete files from PC', 'error')
    } finally {
      setDeleteBusy(false)
    }
  }

  const handleSuggestionKeep = () => setCompletedSuggestion(false)

  const handleSuggestionDelete = handleDeleteSeasonConfirmed

  const handlePlayResume = () => {
    if (!resumeEpisode) return
    onPlayEpisode(resumeEpisode, resumeStartAt)
  }

  const downloadRoots = useMemo(() => {
    const configured = [
      ...(Array.isArray(settings.libraryFolders) ? settings.libraryFolders : []),
      ...(settings.downloadTargetFolder ? [settings.downloadTargetFolder] : []),
    ].filter((folder): folder is string => typeof folder === 'string' && folder.trim().length > 0)
    return [...new Set(configured.map((folder) => folder.trim()))]
  }, [settings.libraryFolders, settings.downloadTargetFolder])

  const localFolderRoot = downloadRoots.find((root) => {
    const normalizedRoot = root.replace(/[\\/]+$/, '').toLowerCase()
    const normalizedFolder = localFolder?.folderPath.replace(/[\\/]+$/, '').toLowerCase() || ''
    return normalizedFolder === normalizedRoot || normalizedFolder.startsWith(`${normalizedRoot}\\`) || normalizedFolder.startsWith(`${normalizedRoot}/`)
  })
  const defaultDownloadRoot = selectedDownloadRoot || localFolderRoot || settings.downloadTargetFolder || downloadRoots[0] || null
  const downloadLocation = (): { targetFolder?: string; downloadRoot?: string } => {
    if (selectedDownloadRoot) {
      const normalizedRoot = selectedDownloadRoot.replace(/[\\/]+$/, '').toLowerCase()
      const existingOnRoot = matchedLocalFolders.find((folder) => {
        const normalizedFolder = folder.folderPath.replace(/[\\/]+$/, '').toLowerCase()
        return normalizedFolder === normalizedRoot
          || normalizedFolder.startsWith(`${normalizedRoot}\\`)
          || normalizedFolder.startsWith(`${normalizedRoot}/`)
      })
      if (existingOnRoot) return { targetFolder: existingOnRoot.folderPath }
      return { downloadRoot: selectedDownloadRoot }
    }
    if (localFolder) return { targetFolder: localFolder.folderPath }
    return defaultDownloadRoot ? { downloadRoot: defaultDownloadRoot } : {}
  }

  const getEffectiveAnimePref = () => {
    const inferred = inferReleasePreferenceFromEpisodes(localFolder?.episodes ?? [])
    if (anilistId == null) return inferred
    const saved = readAnimeReleasePreference(anilistId)
    return {
      ...inferred,
      ...(saved ?? {}),
      preferredGroup: saved?.preferredGroup ?? inferred.preferredGroup ?? null,
      audioMode: saved?.audioMode ?? null,
    }
  }

  const buildQueuedEpisode = (episode: number): QueuedEpisodeDownload => {
    const matchingRemote = remoteEpisodes.find((ep) => ep.number === episode)
    const parsedAir = matchingRemote?.airDate ? Date.parse(matchingRemote.airDate) : Number.NaN
    return {
      anilistId: anilistId!,
      episode,
      title: hero.title,
      aliases: searchAliases,
      season: seasonHint,
      part: partHint,
      episodeCount: details?.episodesCount ?? null,
      episodeDurationMinutes: details?.durationMinutes ?? null,
      mediaFormat: details?.format ?? hero.format ?? null,
      franchiseSeasons: franchiseSeasonTitles,
      contentTitleAliases,
      ...downloadLocation(),
      airedAtMs: Number.isFinite(parsedAir) ? parsedAir : null,
    }
  }

  const requestDownload = async (episode: number | null) => {
    if (!canDownload || notYetReleased || anilistId == null) return
    if (episode != null) {
      const alreadyDownloading = (p2pState?.jobs || []).some((job) => job.status !== 'error' && job.anilistId === anilistId &&
        (job.episodes?.includes(episode) || job.episode === episode || (job.episode == null && (job.filesProgress || []).some((file) => {
          const parsed = parseReleaseCore(file.name)
          return parsed.episodeNumbers.includes(episode) || parsed.episodeNumber === episode
        }))))
      if (alreadyDownloading || queuedEpisodeSet.has(episode)) return
      // Opening the manual picker is not a queued download. Keeping it out of
      // the worker queue avoids showing the episode card's download spinner
      // while the user is only browsing releases (or has not picked one yet).
      if (settings.releaseSelectionMode === 'manual') {
        setPickerState({ episode })
        return
      }
      enqueueEpisodeDownloads?.([buildQueuedEpisode(episode)])
      return
    }

    if (ongoingPlan.isOngoing) {
      if (ongoingPlan.buttonDisabled || ongoingPlan.targetEpisodes.length === 0) return
      const targets = ongoingPlan.targetEpisodes
      if (settings.releaseSelectionMode === 'manual') {
        setPickerState({ episode: targets.length === 1 ? targets[0] : null })
        return
      }
      if (targets.length === 1) {
        enqueueEpisodeDownloads?.([buildQueuedEpisode(targets[0])])
        return
      }
      if (queueing) return
      const api = window.electronAPI
      if (!api?.searchReleases || !api.addDownload) return
      setQueueing(true)
      try {
        const response = await api.searchReleases({
          title: hero.title,
          aliases: searchAliases,
          anilistId,
          season: seasonHint,
          part: partHint,
          episode: null,
          episodeCount: details?.episodesCount ?? null,
          episodeDurationMinutes: details?.durationMinutes ?? null,
          mediaFormat: details?.format ?? hero.format ?? null,
          franchiseSeasons: franchiseSeasonTitles,
        })
        const { best, usedEnglishDubFallback } = pickAutomaticSeasonRelease(response?.results ?? [], {
          isOvaTitle: (details?.format ?? hero.format ?? '').toUpperCase() === 'OVA',
          audioPreferences: settings.preferredTorrentAudioLanguages ?? ['en'],
          subtitlePreferences: settings.preferredTorrentSubtitleLanguages ?? ['en'],
          animePref: getEffectiveAnimePref(),
        })
        if (best) {
          const result = await api.addDownload({
            item: best,
            title: hero.title,
            anilistId,
            episode: null,
            season: seasonHint,
            mediaFormat: details?.format ?? hero.format ?? null,
            episodeCount: details?.episodesCount ?? hero.episodesCount ?? null,
            mediaAliases: contentTitleAliases,
            franchiseSeasons: franchiseSeasonTitles,
            ...downloadLocation(),
          })
          if (result?.success && usedEnglishDubFallback) {
            showGlobalToast(`Season download queued with English dub: ${best.title}. No release with both English dub and English subtitles was found. You can create subtitles in Whisper Studio.`, 'warning')
          } else if (result?.success) {
            showGlobalToast(`Season download queued: ${best.title}`, 'success')
          } else {
            showGlobalToast(result?.error || 'Failed to queue the season download', 'error')
          }
          return
        }
        // No batch pack matched (normal for weekly airing shows): queue missing
        // aired episodes individually through the persistent global worker.
        if (enqueueEpisodeDownloads) {
          enqueueEpisodeDownloads(targets.map((ep) => buildQueuedEpisode(ep)))
          showGlobalToast(`Queuing ${targets.length} aired episode(s) individually…`, 'info')
        } else {
          showGlobalToast('No matching batch or episode queue handler available.', 'error')
        }
      } catch (err) {
        console.error('Automatic ongoing release search failed:', err)
        if (enqueueEpisodeDownloads) {
          enqueueEpisodeDownloads(targets.map((ep) => buildQueuedEpisode(ep)))
          showGlobalToast(`Batch search failed — queuing ${targets.length} aired episode(s) individually…`, 'info')
        } else {
          showGlobalToast(err instanceof Error ? err.message : 'Automatic release search failed', 'error')
        }
      } finally {
        setQueueing(false)
        onLibraryChanged?.()
      }
      return
    }

    if (queueing) return
    if (settings.releaseSelectionMode === 'manual') {
      setPickerState({ episode: null })
      return
    }
    const api = window.electronAPI
    if (!api?.searchReleases || !api.addDownload) return
    setQueueing(true)
    try {
      const response = await api.searchReleases({ title: hero.title, aliases: searchAliases, anilistId, season: seasonHint, part: partHint, episode: null, episodeCount: details?.episodesCount ?? null, episodeDurationMinutes: details?.durationMinutes ?? null, mediaFormat: details?.format ?? hero.format ?? null, franchiseSeasons: franchiseSeasonTitles })
      const { best, usedEnglishDubFallback } = pickAutomaticSeasonRelease(response?.results ?? [], {
        isOvaTitle: (details?.format ?? hero.format ?? '').toUpperCase() === 'OVA',
        audioPreferences: settings.preferredTorrentAudioLanguages ?? ['en'],
        subtitlePreferences: settings.preferredTorrentSubtitleLanguages ?? ['en'],
        animePref: getEffectiveAnimePref(),
      })
      if (!best) {
        if (response?.results?.length) {
          showGlobalToast('No season release matched your automatic audio and subtitle preferences. Choose a release manually.', 'warning')
          setPickerState({ episode: null })
          return
        }
        const providerError = response?.reports?.find((report) => !report.ok)?.error
        showGlobalToast(providerError ? `No release found: ${providerError}` : 'No matching season release found. Check your indexers in Settings.', 'error')
        return
      }
      const result = await api.addDownload({ item: best, title: hero.title, anilistId, episode: null, season: seasonHint, mediaFormat: details?.format ?? hero.format ?? null, episodeCount: details?.episodesCount ?? hero.episodesCount ?? null, mediaAliases: contentTitleAliases, franchiseSeasons: franchiseSeasonTitles, ...downloadLocation() })
      if (result?.success && usedEnglishDubFallback) showGlobalToast(`Season download queued with English dub: ${best.title}. No release with both English dub and English subtitles was found. You can create subtitles in Whisper Studio.`, 'warning')
      else if (result?.success) showGlobalToast(`Season download queued: ${best.title}`, 'success')
      else showGlobalToast(result?.error || 'Failed to queue the season download', 'error')
    } catch (err) {
      console.error('Automatic release selection failed:', err)
      showGlobalToast(err instanceof Error ? err.message : 'Automatic release search failed', 'error')
    } finally {
      setQueueing(false)
      onLibraryChanged?.()
    }
  }

  useEffect(() => {
    if (initialDownloadEpisode == null) {
      initialDownloadStartedRef.current = null
      return
    }
    const metadataReady = !detailsLoading
      && details != null
      && details.anilistId === anilistId
      && (isFeatureFilm || franchiseSeasonLoaded)
    const requestKey = `${anilistId ?? 'unknown'}:${initialDownloadEpisode}`
    if (canDownload && metadataReady && initialDownloadStartedRef.current !== requestKey) {
      initialDownloadStartedRef.current = requestKey
      void requestDownload(initialDownloadEpisode)
    }
  }, [initialDownloadEpisode, canDownload, anilistId, detailsLoading, details, isFeatureFilm, franchiseSeasonLoaded])

  useEffect(() => {
    if (manualPickRequestEpisode == null) return
    setPickerState({ episode: manualPickRequestEpisode })
    onClearManualPickRequest?.()
  }, [manualPickRequestEpisode, onClearManualPickRequest])

  // Queues the picked release via the torrent engine, then closes the picker.
  // The library refresh runs immediately (cheap rescan) so the new files show
  // up as soon as the engine starts writing them.
  const handlePickRelease = async (result: ReleaseSearchResult) => {
    const api = window.electronAPI
    if (!pickerState || !api?.addDownload || queueing) return
    const { episode } = pickerState
    setQueueing(true)
    try {
      const res = await api.addDownload({ item: result, title: hero.title, anilistId, episode, season: seasonHint, mediaFormat: details?.format ?? hero.format ?? null, episodeCount: details?.episodesCount ?? hero.episodesCount ?? null, mediaAliases: contentTitleAliases, franchiseSeasons: franchiseSeasonTitles, ...downloadLocation() })
      if (res?.success) {
        if (anilistId != null) recordPickedReleasePreference(anilistId, result)
        showGlobalToast('Download queued — see the Downloads tab', 'success')
      } else {
        showGlobalToast(res?.error || 'Failed to queue download', 'error')
      }
    } catch (err) {
      console.error('Failed to queue download:', err)
      showGlobalToast('Failed to queue download', 'error')
    } finally {
      setQueueing(false)
      setPickerState(null)
      onLibraryChanged?.()
    }
  }

  const handleCancelReleasePicker = () => {
    setPickerState(null)
  }

  const showBanner = !!hero.bannerUrl
  const showPoster = !!hero.posterUrl && !posterFailed
  const detailBackdropRafRef = useRef<number | null>(null)
  const detailHeroElRef = useRef<HTMLElement | null>(null)
  const detailHeroHeightRef = useRef<number>(0)
  const reportBackdropProgress = (container: HTMLDivElement) => {
    let heroElement = detailHeroElRef.current
    if (!heroElement || !container.contains(heroElement)) {
      heroElement = container.querySelector<HTMLElement>('[data-backdrop-hero]')
      detailHeroElRef.current = heroElement
      detailHeroHeightRef.current = heroElement ? heroElement.offsetHeight : 0
    }
    if (!heroElement) {
      onBackdropProgressChange?.(0)
      return
    }
    const heroHeight = detailHeroHeightRef.current || heroElement.offsetHeight
    const progress = heroHeight > 0
      ? Math.max(0, Math.min(1, 1 - container.scrollTop / heroHeight))
      : 0
    onBackdropProgressChange?.(progress)
  }

  useEffect(() => () => {
    if (detailBackdropRafRef.current != null) window.cancelAnimationFrame(detailBackdropRafRef.current)
  }, [])

  useLayoutEffect(() => {
    detailHeroHeightRef.current = detailHeroElRef.current?.offsetHeight ?? 0
    if (scrollContainerRef.current) reportBackdropProgress(scrollContainerRef.current)
  }, [hero.bannerUrl])

  return (
    <div
      ref={scrollContainerRef}
      onScroll={(event) => {
        const container = event.currentTarget
        const cachedH = detailHeroHeightRef.current
        if (cachedH > 0 && container.scrollTop > cachedH) {
          onBackdropProgressChange?.(0)
          return
        }
        if (detailBackdropRafRef.current != null) return
        detailBackdropRafRef.current = window.requestAnimationFrame(() => {
          detailBackdropRafRef.current = null
          reportBackdropProgress(container)
        })
      }}
      style={animeThemeStyle}
      className="fixed inset-x-0 bottom-0 top-0 z-40 overflow-y-auto scroll-composited pt-[72px] bg-void"
    >
      {/* Full-page ambient color bleed: an unclipped, heavily blurred
          duplicate of the banner anchored at the page root (NOT inside the
          hero's overflow wrapper) so the color atmosphere flows behind the
          Episodes header and the first row of cards. A CSS mask dissolves it
          smoothly, so it never ends in a visible line. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 z-0 h-[950px] overflow-hidden transform-gpu"
        style={{
          maskImage: 'linear-gradient(to bottom, black 20%, transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to bottom, black 20%, transparent 100%)',
        }}
      >
        {showBanner && hero.bannerUrl ? (
          <img
            key={`ambient:${hero.bannerUrl}`}
            src={hero.bannerUrl}
            alt=""
            loading="eager"
            decoding="async"
            onError={() => {
              invalidateResolvedHeroBanner(anilistId, hero.bannerUrl)
              setBannerFailed(true)
            }}
            className="absolute inset-0 h-full w-full object-cover object-[center_28%] opacity-[0.28] blur-[110px] saturate-[1.9]"
            style={{ transform: 'scale(1.15) translateZ(0)' }}
          />
        ) : bannerReady && hero.posterUrl && !posterBgFailed ? (
          <img
            src={hero.posterUrl || ''}
            alt=""
            loading="lazy"
            onError={() => setPosterBgFailed(true)}
            className="absolute inset-0 h-full w-full object-cover opacity-[0.24] blur-[110px] saturate-[1.9]"
            style={{ transform: 'scale(1.15) translateZ(0)' }}
          />
        ) : null}
      </div>

      {/* Hero */}
      <div
        data-backdrop-hero
        className="relative z-20"
      >
        {/* Crisp banner. The whole layer is masked so the artwork dissolves
            completely into --bg-void BEFORE the hero's bottom edge — no hard
            horizontal cutoff above the Episodes section. The solid span stays
            wide (0–70%) so the artwork itself remains clearly visible; only
            the tail dissolves. */}
        <div
          className="pointer-events-none absolute inset-0 overflow-hidden"
          style={{
            maskImage: 'linear-gradient(to bottom, black 0%, black 70%, transparent 97%)',
            WebkitMaskImage: 'linear-gradient(to bottom, black 0%, black 70%, transparent 97%)',
          }}
        >
          {showBanner && hero.bannerUrl ? (
            <img
              key={`hero:${hero.bannerUrl}`}
              src={hero.bannerUrl}
              alt=""
              loading="eager"
              decoding="async"
              onError={() => {
              invalidateResolvedHeroBanner(anilistId, hero.bannerUrl)
              setBannerFailed(true)
            }}
              className="absolute inset-0 h-full w-full object-cover object-[center_28%] opacity-85 saturate-[1.15] animate-in fade-in duration-300"
            />
          ) : bannerReady && hero.posterUrl && !posterBgFailed ? (
            <img
              src={hero.posterUrl || ''}
              alt=""
              loading="lazy"
              onError={() => setPosterBgFailed(true)}
              className="absolute inset-0 h-full w-full scale-125 object-cover opacity-20 blur-3xl"
            />
          ) : null}
          {/* Directional text-protection scrim behind the left hero content:
              smooth contrast from the left poster through metadata without a localized center blob. */}
          <div className="pointer-events-none absolute inset-0" style={{ background: 'linear-gradient(90deg, rgba(7, 6, 10, 0.88) 0%, rgba(7, 6, 10, 0.68) 34%, rgba(7, 6, 10, 0.22) 64%, transparent 100%)' }} />
          {/* Multi-stop vertical dissolve into --bg-void. Kept gentle so the
              banner reads clearly; the left gradient above already guarantees
              text contrast behind the hero content. */}
          <div className="pointer-events-none absolute inset-0" style={{ background: 'linear-gradient(180deg, rgba(7, 6, 10, 0.12) 0%, rgba(7, 6, 10, 0.28) 54%, rgba(7, 6, 10, 0.74) 86%, #07060A 100%)' }} />
        </div>

        <div className="relative z-10 flex w-full flex-col gap-6 px-6 pb-12 pt-8 sm:flex-row sm:items-stretch 2xl:px-8 2xl:pb-14 2xl:pt-10">
          {/* Poster and personal list controls share one aligned left column. */}
          <div className="flex w-[180px] shrink-0 flex-col justify-between sm:w-[220px] md:w-[240px] 2xl:w-[260px]">
            <div className="w-full shrink-0 overflow-hidden rounded-xl border bg-zinc-900 shadow-2xl" style={{ aspectRatio: posterAspectRatio, borderColor: `hsla(${themeHue}, 70%, 70%, .48)`, boxShadow: `0 18px 55px hsla(${themeHue}, 75%, 35%, .24)` }}>
              {showPoster ? (
                <img
                  key={hero.posterUrl}
                  src={hero.posterUrl || ''}
                  alt={hero.title}
                  loading="eager"
                  decoding="async"
                  onLoad={(event) => {
                    const { naturalWidth, naturalHeight } = event.currentTarget
                    const loadedUrl = event.currentTarget.getAttribute('src')
                    if (loadedUrl && loadedUrl === hero.posterUrl && naturalWidth > 0 && naturalHeight > 0) {
                      setPosterAspect({ url: loadedUrl, ratio: naturalWidth / naturalHeight })
                    }
                  }}
                  onError={() => setPosterFailed(true)}
                  className="h-full w-full object-contain"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-zinc-900 to-zinc-950">
                  <Film className="h-10 w-10 text-zinc-700" />
                </div>
              )}
            </div>

            {anilistId != null && (
              <div className="mt-3">
                <span className="mb-1.5 block text-[10px] font-bold uppercase tracking-widest text-zinc-500">My List</span>
                <div className="grid grid-cols-[minmax(0,1fr)_68px] gap-2">
                  {/* Status Dropdown */}
                  <div ref={statusDropdownRef} className="relative min-w-0">
                    <button
                      type="button"
                      onClick={() => {
                        setStatusDropdownOpen((prev) => !prev)
                        setScoreDropdownOpen(false)
                      }}
                      className={`flex h-9 w-full select-none items-center justify-between gap-1.5 rounded-xl border px-2.5 text-xs font-semibold transition-all hover:scale-[1.01] active:scale-[0.99] ${
                        currentEntry?.status && STATUS_THEME[currentEntry.status]
                          ? `${STATUS_THEME[currentEntry.status].activeBorder} ${STATUS_THEME[currentEntry.status].activeBg} ${STATUS_THEME[currentEntry.status].activeText} shadow-sm`
                          : 'border-white/10 bg-white/[0.04] text-zinc-300 hover:border-white/20 hover:bg-white/[0.08]'
                      }`}
                    >
                      <span className="flex items-center gap-2 min-w-0 truncate">
                        {currentEntry?.status && STATUS_THEME[currentEntry.status] ? (
                          <>
                            <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_THEME[currentEntry.status].dotColor} shadow-sm`} />
                            <span className="truncate">{STATUS_THEME[currentEntry.status].label}</span>
                          </>
                        ) : (
                          <>
                            <Plus className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                            <span className="truncate text-zinc-400">Add to list</span>
                          </>
                        )}
                      </span>
                      <ChevronDown
                        className={`h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform duration-200 ${
                          statusDropdownOpen ? 'rotate-180 text-white' : ''
                        }`}
                      />
                    </button>

                    {statusDropdownOpen && (
                      <div className="absolute left-0 top-full z-50 mt-1.5 w-full min-w-[160px] rounded-xl border border-white/10 glass-dropdown p-1 shadow-2xl shadow-black/80 backdrop-blur-xl">
                        {STATUS_OPTIONS.map((opt) => {
                          const conf = STATUS_THEME[opt.value]
                          const isSelected = statusValue === opt.value
                          return (
                            <button
                              key={opt.value}
                              type="button"
                              onClick={() => {
                                setStatusDropdownOpen(false)
                                void handleStatusSelect(opt.value)
                              }}
                              className={`flex w-full select-none items-center justify-between rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
                                isSelected
                                  ? 'bg-white/[0.1] text-white font-semibold'
                                  : 'text-zinc-300 hover:bg-white/[0.06] hover:text-white'
                              }`}
                            >
                              <span className="flex items-center gap-2">
                                <span className={`h-2 w-2 rounded-full ${conf.dotColor}`} />
                                <span>{conf.label}</span>
                              </span>
                              {isSelected && <Check className="h-3.5 w-3.5 text-emerald-400 shrink-0" />}
                            </button>
                          )
                        })}
                        {currentEntry && (
                          <>
                            <div className="my-1 h-px bg-white/10" />
                            <button
                              type="button"
                              onClick={() => {
                                setStatusDropdownOpen(false)
                                void handleStatusSelect('')
                              }}
                              className="flex w-full select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium text-rose-400/80 transition-colors hover:bg-rose-500/10 hover:text-rose-300"
                            >
                              <X className="h-3.5 w-3.5 shrink-0" />
                              <span>Remove from list</span>
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Score Dropdown */}
                  <div ref={scoreDropdownRef} className="relative">
                    <button
                      type="button"
                      disabled={!currentEntry}
                      onClick={() => {
                        if (!currentEntry) return
                        setScoreDropdownOpen((prev) => !prev)
                        setStatusDropdownOpen(false)
                      }}
                      title={currentEntry ? 'Score this anime (1-10)' : 'Set a list status first'}
                      className={`flex h-9 w-full select-none items-center justify-between gap-1 rounded-xl border px-2.5 text-xs font-semibold transition-all ${
                        !currentEntry
                          ? 'cursor-not-allowed border-white/5 bg-white/[0.02] text-zinc-600 opacity-50'
                          : Number(scoreValue) > 0
                            ? 'border-amber-400/35 bg-gradient-to-r from-amber-500/20 to-yellow-500/20 text-amber-200 shadow-sm hover:bg-amber-500/25'
                            : 'border-white/10 bg-white/[0.04] text-zinc-400 hover:border-white/20 hover:bg-white/[0.08]'
                      }`}
                    >
                      <span className="flex items-center gap-1 min-w-0">
                        <Star
                          className={`h-3 w-3 shrink-0 ${
                            Number(scoreValue) > 0 ? 'fill-amber-400 text-amber-400' : 'text-zinc-500'
                          }`}
                        />
                        <span>{Number(scoreValue) > 0 ? scoreValue : '—'}</span>
                      </span>
                      <ChevronDown
                        className={`h-3 w-3 shrink-0 text-zinc-400 transition-transform duration-200 ${
                          scoreDropdownOpen ? 'rotate-180 text-white' : ''
                        }`}
                      />
                    </button>

                    {scoreDropdownOpen && (
                      <div className="absolute right-0 top-full z-50 mt-1.5 w-24 max-h-60 overflow-y-auto rounded-xl border border-white/10 glass-dropdown p-1 shadow-2xl shadow-black/80 backdrop-blur-xl">
                        <button
                          type="button"
                          onClick={() => {
                            setScoreDropdownOpen(false)
                            void handleScoreSelect(null)
                          }}
                          className={`flex w-full select-none items-center justify-between rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                            Number(scoreValue) === 0 ? 'bg-white/[0.1] text-white font-semibold' : 'text-zinc-400 hover:bg-white/[0.06] hover:text-white'
                          }`}
                        >
                          <span>—</span>
                          {Number(scoreValue) === 0 && <Check className="h-3 w-3 text-amber-400 shrink-0" />}
                        </button>
                        <div className="my-1 h-px bg-white/10" />
                        {Array.from({ length: 10 }, (_, i) => 10 - i).map((score) => (
                          <button
                            key={score}
                            type="button"
                            onClick={() => {
                              setScoreDropdownOpen(false)
                              void handleScoreSelect(score)
                            }}
                            className={`flex w-full select-none items-center justify-between rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                              Number(scoreValue) === score ? 'bg-white/[0.1] text-amber-300 font-semibold' : 'text-zinc-300 hover:bg-white/[0.06] hover:text-white'
                            }`}
                          >
                            <span className="flex items-center gap-1">
                              <Star className={`h-2.5 w-2.5 ${Number(scoreValue) === score ? 'fill-amber-400 text-amber-400' : 'text-zinc-600'}`} />
                              <span>{score}</span>
                            </span>
                            {Number(scoreValue) === score && <Check className="h-3 w-3 text-amber-400 shrink-0" />}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Info column */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
            className="min-w-0 flex-1 pt-2 sm:flex sm:flex-col"
          >
            {/* Frosted eyebrow pill tinted with the banner's own hue: dark
                base keeps it legible over bright artwork, the border/text
                pick up the per-title accent so it feels native to the banner. */}
            <p
              className="mb-3 inline-flex self-start items-center rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.08em]"
              style={{
                background: 'rgba(12, 8, 18, 0.72)',
                backdropFilter: 'blur(12px)',
                WebkitBackdropFilter: 'blur(12px)',
                border: `1px solid hsla(${themeHue}, 85%, 70%, 0.45)`,
                color: `hsl(${themeHue}, 90%, 79%)`,
              }}
            >
              Anime overview
            </p>
            {/* Aesthetic click-to-copy main title and per-language alternative chips */}
            <h1 className="text-4xl font-black leading-tight tracking-tight text-white md:text-5xl [text-shadow:0_2px_16px_rgba(0,0,0,0.65)]">
              <button
                type="button"
                onClick={() => handleCopyTitle(hero.title, 'Title')}
                aria-label={`Copy title: ${hero.title}`}
                title="Copy title"
                className="group/title inline cursor-pointer text-left transition-colors hover:text-white/90 focus:outline-none"
              >
                <span>{hero.title}</span>
                <span
                  aria-hidden="true"
                  className={`ml-2.5 inline-flex h-8 w-8 -translate-y-1 shrink-0 items-center justify-center rounded-xl border align-middle backdrop-blur-md transition-all duration-200 [text-shadow:none] ${
                    copiedTitleText === hero.title.trim()
                      ? 'scale-100 opacity-100 border-emerald-400/45 bg-emerald-500/20 text-emerald-300 shadow-[0_0_16px_rgba(16,185,129,0.28)]'
                      : 'scale-90 opacity-0 group-hover/title:scale-100 group-hover/title:opacity-100 group-focus-visible/title:scale-100 group-focus-visible/title:opacity-100 border-white/[0.14] bg-black/45 text-zinc-200 group-hover/title:border-white/25'
                  }`}
                >
                  {copiedTitleText === hero.title.trim() ? <Check className="h-4 w-4" /> : <Copy className="h-3.5 w-3.5" />}
                </span>
              </button>
            </h1>
            {hero.secondaryTitles.length > 0 && (
              <div className="mt-1.5 flex flex-wrap items-center gap-y-1 text-xs font-medium">
                {hero.secondaryTitles.map((altTitle, index) => {
                  const isCopied = copiedTitleText === altTitle
                  return (
                    <React.Fragment key={altTitle}>
                      {index > 0 && (
                        <span
                          aria-hidden="true"
                          className="mx-1.5 select-none text-white/45 [text-shadow:0_2px_10px_rgba(0,0,0,0.95)]"
                        >
                          ·
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => handleCopyTitle(altTitle, 'Alternative title')}
                        title={`Copy: ${altTitle}`}
                        className={`group/alt inline-flex max-w-full cursor-pointer items-center rounded-lg border px-2 py-0.5 transition-all duration-150 focus:outline-none ${
                          index === 0 ? '-ml-2' : ''
                        } ${
                          isCopied
                            ? 'border-emerald-400/45 bg-emerald-500/20 text-emerald-200 backdrop-blur-md shadow-[0_0_14px_rgba(16,185,129,0.22)]'
                            : 'border-transparent bg-transparent text-white/85 [text-shadow:0_2px_10px_rgba(0,0,0,0.95),0_0_24px_rgba(0,0,0,0.85)] hover:border-white/[0.16] hover:bg-black/45 hover:text-white hover:backdrop-blur-md'
                        }`}
                      >
                        <span className="truncate">{altTitle}</span>
                        <span
                          aria-hidden="true"
                          className={`inline-flex shrink-0 items-center justify-center overflow-hidden transition-all duration-150 ${
                            isCopied
                              ? 'ml-1.5 w-3.5 opacity-100 text-emerald-300'
                              : 'ml-0 w-0 opacity-0 text-zinc-200 group-hover/alt:ml-1.5 group-hover/alt:w-3.5 group-hover/alt:opacity-100 group-focus-visible/alt:ml-1.5 group-focus-visible/alt:w-3.5 group-focus-visible/alt:opacity-100'
                          }`}
                        >
                          {isCopied ? (
                            <Check className="h-3 w-3 shrink-0" />
                          ) : (
                            <Copy className="h-3 w-3 shrink-0" />
                          )}
                        </span>
                      </button>
                    </React.Fragment>
                  )
                })}
              </div>
            )}

            {/* Meta chips */}
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {hero.averageScore != null && hero.averageScore > 0 && (
                <MetaChip>
                  <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
                  <span>{Math.round(hero.averageScore)}%</span>
                </MetaChip>
              )}
              {hero.seasonYear != null && (
                <MetaChip>
                  <span>{hero.seasonYear}</span>
                </MetaChip>
              )}
              {hero.format && (
                <MetaChip>
                  <span>{hero.format}</span>
                </MetaChip>
              )}
              {episodeTotal > 0 && !isFeatureFilm && !isSingleEpisodeEntry && (
                <MetaChip>
                  <span>{episodeTotal} EP</span>
                </MetaChip>
              )}
              {hero.idMal != null && (
                <MetaChip
                  title={ageRating === 'NR' ? 'No age rating in the local database' : `MyAnimeList age rating: ${ageRating}`}
                  className={ageRating === 'NR'
                    ? 'border-zinc-300/20 bg-zinc-950/80 text-zinc-200'
                    : ['R-17+', 'R+', 'Rx'].includes(ageRating)
                      ? 'border-amber-300/30 bg-amber-950/80 text-amber-100'
                      : 'border-teal-300/25 bg-teal-950/80 text-teal-100'}
                >
                  <span>{ageRating}</span>
                </MetaChip>
              )}
              {!isFeatureFilm && !isSingleEpisodeEntry && releasedEpisodeCount != null && (hero.status === 'RELEASING' || hero.status === 'NOT_YET_RELEASED') && (
                <MetaChip title="Episodes aired so far">
                  <span>{releasedEpisodeCount}{episodeTotal > 0 ? `/${episodeTotal}` : ''} aired</span>
                </MetaChip>
              )}
              {hero.status && (
                <MetaChip className={statusChipClass(hero.status)}>
                  <span>{hero.status === 'RELEASING' ? 'ONGOING' : hero.status.replace(/_/g, ' ')}</span>
                </MetaChip>
              )}
            </div>

            {(() => {
              const hasBadges = badgeState && (
                badgeState.isDownloading ||
                badgeState.isOnPc ||
                badgeState.isWatched ||
                (badgeState.releaseBadges && badgeState.releaseBadges.length > 0)
              )
              if (!hasBadges && techChips.length === 0) return null
              return (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {hasBadges && <StatusBadges state={badgeState} />}
                  {techChips.map((chip) => (
                    <span
                      key={chip}
                      className="rounded border border-white/10 bg-black/35 px-2 py-0.5 font-mono text-[9px] font-semibold text-zinc-300/90 backdrop-blur-sm"
                    >
                      {chip}
                    </span>
                  ))}
                </div>
              )
            })()}

            {/* Genres */}
            {hero.genres.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                {hero.genres.map((genre) => (
                  <button
                    key={genre}
                    type="button"
                    title={`Explore ${genre} anime in Discover`}
                    onClick={() => onSelectGenre?.(genre)}
                    className="group/genre inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-semibold text-zinc-200 transition-all duration-150 hover:scale-105 hover:border-rose-400 hover:bg-rose-500/20 hover:text-white cursor-pointer"
                    style={{ borderColor: `hsla(${themeHue}, 72%, 68%, .24)`, backgroundColor: `hsla(${themeHue}, 72%, 58%, .10)` }}
                  >
                    <span>{genre}</span>
                    <Compass className="h-3 w-3 opacity-60 transition-transform group-hover/genre:scale-110 group-hover/genre:opacity-100 text-rose-300" />
                  </button>
                ))}
              </div>
            )}

            {hero.description && (
              <div className="mt-4 max-w-2xl rounded-2xl border border-white/[0.08] bg-[#0a070f]/68 px-4 py-3 shadow-lg shadow-black/20 backdrop-blur-xl">
                {/* Keep line-clamp-4 un-padded on <p> itself: putting py-* on a
                    -webkit-box line-clamped element slices the last visible line inside padding. */}
                <p
                  ref={descriptionRef}
                  className="line-clamp-4 text-[13px] leading-relaxed text-zinc-100/95"
                >
                  {hero.description}
                </p>
                {descriptionClamped && (
                  <button
                    type="button"
                    onClick={() => setDescriptionReaderOpen(true)}
                    className="mt-2 inline-flex items-center gap-1 rounded-md text-[11px] font-semibold text-rose-300/90 transition-colors hover:text-rose-200 focus:outline-none focus:ring-2 focus:ring-white/30"
                  >
                    Read full description <span aria-hidden="true">↗</span>
                  </button>
                )}
              </div>
            )}

            {/* Actions row */}
            <div className="mt-6 flex flex-wrap items-center gap-3 sm:mt-auto sm:pt-6">
              <button
                type="button"
                onClick={handlePlayResume}
                disabled={!resumeEpisode}
                title={resumeEpisode ? (isFeatureFilm ? 'Play or resume this movie' : isSingleEpisodeEntry ? 'Play or resume this episode' : 'Play the first unwatched local episode') : 'No local episodes on this PC yet'}
                className={`btn-hue flex select-none items-center gap-2 rounded-xl px-6 py-3 text-sm font-bold transition-all active:scale-[0.98] ${
                  resumeEpisode
                  ? 'text-white hover:scale-[1.02]'
                    : 'cursor-not-allowed text-zinc-500 opacity-60'
                }`}
                style={resumeEpisode ? undefined : { backgroundImage: 'none', background: '#27272a', border: '1px solid rgba(255,255,255,0.06)', boxShadow: 'none' }}
              >
                <Play className="h-4 w-4 fill-current" />
                <span>
                  {resumeStartAt && resumeProgress ? `Resume from ${formatTime(resumeProgress.currentTime)}` : isFeatureFilm ? 'Play movie' : 'Play'}
                </span>
              </button>

              {anilistId != null && followEligible && (
                <>
                  <button
                    type="button"
                    onClick={() => onToggleFollow({
                      anilistId,
                      title: hero.title,
                      posterUrl: hero.posterUrl,
                      status: hero.status || 'RELEASING',
                      episodesCount: hero.episodesCount,
                    }, !isFollowing)}
                    title={isFollowing ? 'Unfollow series updates' : 'Follow series for new episode alerts'}
                    className={`btn-glass flex w-[124px] select-none items-center justify-center gap-1.5 rounded-xl px-3 py-3 text-xs font-bold transition-all hover:scale-[1.02] active:scale-[0.98] ${
                      isFollowing
                        ? 'text-emerald-200 shadow-glow-emerald-sm hover:bg-emerald-400/10'
                        : 'text-zinc-300'
                    }`}
                  >
                    {isFollowing ? (
                      <>
                        <BellRing className="h-4 w-4 text-emerald-300 drop-shadow-[0_0_6px_rgba(52,211,153,0.7)] shrink-0" />
                        <span className="truncate">Following</span>
                        <Check className="h-3 w-3 text-emerald-300 shrink-0" />
                      </>
                    ) : (
                      <>
                        <Bell className="h-4 w-4 text-zinc-400 shrink-0" />
                        <span className="truncate">Follow</span>
                        <Plus className="h-3 w-3 text-zinc-500 shrink-0" />
                      </>
                    )}
                  </button>
                  {isFollowing && p2pAvailable && onToggleFollowAutoDownload && (
                    <button
                      type="button"
                      onClick={() => onToggleFollowAutoDownload(anilistId, !followEntry?.autoDownload, defaultDownloadRoot)}
                      aria-pressed={!!followEntry?.autoDownload}
                      title={
                        followEntry?.autoDownload
                          ? 'Auto-download enabled: new episodes download automatically ~30 min after airing'
                          : 'Enable automatic download when new episodes air'
                      }
                      className={`btn-glass flex select-none items-center justify-center gap-1.5 rounded-xl px-3 py-3 text-xs font-bold transition-all hover:scale-[1.02] active:scale-[0.98] ${
                        followEntry?.autoDownload
                          ? 'text-emerald-200 shadow-glow-emerald-sm hover:bg-emerald-400/10'
                          : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      <Download className={`h-3.5 w-3.5 shrink-0 ${followEntry?.autoDownload ? 'text-emerald-300' : 'text-zinc-400'}`} />
                      <span>Auto-DL</span>
                      {followEntry?.autoDownload && <Check className="h-3 w-3 text-emerald-300 shrink-0" />}
                    </button>
                  )}
                </>
              )}

              <button
                type="button"
                onClick={() => onToggleFavourite({
                  anilistId,
                  titleKey: animeTitleKey(hero.title),
                  title: hero.title,
                  posterUrl: hero.posterUrl,
                }, !isFavourite)}
                aria-pressed={isFavourite}
                title={isFavourite ? 'Remove from favourites' : 'Add to favourites'}
                className={`btn-glass flex w-[136px] select-none items-center justify-center gap-1.5 rounded-xl px-3 py-3 text-xs font-bold transition-all hover:scale-[1.02] active:scale-[0.98] ${
                  isFavourite
                    ? 'text-rose-100 shadow-glow-crimson-sm hover:bg-rose-500/10'
                    : 'text-zinc-300'
                }`}
              >
                {isFavourite ? (
                  <>
                    <Heart className="h-4 w-4 fill-current text-rose-400 drop-shadow-[0_0_6px_rgba(255,30,109,0.7)] shrink-0" />
                    <span className="truncate">Favourited</span>
                    <Check className="h-3 w-3 text-rose-300 shrink-0" />
                  </>
                ) : (
                  <>
                    <Heart className="h-4 w-4 text-zinc-400 shrink-0" />
                    <span className="truncate">Favourite</span>
                    <Plus className="h-3 w-3 text-zinc-500 shrink-0" />
                  </>
                )}
              </button>

              {localFolder && (
                <button
                  type="button"
                  onClick={() => onOpenWhisper(localFolder)}
                  className="btn-glass flex select-none items-center gap-2 rounded-xl px-4 py-3 text-xs font-bold text-zinc-200 transition-all hover:scale-[1.02] active:scale-[0.98]"
                >
                  <Wand2 className="h-4 w-4 text-rose-300/90" />
                  <span>Whisper Batch Subtitles</span>
                </button>
              )}

              {localFolder && localRows.length > 0 && (
                <button
                  type="button"
                  onClick={() => setConfirmDeleteSeason(true)}
                  title="Delete the downloaded files from this PC (history and progress are kept)"
                  className="btn-glass group flex select-none items-center gap-2 rounded-xl px-4 py-3 text-xs font-bold text-zinc-300 transition-all hover:scale-[1.02] active:scale-[0.98]"
                >
                  <Trash2 className="h-4 w-4 text-zinc-400 transition-colors group-hover:text-rose-400" />
                  <span>Delete from PC</span>
                </button>
              )}

              {canDownload && !notYetReleased ? (() => {
                const heroDownloadDisabled = downloadedSeason || ongoingPlan.buttonDisabled || queueing
                const heroDownloadLabel = queueing
                  ? 'Searching…'
                  : downloadedSeason
                    ? (isFeatureFilm ? 'Movie downloaded' : isSingleEpisodeEntry ? 'Episode downloaded' : 'Season downloaded')
                    : ongoingPlan.isOngoing
                      ? ongoingPlan.buttonLabel
                      : (isFeatureFilm ? 'Download movie' : isSingleEpisodeEntry ? 'Download episode' : 'Download season')
                const nextAiringLabel = ongoingPlan.isOngoing && ongoingPlan.allAiredDownloaded && details?.nextAiringEpisode?.airingAt
                  ? formatRelativeAirDate(new Date(details.nextAiringEpisode.airingAt * 1000).toISOString())?.label ?? null
                  : null
                const heroDownloadTitle = downloadedSeason
                  ? 'All listed episodes are already on this PC'
                  : ongoingPlan.isOngoing && ongoingPlan.allAiredDownloaded
                    ? (nextAiringLabel
                      ? `All aired episodes downloaded · Ep ${details?.nextAiringEpisode?.episode ?? ''} ${nextAiringLabel}`.trim()
                      : 'All aired episodes are already downloaded')
                    : ongoingPlan.isOngoing && ongoingPlan.buttonDisabled
                      ? 'Downloading all remaining aired episodes'
                      : ongoingPlan.isOngoing && ongoingPlan.targetEpisodes.length === 1
                        ? `Click to download Ep ${ongoingPlan.targetEpisodes[0]} · hold for manual release search`
                        : ongoingPlan.isOngoing
                          ? `Click to download Ep ${ongoingPlan.targetEpisodes[0]}–${ongoingPlan.targetEpisodes[ongoingPlan.targetEpisodes.length - 1]} (${ongoingPlan.targetEpisodes.length}) · hold for manual release search`
                          : 'Click to download · hold for manual release search'
                const showHeroFolderMenu = !downloadedSeason && !ongoingPlan.buttonDisabled && downloadRoots.length > 1
                const showCompleteIcon = downloadedSeason || (ongoingPlan.isOngoing && ongoingPlan.allAiredDownloaded)

                return (
                  <div className="relative flex">
                    <DownloadActionButton
                      type="button"
                      onClick={() => void requestDownload(null)}
                      onLongPress={() => {
                        if (heroDownloadDisabled) return
                        setPickerState({
                          episode: ongoingPlan.isOngoing && ongoingPlan.targetEpisodes.length === 1
                            ? ongoingPlan.targetEpisodes[0]
                            : null,
                        })
                      }}
                      disabled={heroDownloadDisabled}
                      title={heroDownloadTitle}
                      className={`btn-glass flex select-none items-center gap-2 px-4 py-3 text-xs font-bold text-zinc-200 transition-all hover:scale-[1.02] disabled:cursor-default disabled:opacity-60 disabled:hover:scale-100 ${showHeroFolderMenu ? 'rounded-l-xl' : 'rounded-xl'}`}
                    >
                      {showCompleteIcon ? <CheckCircle className="h-4 w-4 text-emerald-300" /> : <Download className="h-4 w-4 text-zinc-300" />}
                      <span>{heroDownloadLabel}</span>
                    </DownloadActionButton>
                    {showHeroFolderMenu && (
                      <DownloadFolderMenu
                        roots={downloadRoots}
                        selectedRoot={defaultDownloadRoot}
                        onSelect={setSelectedDownloadRoot}
                        triggerVariant="split"
                        resetKey={anilistId ?? localFolder?.folderPath ?? null}
                      />
                    )}
                  </div>
                )
              })() : (
                <button
                  type="button"
                  disabled
                  title={notYetReleased ? 'Not yet released' : DOWNLOAD_TOOLTIP}
                  className="flex cursor-not-allowed select-none items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.04] px-4 py-3 text-xs font-bold text-zinc-500 opacity-70"
                >
                  <Download className="h-4 w-4" />
                  <span>{isFeatureFilm ? 'Download movie' : isSingleEpisodeEntry ? 'Download episode' : 'Download season'}</span>
                </button>
              )}
            </div>

            {/* 'Completed!' suggestion: offer freeing the downloaded files */}
            {completedSuggestion && localFolder && localRows.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25, ease: 'easeOut' }}
                className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3"
              >
                <CheckCircle className="h-5 w-5 shrink-0 text-emerald-400" />
                <p className="min-w-0 flex-1 text-xs leading-relaxed text-zinc-200">
                  Completed! Delete files (frees {formatFileSize(seasonSizeBytes)}), keeping it in
                  history?
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleSuggestionDelete}
                    disabled={deleteBusy}
                    className="flex select-none items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-bold text-white shadow-sm transition-colors hover:bg-red-500 disabled:opacity-60 active:scale-[0.98]"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>Delete files</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleSuggestionKeep}
                    disabled={deleteBusy}
                    className="rounded-lg border border-zinc-700/60 bg-zinc-800/80 px-3 py-1.5 text-xs font-semibold text-zinc-300 transition-colors hover:bg-zinc-700/80 hover:text-white disabled:opacity-60"
                  >
                    Keep
                  </button>
                </div>
              </motion.div>
            )}
          </motion.div>
        </div>
      </div>

      {/* Movies use the hero Play/Resume action; an episode-style movie card
          only repeats the same action and creates a one-item section. */}
      {!isFeatureFilm && !isSingleEpisodeEntry && <>
      <section
        ref={episodesSectionRef}
        className="relative z-10 w-full scroll-mt-4 px-6 pb-16 2xl:px-8"
      >
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-xl font-black text-white">{isFeatureFilm ? 'Movie' : 'Episodes'}</h2>
            <p className="mt-1 text-xs text-zinc-500">
              {isFeatureFilm
                ? `${downloadedCount ? 'Available on this PC' : downloadingCount ? 'Downloading movie' : 'Feature film'}${localRows[0]?.episode?.duration ? ` · ${formatTime(localRows[0].episode.duration)}` : ''}`
                : <>{downloadedCount} downloaded{downloadingCount ? ` · ${downloadingCount} downloading` : ''}{releasedEpisodeCount != null ? ` · ${releasedEpisodeCount} aired` : ''}{` · ${Math.max(0, mergedRows.length - downloadedCount - downloadingCount)} not downloaded`}</>}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {queuedEpisodeSet.size > 0 && <span className="rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1 text-xs font-semibold text-cyan-200">{queuedEpisodeSet.size} in queue</span>}
            {mergedRows.length > 0 && <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-zinc-400">{isFeatureFilm ? '1 movie' : `${mergedRows.length} episodes`}</span>}
          </div>
        </div>

        {mergedRows.length === 0 ? (
          <p className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-4 py-10 text-center text-sm text-zinc-500">
            {detailsLoading || remoteEpisodesLoading ? 'Loading episodes…' : 'No episodes available for this title yet'}
          </p>
        ) : (
          <>
            <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 min-[1800px]:grid-cols-5">
              {visibleEpisodeRows.map((row) => {
                const local = row.local
                const progress = local ? history[local.filePath] : undefined
                const startAt =
                  progress && !progress.completed && progress.currentTime > 0 ? progress.currentTime : undefined
                // AniList/ani.zip metadata is authoritative for episode-facing
                // labels and stills. Local container/release names are only a
                // fallback because they often contain the full torrent filename.
                const isEnglishTitle = (value: string | null | undefined): value is string =>
                  !!value?.trim() && !/[\u3040-\u30ff\u3400-\u9fff]/u.test(value)
                const localEpisodeTitle = [local?.kitsuTitle, local?.episodeTitle].find(isEnglishTitle) || null
                const localTitleLooksLikeRelease = !!localEpisodeTitle &&
                  (/[\[\]]/.test(localEpisodeTitle) ||
                    /\b(?:2160p|1080p|720p|web[- ]?rip|web[- ]?dl|bluray|h\.?265|x265|hevc|e[- ]?ac[- ]?3|multi[- ]audio|dual[- ]audio|repack)\b/i.test(localEpisodeTitle))
                // No placeholder here: EpisodeRow renders a single "Episode N"
                // when no real title exists (avoids "Episode 2 — Episode 2").
                const title = (isEnglishTitle(row.remote?.title) ? row.remote?.title : null) ||
                  (localEpisodeTitle && !localTitleLooksLikeRelease ? localEpisodeTitle : null)
                const thumbnail = row.remote?.thumbnailUrl || local?.kitsuThumbnail || local?.thumbnailUrl || null
                const torrentJob = torrentJobForEpisode(p2pState?.jobs || [], anilistId, row.num)
                const queuedForSearch = queuedEpisodeSet.has(row.num)
                const remoteAirTime = row.remote?.airDate ? Date.parse(row.remote.airDate) : Number.NaN
                const unaired = !local && (
                  hero.status === 'NOT_YET_RELEASED' ||
                  (airedThrough != null && row.num > airedThrough) ||
                  (Number.isFinite(remoteAirTime) && remoteAirTime > Date.now())
                )

                return (
                  <EpisodeRow
                    key={`ep-${row.num}-${local?.filePath ?? 'remote'}`}
                    number={String(row.num)}
                    title={title}
                    isFeatureFilm={isFeatureFilm}
                    thumbnailUrl={thumbnail}
                    fallbackThumbnailUrl={local?.thumbnailUrl}
                    airDate={row.remote?.airDate ?? null}
                    local={local}
                    // When release search is available, fileless rows get an
                    // enabled download action (EpisodeRow keeps remoteOnly rows
                    // as disabled ghosts), trading the 'Not Downloaded' pill /
                    // air-date line for the actionable button.
                    remoteOnly={!local && !p2pAvailable}
                    unaired={unaired}
                    ongoing={ongoing}
                    watched={!!local && history[local.filePath]?.completed === true}
                    isDownloading={!!local?.isDownloading}
                    downloadProgress={local?.downloadProgress}
                    playbackProgress={progress}
                    torrentJob={torrentJob}
                    queuedForSearch={queuedForSearch && !torrentJob}
                    onPlay={local ? () => onPlayEpisode(local, startAt) : undefined}
                    onWhisper={local && localFolder ? () => onOpenWhisper(localFolder) : undefined}
                    onDownload={
                      p2pAvailable && !local && !unaired ? () => void requestDownload(row.num) : undefined
                    }
                    onDownloadLongPress={p2pAvailable && !local && !unaired ? () => setPickerState({ episode: row.num }) : undefined}
                    downloadRoots={downloadRoots}
                    selectedDownloadRoot={defaultDownloadRoot}
                    onSelectDownloadRoot={setSelectedDownloadRoot}
                    onDelete={local ? () => setConfirmDeleteEpisode(local) : undefined}
                  />
                )
              })}
            </div>

            {episodePageCount > 1 && (
              <div className="mt-5 flex items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    scrollEpisodesOnPageChange.current = true
                    setEpisodePage((page) => Math.max(1, safeEpisodePage - 1))
                  }}
                  disabled={safeEpisodePage <= 1}
                  className="rounded-lg border border-zinc-700/60 bg-zinc-800/80 px-3 py-1.5 text-xs font-semibold text-zinc-300 transition-colors hover:bg-zinc-700/80 hover:text-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-zinc-800/80 disabled:hover:text-zinc-300"
                >
                  ← Previous
                </button>
                <span className="text-xs text-zinc-500">Page {safeEpisodePage} of {episodePageCount}</span>
                <button
                  type="button"
                  onClick={() => {
                    scrollEpisodesOnPageChange.current = true
                    setEpisodePage((page) => Math.min(episodePageCount, safeEpisodePage + 1))
                  }}
                  disabled={safeEpisodePage >= episodePageCount}
                  className="rounded-lg border border-zinc-700/60 bg-zinc-800/80 px-3 py-1.5 text-xs font-semibold text-zinc-300 transition-colors hover:bg-zinc-700/80 hover:text-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-zinc-800/80 disabled:hover:text-zinc-300"
                >
                  Next →
                </button>
              </div>
            )}
          </>
        )}
      </section>
      </>}

      <section className="relative z-10 w-full px-6 pb-16 2xl:px-8">
        <div className="mb-4 flex items-end justify-between gap-4">
          <div>
            <h2 className="text-xl font-black text-white">Related</h2>
            <p className="mt-1 text-xs text-zinc-500">Seasons and other entries in this franchise</p>
          </div>
          {orderedRelated.length > 0 && <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-zinc-400">{orderedRelated.length} titles</span>}
        </div>
        {relatedLoading ? <div className="h-36 animate-pulse rounded-2xl border border-white/10 bg-white/[0.03]" /> : orderedRelated.length === 0 ? (
          <p className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-6 text-center text-sm text-zinc-500">No related titles were returned by AniList.</p>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(168px,196px))] gap-3.5">
            {orderedRelated.map((item) => {
              const title = item.title.english || item.title.romaji || `Anime ${item.anilistId}`
              const isCurrent = item.anilistId === details?.anilistId
              const card = (
                <>
                  <div className="relative aspect-[2/3] overflow-hidden bg-zinc-950">
                    {item.posterUrl ? <img src={item.posterUrl} alt="" loading="lazy" className="h-full w-full object-cover transition duration-300 group-hover:scale-105" /> : <div className="flex h-full items-center justify-center text-xs text-zinc-600">No poster</div>}
                    <span className={`absolute left-2 top-2 rounded-md border px-2 py-1 text-[9px] font-bold uppercase tracking-wide ${isCurrent ? 'border-violet-300/40 bg-violet-500/80 text-white' : 'border-black/20 bg-black/75 text-violet-100'}`}>{item.relationType.replace(/_/g, ' ')}</span>
                  </div>
                  <div className="p-2.5">
                    <p className="line-clamp-2 min-h-9 text-xs font-semibold text-zinc-100">{title}</p>
                    <p className="mt-1 text-[10px] text-zinc-500">{[item.format, item.startDate?.year ?? item.seasonYear].filter(Boolean).join(' · ') || 'Anime'}</p>
                  </div>
                </>
              )
              return isCurrent ? (
                <div key={item.anilistId} aria-current="true" title="You are here" className="cursor-default overflow-hidden rounded-xl border border-violet-300/40 bg-[#171320] shadow-lg shadow-violet-950/30 ring-2 ring-violet-400/80">
                  {card}
                </div>
              ) : (
                <button
                  key={item.anilistId}
                  type="button"
                  onClick={() => onOpenRelated(item)}
                  onMouseEnter={() => {
                    if (relatedWarmTimerRef.current != null) window.clearTimeout(relatedWarmTimerRef.current)
                    relatedWarmTimerRef.current = window.setTimeout(() => {
                      window.electronAPI?.warmRemoteEpisodes?.(item.anilistId)
                    }, 180)
                  }}
                  onMouseLeave={() => {
                    if (relatedWarmTimerRef.current != null) {
                      window.clearTimeout(relatedWarmTimerRef.current)
                      relatedWarmTimerRef.current = null
                    }
                  }}
                  className="group overflow-hidden rounded-xl border border-white/10 bg-elevated text-left transition hover:-translate-y-0.5 hover:border-rose-300/40 hover:shadow-lg hover:shadow-rose-950/20"
                >
                  {card}
                </button>
              )
            })}
          </div>
        )}
      </section>

      {descriptionReaderOpen && hero.description && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center modal-dimmer p-4 animate-in fade-in duration-150"
          onClick={() => setDescriptionReaderOpen(false)}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="anime-description-title"
            className="modal-glass flex max-h-[min(78vh,760px)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl animate-in zoom-in-95 duration-150"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="flex items-start justify-between gap-4 border-b border-white/[0.07] px-5 py-4 sm:px-6">
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-[0.2em]" style={{ color: `hsl(${themeHue} 78% 76%)` }}>Synopsis</p>
                <h2 id="anime-description-title" className="mt-1 line-clamp-2 text-base font-bold text-white sm:text-lg">{hero.title}</h2>
              </div>
              <button
                type="button"
                autoFocus
                aria-label="Close full description"
                onClick={() => setDescriptionReaderOpen(false)}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/10 text-zinc-400 transition hover:bg-white/10 hover:text-white focus:outline-none focus:ring-2 focus:ring-white/30"
              >
                <X className="h-4 w-4" />
              </button>
            </header>
            <div className="overflow-y-auto px-5 py-5 text-sm leading-7 text-zinc-200 sm:px-6 sm:py-6">
              {hero.description}
            </div>
            <footer className="flex justify-end border-t border-white/[0.07] px-5 py-3 sm:px-6">
              <button
                type="button"
                onClick={() => setDescriptionReaderOpen(false)}
                className="rounded-lg px-3 py-2 text-xs font-semibold text-zinc-300 transition hover:bg-white/10 hover:text-white"
              >
                Close
              </button>
            </footer>
          </section>
        </div>
      )}

      {/* Season delete confirmation (files only — history and progress are kept) */}
      {confirmDeleteSeason && localFolder && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center modal-dimmer p-4 animate-in fade-in duration-150"
          onClick={() => !deleteBusy && setConfirmDeleteSeason(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            data-modal="true"
            className="modal-glass w-full max-w-md rounded-2xl p-5 text-zinc-100 animate-in zoom-in-95 duration-150"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-500/10">
                <AlertTriangle className="h-5 w-5 text-red-400" />
              </div>
              <div className="min-w-0">
                <h3 className="text-sm font-bold text-white">Delete anime folder from PC</h3>
                <p className="mt-1 text-xs leading-relaxed text-zinc-400">
                  Permanently delete &ldquo;{localFolder.canonicalTitle || localFolder.folderName}&rdquo; and its files from this PC?
                  This frees {formatFileSize(seasonSizeBytes)}. Active downloads to this folder will be stopped; watch history and progress are kept.
                </p>
              </div>
            </div>

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDeleteSeason(false)}
                disabled={deleteBusy}
                className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-white disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeleteSeasonConfirmed}
                disabled={deleteBusy}
                className="flex select-none items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-bold text-white shadow-sm transition-colors hover:bg-red-500 disabled:opacity-60 active:scale-[0.98]"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>{deleteBusy ? 'Deleting…' : 'Delete files'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Single-episode delete confirmation */}
      {confirmDeleteEpisode && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center modal-dimmer p-4 animate-in fade-in duration-150"
          onClick={() => !deleteBusy && setConfirmDeleteEpisode(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            data-modal="true"
            className="modal-glass w-full max-w-md rounded-2xl p-5 text-zinc-100 animate-in zoom-in-95 duration-150"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-500/10">
                <AlertTriangle className="h-5 w-5 text-red-400" />
              </div>
              <div className="min-w-0">
                <h3 className="text-sm font-bold text-white">Delete episode from PC</h3>
                <p className="mt-1 break-all text-xs leading-relaxed text-zinc-400">
                  Delete &ldquo;{confirmDeleteEpisode.fileName}&rdquo; from PC? This frees{' '}
                  {formatFileSize(confirmDeleteEpisode.size)}. Watch history and progress are kept.
                </p>
              </div>
            </div>

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDeleteEpisode(null)}
                disabled={deleteBusy}
                className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-white disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeleteEpisodeConfirmed}
                disabled={deleteBusy}
                className="flex select-none items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-bold text-white shadow-sm transition-colors hover:bg-red-500 disabled:opacity-60 active:scale-[0.98]"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>{deleteBusy ? 'Deleting…' : 'Delete files'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Release picker: searches the user's indexers for this title; the
          picked release is queued by handlePickRelease. episode=null means
          whole season / pack. */}
      <ReleasePickerModal
        open={pickerState !== null}
        title={hero.title}
        anilistId={anilistId}
        mediaFormat={details?.format ?? hero.format ?? null}
        season={seasonHint}
        part={partHint}
        episode={pickerState?.episode ?? null}
        episodeCount={details?.episodesCount ?? null}
        episodeDurationMinutes={details?.durationMinutes ?? null}
        aliases={searchAliases}
        franchiseSeasons={franchiseSeasonTitles}
        onCancel={handleCancelReleasePicker}
        onPicked={handlePickRelease}
      />
    </div>
  )
}

// Memoized: the title page re-renders on its own state only. App-level churn
// (scroll progress, P2P bursts) must not reconcile this 2000-line tree.
export const AnimeDetailView = React.memo(AnimeDetailViewImpl);
