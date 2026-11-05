/**
 * ReleasePickerModal: searches the user's own RSS/Torznab indexers for a given
 * anime title (optionally scoped to a single episode) and shows the ranked
 * results. Purely a picker — the parent performs addDownload via onPicked and
 * owns toasts / library refresh.
 */
import React, { useEffect, useMemo, useState } from 'react'
import { AlertCircle, ArrowDown, ArrowUp, Download, Search, X } from 'lucide-react'
import type { ReleaseSearchResult } from '../../types'
import { formatFileSize } from '../../utils/format'

interface ReleasePickerModalProps {
  open: boolean
  /** Display title of the anime to search for. */
  title: string
  anilistId: number | null
  season?: number | null
  /** null = whole season / pack. */
  episode?: number | null
  onCancel: () => void
  onPicked: (result: ReleaseSearchResult) => void
}

const SKELETON_ROWS = 6

export const ReleasePickerModal: React.FC<ReleasePickerModalProps> = ({
  open,
  title,
  anilistId,
  season,
  episode,
  onCancel,
  onPicked,
}) => {
  const [results, setResults] = useState<ReleaseSearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  // Reset the client-side filter each time the picker opens.
  useEffect(() => {
    if (open) setFilter('')
  }, [open])

  // Search while open; re-runs when the key params change (e.g. the picker is
  // kept mounted for another episode of the same title).
  useEffect(() => {
    if (!open) return
    const api = window.electronAPI
    if (!api?.searchReleases) {
      setResults([])
      setError('Release search is unavailable in this build of the app.')
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    api
      .searchReleases({ title, anilistId, season: season ?? null, episode: episode ?? null })
      .then((res) => {
        if (cancelled) return
        setResults(Array.isArray(res) ? res : [])
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        console.error('Release search failed:', err)
        setResults([])
        setError(err instanceof Error && err.message ? err.message : 'Release search failed.')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, title, anilistId, season, episode])

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

  const normalizedFilter = filter.trim().toLowerCase()
  const filtered = useMemo(() => {
    if (!normalizedFilter) return results
    return results.filter((r) => (r.title || '').toLowerCase().includes(normalizedFilter))
  }, [results, normalizedFilter])

  if (!open) return null

  const scopeLabel =
    episode != null ? `Episode ${episode}` : season != null ? `Season ${season}` : 'Season pack'

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
            {loading ? 'Searching…' : `${filtered.length} of ${results.length} releases`}
          </span>
        </div>

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
          ) : results.length === 0 ? (
            <div className="flex flex-col items-center px-4 py-10 text-center">
              <AlertCircle className="h-8 w-8 text-zinc-700" />
              <p className="mt-2 max-w-md text-sm font-semibold text-zinc-400">
                No releases found from your indexers — add RSS/Torznab providers in Settings
              </p>
              {error && <p className="mt-1 max-w-md break-words text-xs text-red-400/80">{error}</p>}
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center px-4 py-10 text-center">
              <Search className="h-8 w-8 text-zinc-700" />
              <p className="mt-2 text-sm font-semibold text-zinc-400">No releases match your filter</p>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {filtered.map((result, index) => (
                <div
                  key={`${result.providerId}-${result.downloadUrl}-${index}`}
                  onClick={() => onPicked(result)}
                  className="cursor-pointer rounded-xl border border-white/10 bg-zinc-900/70 px-3 py-2.5 transition-colors hover:border-zinc-600/80 hover:bg-zinc-800/70"
                >
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 text-sm font-medium text-zinc-100" title={result.title}>
                        {result.title}
                      </p>
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
                          <span className="flex items-center gap-0.5 text-zinc-500" title="Leechers">
                            <ArrowUp className="h-3 w-3" />
                            {result.leechers}
                          </span>
                        )}
                        <span className="text-zinc-400">
                          {result.sizeBytes != null ? formatFileSize(result.sizeBytes) : '—'}
                        </span>
                      </div>
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
              ))}
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
