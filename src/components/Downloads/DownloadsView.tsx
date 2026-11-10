/**
 * DownloadsView: the Downloads tab. Summarizes local disk usage per anime
 * folder (via the library storage overview IPC), lets the user delete whole
 * titles from the PC (files only — watch history and list progress are kept),
 * and hosts the live P2P download queue (torrent jobs via getP2pState /
 * onP2pStateChanged).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, Film, FileText, FolderOpen, HardDrive, Pause, Play, RefreshCw, Trash2, X } from 'lucide-react'
import type { AnimeFolder, P2pState, StorageOverview, StorageTitleUsage, TorrentJob, TorrentJobStatus } from '../../types'
import { formatFileSize } from '../../utils/format'
import { showGlobalToast } from '../Toast'

interface DownloadsViewProps {
  onRefreshLibrary: () => void
  folders: AnimeFolder[]
}

/** Sort rank for queue ordering: active first, then queued, then terminal. */
const STATUS_RANK: Record<TorrentJobStatus, number> = {
  downloading: 0,
  connecting: 1,
  seeding: 2,
  paused: 3,
  queued: 4,
  completed: 5,
  error: 5,
}

const STATUS_ACTIVE: Record<TorrentJobStatus, boolean> = {
  downloading: true,
  connecting: true,
  seeding: true,
  paused: true,
  queued: false,
  completed: false,
  error: false,
}

function jobStatusChip(status: TorrentJobStatus): { label: string; className: string } {
  switch (status) {
    case 'queued':
      return { label: 'Queued', className: 'bg-zinc-800 text-zinc-300' }
    case 'connecting':
      return { label: 'Connecting', className: 'bg-sky-500/15 text-sky-300' }
    case 'downloading':
      return { label: 'Downloading', className: 'animate-pulse bg-indigo-600/90 text-white' }
    case 'paused':
      return { label: 'Paused', className: 'bg-amber-500/15 text-amber-300' }
    case 'seeding':
      return { label: 'Seeding', className: 'bg-emerald-500/15 text-emerald-300' }
    case 'completed':
      return { label: 'Completed', className: 'bg-emerald-500/15 text-emerald-300' }
    case 'error':
      return { label: 'Error', className: 'bg-red-500/15 text-red-300' }
    default:
      return { label: status, className: 'bg-zinc-800 text-zinc-300' }
  }
}

/** Formats bytes/sec as MB/s with one decimal. */
function formatSpeedMBs(bytesPerSecond: number): string {
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`
}

export const DownloadsView: React.FC<DownloadsViewProps> = ({ onRefreshLibrary, folders }) => {
  const [overview, setOverview] = useState<StorageOverview | null>(null)
  const [loading, setLoading] = useState<boolean>(false)
  const [confirmTarget, setConfirmTarget] = useState<StorageTitleUsage | null>(null)
  const [deleting, setDeleting] = useState<boolean>(false)

  // P2P queue state (torrent engine jobs), driven by push updates.
  const [p2pState, setP2pState] = useState<P2pState | null>(null)
  const [confirmCancelHash, setConfirmCancelHash] = useState<string | null>(null)
  const [cancellingHash, setCancellingHash] = useState<string | null>(null)
  const [discardPartial, setDiscardPartial] = useState(false)

  const api = window.electronAPI
  const hasOverviewApi = typeof api?.getStorageOverview === 'function'

  const loadOverview = useCallback(async () => {
    if (!window.electronAPI?.getStorageOverview) return
    setLoading(true)
    try {
      const data = await window.electronAPI.getStorageOverview()
      setOverview(data ?? { titles: [], totalBytes: 0, freeBytes: null })
    } catch (err) {
      console.error('Failed to load storage overview:', err)
      setOverview({ titles: [], totalBytes: 0, freeBytes: null })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadOverview()
  }, [loadOverview])

  // Load the initial P2P state and subscribe to live queue updates.
  useEffect(() => {
    if (!window.electronAPI?.getP2pState || !window.electronAPI.onP2pStateChanged) return
    let cancelled = false
    window.electronAPI
      .getP2pState()
      .then((state) => {
        if (!cancelled) setP2pState(state)
      })
      .catch((err) => console.error('Failed to load P2P state:', err))
    const unsubscribe = window.electronAPI.onP2pStateChanged((state) => {
      if (!cancelled) setP2pState(state)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const handlePauseResume = async (job: TorrentJob) => {
    const api = window.electronAPI
    if (!api?.pauseDownload || !api?.resumeDownload) return
    const resuming = job.status === 'paused'
    try {
      const res = resuming
        ? await api.resumeDownload(job.infoHash)
        : await api.pauseDownload(job.infoHash)
      if (!res?.success) {
        showGlobalToast(resuming ? 'Failed to resume the download' : 'Failed to pause the download', 'error')
      }
    } catch (err) {
      console.error('Failed to toggle download state:', err)
      showGlobalToast(resuming ? 'Failed to resume the download' : 'Failed to pause the download', 'error')
    }
  }

  // Removes a job from the queue without touching the files on disk
  // (used by the cancel confirm strip and the completed-jobs clear button).
  const handleRemoveJob = async (infoHash: string, removeFiles = false) => {
    const api = window.electronAPI
    if (!api?.cancelDownload) return
    setCancellingHash(infoHash)
    try {
      const res = await api.cancelDownload(infoHash, removeFiles)
      if (res?.success) {
        showGlobalToast(removeFiles
          ? 'Removed from queue and deleted this release’s partial download data.'
          : 'Removed from queue. Partial data and completed anime files stay on disk.', 'success')
      } else {
        showGlobalToast('Failed to remove the download', 'error')
      }
    } catch (err) {
      console.error('Failed to cancel download:', err)
      showGlobalToast('Failed to remove the download', 'error')
    } finally {
      setCancellingHash(null)
      setConfirmCancelHash(null)
      setDiscardPartial(false)
    }
  }

  const handleShowInFolder = (job: TorrentJob) => {
    if (!window.electronAPI?.openFolderInExplorer) return
    window.electronAPI.openFolderInExplorer(job.targetFolder).catch((err) => {
      console.error('Failed to open folder:', err)
      showGlobalToast('Failed to open the download folder', 'error')
    })
  }

  const handleCopyDiagnostics = async (infoHash: string) => {
    try {
      const getDiag = window.electronAPI?.getTorrentDiagnostics
      if (!getDiag) {
        showGlobalToast('Diagnostics not available in current environment', 'warning')
        return
      }
      const report = await getDiag(infoHash)
      if (report) {
        await navigator.clipboard.writeText(report)
        showGlobalToast('Torrent diagnostics copied to clipboard', 'success')
      } else {
        showGlobalToast('No diagnostic history available for this torrent', 'warning')
      }
    } catch (err) {
      console.error('Failed to copy torrent diagnostics:', err)
      showGlobalToast('Failed to copy diagnostics to clipboard', 'error')
    }
  }

  const handleDeleteConfirmed = async () => {
    if (!confirmTarget || deleting) return
    setDeleting(true)
    try {
      const normalizePath = (value: string) => value.replace(/[\\/]+$/, '').toLocaleLowerCase()
      const jobsForTitle = (p2pState?.jobs ?? []).filter(
        (job) => normalizePath(job.targetFolder) === normalizePath(confirmTarget.folderPath),
      )
      for (const job of jobsForTitle) {
        const cancel = await window.electronAPI.cancelDownload(job.infoHash, true)
        if (!cancel?.success) {
          throw new Error(`Could not stop the active download before deleting the anime folder: ${cancel?.error || 'unknown error'}`)
        }
      }
      const res = await window.electronAPI.deleteAnimeFromPC(confirmTarget.folderPath)
      if (res?.success) {
        showGlobalToast(`Deleted anime files and stopped ${jobsForTitle.length} active download(s). Freed ${formatFileSize(res.deletedBytes ?? confirmTarget.totalBytes)}.`, 'success')
        // Remove the row locally so the list updates instantly, then resync.
        setOverview((prev) =>
          prev
            ? {
                ...prev,
                titles: prev.titles.filter((t) => t.folderPath !== confirmTarget.folderPath),
                totalBytes: Math.max(0, prev.totalBytes - (res.deletedBytes ?? confirmTarget.totalBytes)),
              }
            : prev
        )
        onRefreshLibrary()
      } else {
        showGlobalToast(res?.error || 'Failed to delete files from PC', 'error')
      }
    } catch (err) {
      console.error('Failed to delete anime from PC:', err)
      showGlobalToast(err instanceof Error ? err.message : 'Failed to delete files from PC', 'error')
    } finally {
      setDeleting(false)
      setConfirmTarget(null)
      loadOverview()
    }
  }

  const sortedTitles = (overview?.titles ?? []).slice().sort((a, b) => b.totalBytes - a.totalBytes)

  // Queue ordering: active jobs first, then queued, then completed/error by
  // addedAt descending. Push updates replace the whole state, so the memo is cheap.
  const sortedJobs = useMemo(() => {
    return (p2pState?.jobs ?? [])
      .slice()
      .sort((a, b) => {
        const rankDiff = STATUS_RANK[a.status] - STATUS_RANK[b.status]
        if (rankDiff !== 0) return rankDiff
        return b.addedAt - a.addedAt
      })
  }, [p2pState])

  const activeJobCount = sortedJobs.filter((j) => STATUS_ACTIVE[j.status]).length
  const downloadingJobs = sortedJobs.filter((j) => j.status === 'downloading')
  const totalDownloadSpeed = downloadingJobs.reduce((acc, j) => acc + (j.downloadSpeed || 0), 0)
  const totalUploadSpeed = downloadingJobs.reduce((acc, j) => acc + (j.uploadSpeed || 0), 0)

  // Queue-card covers: match a scanned library folder by anilistId; for jobs
  // of titles not yet in the library, fetch the poster via catalog details
  // (cached 24 h on the main side). One fetch per unique anilistId.
  const [jobPosters, setJobPosters] = useState<Map<number, string>>(new Map());
  const jobPosterFetchedRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    const wanted = [...new Set((p2pState?.jobs ?? [])
      .map((job) => job.anilistId)
      .filter((id): id is number => id != null && !jobPosterFetchedRef.current.has(id) && !folders.some((f) => f.anilistId === id)))];
    if (wanted.length === 0) return;
    for (const id of wanted) jobPosterFetchedRef.current.add(id);
    void (async () => {
      const api = window.electronAPI;
      if (!api?.getCatalogDetails) return;
      for (const anilistId of wanted) {
        try {
          const details = await api.getCatalogDetails(anilistId);
          if (details?.posterUrl) {
            setJobPosters((prev) => { const m = new Map(prev); m.set(anilistId, details.posterUrl as string); return m; });
          }
        } catch {}
      }
    })();
  }, [p2pState, folders]);

  const jobCover = (job: TorrentJob): string | null => {
    const folder = folders.find((f) => f.anilistId === job.anilistId);
    return folder?.posterUrl || (job.anilistId != null ? jobPosters.get(job.anilistId) || null : null);
  };
  const hasP2pApi =
    typeof window.electronAPI?.getP2pState === 'function' &&
    typeof window.electronAPI?.onP2pStateChanged === 'function'

  return (
    <div className="mx-auto w-full max-w-[1800px] px-4 py-6 sm:px-6 2xl:px-8">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-black tracking-tight text-white">
            <HardDrive className="h-5 w-5 text-zinc-400" />
            Downloads
          </h1>
          <p className="mt-0.5 text-xs text-zinc-500">
            Storage used by your downloaded anime. Deleting files never touches watch history.
          </p>
        </div>

        <button
          type="button"
          onClick={loadOverview}
          disabled={loading || !hasOverviewApi}
          className="flex select-none items-center gap-1.5 rounded-lg border border-white/10 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 shadow-sm transition-colors hover:bg-zinc-700 disabled:opacity-50"
          title="Rescan storage usage"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin text-zinc-400' : 'text-zinc-400'}`} />
          <span>Refresh</span>
        </button>
      </div>

      {/* Summary cards */}
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-white/10 bg-zinc-900/60 px-4 py-3">
          <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Used by library</p>
          <p className="mt-1 text-lg font-black text-white">{formatFileSize(overview?.totalBytes ?? 0)}</p>
          <p className="text-[11px] text-zinc-500">
            {sortedTitles.length} {sortedTitles.length === 1 ? 'title' : 'titles'} on this PC
          </p>
        </div>
        <div className="rounded-xl border border-white/10 bg-zinc-900/60 px-4 py-3">
          <p className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Free disk space</p>
          <p className="mt-1 text-lg font-black text-white">
            {overview?.freeBytes != null ? formatFileSize(overview.freeBytes) : 'Unknown'}
          </p>
          <p className="text-[11px] text-zinc-500">Across your library drives</p>
        </div>
      </div>

      {/* Title rows */}
      <section className="mt-6">
        <h2 className="mb-2 text-xs font-bold uppercase tracking-widest text-zinc-500">Downloaded titles</h2>

        {!hasOverviewApi ? (
          <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/40 px-4 py-10 text-center">
            <Film className="mx-auto h-8 w-8 text-zinc-700" />
            <p className="mt-2 text-sm font-semibold text-zinc-400">Storage overview unavailable</p>
            <p className="mt-1 text-xs text-zinc-600">
              This build of the app does not expose library storage management.
            </p>
          </div>
        ) : sortedTitles.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/40 px-4 py-10 text-center">
            <Film className="mx-auto h-8 w-8 text-zinc-700" />
            <p className="mt-2 text-sm font-semibold text-zinc-400">Nothing downloaded yet</p>
            <p className="mt-1 text-xs text-zinc-600">
              Files you add to your library folders will show up here with their disk usage.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 2xl:grid-cols-2 2xl:gap-4">
            {sortedTitles.map((title) => {
              // The storage overview carries no artwork — match the scanned
              // library folder (same path) for the poster and canonical name.
              const libraryFolder = folders.find((f) => f.folderPath === title.folderPath)
              const poster = libraryFolder?.posterUrl || null
              const displayTitle = libraryFolder?.canonicalTitle || title.folderName
              return (
              <div
                key={title.folderPath}
                className="group flex items-center gap-3 rounded-xl border border-white/10 bg-zinc-900/70 px-3 py-3 transition-colors hover:border-zinc-700/80 2xl:gap-4 2xl:px-4 2xl:py-4"
              >
                {poster ? (
                  <img src={poster} alt="" loading="lazy" className="h-16 w-11 shrink-0 rounded-md object-cover 2xl:h-20 2xl:w-14" />
                ) : (
                  <div className="flex h-16 w-11 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-zinc-800 to-zinc-950 2xl:h-20 2xl:w-14">
                    <Film className="h-5 w-5 text-zinc-700" />
                  </div>
                )}

                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-zinc-100 2xl:text-base" title={title.folderName}>
                    {displayTitle}
                  </p>
                  <p className="mt-0.5 text-[11px] text-zinc-500">
                    {title.episodeCount} eps · {formatFileSize(title.totalBytes)}
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => setConfirmTarget(title)}
                  title="Delete files from PC"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-red-500/30 bg-red-500/5 text-red-400 transition-colors hover:bg-red-500/20 hover:text-red-300 2xl:h-10 2xl:w-10"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              );
            })}
          </div>
        )}
      </section>

      {/* P2P download queue */}
      <section className="mt-6">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-xs font-bold uppercase tracking-widest text-zinc-500">Queue</h2>
          {p2pState?.enabled && sortedJobs.length > 0 && (
            <p className="text-[11px] text-zinc-500">
              {activeJobCount} active · ↓ {formatSpeedMBs(totalDownloadSpeed)} · ↑{' '}
              {formatSpeedMBs(totalUploadSpeed)}
            </p>
          )}
        </div>

        {!hasP2pApi ? (
          <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/40 px-4 py-8 text-center">
            <p className="text-sm font-medium text-zinc-500">P2P download queue is unavailable</p>
            <p className="mt-1 text-xs text-zinc-600">
              This build of the app does not expose the torrent engine.
            </p>
          </div>
        ) : p2pState && !p2pState.enabled ? (
          <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/40 px-4 py-8 text-center">
            <p className="text-sm font-medium text-zinc-500">
              P2P is disabled — enable it in Settings (P2P &amp; Downloads).
            </p>
            <p className="mt-1 text-xs text-zinc-600">
              Downloads you queue will show up here with live progress.
            </p>
          </div>
        ) : !p2pState ? (
          <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/40 px-4 py-8 text-center">
            <p className="text-sm font-medium text-zinc-500">Loading queue…</p>
          </div>
        ) : sortedJobs.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/40 px-4 py-8 text-center">
            <p className="text-sm font-medium text-zinc-500">Queue is empty</p>
            <p className="mt-1 text-xs text-zinc-600">
              Use the Download button on any title page to search your indexers and queue a release.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 2xl:grid-cols-2 2xl:gap-4">
            {sortedJobs.map((job) => {
              const chip = jobStatusChip(job.status)
              const canPause =
                job.status === 'downloading' ||
                job.status === 'connecting' ||
                job.status === 'queued' ||
                job.status === 'seeding'
              const canResume = job.status === 'paused'
              const isCompleted = job.status === 'completed'
              const confirming = confirmCancelHash === job.infoHash
              const progressPct = Math.max(0, Math.min(100, job.progress || 0))
              const showSpeeds = (job.downloadSpeed || 0) > 0 || (job.uploadSpeed || 0) > 0

              return (
                <div
                  key={job.infoHash}
                  className="rounded-xl border border-white/10 bg-zinc-900/70 px-3 py-3 2xl:px-4 2xl:py-4"
                >
                  <div className="flex items-center gap-3">
                    {(() => {
                      const cover = jobCover(job);
                      return cover ? (
                        <img src={cover} alt="" loading="lazy" className="h-20 w-14 shrink-0 rounded-md object-cover 2xl:h-24 2xl:w-[4.25rem]" />
                      ) : (
                        <div className="flex h-20 w-14 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-zinc-800 to-zinc-950 2xl:h-24 2xl:w-[4.25rem]">
                          <Film className="h-5 w-5 text-zinc-700" />
                        </div>
                      );
                    })()}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <p
                          className="line-clamp-2 min-w-0 flex-1 text-sm font-semibold text-zinc-100 2xl:text-base"
                          title={job.title || job.name}
                        >
                          {job.title || job.name}
                        </p>
                        {job.episode != null && (
                          <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-bold text-zinc-300">
                            EP {job.episode}
                          </span>
                        )}
                        {job.episode == null && job.season != null && (
                          <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-bold text-zinc-300">
                            SEASON {job.season}
                          </span>
                        )}
                        <span
                          title={job.status === 'error' && job.error ? job.error : chip.label}
                          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${chip.className}`}
                        >
                          {isCompleted && <Check className="mr-0.5 inline h-3 w-3" />}
                          {chip.label}
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] text-zinc-500 2xl:text-xs">
                        {formatFileSize(job.downloadedBytes)} / {formatFileSize(job.totalBytes)} ·{' '}
                        {job.peers} peers
                        {showSpeeds && (
                          <>
                            {' '}
                            · ↓ {formatSpeedMBs(job.downloadSpeed)} · ↑ {formatSpeedMBs(job.uploadSpeed)}
                          </>
                        )}
                      </p>
                      {job.releaseTitle && (
                        <p className="mt-1 line-clamp-2 text-[10px] text-zinc-400 2xl:text-xs" title={job.releaseTitle}>
                          Release: {job.releaseTitle}
                        </p>
                      )}
                      {!!job.selectedFiles?.length && (
                        <p className="mt-1 line-clamp-2 text-[10px] text-cyan-200/80 2xl:text-xs" title={job.selectedFiles.join('\n')}>
                          Selected: {job.selectedFiles.slice(0, 2).join(', ')}{job.selectedFiles.length > 2 ? ` +${job.selectedFiles.length - 2} more` : ''}
                        </p>
                      )}
                    </div>

                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => handleCopyDiagnostics(job.infoHash)}
                        title="Copy diagnostic history to clipboard"
                        className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-zinc-800/60 text-zinc-400 transition-colors hover:bg-zinc-700/60 hover:text-white"
                      >
                        <FileText className="h-4 w-4" />
                      </button>
                      {(canPause || canResume) && (
                        <button
                          type="button"
                          onClick={() => handlePauseResume(job)}
                          title={canResume ? 'Resume download' : 'Pause download'}
                          className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-zinc-800/60 text-zinc-300 transition-colors hover:bg-zinc-700/60 hover:text-white"
                        >
                          {canResume ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
                        </button>
                      )}
                      {isCompleted && (
                        <>
                          <button
                            type="button"
                            onClick={() => handleShowInFolder(job)}
                            title="Show in folder"
                            className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-zinc-800/60 text-zinc-300 transition-colors hover:bg-zinc-700/60 hover:text-white"
                          >
                            <FolderOpen className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRemoveJob(job.infoHash)}
                            disabled={cancellingHash === job.infoHash}
                            title="Clear from queue (files stay on disk)"
                            className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-zinc-800/60 text-zinc-400 transition-colors hover:bg-zinc-700/60 hover:text-white disabled:opacity-50"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </>
                      )}
                      {!isCompleted && (
                        <button
                          type="button"
                          onClick={() => { setDiscardPartial(false); setConfirmCancelHash(job.infoHash) }}
                          title="Remove from queue (files stay on disk)"
                          className="flex h-8 w-8 items-center justify-center rounded-full border border-red-500/30 bg-red-500/5 text-red-400 transition-colors hover:bg-red-500/20 hover:text-red-300"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Thin progress bar */}
                  <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                    <div
                      className="h-full rounded-full bg-red-500 transition-[width] duration-500"
                      style={{ width: `${progressPct}%` }}
                    />
                  </div>

                  {/* Inline cancel confirmation strip */}
                  {confirming && (
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2">
                      <p className="text-[11px] font-semibold text-red-200">
                        Remove this release from the queue?
                      </p>
                      <label className="flex items-center gap-2 text-[11px] text-zinc-300">
                        <input
                          type="checkbox"
                          checked={discardPartial}
                          onChange={(event) => setDiscardPartial(event.target.checked)}
                          className="accent-red-500"
                        />
                        Delete this release’s partial download data
                      </label>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => { setConfirmCancelHash(null); setDiscardPartial(false) }}
                          className="rounded-lg bg-zinc-800 px-2.5 py-1 text-[11px] font-semibold text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-white"
                        >
                          Keep
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRemoveJob(job.infoHash, discardPartial)}
                          disabled={cancellingHash === job.infoHash}
                          className="rounded-lg bg-red-600 px-2.5 py-1 text-[11px] font-bold text-white transition-colors hover:bg-red-500 disabled:opacity-60"
                        >
                          {cancellingHash === job.infoHash ? 'Removing…' : discardPartial ? 'Delete data & remove' : 'Remove, keep data'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* Delete confirmation modal */}
      {confirmTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 animate-in fade-in duration-150"
          onClick={() => !deleting && setConfirmTarget(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            data-modal="true"
            className="w-full max-w-md rounded-2xl border border-white/10 bg-[#141418] p-5 text-zinc-100 shadow-2xl animate-in zoom-in-95 duration-150"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-500/10">
                <AlertTriangle className="h-5 w-5 text-red-400" />
              </div>
              <div className="min-w-0">
                <h3 className="text-sm font-bold text-white">Delete anime folder from PC</h3>
                <p className="mt-1 text-xs leading-relaxed text-zinc-400">
                  Permanently delete <span className="font-semibold text-zinc-100">&ldquo;{confirmTarget.folderName}&rdquo;</span> and its files from this PC?
                  This frees {formatFileSize(confirmTarget.totalBytes)}. Any active downloads to this folder will be stopped; watch history and list progress are kept.
                </p>
              </div>
            </div>

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmTarget(null)}
                disabled={deleting}
                className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-white disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeleteConfirmed}
                disabled={deleting}
                className="flex select-none items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-bold text-white shadow-sm transition-colors hover:bg-red-500 disabled:opacity-60 active:scale-[0.98]"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>{deleting ? 'Deleting…' : 'Delete files'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
