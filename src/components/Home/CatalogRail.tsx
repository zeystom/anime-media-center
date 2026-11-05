import React, { useMemo } from 'react';
import { RailItem } from '../../hooks/useCatalog';
import { LocalBadgeState } from '../../hooks/useLocalStatus';
import { AnimeCard } from '../common/AnimeCard';

interface CatalogRailProps {
  title: string;
  items: RailItem[];
  loading?: boolean;
  emptyHint?: string;
  onSelect: (item: RailItem) => void;
  statusFor: (ref: { anilistId?: number | null; title?: string | null; apiEpisodesCount?: number | null }) => LocalBadgeState | null;
}

const SKELETON_COUNT = 6;

const SkeletonCard: React.FC = () => (
  <div className="w-[150px] shrink-0 animate-pulse">
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
}) => {
  const skeletons = useMemo(() => Array.from({ length: SKELETON_COUNT }, (_, i) => i), []);

  return (
    <section className="mb-8">
      <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-zinc-200">{title}</h2>

      {loading ? (
        <div className="flex gap-3 overflow-hidden pb-2">
          {skeletons.map((i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="py-4 text-sm text-zinc-500">
          {emptyHint || 'Nothing here yet'}
        </p>
      ) : (
        <div className="scrollbar-none flex gap-3 overflow-x-auto pb-2">
          {items.map((item) => (
            <AnimeCard
              key={item.anilistId}
              item={item}
              badgeState={statusFor({
                anilistId: item.anilistId,
                title: item.title,
                apiEpisodesCount: item.episodesCount ?? null,
              })}
              onClick={onSelect}
            />
          ))}
        </div>
      )}
    </section>
  );
};
