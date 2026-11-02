import React from 'react';
import { X, Play, CheckCircle2, Subtitles, ListVideo, Sparkles } from 'lucide-react';
import { Episode, PlaybackProgress } from '../../types';
import { formatTime, formatFileSize } from '../../utils/format';

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
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/80 animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md h-full bg-[#121216] border-l border-zinc-800 p-6 flex flex-col shadow-2xl animate-in slide-in-from-right duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-zinc-800">
          <div className="flex items-center space-x-2.5">
            <ListVideo className="w-5 h-5 text-red-500" />
            <h3 className="text-base font-bold text-white tracking-tight">Episodes</h3>
            <span className="px-2 py-0.5 rounded text-xs bg-zinc-800 text-zinc-400 font-semibold">
              {episodes.length}
            </span>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Auto Play Next Toggle */}
        <div className="py-3 px-3.5 my-3 rounded-xl bg-zinc-900 border border-zinc-800/80 flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Sparkles className="w-4 h-4 text-indigo-400" />
            <span className="text-xs font-semibold text-zinc-200">Auto-play Next Episode</span>
          </div>
          <button
            onClick={onToggleAutoPlayNext}
            className={`w-10 h-5 rounded-full p-0.5 transition-colors ${
              autoPlayNext ? 'bg-red-600' : 'bg-zinc-700'
            }`}
          >
            <div
              className={`w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${
                autoPlayNext ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        {/* Episode List */}
        <div className="flex-1 overflow-y-auto space-y-2 pr-1">
          {episodes.map((ep) => {
            const isPlaying = ep.filePath === currentEpisode.filePath;
            const progress = history[ep.filePath];

            return (
              <div
                key={ep.filePath}
                onClick={() => {
                  onSelectEpisode(ep);
                  onClose();
                }}
                className={`group p-3 rounded-xl cursor-pointer transition-all border flex items-center space-x-3.5 ${
                  isPlaying
                    ? 'bg-red-600/15 border-red-500/50 shadow-md shadow-red-600/10'
                    : 'bg-zinc-900/60 border-zinc-800/60 hover:bg-zinc-800/60 hover:border-zinc-700'
                }`}
              >
                {/* Badge or Play Icon */}
                <div
                  className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 font-bold text-xs transition-colors ${
                    isPlaying
                      ? 'bg-red-600 text-white shadow-md shadow-red-600/30'
                      : 'bg-zinc-800 text-zinc-300 group-hover:bg-zinc-700'
                  }`}
                >
                  {isPlaying ? <Play className="w-4 h-4 fill-white" /> : ep.episodeNumber}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center space-x-2">
                    <h4
                      className={`text-xs font-semibold truncate ${
                        isPlaying ? 'text-red-400' : 'text-zinc-200 group-hover:text-white'
                      }`}
                      aria-label={ep.fileName}
                    >
                      {ep.fileName}
                    </h4>
                  </div>

                  <div className="flex items-center space-x-2 mt-1 text-[11px] text-zinc-500">
                    <span>{formatFileSize(ep.size)}</span>
                    {ep.hasExternalSrt && (
                      <>
                        <span>•</span>
                        <span className="text-emerald-400 flex items-center space-x-0.5">
                          <Subtitles className="w-3 h-3" />
                          <span>SRT</span>
                        </span>
                      </>
                    )}
                    {progress && progress.currentTime > 0 && (
                      <>
                        <span>•</span>
                        <span className="font-mono text-zinc-400">
                          {formatTime(progress.currentTime)}
                        </span>
                      </>
                    )}
                  </div>
                </div>

                {/* Completed status check */}
                {progress?.completed && (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
