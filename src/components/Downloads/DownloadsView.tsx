/**
 * DownloadsView: the Downloads tab. Summarizes local disk usage per anime
 * folder (via the library storage overview IPC), lets the user delete whole
 * titles from the PC (files only — watch history and list progress are kept),
 * and hosts the live P2P download queue (torrent jobs via getP2pState /
 * onP2pStateChanged).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, Film, FolderOpen, HardDrive, Pause, Play, RefreshCw, Trash2, X } from 'lucide-react'
import type { P2pState, StorageOverview, StorageTitleUsage, TorrentJob, TorrentJobStatus } from '../../types'
import { formatFileSize } from '../../utils/format'
import { showGlobalToast } from '../Toast'

interface DownloadsViewProps {
  onRefreshLibrary: () => void
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

export const DownloadsView: React.FC<DownloadsViewProps> = ({ onRefreshLibrary }) => {
  const [overview, setOverview] = useState<StorageOverview | null>(null)
  const [loading, setLoading] = useState<boolean>(false)
  const [confirmTarget, setConfirmTarget] = useState<StorageTitleUsage | null>(null)
  const [deleting, setDeleting] = useState<boolean>(false)

  // P2P queue state (torrent engine jobs), driven by push updates.
  const [p2pState, setP2pState] = useState<P2pState | null>(null)
  const [confirmCancelHash, setConfirmCancelHash] = useState<string | null>(null)
  const [cancellingHash, setCancellingHash] = useState<string | null>(null)

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
  const handleRemoveJob = async (infoHash: string) => {
    const api = window.electronAPI
    if (!api?.cancelDownload) return
    setCancellingHash(infoHash)
    try {
      const res = await api.cancelDownload(infoHash, false)
      if (res?.success) {
        showGlobalToast('Removed from queue — files stay on disk', 'success')
      } else {
        showGlobalToast('Failed to remove the download', 'error')
      }
    } catch (err) {
      console.error('Failed to cancel download:', err)
      showGlobalToast('Failed to remove the download', 'error')
    } finally {
      setCancellingHash(null)
      setConfirmCancelHash(null)
    }
  }

  const handleShowInFolder = (job: TorrentJob) => {
    if (!window.electronAPI?.openFolderInExplorer) return
    window.electronAPI.openFolderInExplorer(job.targetFolder).catch((err) => {
      console.error('Failed to open folder:', err)
      showGlobalToast('Failed to open the download folder', 'error')
    })
  }

  const handleDeleteConfirmed = async () => {
    if (!confirmTarget || deleting) return
    setDeleting(true)
    try {
      const res = await window.electronAPI.deleteAnimeFromPC(confirmTarget.folderPath)
      if (res?.success) {
        showGlobalToast(`Freed ${formatFileSize(res.deletedBytes ?? confirmTarget.totalBytes)}`, 'success')
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
      showGlobalToast('Failed to delete files from PC', 'error')
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
  const hasP2pApi =
    typeof window.electronAPI?.getP2pState === 'function' &&
    typeof window.electronAPI?.onP2pStateChanged === 'function'

  return (
    <div className="mx-auto max-w-7xl px-6 py-6">
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
          <div className="grid grid-cols-1 gap-2">
            {sortedTitles.map((title) => (
              <div
                key={title.folderPath}
                className="group flex items-center gap-3 rounded-xl border border-white/10 bg-zinc-900/70 px-3 py-2.5 transition-colors hover:border-zinc-700/80"
              >
                {/* Poster placeholder (storage overview carries no artwork) */}
                <div className="flex h-14 w-10 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-zinc-800 to-zinc-950">
                  <Film className="h-5 w-5 text-zinc-700" />
                </div>

                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-zinc-100" title={title.folderName}>
                    {title.folderName}
                  </p>
                  <p className="mt-0.5 text-[11px] text-zinc-500">
                    {title.episodeCount} eps · {formatFileSize(title.totalBytes)}
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => setConfirmTarget(title)}
                  title="Delete files from PC"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-red-500/30 bg-red-500/5 text-red-400 transition-colors hover:bg-red-500/20 hover:text-red-300"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
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
          <div className="flex flex-col gap-2">
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
                  className="rounded-xl border border-white/10 bg-zinc-900/70 px-3 py-2.5"
                >
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <p
                          className="line-clamp-1 min-w-0 flex-1 text-sm font-semibold text-zinc-100"
                          title={job.title || job.name}
                        >
                          {job.title || job.name}
                        </p>
                        {job.episode != null && (
                          <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-bold text-zinc-300">
                            EP {job.episode}
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
                      <p className="mt-0.5 text-[11px] text-zinc-500">
                        {formatFileSize(job.downloadedBytes)} / {formatFileSize(job.totalBytes)} ·{' '}
                        {job.peers} peers
                        {showSpeeds && (
                          <>
                            {' '}
                            · ↓ {formatSpeedMBs(job.downloadSpeed)} · ↑ {formatSpeedMBs(job.uploadSpeed)}
                          </>
                        )}
                      </p>
                    </div>

                    <div className="flex shrink-0 items-center gap-1.5">
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
                          onClick={() => setConfirmCancelHash(job.infoHash)}
                          title="Remove from queue (files stay on disk)"
                          className="flex h-8 w-8 items-center justify-center rounded-full border border-red-500/30 bg-red-500/5 text-red-400 transition-colors hover:bg-red-500/20 hover:text-red-300"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Thin progress bar */}
                  <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-zinc-800">
                    <div
                      className="h-full rounded-full bg-red-500 transition-[width] duration-500"
                      style={{ width: `${progressPct}%` }}
                    />
                  </div>

                  {/* Inline cancel confirmation strip */}
                  {confirming && (
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2">
                      <p className="text-[11px] font-semibold text-red-200">
                        Remove from queue? Files stay on disk.
                      </p>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setConfirmCancelHash(null)}
                          className="rounded-lg bg-zinc-800 px-2.5 py-1 text-[11px] font-semibold text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-white"
                        >
                          Keep
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRemoveJob(job.infoHash)}
                          disabled={cancellingHash === job.infoHash}
                          className="rounded-lg bg-red-600 px-2.5 py-1 text-[11px] font-bold text-white transition-colors hover:bg-red-500 disabled:opacity-60"
                        >
                          {cancellingHash === job.infoHash ? 'Removing…' : 'Remove'}
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
                <h3 className="text-sm font-bold text-white">Delete files from PC</h3>
                <p className="mt-1 text-xs leading-relaxed text-zinc-400">
                  Delete <span className="font-semibold text-zinc-100">&ldquo;{confirmTarget.folderName}&rdquo;</span> from
                  PC? This frees {formatFileSize(confirmTarget.totalBytes)}. Watch history and progress are kept.
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
