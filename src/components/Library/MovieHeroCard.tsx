import React, { useState, useEffect } from 'react';
import {
  Play,
  Film,
  Sparkles,
  ExternalLink,
  Clock,
  HardDrive,
  Subtitles,
  ArrowDownToLine,
  CheckCircle2,
  RotateCcw,
} from 'lucide-react';
import { AnimeFolder, Episode, PlaybackProgress } from '../../types';
import {
  formatTime,
  formatFileSize,
  formatDurationFriendly,
  cleanSeriesTitle,
  cleanEpisodeTitle,
} from '../../utils/format';
import { showGlobalToast } from '../Toast';

interface MovieHeroCardProps {
  folder: AnimeFolder;
  episode: Episode;
  progress?: PlaybackProgress;
  releaseTags: string[];
  onPlay: (episode: Episode) => void;
  onOpenWhisper: (folder: AnimeFolder) => void;
  onOpenInExplorer: (folderPath: string) => void;
}

export const MovieHeroCard: React.FC<MovieHeroCardProps> = ({
  folder,
  episode,
  progress,
  releaseTags,
  onPlay,
  onOpenWhisper,
  onOpenInExplorer,
}) => {
  const [imgError, setImgError] = useState(false);

  // Broadcast movie hero presence so HeroContinueWatching can deduplicate smoothly
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent('movie-hero-active-change', {
        detail: { folderPath: folder.folderPath, filePath: episode.filePath },
      })
    );
    return () => {
      window.dispatchEvent(
        new CustomEvent('movie-hero-active-change', {
          detail: null,
        })
      );
    };
  }, [folder.folderPath, episode.filePath]);

  const displayTitle =
    folder.canonicalTitle || cleanSeriesTitle(folder.folderName) || episode.title || folder.folderName;

  const parsedEp = cleanEpisodeTitle(episode.fileName);

  // Preferred preview image: Kitsu thumbnail -> Folder banner -> Episode thumb -> Poster
  const previewImg =
    episode.kitsuThumbnail ||
    folder.bannerUrl ||
    episode.thumbnailUrl ||
    folder.posterUrl;

  const durationSec = episode.duration || progress?.duration;
  const friendlyDuration = formatDurationFriendly(durationSec);

  const percentWatched =
    progress && progress.duration && progress.duration > 0
      ? Math.min(100, Math.round((progress.currentTime / progress.duration) * 100))
      : 0;

  const isPartiallyWatched = progress && progress.currentTime > 60 && !progress.completed;
  const isCompleted = progress && progress.completed;
  const isDownloading = Boolean(episode.isDownloading || folder.isDownloading);
  const downloadProgress = episode.downloadProgress ?? folder.downloadProgress;

  const handlePlayClick = () => {
    if (isDownloading) {
      showGlobalToast(
        'This movie is currently downloading in your torrent client and cannot be played yet.',
        'warning'
      );
      return;
    }
    onPlay(episode);
  };

  return (
    <div
      data-movie-hero-card="true"
      data-folder-path={folder.folderPath}
      className="relative rounded-2xl overflow-hidden border border-white/10 bg-gradient-to-br from-[#16161b] via-[#121216] to-[#0d0d10] p-5 sm:p-7 shadow-2xl backdrop-blur-md"
    >
      {/* Ambient background glow if preview image is available */}
      {previewImg && !imgError && (
        <>
          <img
            src={previewImg}
            alt=""
            className="absolute inset-0 w-full h-full object-cover blur-3xl opacity-15 scale-125 pointer-events-none"
          />
          <div className="absolute inset-0 bg-gradient-to-r from-[#121216]/95 via-[#121216]/80 to-transparent pointer-events-none" />
        </>
      )}

      <div className="relative z-10 flex flex-col lg:flex-row items-stretch gap-6">
        {/* Left Column: 16:9 Cinematic Video Preview Frame */}
        <div
          onClick={handlePlayClick}
          className={`group relative shrink-0 w-full lg:w-[440px] xl:w-[480px] aspect-video rounded-xl overflow-hidden bg-zinc-950 border transition-all duration-300 select-none ${
            isDownloading
              ? 'border-amber-500/30 cursor-not-allowed'
              : 'border-white/10 hover:border-red-500/50 cursor-pointer shadow-xl hover:shadow-red-600/10'
          }`}
        >
          {/* Base Preview Image (Found via API, heavily blurred when downloading) */}
          {previewImg && !imgError ? (
            <img
              src={previewImg}
              alt={displayTitle}
              onError={() => setImgError(true)}
              className={`w-full h-full object-cover transition-all duration-500 ${
                isDownloading
                  ? 'blur-xl scale-110 opacity-35'
                  : 'group-hover:scale-105 opacity-100'
              }`}
            />
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-br from-zinc-900 to-zinc-950 p-6 text-center">
              <Film className="w-12 h-12 text-zinc-700 mb-2" />
              <span className="text-sm font-bold text-zinc-500">{displayTitle}</span>
            </div>
          )}

          {/* Vignette Gradients */}
          <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/40 to-black/30 pointer-events-none" />

          {/* Top Left: Movie Badge */}
          <div className="absolute top-3 left-3 flex items-center space-x-1.5 z-10 pointer-events-none">
            <span className="px-2.5 py-1 rounded-md text-[11px] font-black uppercase tracking-wider bg-red-600 text-white shadow-lg flex items-center space-x-1">
              <Film className="w-3 h-3" />
              <span>Movie</span>
            </span>
          </div>

          {/* Top Right: Technical Quality Tags */}
          <div className="absolute top-3 right-3 flex items-center space-x-1 z-10 pointer-events-none">
            {releaseTags.slice(0, 2).map((tag) => (
              <span
                key={tag}
                className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-black/80 text-zinc-200 border border-white/20 backdrop-blur-md"
              >
                {tag}
              </span>
            ))}
          </div>

          {/* Center Overlay: Downloading State vs Normal Play Button */}
          {isDownloading ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center z-10 pointer-events-none">
              <div className="w-14 h-14 rounded-2xl bg-amber-500/20 border border-amber-500/40 backdrop-blur-md flex items-center justify-center mb-3 shadow-xl shadow-amber-500/10">
                <ArrowDownToLine className="w-7 h-7 text-amber-400 animate-pulse" />
              </div>
              <span className="text-sm font-bold text-white tracking-wide drop-shadow-md">
                {downloadProgress !== undefined ? `Downloading (${downloadProgress}%)...` : 'Downloading in Progress...'}
              </span>
              <span className="text-xs text-zinc-300 font-mono mt-1 drop-shadow-sm">
                {episode.size > 0 ? (
                  downloadProgress !== undefined
                    ? `${formatFileSize(Math.round((episode.size * downloadProgress) / 100))} / ${formatFileSize(episode.size)}`
                    : formatFileSize(episode.size)
                ) : 'Incomplete torrent'}
              </span>
              {downloadProgress !== undefined && (
                <div className="w-40 h-1.5 bg-white/20 rounded-full mt-2.5 overflow-hidden backdrop-blur-sm">
                  <div
                    className="h-full bg-gradient-to-r from-amber-500 to-amber-400 transition-all duration-300 rounded-full"
                    style={{ width: `${downloadProgress}%` }}
                  />
                </div>
              )}
            </div>
          ) : (
            <div className="absolute inset-0 flex items-center justify-center bg-black/30 group-hover:bg-black/50 transition-colors backdrop-blur-[0.5px]">
              <div className="w-16 h-16 rounded-full bg-red-600/90 text-white flex items-center justify-center shadow-xl shadow-red-600/40 transform group-hover:scale-110 transition-transform">
                {isCompleted ? (
                  <RotateCcw className="w-7 h-7" />
                ) : (
                  <Play className="w-7 h-7 ml-1 fill-white" />
                )}
              </div>
            </div>
          )}

          {/* Bottom Progress Bar if watched */}
          {progress && progress.currentTime > 0 && !isDownloading && (
            <div className="absolute bottom-0 left-0 right-0 h-1.5 bg-zinc-800/90">
              <div
                className={`h-full ${isCompleted ? 'bg-emerald-500' : 'bg-red-600'}`}
                style={{ width: `${percentWatched}%` }}
              />
            </div>
          )}
        </div>

        {/* Right Column: Movie Info & Actions */}
        <div className="flex-1 flex flex-col justify-between space-y-4">
          <div className="space-y-3">
            {/* Badges Row: Subtitles, Duration & Size */}
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {/* Subtitle Badge */}
              {episode.hasEmbeddedDubtitles ? (
                <span
                  title="Embedded English Dubtitles (SDH) detected"
                  className="inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-purple-600/20 text-purple-300 border border-purple-500/30"
                >
                  <Subtitles className="w-3.5 h-3.5 text-purple-400" />
                  <span>Dub Sub</span>
                </span>
              ) : episode.hasWhisperSrt ? (
                <span
                  title="Synced English subtitles generated by Whisper Studio"
                  className="inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-indigo-600/20 text-indigo-300 border border-indigo-500/30"
                >
                  <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
                  <span>AI Sub</span>
                </span>
              ) : episode.hasExternalSrt ? (
                <span
                  title="External English subtitles present"
                  className="inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-blue-600/20 text-blue-300 border border-blue-500/30"
                >
                  <Subtitles className="w-3.5 h-3.5 text-blue-400" />
                  <span>Ext Sub</span>
                </span>
              ) : episode.hasEmbeddedSubtitles || folder.hasEmbeddedSubtitles ? (
                <span
                  title="Embedded English subtitles detected"
                  className="inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-emerald-600/20 text-emerald-300 border border-emerald-500/30"
                >
                  <Subtitles className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Sub</span>
                </span>
              ) : (
                <span
                  title="No English subtitles found"
                  className="inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-zinc-800 text-zinc-400 border border-zinc-700/60"
                >
                  <Subtitles className="w-3.5 h-3.5 text-zinc-500" />
                  <span>No Sub</span>
                </span>
              )}

              {/* Friendly Duration */}
              {friendlyDuration && (
                <span className="inline-flex items-center space-x-1 px-2.5 py-1 rounded-md text-xs font-medium bg-zinc-800/80 text-zinc-300 border border-zinc-700/60">
                  <Clock className="w-3.5 h-3.5 text-zinc-400" />
                  <span>{friendlyDuration}</span>
                </span>
              )}

              {/* File Size */}
              {episode.size > 0 && (
                <span className="inline-flex items-center space-x-1 px-2.5 py-1 rounded-md text-xs font-mono bg-zinc-800/80 text-zinc-300 border border-zinc-700/60">
                  <HardDrive className="w-3.5 h-3.5 text-zinc-400" />
                  <span>{formatFileSize(episode.size)}</span>
                </span>
              )}

              {/* Watched Progress Badge */}
              {isCompleted && (
                <span className="inline-flex items-center space-x-1 px-2.5 py-1 rounded-md text-xs font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Watched</span>
                </span>
              )}
            </div>

            {/* Movie Title */}
            <div>
              <h3 className="text-xl sm:text-2xl font-black text-white tracking-tight">
                {displayTitle}
              </h3>
              <p className="text-xs text-zinc-400 font-mono mt-1 truncate" title={episode.fileName}>
                {episode.fileName}
              </p>
            </div>

            {/* Synopsis / Description */}
            {folder.synopsis && (
              <p className="text-xs text-zinc-300 leading-relaxed line-clamp-3 max-w-2xl">
                {folder.synopsis}
              </p>
            )}

            {/* Genres */}
            {folder.genres && folder.genres.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                {folder.genres.map((g) => (
                  <span
                    key={g}
                    className="px-2.5 py-0.5 rounded text-[11px] font-medium bg-white/5 text-zinc-300 border border-white/10"
                  >
                    {g}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Action Buttons Row */}
          <div className="pt-2 flex flex-wrap items-center gap-3">
            {/* Primary Watch Movie Button */}
            <button
              onClick={handlePlayClick}
              disabled={isDownloading}
              className={`flex items-center space-x-2.5 px-6 py-3 rounded-xl font-bold text-sm transition-all shadow-lg select-none ${
                isDownloading
                  ? 'bg-zinc-800 text-zinc-500 border border-zinc-700/40 cursor-not-allowed opacity-60'
                  : 'bg-gradient-to-r from-red-600 to-red-500 hover:from-red-500 hover:to-red-400 text-white shadow-red-600/30 hover:shadow-red-600/50 hover:scale-[1.02] active:scale-[0.98]'
              }`}
            >
              {isDownloading ? (
                <>
                  <ArrowDownToLine className="w-4 h-4 text-amber-400 animate-pulse" />
                  <span>
                    {downloadProgress !== undefined
                      ? `Downloading (${downloadProgress}%)...`
                      : 'Downloading in Progress...'}
                  </span>
                </>
              ) : isCompleted ? (
                <>
                  <RotateCcw className="w-4 h-4" />
                  <span>Play Again</span>
                </>
              ) : isPartiallyWatched ? (
                <>
                  <Play className="w-4 h-4 fill-white" />
                  <span>Resume from {formatTime(progress?.currentTime || 0)}</span>
                </>
              ) : (
                <>
                  <Play className="w-4 h-4 fill-white" />
                  <span>Watch Movie</span>
                </>
              )}
            </button>

            {/* Whisper Subtitles Button for Movie */}
            <button
              onClick={() => onOpenWhisper(folder)}
              disabled={isDownloading}
              className={`flex items-center space-x-2 px-4 py-3 rounded-xl border text-xs font-bold transition-all shadow-sm select-none ${
                isDownloading
                  ? 'bg-zinc-800/40 text-zinc-500 border-zinc-700/40 cursor-not-allowed opacity-60'
                  : 'bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border-indigo-500/40 hover:scale-[1.02] active:scale-[0.98]'
              }`}
              title="Transcribe English subtitles for this movie with offline Whisper"
            >
              <Sparkles className="w-4 h-4 text-indigo-400" />
              <span>
                {episode.hasWhisperSrt ? 'Regenerate Whisper' : 'Whisper Subtitles'}
              </span>
            </button>

            {/* Open Folder in Explorer Button */}
            <button
              onClick={() => onOpenInExplorer(folder.folderPath)}
              className="p-3 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700/60 transition-colors shadow-sm"
              title="Open Folder in Windows Explorer"
            >
              <ExternalLink className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
