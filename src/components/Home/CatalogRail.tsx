import React, { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RailItem } from '../../hooks/useCatalog';
import { LocalBadgeState } from '../../hooks/useLocalStatus';
import { AnimeCard } from '../common/AnimeCard';
import { HorizontalScroller } from '../common/HorizontalScroller';
import { useAgeRatings } from '../../hooks/useAgeRatings';
import { isScrollActive } from '../../utils/scrollState';

interface CatalogRailProps {
  title: string;
  items: RailItem[];
  loading?: boolean;
  emptyHint?: string;
  onSelect: (item: RailItem) => void;
  statusFor: (ref: { anilistId?: number | null; title?: string | null; apiEpisodesCount?: number | null }) => LocalBadgeState | null;
  onSeeMore?: () => void;
}

const SKELETON_COUNT = 12;
const INITIAL_VISIBLE_CARDS = typeof window !== 'undefined'
  ? Math.max(12, Math.ceil(window.innerWidth / 192) + 2)
  : 12;

const SkeletonCard: React.FC = () => (
  <div className="w-[180px] shrink-0">
    <div className="aspect-[2/3] w-full rounded-xl bg-zinc-900" />
    <div className="mt-2 h-3 w-3/4 rounded bg-zinc-900" />
    <div className="mt-1.5 h-2.5 w-1/2 rounded bg-zinc-900" />
  </div>
);

const CatalogRailImpl: React.FC<CatalogRailProps> = ({
  title,
  items,
  loading = false,
  emptyHint,
  onSelect,
  statusFor,
  onSeeMore,
}) => {
  const skeletons = useMemo(() => Array.from({ length: SKELETON_COUNT }, (_, i) => i), []);
  const [expanded, setExpanded] = useState(false);
  const hoverExpandTimerRef = useRef<number | null>(null);
  const engage = useCallback(() => {
    if (hoverExpandTimerRef.current != null) {
      window.clearTimeout(hoverExpandTimerRef.current);
      hoverExpandTimerRef.current = null;
    }
    startTransition(() => setExpanded(true));
  }, []);
  const scheduleHoverExpand = useCallback(() => {
    if (expanded || items.length <= INITIAL_VISIBLE_CARDS || isScrollActive()) return;
    if (hoverExpandTimerRef.current != null) return;
    hoverExpandTimerRef.current = window.setTimeout(() => {
      hoverExpandTimerRef.current = null;
      if (!isScrollActive()) startTransition(() => setExpanded(true));
    }, 120);
  }, [expanded, items.length]);
  const cancelHoverExpand = useCallback(() => {
    if (hoverExpandTimerRef.current != null) {
      window.clearTimeout(hoverExpandTimerRef.current);
      hoverExpandTimerRef.current = null;
    }
  }, []);
  useEffect(() => cancelHoverExpand, [cancelHoverExpand]);
  const { ratings } = useAgeRatings(items);
  const tailCutoff = expanded ? items.length : INITIAL_VISIBLE_CARDS;

  return (
    <section
      onPointerEnter={!expanded && items.length > INITIAL_VISIBLE_CARDS ? scheduleHoverExpand : undefined}
      onPointerLeave={!expanded && items.length > INITIAL_VISIBLE_CARDS ? cancelHoverExpand : undefined}
      onFocusCapture={!expanded && items.length > INITIAL_VISIBLE_CARDS ? engage : undefined}
      className="home-rail-section mb-10"
    >
      <div className="mb-4 flex items-center justify-between gap-2.5">
        <div className="flex items-center gap-2.5">
          <span className="h-2 w-2 rounded-full bg-rose-400 shadow-[0_0_10px_rgba(255,30,109,0.65)]" />
          <h2 className="text-lg font-black uppercase tracking-wide text-white">{title}</h2>
        </div>
        {onSeeMore && <button type="button" onClick={onSeeMore} className="text-xs font-semibold text-rose-300 transition hover:text-rose-100">See all →</button>}
      </div>

      {loading ? (
        <div className="flex gap-4 overflow-hidden pb-2">
          {skeletons.map((i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="py-4 text-sm text-zinc-500">
          {emptyHint || 'Nothing here yet'}
        </p>
      ) : (
        <HorizontalScroller label={`${title} anime`} onEngageScroll={engage} className="flex gap-4 overflow-x-auto pb-3">
          {items.map((item, idx) =>
            idx < tailCutoff ? (
              <AnimeCard
                key={item.anilistId}
                item={item}
                showCatalogBadges
                ageRating={item.idMal != null ? ratings[item.idMal] : null}
                ageRatingLoaded={item.idMal == null || Object.prototype.hasOwnProperty.call(ratings, item.idMal)}
                badgeState={statusFor({
                  anilistId: item.anilistId,
                  title: item.title,
                  apiEpisodesCount: item.episodesCount ?? null,
                })}
                onClick={onSelect}
              />
            ) : (
              <div key={item.anilistId} aria-hidden="true" className="anime-card w-[180px] shrink-0 xl:w-[192px]">
                <div className="aspect-[2/3] w-full rounded-2xl bg-zinc-900/40" />
              </div>
            )
          )}
        </HorizontalScroller>
      )}
    </section>
  );
};

export const CatalogRail = React.memo(CatalogRailImpl);
