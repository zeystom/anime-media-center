import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { Play } from 'lucide-react';
import { Episode, PlaybackProgress } from '../../types';
import { formatTime, cleanSeriesTitle } from '../../utils/format';

export interface UpNextData {
  progress: PlaybackProgress;
  episode: Episode;
  seasonName: string;
  posterUrl?: string | null;
  bannerUrl?: string | null;
  isUpNext: boolean;
}

interface UpNextWidgetProps {
  data: UpNextData;
  onPlay: (episode: Episode, startAt?: number) => void;
}

export const UpNextWidget: React.FC<UpNextWidgetProps> = ({ data, onPlay }) => {
  const { progress, episode, seasonName, posterUrl, bannerUrl, isUpNext } = data;

  // Poster candidates: poster first, then episode stills as fallbacks (remote https)
  const posterCandidates = useMemo(
    () => [posterUrl, episode.kitsuThumbnail, episode.thumbnailUrl].filter(
      (src): src is string => Boolean(src)
    ),
    [posterUrl, episode.kitsuThumbnail, episode.thumbnailUrl]
  );
  const [posterIdx, setPosterIdx] = useState(0);

  useEffect(() => {
    setPosterIdx(0);
  }, [posterCandidates]);

  const [bannerFailed, setBannerFailed] = useState(false);
  useEffect(() => {
    setBannerFailed(false);
  }, [bannerUrl]);

  const displayTitle = useMemo(() => cleanSeriesTitle(seasonName) || seasonName, [seasonName]);

  const percent = progress.duration > 0
    ? Math.min(100, Math.round((progress.currentTime / progress.duration) * 100))
    : 0;
  const startAt = !progress.completed ? progress.currentTime || 0 : 0;
  const posterSrc = posterCandidates[posterIdx] || null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: 'easeOut' }}
      className="relative mb-8 overflow-hidden rounded-2xl border border-zinc-800/80 bg-zinc-900/80 backdrop-blur"
    >
      {/* Subtle blurred banner backdrop */}
      {bannerUrl && !bannerFailed && (
        <img
          src={bannerUrl}
          alt=""
          aria-hidden
          loading="lazy"
          onError={() => setBannerFailed(true)}
          className="pointer-events-none absolute inset-0 h-full w-full scale-110 object-cover opacity-15 blur-xl select-none"
        />
      )}
      <div className="absolute inset-0 bg-gradient-to-r from-zinc-950/70 via-zinc-950/40 to-zinc-950/70 pointer-events-none" />

      <div className="relative flex h-[120px] items-stretch">
        {/* Poster */}
        <div className="relative h-full aspect-[2/3] shrink-0 overflow-hidden bg-zinc-950">
          {posterSrc ? (
            <img
              src={posterSrc}
              alt={displayTitle}
              loading="lazy"
              onError={() => setPosterIdx((i) => i + 1)}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-zinc-900 to-zinc-950">
              <span className="text-lg font-black tracking-wider text-zinc-700">
                {(displayTitle || '?').charAt(0).toUpperCase()}
              </span>
            </div>
          )}
          <div className="absolute inset-0 bg-gradient-to-r from-transparent to-zinc-950/30 pointer-events-none" />
        </div>

        {/* Info column */}
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-1.5 px-4 py-2">
          <div className="flex items-center gap-2">
            <span
              className={`rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                isUpNext
                  ? 'border-indigo-500/30 bg-indigo-500/15 text-indigo-300'
                  : 'border-red-500/30 bg-red-500/15 text-red-300'
              }`}
            >
              {isUpNext ? 'Up Next' : 'Continue Watching'}
            </span>
            {progress.episodeNumber && (
              <span className="rounded border border-zinc-700/50 bg-zinc-800 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-300">
                {progress.episodeNumber}
              </span>
            )}
          </div>

          <h3 className="truncate font-bold text-zinc-100" title={displayTitle}>
            {displayTitle}
          </h3>

          <div className="flex max-w-md items-center gap-2">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-zinc-800/90">
              <div
                className="h-full rounded-full bg-red-500 transition-all duration-300"
                style={{ width: `${percent}%` }}
              />
            </div>
            <span className="shrink-0 font-mono text-[11px] text-zinc-400">
              {formatTime(progress.currentTime)} / {formatTime(progress.duration)}
            </span>
          </div>
        </div>

        {/* Play action */}
        <div className="flex shrink-0 items-center pr-4 pl-2">
          <button
            onClick={() => onPlay(episode, startAt)}
            className="flex items-center gap-2 rounded-xl bg-red-600 px-4 py-2.5 text-sm font-bold text-white shadow-lg shadow-red-600/30 transition-all hover:bg-red-500 hover:shadow-red-600/50 active:scale-[0.97] sm:px-5"
            title={`Play ${progress.episodeNumber || 'episode'}`}
          >
            <Play className="h-4 w-4 fill-white" />
            <span>Play {progress.episodeNumber || 'Episode'}</span>
          </button>
        </div>
      </div>
    </motion.div>
  );
};
