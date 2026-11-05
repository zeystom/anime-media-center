/**
 * DownloadsView: the Downloads tab. Summarizes local disk usage per anime
 * folder (via the library storage overview IPC), lets the user delete whole
 * titles from the PC (files only — watch history and list progress are kept),
 * and hosts the placeholder section for the future P2P download queue.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Film, HardDrive, RefreshCw, Trash2 } from 'lucide-react'
import type { StorageOverview, StorageTitleUsage } from '../../types'
import { formatFileSize } from '../../utils/format'
import { showGlobalToast } from '../Toast'

interface DownloadsViewProps {
  onRefreshLibrary: () => void
}

export const DownloadsView: React.FC<DownloadsViewProps> = ({ onRefreshLibrary }) => {
  const [overview, setOverview] = useState<StorageOverview | null>(null)
  const [loading, setLoading] = useState<boolean>(false)
  const [confirmTarget, setConfirmTarget] = useState<StorageTitleUsage | null>(null)
  const [deleting, setDeleting] = useState<boolean>(false)

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

      {/* Placeholder: future P2P download queue */}
      <section className="mt-6">
        <h2 className="mb-2 text-xs font-bold uppercase tracking-widest text-zinc-500">Active downloads</h2>
        <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/40 px-4 py-8 text-center">
          <p className="text-sm font-medium text-zinc-500">P2P download queue arrives in a later update</p>
          <p className="mt-1 text-xs text-zinc-600">
            Episodes currently downloading via your torrent client stay visible in the Library tab.
          </p>
        </div>
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
