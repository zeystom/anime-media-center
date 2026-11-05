/**
 * AnimeDetailView: the unified full-screen title page of the hybrid design.
 * Merges local library data (scanned folders, playback history, user list)
 * with remote catalog details (AniList) and remote episode metadata (ani.zip):
 * hero banner/poster, meta chips, local tech tags, list-status + score
 * controls, and a single episode list merging local files with remote rows.
 * Purely local titles (no AniList id) render without any remote fetches.
 */
import React, { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Download, Film, Play, Star, Wand2, X } from 'lucide-react'
import type {
  AnimeFolder,
  CatalogItem,
  Episode,
  PlaybackProgress,
  RemoteEpisodeInfo,
  UserLibraryEntry,
  UserListStatus,
} from '../../types'
import type { RailItem } from '../../hooks/useCatalog'
import { findLocalFolder, useLocalStatus } from '../../hooks/useLocalStatus'
import { useUserLibrary } from '../../hooks/useUserLibrary'
import { StatusBadges } from '../common/StatusBadges'
import { EpisodeRow } from './EpisodeRow'
// CRITICAL: import the wasm-free regex engine directly — never from
// ../../lib/releaseParser/index.ts, which pulls native/wasm deps unsuitable
// for the renderer process.
import { parseReleaseCore } from '../../lib/releaseParser/regexEngine.ts'
import { formatTime } from '../../utils/format'

export type DetailSource = { kind: 'catalog'; item: RailItem } | { kind: 'local'; folder: AnimeFolder }

export interface AnimeDetailViewProps {
  source: DetailSource
  folders: AnimeFolder[]
  history: Record<string, PlaybackProgress>
  userEntries: Record<number, UserLibraryEntry>
  onClose: () => void
  onPlayEpisode: (episode: Episode, startAt?: number) => void
  onOpenWhisper: (folder: AnimeFolder) => void
}

interface MergedEpisodeRow {
  num: number
  local?: Episode
  remote?: RemoteEpisodeInfo
}

const STATUS_OPTIONS: { value: UserListStatus; label: string }[] = [
  { value: 'watching', label: 'Watching' },
  { value: 'completed', label: 'Completed' },
  { value: 'planning', label: 'Planning' },
  { value: 'paused', label: 'Paused' },
  { value: 'dropped', label: 'Dropped' },
]

const DOWNLOAD_TOOLTIP = 'P2P downloads arrive in a later update'

const SELECT_CLASS =
  'rounded-lg border border-zinc-700/60 bg-zinc-800/90 px-3 py-2 text-sm font-semibold text-zinc-100 focus:outline-none focus:ring-2 focus:ring-red-600/40 disabled:cursor-not-allowed disabled:opacity-50'

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

const MetaChip: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => (
  <span
    className={`inline-flex items-center gap-1 rounded-full border border-white/10 bg-black/40 px-2 py-0.5 text-xs font-semibold text-zinc-200 backdrop-blur-sm ${className || ''}`}
  >
    {children}
  </span>
)

export const AnimeDetailView: React.FC<AnimeDetailViewProps> = ({
  source,
  folders,
  history,
  userEntries,
  onClose,
  onPlayEpisode,
  onOpenWhisper,
}) => {
  const [details, setDetails] = useState<CatalogItem | null>(null)
  const [remoteEpisodes, setRemoteEpisodes] = useState<RemoteEpisodeInfo[]>([])
  const [detailsLoading, setDetailsLoading] = useState(false)
  const [bgFailed, setBgFailed] = useState(false)
  const [posterFailed, setPosterFailed] = useState(false)

  const railItem = source.kind === 'catalog' ? source.item : null

  // Local folder resolution: direct for local sources, fuzzy (anilistId then
  // normalized title) for catalog sources.
  const localFolder = useMemo(() => {
    if (source.kind === 'local') return source.folder
    return findLocalFolder(folders, { anilistId: source.item.anilistId, title: source.item.title })
  }, [source, folders])

  // Remote fetches happen for catalog items and for local folders that carry
  // an AniList id; purely local titles skip all network calls.
  const anilistId =
    source.kind === 'catalog' ? source.item.anilistId : (localFolder?.anilistId ?? null)

  const { statusFor } = useLocalStatus(folders, history, userEntries)
  // Mutators only: reads come from the userEntries prop (plus this instance's
  // optimistic entries so the score control enables right after a status pick).
  const userLibrary = useUserLibrary()

  // Escape closes the overlay (unless a consumer already handled the event).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Remote details + episode metadata for the resolved AniList id.
  useEffect(() => {
    if (anilistId == null) {
      setDetails(null)
      setRemoteEpisodes([])
      setDetailsLoading(false)
      return
    }
    let cancelled = false
    setDetailsLoading(true)
    const load = async () => {
      const api = window.electronAPI
      if (!api) {
        if (!cancelled) {
          setDetails(null)
          setRemoteEpisodes([])
          setDetailsLoading(false)
        }
        return
      }
      const [detailsRes, episodesRes] = await Promise.all([
        api.getCatalogDetails(anilistId).catch(() => null),
        api.getRemoteEpisodes(anilistId).catch(() => [] as RemoteEpisodeInfo[]),
      ])
      if (cancelled) return
      setDetails(detailsRes ?? null)
      setRemoteEpisodes(Array.isArray(episodesRes) ? episodesRes : [])
      setDetailsLoading(false)
    }
    load()
    return () => {
      cancelled = true
    }
  }, [anilistId])

  // Hero data: full CatalogItem preferred, RailItem/folder as fallback chain.
  const hero = useMemo(() => {
    const fallbackTitle = railItem?.title || localFolder?.canonicalTitle || localFolder?.folderName || ''
    const title = details ? details.title.english || details.title.romaji || fallbackTitle : fallbackTitle
    return {
      title,
      bannerUrl: details?.bannerUrl ?? railItem?.bannerUrl ?? localFolder?.bannerUrl ?? null,
      posterUrl: details?.posterUrl ?? railItem?.posterUrl ?? localFolder?.posterUrl ?? null,
      averageScore: details?.averageScore ?? railItem?.averageScore ?? localFolder?.averageScore ?? null,
      episodesCount: details?.episodesCount ?? railItem?.episodesCount ?? null,
      totalEpisodes: localFolder?.totalEpisodes ?? 0,
      format: details?.format ?? railItem?.format ?? null,
      status: details?.status ?? railItem?.status ?? null,
      seasonYear: details?.seasonYear ?? railItem?.seasonYear ?? null,
      genres: details?.genres ?? localFolder?.genres ?? [],
      description: stripHtml(details?.description ?? localFolder?.synopsis ?? null),
      idMal: details?.idMal ?? null,
    }
  }, [details, railItem, localFolder])

  useEffect(() => {
    setBgFailed(false)
    setPosterFailed(false)
  }, [hero.bannerUrl, hero.posterUrl])

  const badgeState = useMemo(
    () =>
      statusFor({
        anilistId: anilistId ?? null,
        title: hero.title,
        apiEpisodesCount: hero.episodesCount ?? null,
      }),
    [statusFor, anilistId, hero.title, hero.episodesCount]
  )

  // Local episodes keyed by their parsed release number (fallback: index+1),
  // sorted ascending for both the merge and the resume target.
  const localRows = useMemo(() => {
    return (localFolder?.episodes ?? [])
      .map((episode, index) => {
        const parsed = episode?.fileName ? parseReleaseCore(episode.fileName) : null
        const num =
          typeof parsed?.episodeNumber === 'number' && Number.isFinite(parsed.episodeNumber)
            ? parsed.episodeNumber
            : index + 1
        return { episode, num }
      })
      .sort((a, b) => a.num - b.num)
  }, [localFolder])

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
      const existing = byNum.get(remote.number)
      if (existing) existing.remote = remote
      else byNum.set(remote.number, { num: remote.number, remote })
    }
    return Array.from(byNum.values()).sort((a, b) => a.num - b.num)
  }, [localRows, remoteEpisodes])

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

  const handleStatusChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    if (anilistId == null) return
    const status = event.target.value as UserListStatus
    if (!STATUS_OPTIONS.some((option) => option.value === status)) return
    void userLibrary.setStatus(anilistId, hero.idMal, hero.title, status)
  }

  const handleScoreChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    if (anilistId == null) return
    const score = Number(event.target.value)
    void userLibrary.setScore(anilistId, Number.isNaN(score) || score === 0 ? null : score)
  }

  const handlePlayResume = () => {
    if (!resumeEpisode) return
    onPlayEpisode(resumeEpisode, resumeStartAt)
  }

  const showBanner = !!hero.bannerUrl && !bgFailed
  const showPoster = !!hero.posterUrl && !posterFailed
  const episodeTotal = hero.episodesCount ?? hero.totalEpisodes

  return (
    <div className="fixed inset-0 z-40 overflow-y-auto bg-[#0f0f12]">
      {/* Sticky top bar with close button */}
      <div className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-white/5 bg-[#0f0f12]/80 px-4 py-2.5 backdrop-blur-md">
        <span className="truncate text-xs font-bold uppercase tracking-widest text-zinc-500">Title Details</span>
        <button
          type="button"
          onClick={onClose}
          title="Close (Esc)"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/5 text-zinc-300 backdrop-blur-md transition-colors hover:bg-white/10 hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Hero */}
      <div className="relative">
        {/* Background: banner, or blurred poster as fallback */}
        {showBanner ? (
          <img
            src={hero.bannerUrl || ''}
            alt=""
            loading="lazy"
            onError={() => setBgFailed(true)}
            className="absolute inset-0 h-full w-full object-cover opacity-40"
          />
        ) : hero.posterUrl && !bgFailed ? (
          <img
            src={hero.posterUrl || ''}
            alt=""
            loading="lazy"
            onError={() => setBgFailed(true)}
            className="absolute inset-0 h-full w-full scale-125 object-cover opacity-20 blur-3xl"
          />
        ) : null}
        <div className="absolute inset-0 bg-gradient-to-t from-[#0f0f12] via-[#0f0f12]/70 to-[#0f0f12]/40 pointer-events-none" />
        <div className="absolute inset-0 bg-gradient-to-r from-[#0f0f12]/90 via-[#0f0f12]/55 to-transparent pointer-events-none" />

        <div className="relative z-10 mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-8 sm:flex-row">
          {/* Poster thumb */}
          <div className="aspect-[2/3] w-[180px] shrink-0 overflow-hidden rounded-xl border border-white/10 bg-zinc-900 shadow-2xl">
            {showPoster ? (
              <img
                src={hero.posterUrl || ''}
                alt={hero.title}
                loading="lazy"
                onError={() => setPosterFailed(true)}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-zinc-900 to-zinc-950">
                <Film className="h-10 w-10 text-zinc-700" />
              </div>
            )}
          </div>

          {/* Info column */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
            className="min-w-0 flex-1"
          >
            <h1 className="text-3xl font-black leading-tight tracking-tight text-white" title={hero.title}>
              {hero.title}
            </h1>

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
              {episodeTotal > 0 && (
                <MetaChip>
                  <span>{episodeTotal} EP</span>
                </MetaChip>
              )}
              {hero.status && (
                <MetaChip className={statusChipClass(hero.status)}>
                  <span>{hero.status.replace(/_/g, ' ')}</span>
                </MetaChip>
              )}
            </div>

            {badgeState && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                <StatusBadges state={badgeState} />
              </div>
            )}

            {/* Tech tag chips (LOCAL only) */}
            {techChips.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                {techChips.map((chip) => (
                  <span
                    key={chip}
                    className="rounded border border-white/15 bg-black/60 px-2 py-0.5 font-mono text-[10px] font-bold text-zinc-200 backdrop-blur-sm"
                  >
                    {chip}
                  </span>
                ))}
              </div>
            )}

            {/* Genres */}
            {hero.genres.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                {hero.genres.map((genre) => (
                  <span
                    key={genre}
                    className="rounded border border-white/10 bg-white/5 px-2.5 py-0.5 text-[11px] font-medium text-zinc-300"
                  >
                    {genre}
                  </span>
                ))}
              </div>
            )}

            {hero.description && (
              <p className="mt-4 max-w-2xl text-xs leading-relaxed text-zinc-300 line-clamp-3">{hero.description}</p>
            )}

            {/* Actions row */}
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handlePlayResume}
                disabled={!resumeEpisode}
                title={resumeEpisode ? 'Play the first unwatched local episode' : 'No local episodes on this PC yet'}
                className={`flex select-none items-center gap-2 rounded-xl px-6 py-3 text-sm font-bold shadow-lg transition-all active:scale-[0.98] ${
                  resumeEpisode
                    ? 'bg-gradient-to-r from-red-600 to-red-500 text-white shadow-red-600/30 hover:from-red-500 hover:to-red-400 hover:shadow-red-600/50 hover:scale-[1.02]'
                    : 'cursor-not-allowed border border-zinc-700/40 bg-zinc-800 text-zinc-500 opacity-60 shadow-none'
                }`}
              >
                <Play className="h-4 w-4 fill-current" />
                <span>
                  {resumeStartAt && resumeProgress ? `Resume from ${formatTime(resumeProgress.currentTime)}` : 'Play'}
                </span>
              </button>

              {localFolder && (
                <button
                  type="button"
                  onClick={() => onOpenWhisper(localFolder)}
                  className="flex select-none items-center gap-2 rounded-xl border border-indigo-500/40 bg-indigo-600/20 px-4 py-3 text-xs font-bold text-indigo-300 transition-all hover:bg-indigo-600/30 hover:scale-[1.02] active:scale-[0.98]"
                >
                  <Wand2 className="h-4 w-4" />
                  <span>Whisper Batch Subtitles</span>
                </button>
              )}

              <button
                type="button"
                disabled
                title={DOWNLOAD_TOOLTIP}
                className="flex cursor-not-allowed select-none items-center gap-2 rounded-xl border border-zinc-700/40 bg-zinc-800/40 px-4 py-3 text-xs font-bold text-zinc-500 opacity-70"
              >
                <Download className="h-4 w-4" />
                <span>Download</span>
              </button>
            </div>

            {/* List status + score (only when the AniList id is known) */}
            {anilistId != null && (
              <div className="mt-5 flex flex-wrap items-center gap-2">
                <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">My List</span>
                <select value={statusValue} onChange={handleStatusChange} className={SELECT_CLASS}>
                  <option value="">Add to list</option>
                  {STATUS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <select
                  value={scoreValue}
                  onChange={handleScoreChange}
                  disabled={!currentEntry}
                  title={currentEntry ? 'Your score' : 'Set a list status first'}
                  className={SELECT_CLASS}
                >
                  {Array.from({ length: 11 }, (_, n) => n).map((n) => (
                    <option key={n} value={n}>
                      {n === 0 ? '—' : n}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </motion.div>
        </div>
      </div>

      {/* Episode list */}
      <section className="mx-auto w-full max-w-7xl px-6 pb-16">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-black text-white">Episodes</h2>
          {mergedRows.length > 0 && <span className="text-xs text-zinc-500">{mergedRows.length} total</span>}
        </div>

        {mergedRows.length === 0 ? (
          <p className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-4 py-10 text-center text-sm text-zinc-500">
            {detailsLoading ? 'Loading episodes…' : 'No episodes available for this title yet'}
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {mergedRows.map((row) => {
              const local = row.local
              const progress = local ? history[local.filePath] : undefined
              const startAt =
                progress && !progress.completed && progress.currentTime > 0 ? progress.currentTime : undefined
              const title = local
                ? local.episodeTitle ||
                  local.kitsuTitle ||
                  local.title ||
                  row.remote?.title ||
                  local.fileName ||
                  `Episode ${row.num}`
                : row.remote?.title || `Episode ${row.num}`
              const thumbnail = local
                ? local.kitsuThumbnail || local.thumbnailUrl || row.remote?.thumbnailUrl || null
                : (row.remote?.thumbnailUrl ?? null)

              return (
                <EpisodeRow
                  key={`ep-${row.num}-${local?.filePath ?? 'remote'}`}
                  number={String(row.num)}
                  title={title}
                  thumbnailUrl={thumbnail}
                  airDate={row.remote?.airDate ?? null}
                  local={local}
                  remoteOnly={!local}
                  watched={!!local && history[local.filePath]?.completed === true}
                  isDownloading={!!local?.isDownloading}
                  downloadProgress={local?.downloadProgress}
                  onPlay={local ? () => onPlayEpisode(local, startAt) : undefined}
                  onWhisper={local && localFolder ? () => onOpenWhisper(localFolder) : undefined}
                />
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}
