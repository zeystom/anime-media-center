import React, { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Film, Star } from 'lucide-react'
import type { RailItem } from '../../hooks/useCatalog'
import type { LocalBadgeState } from '../../hooks/useLocalStatus'
import { StatusBadges } from './StatusBadges'

export interface AnimeCardProps {
  item: RailItem
  badgeState?: LocalBadgeState | null
  onClick: (item: RailItem) => void
}

/**
 * Compact poster card for catalog rails: fixed-width poster (2:3), score
 * chip, optional local-status badges over a subtle bottom gradient, and a
 * two-line clamped title underneath.
 */
export const AnimeCard: React.FC<AnimeCardProps> = ({ item, badgeState = null, onClick }) => {
  const [imgError, setImgError] = useState(false)

  // Reset the error state when the card is reused for a different item.
  useEffect(() => {
    setImgError(false)
  }, [item.anilistId, item.posterUrl])

  const showImage = !!item.posterUrl && !imgError
  const hasBadges =
    !!badgeState &&
    (badgeState.isDownloading || badgeState.isOnPc || badgeState.isWatched || (badgeState.releaseBadges?.length ?? 0) > 0)

  return (
    <motion.div
      whileHover={{ y: -2 }}
      onClick={() => onClick(item)}
      className="w-[150px] shrink-0 cursor-pointer group"
    >
      <div className="relative aspect-[2/3] rounded-xl overflow-hidden bg-zinc-900 border border-zinc-800/80">
        {showImage ? (
          <img
            src={item.posterUrl || ''}
            alt={item.title}
            loading="lazy"
            onError={() => setImgError(true)}
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-zinc-900 to-zinc-950">
            <Film className="w-7 h-7 text-zinc-700" />
          </div>
        )}

        {item.averageScore != null && (
          <div className="absolute top-1 right-1 flex items-center gap-0.5 rounded bg-black/70 px-1 py-0.5 text-[10px] font-bold text-white backdrop-blur-sm">
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
    </motion.div>
  )
}
