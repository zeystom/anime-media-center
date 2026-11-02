import React, { useState, useMemo } from 'react';
import { Play, Subtitles, CheckCircle2 } from 'lucide-react';
import { Episode, PlaybackProgress } from '../../types';
import { formatTime, formatFileSize, cleanEpisodeTitle } from '../../utils/format';

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

        {/* Top Badges */}
        <div className="absolute top-2 left-2 flex items-center space-x-1.5">
          <span className="px-2 py-0.5 rounded text-xs font-bold bg-black/75 backdrop-blur-md text-white border border-white/10">
            {parsed.episodeLabel || episode.episodeNumber}
          </span>
        </div>

        <div className="absolute top-2 right-2 flex items-center space-x-1">
          {episode.hasExternalSrt ? (
            <span
              title="Whisper External Subtitle Ready (.srt)"
              className="flex items-center space-x-1 px-1.5 py-0.5 rounded text-[11px] font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 backdrop-blur-md"
            >
              <Subtitles className="w-3 h-3" />
              <span>SRT Ready</span>
            </span>
          ) : episode.hasEmbeddedDubtitles ? (
            <span
              title="Embedded English Dubtitles (SDH) detected inside MKV"
              className="flex items-center space-x-1 px-1.5 py-0.5 rounded text-[11px] font-semibold bg-purple-500/25 text-purple-300 border border-purple-500/50 backdrop-blur-md shadow-sm shadow-purple-500/20"
            >
              <Subtitles className="w-3 h-3 text-purple-400" />
              <span>Dub Sub</span>
            </span>
          ) : (
            <span
              title="No external SRT found (uses embedded audio/subtitles)"
              className="px-1.5 py-0.5 rounded text-[11px] font-medium bg-zinc-800/80 text-zinc-400 border border-zinc-700/50 backdrop-blur-md"
            >
              MKV Internal
            </span>
          )}
        </div>

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

          {parsed.tags.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 mt-1.5">
              {parsed.tags.slice(0, 3).map((tag) => (
                <span
                  key={tag}
                  className="px-1.5 py-0.2 rounded text-[10px] font-mono font-medium bg-zinc-800 text-zinc-300 border border-white/5"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="mt-2.5 flex items-center justify-between text-[11px] text-zinc-400">
          <span>{formatFileSize(episode.size)}</span>
          {progress && progress.currentTime > 0 ? (
            <span className="flex items-center space-x-1 font-mono text-zinc-300">
              {progress.completed ? (
                <>
                  <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                  <span className="text-emerald-400">Finished</span>
                </>
              ) : (
                <span>
                  {formatTime(progress.currentTime)} / {formatTime(progress.duration)}
                </span>
              )}
            </span>
          ) : (
            <span className="text-zinc-500">Unwatched</span>
          )}
        </div>
      </div>
    </div>
  );
};
