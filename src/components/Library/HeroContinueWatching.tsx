import React from 'react';
import { Play, Clock, Sparkles } from 'lucide-react';
import { Episode, PlaybackProgress } from '../../types';
import { formatTime } from '../../utils/format';

interface HeroContinueWatchingProps {
  lastWatched: PlaybackProgress;
  episode: Episode;
  seasonName: string;
  onResume: (episode: Episode, startTime: number) => void;
}

export const HeroContinueWatching: React.FC<HeroContinueWatchingProps> = ({
  lastWatched,
  episode,
  seasonName,
  onResume,
}) => {
  const percent = lastWatched.duration > 0
    ? Math.min(100, Math.round((lastWatched.currentTime / lastWatched.duration) * 100))
    : 0;

  return (
    <div className="relative w-full rounded-2xl overflow-hidden mb-8 border border-zinc-800 bg-gradient-to-r from-zinc-950 via-[#181820] to-[#121218] p-6 md:p-8 shadow-2xl">
      {/* Background Glow Accents */}
      <div className="absolute top-0 right-0 -mr-20 -mt-20 w-96 h-96 bg-red-600/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-0 left-1/3 -mb-20 w-80 h-80 bg-indigo-600/10 rounded-full blur-3xl pointer-events-none" />

      <div className="relative z-10 flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
        <div className="max-w-2xl space-y-3">
          <div className="flex items-center space-x-2">
            <span className="flex items-center space-x-1.5 px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wider bg-red-500/20 text-red-400 border border-red-500/30">
              <Sparkles className="w-3.5 h-3.5 text-red-400" />
              <span>Continue Watching</span>
            </span>
            <span className="text-zinc-400 text-xs font-semibold px-2 py-0.5 rounded bg-zinc-800 border border-zinc-700/50">
              {lastWatched.episodeNumber}
            </span>
          </div>

          <div>
            <h2 className="text-2xl md:text-3xl font-extrabold text-white tracking-tight line-clamp-1">
              {seasonName}
            </h2>
            <p className="text-sm text-zinc-400 line-clamp-1 mt-1 font-medium">
              {lastWatched.fileName}
            </p>
          </div>

          {/* Time & Progress */}
          <div className="space-y-1.5 pt-2 max-w-md">
            <div className="flex items-center justify-between text-xs text-zinc-400 font-mono">
              <span className="flex items-center space-x-1">
                <Clock className="w-3.5 h-3.5 text-zinc-500" />
                <span>{formatTime(lastWatched.currentTime)}</span>
              </span>
              <span>{formatTime(lastWatched.duration)} ({percent}%)</span>
            </div>
            <div className="w-full h-2 rounded-full bg-zinc-800/80 overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-red-600 to-indigo-500 rounded-full transition-all duration-300"
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>
        </div>

        {/* Action Button */}
        <div className="flex items-center space-x-3 w-full md:w-auto">
          <button
            onClick={() => onResume(episode, lastWatched.currentTime)}
            className="w-full md:w-auto flex items-center justify-center space-x-3 px-8 py-3.5 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold text-base shadow-lg shadow-red-600/30 hover:shadow-red-600/50 transition-all hover:scale-[1.02] active:scale-[0.98]"
          >
            <Play className="w-5 h-5 fill-white" />
            <span>Resume from {formatTime(lastWatched.currentTime)}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
