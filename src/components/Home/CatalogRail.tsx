import React, { useMemo } from 'react';
import { RailItem } from '../../hooks/useCatalog';
import { LocalBadgeState } from '../../hooks/useLocalStatus';
import { AnimeCard } from '../common/AnimeCard';
import { HorizontalScroller } from '../common/HorizontalScroller';
import { useAgeRatings } from '../../hooks/useAgeRatings';

interface CatalogRailProps {
  title: string;
  items: RailItem[];
  loading?: boolean;
  emptyHint?: string;
  onSelect: (item: RailItem) => void;
  statusFor: (ref: { anilistId?: number | null; title?: string | null; apiEpisodesCount?: number | null }) => LocalBadgeState | null;
  onSeeMore?: () => void;
}

const SKELETON_COUNT = 6;

const SkeletonCard: React.FC = () => (
  <div className="w-[180px] shrink-0">
    <div className="aspect-[2/3] w-full rounded-xl bg-zinc-900" />
    <div className="mt-2 h-3 w-3/4 rounded bg-zinc-900" />
    <div className="mt-1.5 h-2.5 w-1/2 rounded bg-zinc-900" />
  </div>
);

export const CatalogRail: React.FC<CatalogRailProps> = ({
  title,
  items,
  loading = false,
  emptyHint,
  onSelect,
  statusFor,
  onSeeMore,
}) => {
  const skeletons = useMemo(() => Array.from({ length: SKELETON_COUNT }, (_, i) => i), []);
  const { ratings } = useAgeRatings(items);

  return (
    <section className="home-rail-section mb-10">
      <div className="mb-4 flex items-center justify-between gap-2.5">
        <div className="flex items-center gap-2.5">
          <span className="h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_10px_rgba(103,232,249,0.65)]" />
          <h2 className="text-lg font-black uppercase tracking-wide text-white">{title}</h2>
        </div>
        {onSeeMore && <button type="button" onClick={onSeeMore} className="text-xs font-semibold text-cyan-300 transition hover:text-cyan-100">See all →</button>}
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
        <HorizontalScroller label={`${title} anime`} className="flex gap-4 overflow-x-auto pb-3">
          {items.map((item) => (
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
          ))}
        </HorizontalScroller>
      )}
    </section>
  );
};
