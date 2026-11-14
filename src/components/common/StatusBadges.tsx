import React from 'react'
import { ArrowDownToLine, Check, HardDrive } from 'lucide-react'
import type { LocalBadgeState } from '../../hooks/useLocalStatus'

export interface StatusBadgesProps {
  state: LocalBadgeState
  size?: 'sm' | 'md'
  className?: string
}

const PILL_BASE = 'inline-flex items-center gap-1 rounded-full font-bold uppercase tracking-wide glass-pill'

/**
 * Row of micro-pills summarizing local + user-list state for one title:
 * downloading progress, on-PC episode counts, watched marker and release
 * badges (Ext Sub / Dub Sub / Sub / Movie). Only meaningful pills render; an
 * empty state renders nothing at all.
 */
export const StatusBadges: React.FC<StatusBadgesProps> = ({ state, size = 'md', className = '' }) => {
  if (!state) return null

  const isSm = size === 'sm'
  const pillSize = isSm ? 'text-[9px] px-1 py-px' : 'text-[10px] px-1.5 py-[2px]'
  const iconCls = isSm ? 'w-2 h-2' : 'w-2.5 h-2.5'

  const pills: React.ReactNode[] = []

  if (state.isDownloading) {
    pills.push(
      <span
        key="downloading"
        title="Downloading to this PC"
        className={`${PILL_BASE} ${pillSize} animate-pulse text-rose-300`}
      >
        <ArrowDownToLine className={iconCls} />
        <span>{Math.round(state.downloadProgress ?? 0)}%</span>
      </span>
    )
  }

  if (state.isOnPc) {
    const isComplete =
      state.downloadedEpisodes > 0 && state.downloadedEpisodes >= state.totalEpisodes && state.totalEpisodes > 0
    pills.push(
      <span
        key="on-pc"
        title={isComplete ? 'Fully downloaded on this PC' : 'On this PC'}
        className={`${PILL_BASE} ${pillSize} ${isComplete ? 'text-emerald-300' : 'text-zinc-300'}`}
      >
        <HardDrive className={iconCls} />
        <span>
          {state.downloadedEpisodes}/{state.totalEpisodes}
        </span>
      </span>
    )
  }

  if (state.isWatched) {
    pills.push(
      <span key="watched" title="Watched" className={`${PILL_BASE} ${pillSize} text-emerald-300`}>
        <Check className={iconCls} />
        <span>Watched</span>
      </span>
    )
  }

  for (const badge of Array.from(new Set(state.releaseBadges || []))) {
    if (!badge) continue
    pills.push(
      <span
        key={`release-${badge}`}
        title={badge}
        className={`${PILL_BASE} ${pillSize} text-rose-300`}
      >
        {badge}
      </span>
    )
  }

  if (pills.length === 0) return null

  return <div className={`flex flex-wrap items-center gap-1 ${className}`}>{pills}</div>
}
