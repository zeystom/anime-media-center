import React, { useEffect, useRef, useState } from 'react'
import { Film, Star } from 'lucide-react'
import type { RailItem } from '../../hooks/useCatalog'
import type { LocalBadgeState } from '../../hooks/useLocalStatus'
import { StatusBadges } from './StatusBadges'
import { normalizeAgeRating } from '../../utils/ageRating'

export interface AnimeCardProps {
  item: RailItem
  badgeState?: LocalBadgeState | null
  /** Show AniList release state, format, and airing episode progress. */
  showCatalogBadges?: boolean
  ageRating?: string | null
  ageRatingLoaded?: boolean
  onClick: (item: RailItem) => void
}

function formatAgeRating(value: string | null): { label: string; description: string } {
  return {
    label: normalizeAgeRating(value),
    description: value || 'No MyAnimeList age rating available',
  }
}

/**
 * Compact poster card for catalog rails: fixed-width poster (2:3), score
 * chip, optional local-status badges over a subtle bottom gradient, and a
 * two-line clamped title underneath.
 */
export const AnimeCard: React.FC<AnimeCardProps> = ({ item, badgeState = null, showCatalogBadges = false, ageRating = null, ageRatingLoaded = false, onClick }) => {
  const [imgError, setImgError] = useState(false)
  // Hover prefetch: arm a short timer on enter and cancel it on leave, so a
  // sweep across a rail produces zero requests while a resting cursor warms
  // the episodes pipeline ~1 card-click ahead of the user.
  const warmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelWarm = () => {
    if (warmTimer.current) {
      clearTimeout(warmTimer.current)
      warmTimer.current = null
    }
  }
  useEffect(() => cancelWarm, [])


  const showImage = !!item.posterUrl && !imgError
  const normalizedAgeRating = formatAgeRating(ageRating)
  const ageRatingTone = normalizedAgeRating.label === 'NR'
    ? 'border-zinc-300/20 bg-zinc-950 text-zinc-200'
    : ['R-17+', 'R+', 'Rx'].includes(normalizedAgeRating.label)
      ? 'border-amber-300/30 bg-amber-950 text-amber-100'
      : 'border-teal-300/25 bg-teal-950 text-teal-100'
  const hasBadges =
    !!badgeState &&
    (badgeState.isDownloading || badgeState.isOnPc || badgeState.isWatched || (badgeState.releaseBadges?.length ?? 0) > 0)
  const releaseLabel = item.status === 'RELEASING'
    ? 'Ongoing'
    : item.status === 'NOT_YET_RELEASED'
      ? 'Not released'
      : item.status === 'FINISHED'
        ? 'Finished'
        : item.status === 'HIATUS'
          ? 'On hiatus'
          : item.status === 'CANCELLED'
            ? 'Cancelled'
            : null
  const releaseClass = item.status === 'RELEASING'
    ? 'border-emerald-300/30 bg-emerald-950/90 text-emerald-100'
    : item.status === 'NOT_YET_RELEASED'
      ? 'border-sky-300/30 bg-sky-950/90 text-sky-100'
      : item.status === 'HIATUS' || item.status === 'CANCELLED'
        ? 'border-amber-300/30 bg-amber-950/90 text-amber-100'
        : 'border-white/15 bg-zinc-950/90 text-zinc-100'
  const formatLabel = item.format === 'TV'
    ? 'Series'
    : item.format === 'TV_SHORT'
      ? 'Short series'
      : item.format === 'MOVIE'
        ? 'Film'
        : item.format === 'OVA' || item.format === 'ONA' || item.format === 'SPECIAL' || item.format === 'MUSIC'
          ? item.format
          : null
  const airedEpisodes = item.airingEpisode != null ? Math.max(0, item.airingEpisode - 1) : null

  return (
    <div
      onClick={() => onClick(item)}
      onMouseEnter={() => {
        if (item.anilistId == null || warmTimer.current) return
        warmTimer.current = setTimeout(() => {
          warmTimer.current = null
          window.electronAPI?.warmRemoteEpisodes?.(item.anilistId as number)
        }, 200)
      }}
      onMouseLeave={cancelWarm}
      className="anime-card group w-[180px] shrink-0 cursor-pointer transition-transform duration-150 hover:-translate-y-0.5 xl:w-[192px]"
    >
      <div className="relative aspect-[2/3] overflow-hidden rounded-2xl border border-white/[0.09] bg-zinc-900 shadow-lg shadow-black/20 transition-colors group-hover:border-violet-300/30">
        {showImage ? (
          <img
            src={item.posterUrl || ''}
            alt={item.title}
            draggable={false}
            loading="lazy"
            decoding="async"
            onError={() => setImgError(true)}
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-zinc-900 to-zinc-950">
            <Film className="w-7 h-7 text-zinc-700" />
          </div>
        )}

        {showCatalogBadges && (
          <div className="absolute left-1.5 right-9 top-1.5 flex flex-wrap items-start gap-1">
            {item.seasonYear != null && (
              <span className="inline-flex items-center rounded-md border border-white/20 bg-black/90 px-1.5 py-1 text-[9px] font-bold leading-none text-zinc-100 shadow-sm">
                {item.seasonYear}
              </span>
            )}
            {releaseLabel && (
              <span className={`inline-flex items-center rounded-md border px-1.5 py-1 text-[9px] font-bold leading-none shadow-sm ${releaseClass}`}>
                {releaseLabel}
                {item.status === 'RELEASING' && item.episodesCount != null && airedEpisodes != null && (
                  <span className="ml-1 font-extrabold text-white">{airedEpisodes}/{item.episodesCount}</span>
                )}
                {item.status === 'RELEASING' && item.episodesCount != null && airedEpisodes == null && (
                  <span className="ml-1 font-semibold text-white/85">{item.episodesCount} eps</span>
                )}
              </span>
            )}
            {formatLabel && (
              <span className="inline-flex items-center rounded-md border border-white/20 bg-zinc-900 px-1.5 py-1 text-[9px] font-bold leading-none text-zinc-100 shadow-sm">
                {formatLabel}
              </span>
            )}
            <span
              title={ageRatingLoaded ? normalizedAgeRating.description : 'Loading MyAnimeList age rating…'}
              className={`inline-flex items-center rounded-md border px-1.5 py-1 text-[9px] font-bold leading-none shadow-sm ${ageRatingTone}`}
            >
              {item.idMal == null ? 'NR' : ageRatingLoaded ? normalizedAgeRating.label : '…'}
            </span>
          </div>
        )}

        {item.averageScore != null && (
          <div className="absolute top-1 right-1 flex items-center gap-0.5 rounded bg-black/85 px-1 py-0.5 text-[10px] font-bold text-white">
            <Star className="w-2.5 h-2.5 fill-amber-400 text-amber-400" />
            <span>{Math.round(item.averageScore)}</span>
          </div>
        )}

        {hasBadges && (
          <div className="absolute bottom-1 left-1 right-1 rounded-lg bg-gradient-to-t from-black/80 via-black/40 to-transparent px-1 pb-0.5 pt-4">
            <StatusBadges state={badgeState} size="sm" />
          </div>
        )}
      </div>

      <h4 className="mt-1.5 text-xs leading-snug text-zinc-200 line-clamp-2" title={item.title}>
        {item.title}
      </h4>
    </div>
  )
}
