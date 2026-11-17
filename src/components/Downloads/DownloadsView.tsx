/**
 * DownloadsView: the Downloads tab. Summarizes local disk usage per anime
 * folder (via the library storage overview IPC), lets the user delete whole
 * titles from the PC (files only — watch history and list progress are kept),
 * and hosts the live P2P download queue (torrent jobs via getP2pState /
 * onP2pStateChanged).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Check,
  Download,
  FileText,
  Film,
  FolderOpen,
  HardDrive,
  Pause,
  Play,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react'
import type { AnimeFolder, P2pState, StorageOverview, StorageTitleUsage, TorrentJob, TorrentJobStatus } from '../../types'
import { formatFileSize } from '../../utils/format'
import { showGlobalToast } from '../Toast'
import { useDeveloperMode } from '../../utils/devMode'

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
      return { label: 'Queued', className: 'border border-white/10 bg-white/[0.06] text-zinc-300' }
    case 'connecting':
      return { label: 'Connecting', className: 'border border-violet-400/35 bg-violet-500/15 text-violet-200' }
    case 'downloading':
      return { label: 'Downloading', className: 'animate-pulse border border-rose-400/40 bg-rose-500/20 text-rose-200' }
    case 'paused':
      return { label: 'Paused', className: 'border border-amber-400/35 bg-amber-500/15 text-amber-200' }
    case 'seeding':
      return { label: 'Seeding', className: 'border border-emerald-400/35 bg-emerald-500/15 text-emerald-200' }
    case 'completed':
      return { label: 'Completed', className: 'border border-emerald-400/35 bg-emerald-500/15 text-emerald-200' }
    case 'error':
      return { label: 'Error', className: 'border border-red-500/40 bg-red-500/15 text-red-200' }
    default:
      return { label: status, className: 'border border-white/10 bg-white/[0.06] text-zinc-300' }
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
  // Developer-only UI gates (diagnostics buttons etc.). Session-only flag.
  const isDeveloper = useDeveloperMode()

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

  // A download that finishes while this tab is open must surface in the
  // storage overview: its folder only becomes a "release folder" once the
  // files leave the staging directory, so the snapshot taken at mount is
  // stale from then on. Reload whenever the set of active jobs changes
  // (job added, finished and removed, cancelled).
  const activeJobsKeyRef = useRef<string>('')
  useEffect(() => {
    const key = (p2pState?.jobs ?? [])
      .filter((job) => STATUS_ACTIVE[job.status])
      .map((job) => job.infoHash)
      .sort()
      .join(',')
    const previous = activeJobsKeyRef.current
    activeJobsKeyRef.current = key
    if (previous !== '' && key !== previous) loadOverview()
  }, [p2pState, loadOverview])

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
  const [jobPosters, setJobPosters] = useState<Map<number, string>>(new Map())
  const jobPosterFetchedRef = useRef<Set<number>>(new Set())
  useEffect(() => {
    const wanted = [...new Set((p2pState?.jobs ?? [])
      .map((job) => job.anilistId)
      .filter((id): id is number => id != null && !jobPosterFetchedRef.current.has(id) && !folders.some((f) => f.anilistId === id)))]
    if (wanted.length === 0) return
    for (const id of wanted) jobPosterFetchedRef.current.add(id)
    void (async () => {
      const api = window.electronAPI
      if (!api?.getCatalogDetails) return
      for (const anilistId of wanted) {
        try {
          const details = await api.getCatalogDetails(anilistId)
          if (details?.posterUrl) {
            setJobPosters((prev) => { const m = new Map(prev); m.set(anilistId, details.posterUrl as string); return m })
          }
        } catch {}
      }
    })()
  }, [p2pState, folders])

  const jobCover = (job: TorrentJob): string | null => {
    const folder = folders.find((f) => f.anilistId === job.anilistId)
    return folder?.posterUrl || (job.anilistId != null ? jobPosters.get(job.anilistId) || null : null)
  }

  const hasP2pApi =
    typeof window.electronAPI?.getP2pState === 'function' &&
    typeof window.electronAPI?.onP2pStateChanged === 'function'

  return (
    <div className="min-h-full w-full px-6 py-7 2xl:px-8">
      {/* Symmetrical hero banner matching Discover, Library & Schedule */}
      <section className="relative mb-6 flex h-[160px] flex-col justify-center overflow-hidden rounded-[26px] border border-white/[0.08] bg-[#0F0B15] px-6 shadow-2xl shadow-black/20 md:h-[168px] md:px-9">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-28 -top-40 h-[440px] w-[440px] rounded-full"
          style={{ background: 'radial-gradient(closest-side, rgba(255,30,109,0.085), rgba(255,30,109,0.025) 55%, transparent 100%)' }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-44 left-1/3 h-[400px] w-[400px] rounded-full"
          style={{ background: 'radial-gradient(closest-side, rgba(156,70,165,0.08), rgba(156,70,165,0.02) 55%, transparent 100%)' }}
        />
        <div className="relative">
          <div className="flex items-center gap-2 text-rose-300">
            <HardDrive className="h-4 w-4" />
            <span className="text-[10px] font-bold uppercase tracking-[0.22em]">Kaiko / Downloads</span>
          </div>
          <h1 className="mt-2.5 text-3xl font-black leading-tight tracking-tight text-white md:text-4xl">Downloads &amp; storage</h1>
          <p className="mt-2 max-w-3xl truncate text-sm leading-normal text-zinc-400">
            Manage active P2P transfers, inspect local disk usage, and free up space without losing your watch history.
          </p>
        </div>
      </section>

      {/* Top summary & control panel */}
      <section className="mb-6 rounded-2xl border border-white/[0.08] bg-white/[0.025] p-4 shadow-xl shadow-black/10 md:p-5">
        <div className="grid grid-cols-1 gap-3.5 md:grid-cols-3">
          <div className="flex items-center gap-4 rounded-2xl border border-white/[0.07] bg-[#0F0B15]/80 px-5 py-4">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-rose-400/20 bg-rose-500/10 text-rose-300">
              <HardDrive className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-500">Used by library</p>
              <p className="mt-0.5 text-xl font-black text-white">{formatFileSize(overview?.totalBytes ?? 0)}</p>
              <p className="text-xs text-zinc-400">
                {sortedTitles.length} {sortedTitles.length === 1 ? 'title' : 'titles'} on this PC
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4 rounded-2xl border border-white/[0.07] bg-[#0F0B15]/80 px-5 py-4">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-violet-400/20 bg-violet-500/10 text-violet-300">
              <FolderOpen className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-500">Free disk space</p>
              <p className="mt-0.5 text-xl font-black text-white">
                {overview?.freeBytes != null ? formatFileSize(overview.freeBytes) : 'Unknown'}
              </p>
              <p className="text-xs text-zinc-400">Across your library drives</p>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-2xl border border-white/[0.07] bg-[#0F0B15]/80 px-5 py-4">
            <div className="flex min-w-0 items-center gap-4">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/[0.08] bg-white/[0.04] text-zinc-300">
                <Download className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-500">Transfer activity</p>
                <p className="mt-0.5 truncate text-xl font-black text-white">
                  {!hasP2pApi
                    ? 'Unavailable'
                    : p2pState && !p2pState.enabled
                      ? 'P2P off'
                      : `${activeJobCount} active`}
                </p>
                <p className="truncate text-xs text-zinc-400">
                  {p2pState?.enabled
                    ? `↓ ${formatSpeedMBs(totalDownloadSpeed)} · ↑ ${formatSpeedMBs(totalUploadSpeed)}`
                    : 'Enable P2P in Settings'}
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={loadOverview}
              disabled={loading || !hasOverviewApi}
              className="inline-flex shrink-0 select-none items-center gap-1.5 rounded-xl border border-white/[0.08] bg-white/[0.05] px-3.5 py-2 text-xs font-bold text-zinc-200 transition hover:border-rose-400/35 hover:bg-rose-500/15 hover:text-white disabled:opacity-50"
              title="Rescan storage usage"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin text-rose-300' : 'text-zinc-300'}`} />
              <span>Refresh</span>
            </button>
          </div>
        </div>
      </section>

      {/* Downloaded titles */}
      <section className="mb-6 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <h2 className="text-sm font-extrabold uppercase tracking-wider text-zinc-200">Downloaded titles</h2>
            <span className="rounded-full border border-rose-400/25 bg-rose-500/15 px-2.5 py-0.5 font-mono text-xs font-bold text-rose-200">
              {sortedTitles.length}
            </span>
          </div>
          <p className="text-xs text-zinc-500">Deleting files never touches watch history</p>
        </div>

        {!hasOverviewApi ? (
          <div className="rounded-2xl border border-white/[0.06] bg-[#0F0B15]/50 px-6 py-12 text-center">
            <Film className="mx-auto h-8 w-8 text-zinc-700" />
            <p className="mt-2.5 text-sm font-semibold text-zinc-300">Storage overview unavailable</p>
            <p className="mt-1 text-xs text-zinc-500">
              This build of the app does not expose library storage management.
            </p>
          </div>
        ) : sortedTitles.length === 0 ? (
          <div className="rounded-2xl border border-white/[0.06] bg-[#0F0B15]/50 px-6 py-12 text-center">
            <Film className="mx-auto h-8 w-8 text-zinc-700" />
            <p className="mt-2.5 text-sm font-semibold text-zinc-300">Nothing downloaded yet</p>
            <p className="mt-1 text-xs text-zinc-500">
              Files you add to your library folders will show up here with their disk usage.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 2xl:grid-cols-2 min-[1800px]:grid-cols-3 2xl:gap-3.5">
            {sortedTitles.map((title) => {
              // The storage overview carries no artwork — match the scanned
              // library folder (same path) for the poster and canonical name.
              const libraryFolder = folders.find((f) => f.folderPath === title.folderPath)
              const poster = libraryFolder?.posterUrl || null
              const displayTitle = libraryFolder?.canonicalTitle || title.folderName
              return (
                <div
                  key={title.folderPath}
                  className="group flex items-center gap-3.5 rounded-2xl border border-white/[0.07] bg-[#0F0B15]/75 px-3.5 py-3 transition-all hover:border-rose-400/30 hover:bg-[#161020]/90 2xl:gap-4 2xl:px-4 2xl:py-3.5"
                >
                  {poster ? (
                    <img
                      src={poster}
                      alt=""
                      loading="lazy"
                      className="h-16 w-11 shrink-0 rounded-lg object-cover ring-1 ring-white/10 2xl:h-20 2xl:w-14"
                    />
                  ) : (
                    <div className="flex h-16 w-11 shrink-0 items-center justify-center rounded-lg border border-white/[0.06] bg-[#07060A] 2xl:h-20 2xl:w-14">
                      <Film className="h-5 w-5 text-zinc-700" />
                    </div>
                  )}

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-zinc-100 2xl:text-base" title={title.folderName}>
                      {displayTitle}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <span className="rounded-md border border-white/[0.07] bg-white/[0.04] px-2 py-0.5 text-[11px] font-medium text-zinc-300">
                        {title.episodeCount} video {title.episodeCount === 1 ? 'file' : 'files'}
                      </span>
                      <span className="rounded-md border border-rose-500/20 bg-rose-500/10 px-2 py-0.5 font-mono text-[11px] font-bold text-rose-200">
                        {formatFileSize(title.totalBytes)}
                      </span>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => setConfirmTarget(title)}
                    title="Delete files from PC"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-rose-500/25 bg-rose-500/10 text-rose-300 transition-all hover:border-rose-400/50 hover:bg-rose-500/20 hover:text-rose-100 2xl:h-10 2xl:w-10"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* P2P download queue */}
      <section className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <h2 className="text-sm font-extrabold uppercase tracking-wider text-zinc-200">Queue</h2>
            <span className="rounded-full border border-violet-400/25 bg-violet-500/15 px-2.5 py-0.5 font-mono text-xs font-bold text-violet-200">
              {sortedJobs.length}
            </span>
          </div>
          {p2pState?.enabled && sortedJobs.length > 0 && (
            <p className="text-xs text-zinc-400">
              {activeJobCount} active · ↓ {formatSpeedMBs(totalDownloadSpeed)} · ↑{' '}
              {formatSpeedMBs(totalUploadSpeed)}
            </p>
          )}
        </div>

        {!hasP2pApi ? (
          <div className="rounded-2xl border border-white/[0.06] bg-[#0F0B15]/50 px-6 py-10 text-center">
            <p className="text-sm font-semibold text-zinc-300">P2P download queue is unavailable</p>
            <p className="mt-1 text-xs text-zinc-500">
              This build of the app does not expose the torrent engine.
            </p>
          </div>
        ) : p2pState && !p2pState.enabled ? (
          <div className="rounded-2xl border border-white/[0.06] bg-[#0F0B15]/50 px-6 py-10 text-center">
            <p className="text-sm font-semibold text-zinc-300">
              P2P is disabled — enable it in Settings (P2P &amp; Downloads).
            </p>
            <p className="mt-1 text-xs text-zinc-500">
              Downloads you queue will show up here with live progress.
            </p>
          </div>
        ) : !p2pState ? (
          <div className="rounded-2xl border border-white/[0.06] bg-[#0F0B15]/50 px-6 py-10 text-center">
            <p className="text-sm font-medium text-zinc-400">Loading queue…</p>
          </div>
        ) : sortedJobs.length === 0 ? (
          <div className="rounded-2xl border border-white/[0.06] bg-[#0F0B15]/50 px-6 py-10 text-center">
            <p className="text-sm font-semibold text-zinc-300">Queue is empty</p>
            <p className="mt-1 text-xs text-zinc-500">
              Use the Download button on any title page to search your indexers and queue a release.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 2xl:grid-cols-2 min-[1800px]:grid-cols-3 2xl:gap-3.5">
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
              const cover = jobCover(job)

              return (
                <div
                  key={job.infoHash}
                  className="rounded-2xl border border-white/[0.08] bg-[#0F0B15]/80 px-4 py-3.5 transition-colors hover:border-white/[0.14]"
                >
                  <div className="flex items-center gap-3.5">
                    {cover ? (
                      <img
                        src={cover}
                        alt=""
                        loading="lazy"
                        className="h-20 w-14 shrink-0 rounded-lg object-cover ring-1 ring-white/10 2xl:h-24 2xl:w-[4.25rem]"
                      />
                    ) : (
                      <div className="flex h-20 w-14 shrink-0 items-center justify-center rounded-lg border border-white/[0.06] bg-[#07060A] 2xl:h-24 2xl:w-[4.25rem]">
                        <Film className="h-5 w-5 text-zinc-700" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <p
                          className="line-clamp-2 min-w-0 flex-1 text-sm font-semibold text-zinc-100 2xl:text-base"
                          title={job.title || job.name}
                        >
                          {job.title || job.name}
                        </p>
                        {job.episode != null && (
                          <span className="shrink-0 rounded-md border border-white/10 bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-bold text-zinc-200">
                            EP {job.episode}
                          </span>
                        )}
                        {job.episode == null && job.season != null && (
                          <span className="shrink-0 rounded-md border border-white/10 bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-bold text-zinc-200">
                            SEASON {job.season}
                          </span>
                        )}
                        <span
                          title={job.status === 'error' && job.error ? job.error : chip.label}
                          className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-bold ${chip.className}`}
                        >
                          {isCompleted && <Check className="mr-0.5 inline h-3 w-3" />}
                          {chip.label}
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] text-zinc-400 2xl:text-xs">
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
                        <p className="mt-1 line-clamp-2 text-[10px] text-violet-200/80 2xl:text-xs" title={job.selectedFiles.join('\n')}>
                          Selected: {job.selectedFiles.slice(0, 2).join(', ')}{job.selectedFiles.length > 2 ? ` +${job.selectedFiles.length - 2} more` : ''}
                        </p>
                      )}
                    </div>

                    <div className="flex shrink-0 items-center gap-1.5">
                      {isDeveloper && (
                        <button
                          type="button"
                          onClick={() => handleCopyDiagnostics(job.infoHash)}
                          title="Copy diagnostic history to clipboard"
                          className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/10 bg-white/[0.05] text-zinc-300 transition-colors hover:bg-white/[0.12] hover:text-white"
                        >
                          <FileText className="h-4 w-4" />
                        </button>
                      )}
                      {(canPause || canResume) && (
                        <button
                          type="button"
                          onClick={() => handlePauseResume(job)}
                          title={canResume ? 'Resume download' : 'Pause download'}
                          className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/10 bg-white/[0.05] text-zinc-200 transition-colors hover:bg-white/[0.12] hover:text-white"
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
                            className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/10 bg-white/[0.05] text-zinc-200 transition-colors hover:bg-white/[0.12] hover:text-white"
                          >
                            <FolderOpen className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRemoveJob(job.infoHash)}
                            disabled={cancellingHash === job.infoHash}
                            title="Clear from queue (files stay on disk)"
                            className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/10 bg-white/[0.05] text-zinc-400 transition-colors hover:bg-white/[0.12] hover:text-white disabled:opacity-50"
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
                          className="flex h-8 w-8 items-center justify-center rounded-xl border border-rose-500/25 bg-rose-500/10 text-rose-300 transition-colors hover:border-rose-400/50 hover:bg-rose-500/20 hover:text-rose-100"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Thin crimson progress bar */}
                  <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.07]">
                    <div
                      className="h-full rounded-full bg-[linear-gradient(90deg,#FF1E6D_0%,#FF5E92_100%)] transition-[width] duration-500"
                      style={{ width: `${progressPct}%` }}
                    />
                  </div>

                  {/* Inline cancel confirmation strip */}
                  {confirming && (
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3.5 py-2.5">
                      <p className="text-[11px] font-semibold text-rose-200">
                        Remove this release from the queue?
                      </p>
                      <label className="flex items-center gap-2 text-[11px] text-zinc-200">
                        <input
                          type="checkbox"
                          checked={discardPartial}
                          onChange={(event) => setDiscardPartial(event.target.checked)}
                          className="accent-rose-500"
                        />
                        Delete this release’s partial download data
                      </label>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => { setConfirmCancelHash(null); setDiscardPartial(false) }}
                          className="rounded-lg bg-white/[0.08] px-2.5 py-1 text-[11px] font-semibold text-zinc-200 transition-colors hover:bg-white/[0.15] hover:text-white"
                        >
                          Keep
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRemoveJob(job.infoHash, discardPartial)}
                          disabled={cancellingHash === job.infoHash}
                          className="rounded-lg bg-rose-600 px-2.5 py-1 text-[11px] font-bold text-white transition-colors hover:bg-rose-500 disabled:opacity-60"
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
          className="fixed inset-0 z-50 flex items-center justify-center modal-dimmer p-4 animate-in fade-in duration-150"
          onClick={() => !deleting && setConfirmTarget(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            data-modal="true"
            className="modal-glass w-full max-w-md rounded-2xl p-5 text-zinc-100 animate-in zoom-in-95 duration-150"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-rose-500/25 bg-rose-500/15 text-rose-400">
                <AlertTriangle className="h-5 w-5" />
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
                className="rounded-xl border border-white/10 bg-white/[0.06] px-3.5 py-2 text-xs font-semibold text-zinc-200 transition-colors hover:bg-white/[0.12] hover:text-white disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeleteConfirmed}
                disabled={deleting}
                className="flex select-none items-center gap-1.5 rounded-xl bg-rose-600 px-3.5 py-2 text-xs font-bold text-white shadow-sm transition-colors hover:bg-rose-500 disabled:opacity-60 active:scale-[0.98]"
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
