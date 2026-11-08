import React, { useState, useEffect, useMemo } from 'react';
import { Play, Subtitles, CheckCircle2, ArrowDownToLine, Check } from 'lucide-react';
import { Episode, PlaybackProgress } from '../../types';
import { formatTime, formatFileSize, cleanEpisodeTitle, formatEpisodeDisplayTitle } from '../../utils/format';
import { showGlobalToast } from '../Toast';

interface EpisodeCardProps {
  episode: Episode;
  progress?: PlaybackProgress;
  onPlay: (episode: Episode) => void;
}

export const EpisodeCard: React.FC<EpisodeCardProps> = ({ episode, progress, onPlay }) => {
  const [imgError, setImgError] = useState(false);
  const [activeImgUrl, setActiveImgUrl] = useState(episode.thumbnailUrl || episode.kitsuThumbnail);
  const [retryCount, setRetryCount] = useState(0);
  const parsed = useMemo(() => cleanEpisodeTitle(episode.fileName), [episode.fileName]);

  useEffect(() => {
    setActiveImgUrl(episode.thumbnailUrl || episode.kitsuThumbnail);
    setImgError(false);
    setRetryCount(0);
  }, [episode.kitsuThumbnail, episode.thumbnailUrl]);

  const handleImgError = () => {
    if (activeImgUrl === episode.thumbnailUrl && episode.kitsuThumbnail) {
      // If the local frame is unavailable, use the episode still from metadata.
      setActiveImgUrl(episode.kitsuThumbnail);
    } else if (activeImgUrl === episode.thumbnailUrl && retryCount < 3 && episode.thumbnailUrl) {
      // If local thumbnail was queued or in extraction, retry
      setTimeout(() => {
        setRetryCount((c) => c + 1);
        setActiveImgUrl(`${episode.thumbnailUrl}&retry=${Date.now()}`);
      }, 1000);
    } else {
      setImgError(true);
    }
  };

  const percentWatched = progress && progress.duration > 0
    ? Math.min(100, Math.round((progress.currentTime / progress.duration) * 100))
    : 0;

  const fullDisplayTitle = useMemo(
    () => formatEpisodeDisplayTitle(parsed.displayTitle, episode.kitsuTitle || episode.episodeTitle),
    [parsed.displayTitle, episode.kitsuTitle, episode.episodeTitle]
  );

  const handleClick = () => {
    if (episode.isDownloading) {
      showGlobalToast(
        'This episode is currently downloading in your torrent client and cannot be played yet.',
        'warning'
      );
      return;
    }
    onPlay(episode);
  };

  return (
    <div
      onClick={handleClick}
      className={`group relative bg-[#18181c] rounded-xl overflow-hidden border transition-all duration-200 flex flex-col shadow-sm ${
        episode.isDownloading
          ? 'border-amber-500/20 hover:border-amber-500/40 cursor-not-allowed opacity-90'
          : 'hover:bg-[#202026] border-zinc-800/80 hover:border-zinc-700 cursor-pointer hover:shadow-xl hover:shadow-black/40 hover:-translate-y-0.5'
      }`}
    >
      {/* Thumbnail Aspect Container (16:9) */}
      <div className="relative aspect-video w-full bg-zinc-950 overflow-hidden">
        {!imgError && activeImgUrl ? (
          <img
            src={activeImgUrl}
            alt=""
            onError={handleImgError}
            className={`w-full h-full object-cover transition-transform duration-300 ${
              episode.isDownloading
                ? 'blur-md scale-110 opacity-35'
                : 'group-hover:scale-105 opacity-100'
            }`}
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-br from-zinc-900 to-zinc-950 p-4 text-center">
            <span className="text-2xl font-bold tracking-wider text-zinc-700 group-hover:text-zinc-500 transition-colors">
              {episode.episodeNumber}
            </span>
          </div>
        )}

        {/* If downloading, render centered downloading overlay - preserved on hover without jitter */}
        {episode.isDownloading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/50 group-hover:bg-black/65 backdrop-blur-[2px] p-4 text-center select-none z-10 transition-colors duration-200">
            <ArrowDownToLine className="w-6 h-6 text-amber-400 animate-pulse mb-1" />
            <span className="text-xs font-bold text-amber-300">
              {episode.downloadProgress !== undefined ? `Downloading ${episode.downloadProgress}%` : 'Downloading...'}
            </span>
            <span className="text-[10px] text-zinc-300 font-mono mt-0.5">
              {episode.size > 0 ? (
                episode.downloadProgress !== undefined
                  ? `${formatFileSize(Math.round((episode.size * episode.downloadProgress) / 100))} / ${formatFileSize(episode.size)}`
                  : formatFileSize(episode.size)
              ) : 'Incomplete'}
            </span>
          </div>
        )}

        {/* Hover Overlay (for playable episodes) */}
        {!episode.isDownloading && (
          <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center backdrop-blur-[1px]">
            <div className="w-12 h-12 rounded-full bg-red-600/90 text-white flex items-center justify-center shadow-lg shadow-red-600/50 transform group-hover:scale-110 transition-transform">
              <Play className="w-6 h-6 ml-1 fill-white" />
            </div>
          </div>
        )}

        {/* Watched Indicator (Top-Right of Thumb) */}
        {progress?.completed && !episode.isDownloading && (
          <div
            title="Watched"
            className="absolute top-2 right-2 z-20 flex h-6 w-6 items-center justify-center rounded-full bg-emerald-600/95 text-white shadow-md border border-emerald-300/40 backdrop-blur-sm"
          >
            <Check className="w-3.5 h-3.5" />
          </div>
        )}

        {/* Bottom Progress Bar if watched */}
        {progress && progress.currentTime > 0 && !episode.isDownloading && (
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
            title={fullDisplayTitle}
          >
            {fullDisplayTitle}
          </h4>
        </div>

        <div className="mt-2.5 flex items-center justify-between text-[11px]">
          {/* Subtitle Indicator (Lower-Left under Episode) */}
          <div>
            {episode.hasEmbeddedDubtitles ? (
              <span
                title="Embedded English Dubtitles (SDH) detected"
                className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-purple-500/25 text-purple-300 border border-purple-500/40"
              >
                <Subtitles className="w-3 h-3 text-purple-400" />
                <span>Dub Sub</span>
              </span>
            ) : episode.hasWhisperSrt ? (
              <span
                title="Whisper AI Subtitle Ready (.whisper.srt)"
                className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-indigo-500/25 text-indigo-300 border border-indigo-500/40"
              >
                <Subtitles className="w-3 h-3 text-indigo-400" />
                <span>AI Sub</span>
              </span>
            ) : episode.hasExternalSrt ? (
              <span
                title="External Subtitle Ready (.srt)"
                className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-500/20 text-blue-300 border border-blue-500/40"
              >
                <Subtitles className="w-3 h-3 text-blue-400" />
                <span>Ext Sub</span>
              </span>
            ) : episode.hasEmbeddedSubtitles ? (
              <span
                title="Embedded English Subtitles detected"
                className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
              >
                <Subtitles className="w-3 h-3 text-emerald-400" />
                <span>Sub</span>
              </span>
            ) : (
              <span
                title="No English Subtitles found"
                className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-zinc-800/90 text-zinc-400 border border-zinc-700/60"
              >
                <Subtitles className="w-3 h-3 text-zinc-500" />
                <span>No Sub</span>
              </span>
            )}
          </div>

          {/* Watch Progress / Timestamp (Lower-Right) */}
          <div className="text-zinc-400">
            {progress && progress.currentTime > 0 ? (
              <span className="flex items-center space-x-1 font-mono text-zinc-300">
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
              <span className="text-zinc-500 font-mono">
                {episode.duration && episode.duration > 0 ? formatTime(episode.duration) : 'Unwatched'}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
