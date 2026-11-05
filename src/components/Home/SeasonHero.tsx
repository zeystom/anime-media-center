import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Star, Info, Tv } from 'lucide-react';
import { RailItem } from '../../hooks/useCatalog';
import { LocalBadgeState } from '../../hooks/useLocalStatus';
import { StatusBadges } from '../common/StatusBadges';

interface SeasonHeroProps {
  items: RailItem[];
  loading: boolean;
  onSelect: (item: RailItem) => void;
  statusFor: (ref: { anilistId?: number | null; title?: string | null; apiEpisodesCount?: number | null }) => LocalBadgeState | null;
}

const ROTATE_MS = 8000;

function prettifyStatus(status: string): string {
  const text = status.replace(/_/g, ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function statusChipClass(status: string): string {
  switch (status) {
    case 'RELEASING':
      return 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300';
    case 'FINISHED':
      return 'border-zinc-500/30 bg-zinc-500/15 text-zinc-300';
    case 'NOT_YET_RELEASED':
      return 'border-sky-500/30 bg-sky-500/15 text-sky-300';
    default:
      return 'border-zinc-700/60 bg-zinc-800/80 text-zinc-300';
  }
}

const MetaChip: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => (
  <span
    className={`inline-flex items-center gap-1 rounded-full border border-white/10 bg-black/40 px-2 py-0.5 text-xs font-semibold text-zinc-200 backdrop-blur-sm ${className || ''}`}
  >
    {children}
  </span>
);

export const SeasonHero: React.FC<SeasonHeroProps> = ({ items, loading, onSelect, statusFor }) => {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [bannerFailed, setBannerFailed] = useState(false);

  const count = items.length;

  // Clamp the featured index if the list shrinks; avoid resetting on every
  // new `items` array identity so auto-rotation is never interrupted.
  useEffect(() => {
    setIndex((i) => (count > 0 && i >= count ? 0 : i));
  }, [count]);

  useEffect(() => {
    if (paused || count <= 1) return;
    const timer = setInterval(() => {
      setIndex((i) => (i + 1) % count);
    }, ROTATE_MS);
    return () => clearInterval(timer);
  }, [paused, count]);

  const item = count > 0 ? items[Math.min(index, count - 1)] : null;

  const badgeState = useMemo(
    () =>
      item
        ? statusFor({
            anilistId: item.anilistId,
            title: item.title,
            apiEpisodesCount: item.episodesCount ?? null,
          })
        : null,
    [item, statusFor]
  );

  // Reset banner error state when the featured item changes
  useEffect(() => {
    setBannerFailed(false);
  }, [item?.anilistId]);

  if (loading) {
    return (
      <section className="mb-8" aria-label="Season spotlight loading">
        <div className="h-[280px] w-full animate-pulse overflow-hidden rounded-2xl border border-zinc-800/80 bg-zinc-900">
          <div className="flex h-full items-end p-8">
            <div className="w-full max-w-xl space-y-4">
              <div className="h-8 w-2/3 rounded bg-zinc-800/80" />
              <div className="h-4 w-1/2 rounded bg-zinc-800/60" />
              <div className="h-4 w-1/3 rounded bg-zinc-800/60" />
            </div>
          </div>
        </div>
      </section>
    );
  }

  if (!item) return null;

  const showBanner = item.bannerUrl && !bannerFailed;

  return (
    <section className="mb-8" aria-label="Season spotlight">
      <div
        className="group relative h-[280px] w-full overflow-hidden rounded-2xl border border-zinc-800/80 bg-zinc-950"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
      >
        {/* Background banner with crossfade */}
        {showBanner ? (
          <motion.div
            key={item.anilistId}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6, ease: 'easeOut' }}
            className="absolute inset-0"
          >
            <img
              src={item.bannerUrl as string}
              alt=""
              loading="lazy"
              onError={() => setBannerFailed(true)}
              className="h-full w-full object-cover"
            />
          </motion.div>
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-indigo-950/60 via-zinc-900 to-zinc-950" />
        )}

        {/* Gradient overlays: bottom fade into page bg + left readability shade */}
        <div className="absolute inset-x-0 bottom-0 h-3/4 bg-gradient-to-t from-[#0f0f12] to-transparent pointer-events-none" />
        <div className="absolute inset-0 bg-gradient-to-r from-[#0f0f12]/95 via-[#0f0f12]/55 to-transparent pointer-events-none" />

        {/* Foreground content */}
        <div className="absolute inset-0 flex items-center">
          <div className="w-full px-6 sm:px-8">
            <div className="max-w-2xl">
              <div className="mb-2 flex items-center gap-2">
                <Tv className="h-3.5 w-3.5 text-red-500" />
                <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-400">
                  Popular This Season
                </span>
              </div>

              <h2 className="line-clamp-2 text-3xl font-black leading-tight text-white" title={item.title}>
                {item.title}
              </h2>

              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                {item.averageScore != null && item.averageScore > 0 && (
                  <MetaChip>
                    <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
                    <span>{Math.round(item.averageScore)}%</span>
                  </MetaChip>
                )}
                {item.seasonYear != null && (
                  <MetaChip>
                    <span>{item.seasonYear}</span>
                  </MetaChip>
                )}
                {item.format && (
                  <MetaChip>
                    <span>{item.format}</span>
                  </MetaChip>
                )}
                {item.episodesCount != null && item.episodesCount > 0 && (
                  <MetaChip>
                    <span>{item.episodesCount} EP</span>
                  </MetaChip>
                )}
                {item.status && (
                  <MetaChip className={statusChipClass(item.status)}>
                    <span>{prettifyStatus(item.status)}</span>
                  </MetaChip>
                )}
              </div>

              {badgeState && (
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  <StatusBadges state={badgeState} size="sm" />
                </div>
              )}

              <button
                onClick={() => onSelect(item)}
                className="mt-4 inline-flex items-center gap-2 rounded-xl border border-zinc-700/60 bg-zinc-800/90 px-4 py-2 text-sm font-semibold text-zinc-100 shadow-lg shadow-black/30 backdrop-blur transition-all hover:border-zinc-600 hover:bg-zinc-700/90 active:scale-[0.98]"
              >
                <Info className="h-4 w-4" />
                <span>Details</span>
              </button>
            </div>
          </div>
        </div>

        {/* Rotation dots */}
        {count > 1 && (
          <div className="absolute bottom-4 right-4 z-10 flex max-w-[45%] flex-wrap justify-end gap-1.5">
            {items.map((it, i) => (
              <button
                key={it.anilistId}
                onClick={() => setIndex(i)}
                aria-label={`Show ${it.title}`}
                className={`h-1.5 rounded-full transition-all duration-200 ${
                  i === index
                    ? 'w-4 bg-red-500'
                    : 'w-1.5 bg-white/30 hover:bg-white/60'
                }`}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
};
