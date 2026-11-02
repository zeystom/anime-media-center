import React, { useState, useEffect, useRef, useMemo } from 'react';
import { X, Play, CheckCircle2, ListVideo, Film, Sparkles } from 'lucide-react';
import { Episode, PlaybackProgress } from '../../types';
import { formatTime, cleanEpisodeTitle, cleanSeriesTitle, formatEpisodeDisplayTitle } from '../../utils/format';

interface EpisodeDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  episodes: Episode[];
  currentEpisode: Episode;
  history: Record<string, PlaybackProgress>;
  autoPlayNext: boolean;
  onToggleAutoPlayNext: () => void;
  onSelectEpisode: (episode: Episode) => void;
}

interface EpisodeItemProps {
  episode: Episode;
  isPlaying: boolean;
  progress?: PlaybackProgress;
  onSelect: () => void;
  isCurrentRef?: (el: HTMLDivElement | null) => void;
}

const EpisodeDrawerItem: React.FC<EpisodeItemProps> = ({
  episode,
  isPlaying,
  progress,
  onSelect,
  isCurrentRef,
}) => {
  const [imgError, setImgError] = useState(false);
  const [activeImgUrl, setActiveImgUrl] = useState(episode.kitsuThumbnail || episode.thumbnailUrl);
  const [retryCount, setRetryCount] = useState(0);
  const parsed = useMemo(() => cleanEpisodeTitle(episode.fileName), [episode.fileName]);

  useEffect(() => {
    setActiveImgUrl(episode.kitsuThumbnail || episode.thumbnailUrl);
    setImgError(false);
    setRetryCount(0);
  }, [episode.kitsuThumbnail, episode.thumbnailUrl]);

  const handleImgError = () => {
    if (activeImgUrl === episode.kitsuThumbnail && episode.thumbnailUrl) {
      setActiveImgUrl(episode.thumbnailUrl);
    } else if (retryCount < 3 && episode.thumbnailUrl) {
      setTimeout(() => {
        setRetryCount((c) => c + 1);
        setActiveImgUrl(`${episode.thumbnailUrl}&retry=${Date.now()}`);
      }, 1000);
    } else {
      setImgError(true);
    }
  };

  const percentWatched =
    progress && progress.duration > 0
      ? Math.min(100, Math.round((progress.currentTime / progress.duration) * 100))
      : 0;

  return (
    <div
      ref={isCurrentRef}
      onClick={onSelect}
      className={`group relative p-3 rounded-2xl cursor-pointer transition-all duration-200 border flex items-center space-x-3.5 ${
        isPlaying
          ? 'bg-red-500/10 border-red-500/50 shadow-lg shadow-red-500/5'
          : 'bg-[#16161b]/80 border-white/[0.06] hover:bg-[#1f1f26] hover:border-white/20'
      }`}
    >
      {/* Thumbnail Card (16:9 aspect) */}
      <div className="relative w-32 sm:w-36 aspect-video rounded-xl overflow-hidden shrink-0 bg-zinc-950 border border-white/10 shadow-sm">
        {!imgError && activeImgUrl ? (
          <img
            src={activeImgUrl}
            alt={episode.fileName}
            onError={handleImgError}
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-br from-zinc-900 via-zinc-950 to-black p-2 text-center">
            <Film className="w-5 h-5 text-zinc-600 mb-1" />
            <span className="text-[11px] font-bold text-zinc-400 tracking-wider">
              {parsed.episodeLabel}
            </span>
          </div>
        )}

        {/* Active Now Playing Indicator / Hover Play Overlay */}
        {isPlaying ? (
          <div className="absolute inset-0 bg-red-950/40 backdrop-blur-[1px] flex items-center justify-center">
            <div className="w-8 h-8 rounded-full bg-red-600 text-white flex items-center justify-center shadow-lg shadow-red-600/50 ring-2 ring-white/20">
              <Play className="w-4 h-4 ml-0.5 fill-white" />
            </div>
            <div className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-red-600 text-white flex items-center space-x-1 shadow-sm">
              <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
              <span>Playing</span>
            </div>
          </div>
        ) : (
          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center backdrop-blur-[1px]">
            <div className="w-8 h-8 rounded-full bg-red-600/90 text-white flex items-center justify-center shadow-md transform group-hover:scale-110 transition-transform">
              <Play className="w-4 h-4 ml-0.5 fill-white" />
            </div>
          </div>
        )}

        {/* Watch Progress Bar */}
        {progress && progress.currentTime > 0 && (
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-zinc-900/80">
            <div
              className={`h-full ${progress.completed ? 'bg-emerald-500' : 'bg-red-600'}`}
              style={{ width: `${percentWatched}%` }}
            />
          </div>
        )}
      </div>

      {/* Episode Details */}
      <div className="flex-1 min-w-0 flex flex-col justify-center py-0.5">
        {/* Main Title Row */}
        <div className="flex items-center justify-between gap-1.5">
          <h4
            className={`text-xs sm:text-sm font-semibold truncate ${
              isPlaying ? 'text-red-400 font-bold' : 'text-zinc-100 group-hover:text-white'
            }`}
            title={formatEpisodeDisplayTitle(parsed.displayTitle, episode.kitsuTitle || episode.episodeTitle)}
          >
            {formatEpisodeDisplayTitle(parsed.displayTitle, episode.kitsuTitle || episode.episodeTitle)}
          </h4>

          {progress?.completed && (
            <span title="Completed">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            </span>
          )}
        </div>

        {/* Timestamp Footer */}
        <div className="mt-1.5 text-[11px] text-zinc-400 font-mono">
          {progress && progress.currentTime > 0 ? (
            <span>
              {formatTime(progress.currentTime)} / {formatTime(progress.duration || episode.duration || 0)}
            </span>
          ) : (
            <span className="text-zinc-500">
              {episode.duration && episode.duration > 0 ? formatTime(episode.duration) : 'Unwatched'}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};

export const EpisodeDrawer: React.FC<EpisodeDrawerProps> = ({
  isOpen,
  onClose,
  episodes,
  currentEpisode,
  history,
  autoPlayNext,
  onToggleAutoPlayNext,
  onSelectEpisode,
}) => {
  const activeElementRef = useRef<HTMLDivElement | null>(null);
  const leaveTimerRef = useRef<any>(null);

  const handleMouseEnter = () => {
    if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
  };

  const handleMouseLeave = () => {
    if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
    leaveTimerRef.current = setTimeout(() => {
      onClose();
    }, 280);
  };

  // Auto-scroll to current episode on drawer open
  useEffect(() => {
    if (isOpen && activeElementRef.current) {
      const timer = setTimeout(() => {
        activeElementRef.current?.scrollIntoView({
          behavior: 'smooth',
          block: 'nearest',
        });
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  // Clean Series Title for Header
  const seriesName = useMemo(() => {
    if (episodes.length === 0) return 'Episodes';
    return cleanSeriesTitle(episodes[0].fileName || currentEpisode.fileName);
  }, [episodes, currentEpisode]);

  return (
    <div
      className={`fixed inset-0 z-50 flex justify-end bg-black/80 backdrop-blur-sm transition-opacity duration-300 ease-out select-none ${
        isOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
      }`}
      onClick={onClose}
    >
      <div
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        className={`w-full sm:max-w-md md:max-w-[480px] h-full bg-[#101014]/95 backdrop-blur-2xl border-l border-white/10 p-6 flex flex-col shadow-[-25px_0_60px_rgba(0,0,0,0.85)] transition-transform duration-400 ease-[cubic-bezier(0.16,1,0.3,1)] transform ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-zinc-800/80">
          <div className="flex items-center space-x-3 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-red-600/15 border border-red-500/30 flex items-center justify-center shrink-0">
              <ListVideo className="w-5 h-5 text-red-500" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center space-x-2">
                <h3 className="text-base font-bold text-white tracking-tight">Episodes</h3>
                <span className="px-2 py-0.5 rounded-full text-xs bg-zinc-800 text-zinc-300 font-semibold border border-white/5">
                  {episodes.length}
                </span>
              </div>
              {seriesName && (
                <p className="text-xs text-zinc-400 truncate mt-0.5" title={seriesName}>
                  {seriesName}
                </p>
              )}
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-2 rounded-xl text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
            aria-label="Close Episodes Drawer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Auto Play Next Toggle */}
        <div className="py-3 px-3.5 my-3.5 rounded-2xl bg-zinc-900/90 border border-zinc-800 flex items-center justify-between shadow-inner">
          <div className="flex items-center space-x-2.5">
            <div className="w-7 h-7 rounded-lg bg-indigo-500/10 flex items-center justify-center">
              <Sparkles className="w-4 h-4 text-indigo-400" />
            </div>
            <div>
              <span className="text-xs font-semibold text-zinc-200">Auto-play Next Episode</span>
              <p className="text-[10px] text-zinc-400">Play next episode seamlessly on end</p>
            </div>
          </div>
          <button
            onClick={onToggleAutoPlayNext}
            className={`w-11 h-6 rounded-full p-0.5 transition-colors duration-200 ${
              autoPlayNext ? 'bg-red-600' : 'bg-zinc-700'
            }`}
          >
            <div
              className={`w-5 h-5 rounded-full bg-white shadow-md transition-transform duration-200 ${
                autoPlayNext ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        {/* Episode List */}
        <div className="flex-1 overflow-y-auto space-y-2.5 pr-1.5 scrollbar-thin scrollbar-thumb-zinc-700">
          {episodes.map((ep) => {
            const isPlaying = ep.filePath === currentEpisode.filePath;
            const progress = history[ep.filePath];

            return (
              <EpisodeDrawerItem
                key={ep.filePath}
                episode={ep}
                isPlaying={isPlaying}
                progress={progress}
                onSelect={() => {
                  onSelectEpisode(ep);
                  onClose();
                }}
                isCurrentRef={isPlaying ? (el) => (activeElementRef.current = el) : undefined}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
};
