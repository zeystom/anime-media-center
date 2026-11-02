import React, { useState, useEffect, useRef, useMemo } from 'react';
import { X, Play, CheckCircle2, Subtitles, ListVideo, Sparkles, Film, Clock } from 'lucide-react';
import { Episode, PlaybackProgress } from '../../types';
import { formatTime, formatFileSize, cleanEpisodeTitle, cleanSeriesTitle } from '../../utils/format';

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
  const parsed = useMemo(() => cleanEpisodeTitle(episode.fileName), [episode.fileName]);

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
        {!imgError && episode.thumbnailUrl ? (
          <img
            src={episode.thumbnailUrl}
            alt={episode.fileName}
            onError={() => setImgError(true)}
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

        {/* Top-Left Episode Badge Pill */}
        <div className="absolute top-1.5 left-1.5">
          <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-black/80 backdrop-blur-md text-white border border-white/10">
            {parsed.episodeLabel}
          </span>
        </div>

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
      <div className="flex-1 min-w-0 flex flex-col justify-between py-0.5">
        <div>
          {/* Main Title Row */}
          <div className="flex items-center justify-between gap-1.5">
            <h4
              className={`text-xs sm:text-sm font-semibold truncate ${
                isPlaying ? 'text-red-400 font-bold' : 'text-zinc-100 group-hover:text-white'
              }`}
              title={episode.fileName}
            >
              {parsed.displayTitle}
            </h4>

            {progress?.completed && (
              <span title="Completed">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              </span>
            )}
          </div>

          {/* Quality & Feature Badges */}
          {parsed.tags.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 mt-1.5">
              {parsed.tags.slice(0, 4).map((tag) => (
                <span
                  key={tag}
                  className="px-1.5 py-0.2 rounded text-[10px] font-mono font-medium bg-zinc-800/90 text-zinc-300 border border-white/5"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Metadata Footer */}
        <div className="flex items-center space-x-2 mt-2 text-[11px] text-zinc-400">
          <span className="font-mono">{formatFileSize(episode.size)}</span>

          {progress && progress.currentTime > 0 && (
            <>
              <span className="text-zinc-600">•</span>
              <span className="flex items-center space-x-1 font-mono text-zinc-300">
                <Clock className="w-3 h-3 text-zinc-500" />
                <span>{formatTime(progress.currentTime)}</span>
              </span>
            </>
          )}

          {episode.hasExternalSrt ? (
            <>
              <span className="text-zinc-600">•</span>
              <span
                title="Whisper External Subtitle Ready"
                className="flex items-center space-x-1 font-medium text-emerald-400"
              >
                <Subtitles className="w-3 h-3" />
                <span>SRT</span>
              </span>
            </>
          ) : episode.hasEmbeddedDubtitles ? (
            <>
              <span className="text-zinc-600">•</span>
              <span
                title="Embedded English Dubtitles (SDH) inside MKV"
                className="flex items-center space-x-1 font-medium text-purple-400"
              >
                <Subtitles className="w-3 h-3" />
                <span>Dub Sub</span>
              </span>
            </>
          ) : null}
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

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/80 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-md md:max-w-[480px] h-full bg-[#101014]/95 backdrop-blur-xl border-l border-zinc-800 p-6 flex flex-col shadow-2xl animate-in slide-in-from-right duration-200"
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
