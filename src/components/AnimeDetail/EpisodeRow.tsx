import React, { useEffect, useId, useMemo, useState } from 'react'
import { Check, CheckCircle2, Clock3, Download, Film, MoreHorizontal, Pause, Play, Subtitles, Trash2, Wand2, X } from 'lucide-react'
import type { Episode, PlaybackProgress, TorrentJob } from '../../types'
import { formatRelativeAirDate, formatTime } from '../../utils/format'
import { parseReleaseCore } from '../../lib/releaseParser/regexEngine.ts'
import { DownloadActionButton } from '../common/DownloadActionButton'
import { PLACEHOLDER_EPISODE_IMAGE } from '../../utils/assets'

export interface EpisodeRowProps {
  number: string
  /** Real episode title; when absent the card reads a single "Episode N". */
  title?: string | null
  /** Render a single movie as a wide feature rather than a lone episode tile. */
  isFeatureFilm?: boolean
  thumbnailUrl?: string | null
  fallbackThumbnailUrl?: string | null
  airDate?: string | null
  local?: Episode
  remoteOnly?: boolean
  /** Episode has not aired yet: download is unavailable, air date is shown. */
  unaired?: boolean
  /** Ongoing (airing) title: cards show relative air times ("in 6 days" / "2 days ago"). */
  ongoing?: boolean
  watched?: boolean
  isDownloading?: boolean
  downloadProgress?: number
  playbackProgress?: PlaybackProgress
  torrentJob?: TorrentJob
  queuedForSearch?: boolean
  onPlay?: () => void
  onWhisper?: () => void
  onDownload?: () => void
  onDownloadLongPress?: () => void
  downloadRoots?: string[]
  selectedDownloadRoot?: string | null
  onSelectDownloadRoot?: (root: string) => void
  onDelete?: () => void
}

function fileProgressForEpisode(job: TorrentJob | undefined, episodeNumber: number): number | undefined {
  if (!job) return undefined
  const matching = (job.filesProgress || []).find((file) => {
    const parsed = parseReleaseCore(file.name)
    return parsed.episodeNumbers.includes(episodeNumber) || parsed.episodeNumber === episodeNumber
  })
  if (matching) return matching.progress
  // A job-level percentage is only episode-specific when exactly one episode
  // was selected. For multi-episode batches it falsely showed the same nearly
  // complete bar on every card and made completed files look stuck.
  if ((job.episodes?.length === 1 && job.episodes[0] === episodeNumber) || (!job.episodes?.length && job.episode === episodeNumber)) return job.progress
  return undefined
}

/** 16:9 episode tile shared visually with Library, with local and torrent state. */
export const EpisodeRow: React.FC<EpisodeRowProps> = ({
  number, title, isFeatureFilm = false, thumbnailUrl, fallbackThumbnailUrl, airDate, local, remoteOnly = false, unaired = false, watched = false,
  isDownloading = false, downloadProgress, playbackProgress, torrentJob, queuedForSearch = false,
  onPlay, onWhisper, onDownload, onDownloadLongPress, downloadRoots = [], selectedDownloadRoot, onSelectDownloadRoot, onDelete,
}) => {
  const [imgError, setImgError] = useState(false)
  const [activeThumbnail, setActiveThumbnail] = useState(thumbnailUrl || fallbackThumbnailUrl || null)
  const [folderMenuOpen, setFolderMenuOpen] = useState(false)
  const episodeNumber = Number(number)
  const torrentProgress = fileProgressForEpisode(torrentJob, episodeNumber) ?? downloadProgress
  const torrentActive = !!torrentJob && ['queued', 'connecting', 'downloading', 'paused'].includes(torrentJob.status)
  const torrentFailed = torrentJob?.status === 'error'
  const downloadActive = torrentActive || torrentFailed || queuedForSearch || isDownloading
  const downloaded = !!local || torrentJob?.status === 'completed' || torrentJob?.status === 'seeding'
  const fileReceived = !downloaded && torrentProgress != null && torrentProgress >= 99.99 && torrentJob?.status === 'downloading'
  const watchedPercent = playbackProgress && playbackProgress.duration > 0
    ? Math.min(100, Math.round(playbackProgress.currentTime / playbackProgress.duration * 100))
    : 0
  const filmDuration = playbackProgress?.duration || local?.duration || 0
  const filmCurrentTime = playbackProgress?.currentTime || 0
  const filmCanResume = filmCurrentTime > 0 && !playbackProgress?.completed

  useEffect(() => {
    setImgError(false)
    setActiveThumbnail(thumbnailUrl || fallbackThumbnailUrl || null)
  }, [thumbnailUrl, fallbackThumbnailUrl])

  // Circular progress ring around the download button while a torrent runs.
  // Without a measurable percent (queued/connecting/finding a release) the
  // ring spins as an indeterminate arc instead.
  const ringGradientId = useId().replace(/:/g, '')
  const ringRadius = 31
  const ringCircumference = 2 * Math.PI * ringRadius
  const ringPercent = downloadActive && !torrentFailed && torrentProgress != null
    ? Math.max(0, Math.min(100, torrentProgress))
    : null

  // "Episode 3 — Let Them Eat Cake" when a real title exists, a single
  // "Episode 3" otherwise (no "Episode 3 — Episode 3" duplication).
  const displayTitle = isFeatureFilm ? 'Full movie' : title && title.trim() ? `Episode ${number} — ${title}` : `Episode ${number}`

  const airDateLabel = useMemo(() => {
    if (!airDate) return null
    const time = Date.parse(airDate)
    if (!Number.isFinite(time)) return null
    return new Date(time).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  }, [airDate])

  // Relative airing time ("in 6 days" / "23 hours ago"), the ongoing-title
  // equivalent of AniList's episode list. Falls back to the absolute date.
  const relativeAir = useMemo(() => formatRelativeAirDate(airDate), [airDate])

  return (
    <article className={`group overflow-hidden rounded-2xl border bg-[#17181e] shadow-sm transition hover:-translate-y-0.5 hover:shadow-xl hover:shadow-black/30 ${isFeatureFilm ? 'grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_1.15fr]' : ''} ${downloadActive ? 'border-cyan-400/25' : 'border-white/[0.08] hover:border-white/15'}`}>
      <div className={`relative aspect-video overflow-hidden bg-zinc-950 ${isFeatureFilm ? 'sm:aspect-auto sm:min-h-[250px]' : ''}`}>
        {activeThumbnail && !imgError ? (
          <img src={activeThumbnail} alt="" loading="lazy" onError={() => {
            if (activeThumbnail === thumbnailUrl && fallbackThumbnailUrl && fallbackThumbnailUrl !== thumbnailUrl) setActiveThumbnail(fallbackThumbnailUrl)
            else setImgError(true)
          }} className={`h-full w-full object-cover transition duration-300 ${!downloaded || downloadActive ? 'scale-105 blur-sm brightness-50' : 'group-hover:scale-105'}`} />
        ) : (
          <div className="relative flex h-full w-full items-center justify-center bg-[#0e0915] overflow-hidden">
            <img
              src={PLACEHOLDER_EPISODE_IMAGE}
              alt=""
              loading="lazy"
              className={`h-full w-full object-cover transition duration-300 ${downloadActive ? 'scale-105 blur-sm brightness-50' : 'group-hover:scale-105'}`}
            />
          </div>
        )}

        {watched && downloaded && <span title="Watched" className="absolute right-2.5 top-2.5 flex h-6 w-6 items-center justify-center rounded-full border border-emerald-200/30 bg-emerald-500 text-white shadow"><Check className="h-3.5 w-3.5" /></span>}

        {downloaded && !downloadActive && onPlay && (
          <button type="button" onClick={onPlay} title="Play episode" className="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 transition hover:opacity-100 focus:opacity-100">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-rose-500 text-white shadow-lg shadow-rose-950/50"><Play className="ml-0.5 h-5 w-5 fill-current" /></span>
          </button>
        )}

        {!downloaded && !downloadActive && onDownload && !unaired && (
          <div className="absolute inset-0 flex items-center justify-center">
            <DownloadActionButton type="button" onClick={onDownload} onLongPress={onDownloadLongPress || onDownload} title="Queue episode download · hold for manual search" className="flex h-12 w-12 items-center justify-center rounded-full border border-cyan-100/30 bg-cyan-300/20 text-cyan-100 shadow-lg shadow-black/40 backdrop-blur-md transition hover:scale-110 hover:bg-cyan-300/35 focus:outline-none focus:ring-2 focus:ring-cyan-200/70">
              <Download className="h-5 w-5" />
            </DownloadActionButton>
          </div>
        )}

        {downloadActive && !torrentFailed && (
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <div className="relative flex h-[76px] w-[76px] items-center justify-center">
              <svg viewBox="0 0 72 72" className={`absolute inset-0 h-full w-full ${ringPercent == null ? 'release-search-ring' : '-rotate-90'}`}>
                <defs>
                  <linearGradient id={`ep-ring-${ringGradientId}`} x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#67e8f9" />
                    <stop offset="55%" stopColor="#22d3ee" />
                    <stop offset="100%" stopColor="#6ee7b7" />
                  </linearGradient>
                </defs>
                <circle cx="36" cy="36" r={ringRadius} fill="none" stroke="black" strokeOpacity="0.45" strokeWidth="5" />
                {ringPercent == null ? (
                  <circle cx="36" cy="36" r={ringRadius} fill="none" stroke={`url(#ep-ring-${ringGradientId})`} strokeWidth="5" strokeLinecap="round" className="release-search-ring__arc" />
                ) : (
                  <circle cx="36" cy="36" r={ringRadius} fill="none" stroke={`url(#ep-ring-${ringGradientId})`} strokeWidth="5" strokeLinecap="round" strokeDasharray={ringCircumference} strokeDashoffset={ringCircumference * (1 - ringPercent / 100)} className="transition-[stroke-dashoffset] duration-500 ease-out" />
                )}
              </svg>
              <div className={`flex h-12 w-12 items-center justify-center rounded-full border shadow-lg shadow-black/40 backdrop-blur-[2px] ${torrentJob?.status === 'paused' ? 'border-amber-100/30 bg-amber-300/20 text-amber-100' : 'border-cyan-100/30 bg-cyan-300/20 text-cyan-100'}`}>
                {torrentJob?.status === 'paused' ? <Pause className="h-5 w-5" /> : <Download className="h-5 w-5" />}
              </div>
            </div>
            {ringPercent != null && <span className="mt-1 text-[11px] font-bold text-cyan-100 drop-shadow">{Math.round(ringPercent)}%</span>}
          </div>
        )}

        {torrentFailed && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/45 px-3 text-center">
            <X className="h-5 w-5 text-rose-300" />
            {torrentJob?.error && <span className="line-clamp-2 max-w-full text-[10px] text-rose-200">{torrentJob.error}</span>}
            {onDownload && <DownloadActionButton type="button" onClick={onDownload} onLongPress={onDownloadLongPress || onDownload} className="rounded-full border border-rose-300/30 bg-rose-500/20 px-3 py-1 text-[10px] font-bold text-rose-100 transition hover:bg-rose-500/35">Retry</DownloadActionButton>}
          </div>
        )}

        {playbackProgress && playbackProgress.currentTime > 0 && downloaded && !downloadActive && (
          <div className="absolute bottom-0 left-0 right-0 h-1.5 bg-black/60"><div className={`h-full ${playbackProgress.completed ? 'bg-emerald-400' : 'bg-rose-500'}`} style={{ width: `${watchedPercent}%` }} /></div>
        )}

        {!isFeatureFilm && (playbackProgress?.currentTime || local?.duration || local?.hasWhisperSrt || local?.hasExternalSrt || local?.hasEmbeddedDubtitles || local?.hasEmbeddedSubtitles) && (
          <div className="pointer-events-none absolute left-3 top-3 z-10 flex max-w-[calc(100%-1.5rem)] items-center gap-1.5">
            {(local?.hasWhisperSrt || local?.hasEmbeddedDubtitles || local?.hasEmbeddedSubtitles || local?.hasExternalSrt) && (
              <span className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-1 text-[10px] font-semibold shadow-sm backdrop-blur-md ${local.hasWhisperSrt ? 'border-indigo-400/30 bg-[#131224]/85 text-indigo-200' : local.hasEmbeddedDubtitles ? 'border-purple-200/25 bg-[#17121f]/85 text-purple-100' : 'border-emerald-200/25 bg-[#101b19]/85 text-emerald-100'}`}>
                <Subtitles className="h-3 w-3" />
                {local.hasWhisperSrt ? 'AI Sub' : local.hasEmbeddedDubtitles ? 'Dub Sub' : local.hasEmbeddedSubtitles ? 'Sub' : 'Ext Sub'}
              </span>
            )}
            {playbackProgress?.currentTime ? (
              <span className="truncate rounded-md border border-white/15 bg-black/75 px-1.5 py-1 font-mono text-[10px] font-medium text-white shadow-sm backdrop-blur-md">
                {formatTime(playbackProgress.currentTime)} / {formatTime(playbackProgress.duration || local?.duration || 0)}
              </span>
            ) : local?.duration ? (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-white/15 bg-black/75 px-1.5 py-1 font-mono text-[10px] font-medium text-white shadow-sm backdrop-blur-md">
                <Clock3 className="h-3 w-3" />{formatTime(local.duration)}
              </span>
            ) : null}
          </div>
        )}
      </div>

      {isFeatureFilm ? (
        <div className="flex flex-col justify-center p-5 sm:p-8 lg:p-10">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.16em]" style={{ color: 'var(--anime-accent)', borderColor: 'var(--anime-accent-soft)', backgroundColor: 'var(--anime-accent-soft)' }}>Feature film</span>
            <span className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold ${downloaded ? 'border-emerald-300/20 bg-emerald-300/10 text-emerald-200' : downloadActive ? 'border-cyan-300/20 bg-cyan-300/10 text-cyan-200' : 'border-white/10 bg-black/20 text-zinc-400'}`}>
              {watched ? 'Watched' : downloaded ? 'Ready to watch' : downloadActive ? 'Downloading' : remoteOnly ? 'Not downloaded' : 'Available'}
            </span>
          </div>
          <h3 className="mt-4 text-2xl font-black tracking-tight text-white sm:text-3xl" title={displayTitle}>Full movie</h3>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-zinc-400">
            {filmDuration > 0 && <span className="inline-flex items-center gap-1.5"><Clock3 className="h-3.5 w-3.5" />{formatTime(filmDuration)}</span>}
            {(local?.hasEmbeddedDubtitles || local?.hasEmbeddedSubtitles) && <span className="inline-flex items-center gap-1.5"><Subtitles className="h-3.5 w-3.5" />{local.hasEmbeddedDubtitles ? 'Dubtitles + subtitles' : 'Subtitles included'}</span>}
            {playbackProgress && filmCurrentTime > 0 && <span className="font-mono text-zinc-300">{formatTime(filmCurrentTime)} watched</span>}
          </div>

          {playbackProgress && filmDuration > 0 && filmCurrentTime > 0 && (
            <div className="mt-5 max-w-lg">
              <div className="mb-1.5 flex justify-between text-[10px] font-medium text-zinc-500"><span>{watchedPercent}% watched</span><span>{formatTime(Math.max(0, filmDuration - filmCurrentTime))} left</span></div>
              <div className="h-1.5 overflow-hidden rounded-full bg-black/50"><div className="h-full rounded-full" style={{ width: `${watchedPercent}%`, backgroundColor: 'var(--anime-accent)' }} /></div>
            </div>
          )}

          <div className="mt-6 flex flex-wrap items-center gap-2.5">
            {downloaded && onPlay && <button type="button" onClick={onPlay} className="inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-bold text-white shadow-lg transition hover:-translate-y-0.5" style={{ backgroundColor: 'var(--anime-accent)', boxShadow: '0 10px 28px var(--anime-accent-soft)' }}><Play className="h-4 w-4 fill-current" />{filmCanResume ? 'Resume movie' : watched ? 'Watch again' : 'Play movie'}</button>}
            {!downloaded && onDownload && !unaired && <DownloadActionButton type="button" onClick={onDownload} onLongPress={onDownloadLongPress || onDownload} title="Download movie · hold for manual search" className="inline-flex items-center gap-2 rounded-xl border border-cyan-200/20 bg-cyan-300/10 px-5 py-3 text-sm font-bold text-cyan-100 transition hover:bg-cyan-300/20"><Download className="h-4 w-4" />Download movie</DownloadActionButton>}
            {onWhisper && <button type="button" onClick={onWhisper} title="Generate subtitles" className="inline-flex items-center gap-2 rounded-xl border border-indigo-400/20 bg-indigo-400/[0.06] px-4 py-3 text-xs font-semibold text-indigo-200 transition hover:bg-indigo-400/15"><Wand2 className="h-4 w-4" /><span>Subtitles</span></button>}
            {onDelete && <button type="button" onClick={onDelete} title="Delete downloaded movie" className="inline-flex items-center gap-2 rounded-xl border border-rose-400/20 bg-rose-400/[0.05] px-4 py-3 text-xs font-semibold text-rose-200 transition hover:bg-rose-400/15"><Trash2 className="h-4 w-4" /><span>Delete file</span></button>}
            {onDownload && downloadRoots.length > 1 && <div className="relative">
              <button type="button" aria-label="Choose download folder" title={`Download folder: ${selectedDownloadRoot || downloadRoots[0]}`} onClick={() => setFolderMenuOpen((open) => !open)} className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/10 text-zinc-300 transition hover:bg-white/5"><MoreHorizontal className="h-4 w-4" /></button>
              {folderMenuOpen && <div className="absolute bottom-full right-0 z-50 mb-2 max-h-52 w-64 overflow-y-auto rounded-xl border border-white/10 bg-[#17181f] p-1.5 shadow-2xl">
                <p className="px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-500">Download to folder</p>
                {downloadRoots.map((root) => <button key={root} type="button" title={root} onClick={() => { onSelectDownloadRoot?.(root); setFolderMenuOpen(false) }} className={`block w-full rounded-lg px-2 py-2 text-left text-[11px] transition-colors ${selectedDownloadRoot === root ? 'bg-cyan-300/10 text-cyan-100' : 'text-zinc-300 hover:bg-white/5'}`}><span className="block truncate font-medium">{root.split(/[\\/]/).filter(Boolean).slice(-1)[0] || root}</span><span className="mt-0.5 block truncate font-mono text-[9px] text-zinc-500">{root}</span></button>)}
              </div>}
            </div>}
          </div>
        </div>
      ) : (
        <div className="p-3">
          <h3 className="line-clamp-1 min-h-5 text-xs font-semibold text-zinc-100" title={displayTitle}>{displayTitle}</h3>
          {relativeAir && (
            <p className={`mt-1 truncate text-[10px] font-medium ${relativeAir.future ? 'text-cyan-200/80' : 'text-zinc-400'}`} title={airDateLabel || undefined}>
              {relativeAir.future ? `Airs ${relativeAir.label}` : `Aired ${relativeAir.label}`}
            </p>
          )}
          <div className="mt-2 flex min-h-5 items-center justify-between gap-2 text-[10px]">
            <div className="flex min-w-0 items-center gap-1.5">
              {watched ? <span className="inline-flex items-center gap-1 text-emerald-300"><CheckCircle2 className="h-3 w-3" />Watched</span> : local || downloaded ? <span className="text-zinc-400">Downloaded</span> : unaired && !relativeAir ? <span className="text-zinc-500" title={airDateLabel || undefined}>Airs soon</span> : remoteOnly ? <span className="text-zinc-500">Not downloaded</span> : null}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {onWhisper && <button type="button" onClick={onWhisper} title="Generate subtitles" className="flex h-7 w-7 items-center justify-center rounded-full border border-indigo-400/25 text-indigo-200 transition hover:bg-indigo-400/15"><Wand2 className="h-3.5 w-3.5" /></button>}
              {onDelete && <button type="button" onClick={onDelete} title="Delete downloaded episode" className="flex h-7 w-7 items-center justify-center rounded-full border border-rose-400/25 text-rose-300 transition hover:bg-rose-400/15"><Trash2 className="h-3.5 w-3.5" /></button>}
            </div>
          </div>
        </div>
      )}
    </article>
  )
}
