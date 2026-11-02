import React from 'react';
import { Folder, FolderOpen, RefreshCw, ExternalLink, Sparkles, Film, HardDrive } from 'lucide-react';
import { AnimeFolder, Episode, PlaybackProgress } from '../../types';
import { cleanSeriesTitle } from '../../utils/format';
import { EpisodeCard } from './EpisodeCard';

interface FolderBrowserProps {
  libraryRoot: string;
  folders: AnimeFolder[];
  selectedFolder: AnimeFolder | null;
  history: Record<string, PlaybackProgress>;
  loading: boolean;
  onSelectFolder: (folder: AnimeFolder) => void;
  onChangeRoot: () => void;
  onRefresh: () => void;
  onPlayEpisode: (episode: Episode) => void;
  onOpenWhisper: (folder: AnimeFolder) => void;
  onOpenInExplorer: (folderPath: string) => void;
}

export const FolderBrowser: React.FC<FolderBrowserProps> = ({
  libraryRoot,
  folders,
  selectedFolder,
  history,
  loading,
  onSelectFolder,
  onChangeRoot,
  onRefresh,
  onPlayEpisode,
  onOpenWhisper,
  onOpenInExplorer,
}) => {
  return (
    <div className="space-y-6">
      {/* Path Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-xl bg-[#141418] border border-zinc-800">
        <div className="flex items-center space-x-3 overflow-hidden">
          <div className="w-9 h-9 rounded-lg bg-zinc-800 flex items-center justify-center shrink-0 text-zinc-300">
            <HardDrive className="w-5 h-5 text-indigo-400" />
          </div>
          <div className="overflow-hidden">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 block">
              Library Directory
            </span>
            <span className="text-sm font-mono text-zinc-200 truncate block max-w-md md:max-w-xl" title={libraryRoot}>
              {libraryRoot}
            </span>
          </div>
        </div>

        <div className="flex items-center space-x-2">
          <button
            onClick={onChangeRoot}
            className="flex items-center space-x-2 px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium border border-zinc-700/60 transition-colors"
          >
            <FolderOpen className="w-4 h-4 text-zinc-400" />
            <span>Change Folder</span>
          </button>

          <button
            onClick={onRefresh}
            disabled={loading}
            className="p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700/60 transition-colors disabled:opacity-50"
            title="Scan Again"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Anime Folder Tabs / Selector */}
      {folders.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">
              Anime Seasons ({folders.length})
            </h3>
          </div>

          <div className="flex items-center space-x-2 overflow-x-auto pb-2 scrollbar-thin">
            {folders.map((folder) => {
              const isSelected = selectedFolder?.folderPath === folder.folderPath;
              return (
                <button
                  key={folder.folderPath}
                  onClick={() => onSelectFolder(folder)}
                  className={`flex items-center space-x-2.5 px-4 py-2.5 rounded-xl text-xs font-semibold shrink-0 transition-all border ${
                    isSelected
                      ? 'bg-zinc-800 text-white border-red-500/50 shadow-md shadow-red-500/10'
                      : 'bg-zinc-900/90 text-zinc-400 border-zinc-800 hover:bg-zinc-800/60 hover:text-zinc-200'
                  }`}
                >
                  <Folder className={`w-4 h-4 ${isSelected ? 'text-red-500' : 'text-zinc-500'}`} />
                  <span className="truncate max-w-[220px]" title={folder.folderName}>
                    {cleanSeriesTitle(folder.folderName) || folder.folderName}
                  </span>
                  {folder.hasEmbeddedDubtitles && (
                    <span
                      title="Embedded English Dubtitles (SDH) available"
                      className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-purple-500/20 text-purple-300 border border-purple-500/40"
                    >
                      Dub Sub
                    </span>
                  )}
                  <span className="px-1.5 py-0.5 rounded text-[10px] bg-zinc-950/80 text-zinc-400">
                    {folder.episodes.length}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Selected Folder Header & Actions */}
      {selectedFolder ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4 pb-2 border-b border-zinc-800/80">
            <div>
              <h2 className="text-xl font-bold text-white tracking-tight flex items-center space-x-2" title={selectedFolder.folderName}>
                <span>{cleanSeriesTitle(selectedFolder.folderName) || selectedFolder.folderName}</span>
              </h2>
              <p className="text-xs text-zinc-400 mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>{selectedFolder.episodes.length} Episodes found</span>
                <span>•</span>
                {selectedFolder.hasEmbeddedDubtitles && (
                  <>
                    <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded bg-purple-500/15 border border-purple-500/30 text-purple-300 font-semibold">
                      <Sparkles className="w-3 h-3 text-purple-400" />
                      <span>Dubtitles / SDH Embedded</span>
                    </span>
                    <span>•</span>
                  </>
                )}
                <span className="text-emerald-400 font-semibold">
                  {selectedFolder.hasSubtitlesCount} / {selectedFolder.totalEpisodes} with External SRT
                </span>
              </p>
            </div>

            <div className="flex items-center space-x-2.5">
              <button
                onClick={() => onOpenWhisper(selectedFolder)}
                className="flex items-center space-x-2 px-3.5 py-2 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/40 text-xs font-semibold transition-all hover:scale-[1.02]"
              >
                <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
                <span>Whisper Batch Subtitles</span>
              </button>

              <button
                onClick={() => onOpenInExplorer(selectedFolder.folderPath)}
                className="p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700/60 text-xs transition-colors"
                title="Open Folder in Windows Explorer"
              >
                <ExternalLink className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Episode Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {selectedFolder.episodes.map((ep) => (
              <EpisodeCard
                key={ep.filePath}
                episode={ep}
                progress={history[ep.filePath]}
                onPlay={onPlayEpisode}
              />
            ))}
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-20 text-center rounded-2xl border border-dashed border-zinc-800 p-8">
          <Film className="w-12 h-12 text-zinc-600 mb-3" />
          <h3 className="text-base font-semibold text-zinc-300">No Anime Folders Found</h3>
          <p className="text-xs text-zinc-500 max-w-sm mt-1">
            Choose a directory containing `.mkv` files or anime season folders to populate your media center.
          </p>
          <button
            onClick={onChangeRoot}
            className="mt-4 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-semibold shadow-md transition-colors"
          >
            Select Media Folder
          </button>
        </div>
      )}
    </div>
  );
};
