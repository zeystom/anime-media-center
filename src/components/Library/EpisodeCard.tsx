import React, { useState, useMemo } from 'react';
import { Play, Subtitles, CheckCircle2 } from 'lucide-react';
import { Episode, PlaybackProgress } from '../../types';
import { formatTime, cleanEpisodeTitle } from '../../utils/format';

interface EpisodeCardProps {
  episode: Episode;
  progress?: PlaybackProgress;
  onPlay: (episode: Episode) => void;
}

export const EpisodeCard: React.FC<EpisodeCardProps> = ({ episode, progress, onPlay }) => {
  const [imgError, setImgError] = useState(false);
  const parsed = useMemo(() => cleanEpisodeTitle(episode.fileName), [episode.fileName]);

  const percentWatched = progress && progress.duration > 0
    ? Math.min(100, Math.round((progress.currentTime / progress.duration) * 100))
    : 0;

  return (
    <div
      onClick={() => onPlay(episode)}
      className="group relative bg-[#18181c] hover:bg-[#202026] rounded-xl overflow-hidden border border-zinc-800/80 hover:border-zinc-700 transition-all duration-200 cursor-pointer flex flex-col shadow-sm hover:shadow-xl hover:shadow-black/40 hover:-translate-y-0.5"
    >
      {/* Thumbnail Aspect Container (16:9) */}
      <div className="relative aspect-video w-full bg-zinc-950 overflow-hidden">
        {!imgError && episode.thumbnailUrl ? (
          <img
            src={episode.thumbnailUrl}
            alt={episode.title}
            onError={() => setImgError(true)}
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-br from-zinc-900 to-zinc-950 p-4 text-center">
            <span className="text-2xl font-bold tracking-wider text-zinc-700 group-hover:text-zinc-500 transition-colors">
              {episode.episodeNumber}
            </span>
          </div>
        )}

        {/* Hover Dark Overlay with Play Icon */}
        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center backdrop-blur-[1px]">
          <div className="w-12 h-12 rounded-full bg-red-600/90 text-white flex items-center justify-center shadow-lg shadow-red-600/50 transform group-hover:scale-110 transition-transform">
            <Play className="w-6 h-6 ml-1 fill-white" />
          </div>
        </div>

        {/* Subtle Indicator for External SRT or Embedded Dubtitles */}
        {(episode.hasExternalSrt || episode.hasEmbeddedDubtitles) && (
          <div className="absolute top-2 right-2 flex items-center space-x-1">
            {episode.hasExternalSrt ? (
              <span
                title="Whisper External Subtitle Ready (.srt)"
                className="flex items-center space-x-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/25 text-emerald-300 border border-emerald-500/40 backdrop-blur-md"
              >
                <Subtitles className="w-3 h-3" />
                <span>SRT Ready</span>
              </span>
            ) : (
              <span
                title="Embedded English Dubtitles (SDH) detected"
                className="flex items-center space-x-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-purple-500/25 text-purple-300 border border-purple-500/40 backdrop-blur-md"
              >
                <Subtitles className="w-3 h-3 text-purple-400" />
                <span>Dub Sub</span>
              </span>
            )}
          </div>
        )}

        {/* Bottom Progress Bar if watched */}
        {progress && progress.currentTime > 0 && (
          <div className="absolute bottom-0 left-0 right-0 h-1.5 bg-zinc-800/80">
            <div
              className={`h-full ${progress.completed ? 'bg-emerald-500' : 'bg-red-600'}`}
              style={{ width: `${percentWatched}%` }}
            />
          </div>
        )}
      </div>

      {/* Episode Metadata */}
      <div className="p-3 flex-1 flex flex-col justify-between">
        <div>
          <h4
            className="text-xs font-semibold text-zinc-100 line-clamp-1 group-hover:text-red-400 transition-colors"
            title={episode.fileName}
          >
            {parsed.displayTitle}
          </h4>
        </div>

        <div className="mt-2.5 flex items-center justify-between text-[11px] text-zinc-400">
          {progress && progress.currentTime > 0 ? (
            <span className="flex items-center space-x-1 font-mono text-zinc-300 ml-auto">
              {progress.completed ? (
                <>
                  <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                  <span className="text-emerald-400 font-medium">Watched</span>
                </>
              ) : (
                <span>
                  {formatTime(progress.currentTime)} / {formatTime(progress.duration || episode.duration || 0)}
                </span>
              )}
            </span>
          ) : (
            <span className="text-zinc-500 ml-auto">
              {episode.duration && episode.duration > 0 ? formatTime(episode.duration) : 'Unwatched'}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
