import React, { useEffect, useState } from 'react'
import { Check, Download, Film, Play, Wand2 } from 'lucide-react'
import type { Episode } from '../../types'

export interface EpisodeRowProps {
  /** Display number ('1', '5.5', 'S02E03'). */
  number: string
  title: string
  thumbnailUrl?: string | null
  /** Remote air date (ani.zip ISO string); shown under the title on remote-only rows. */
  airDate?: string | null
  /** Local file backing this row, when one exists on the PC. */
  local?: Episode
  remoteOnly?: boolean
  watched?: boolean
  isDownloading?: boolean
  downloadProgress?: number
  onPlay?: () => void
  onWhisper?: () => void
  onDownload?: () => void
}

const ACTION_BTN = 'flex h-8 w-8 items-center justify-center rounded-full border transition-colors'

const DOWNLOAD_TOOLTIP = 'P2P downloads arrive in a later update'

/** Formats an ani.zip air date ('YYYY-MM-DD') as '7 Apr 2019'; returns the raw string when unparsable. */
function formatAirDate(raw: string | null | undefined): string | null {
  if (!raw) return null
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return raw
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

/**
 * One merged episode row in the detail view's episode list: 16:9 thumbnail,
 * number chip, clamped title (+ air date for remote-only rows) and right-side
 * status pills plus play / whisper / download actions. Rows without a local
 * file render a 'Not Downloaded' pill and a disabled download ghost button
 * (P2P downloads arrive in a later update).
 */
export const EpisodeRow: React.FC<EpisodeRowProps> = ({
  number,
  title,
  thumbnailUrl,
  airDate,
  local,
  remoteOnly = false,
  watched = false,
  isDownloading = false,
  downloadProgress,
  onPlay,
  onWhisper,
  onDownload,
}) => {
  const [imgError, setImgError] = useState(false)

  // Reset the fallback when the row is reused for a different episode.
  useEffect(() => {
    setImgError(false)
  }, [thumbnailUrl])

  const showThumb = !!thumbnailUrl && !imgError
  const airLabel = remoteOnly ? formatAirDate(airDate) : null

  return (
    <div className="flex h-[72px] items-center gap-3 rounded-lg px-2 transition-colors hover:bg-zinc-900/60">
      {/* 16:9 thumbnail with dark placeholder fallback */}
      <div className="relative aspect-video w-[100px] shrink-0 overflow-hidden rounded-md bg-zinc-950">
        {showThumb ? (
          <img
            src={thumbnailUrl || ''}
            alt=""
            loading="lazy"
            onError={() => setImgError(true)}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-zinc-900 to-zinc-950">
            <Film className="h-5 w-5 text-zinc-700" />
          </div>
        )}
      </div>

      {/* Episode number chip */}
      <div className="flex w-9 shrink-0 justify-center">
        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-bold text-zinc-300">{number}</span>
      </div>

      {/* Title + optional air date */}
      <div className="min-w-0 flex-1">
        <p className="line-clamp-1 text-sm font-medium text-zinc-100" title={title}>
          {title}
        </p>
        {airLabel && <p className="mt-0.5 text-[11px] text-zinc-500">Aired {airLabel}</p>}
      </div>

      {/* Status pills + row actions */}
      <div className="flex shrink-0 items-center gap-1.5">
        {isDownloading && (
          <span
            title="Downloading to this PC"
            className="animate-pulse rounded bg-indigo-600/90 px-1.5 py-0.5 text-[10px] font-bold text-white"
          >
            {Math.round(downloadProgress ?? 0)}%
          </span>
        )}
        {!isDownloading && remoteOnly && (
          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-400">
            Not Downloaded
          </span>
        )}
        {watched && (
          <span title="Watched">
            <Check className="h-4 w-4 text-emerald-400" />
          </span>
        )}

        {onPlay && (
          <button
            type="button"
            onClick={onPlay}
            title="Play episode"
            className={`${ACTION_BTN} border-red-500/30 bg-red-500/10 text-red-300 hover:bg-red-500/20`}
          >
            <Play className="h-4 w-4 fill-current" />
          </button>
        )}

        {onWhisper && (
          <button
            type="button"
            onClick={onWhisper}
            title="Whisper subtitles for this season"
            className={`${ACTION_BTN} border-indigo-500/30 bg-indigo-500/10 text-indigo-300 hover:bg-indigo-500/20`}
          >
            <Wand2 className="h-4 w-4" />
          </button>
        )}

        {(remoteOnly || onDownload) && (
          <button
            type="button"
            onClick={onDownload}
            disabled={remoteOnly || !onDownload}
            title={remoteOnly || !onDownload ? DOWNLOAD_TOOLTIP : 'Download'}
            className={`${ACTION_BTN} border-zinc-700/60 bg-zinc-800/60 text-zinc-400 ${
              remoteOnly || !onDownload ? 'cursor-not-allowed opacity-60' : 'hover:bg-zinc-700/60'
            }`}
          >
            <Download className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  )
}
