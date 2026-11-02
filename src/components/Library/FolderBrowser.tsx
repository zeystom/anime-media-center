import React, { useMemo } from 'react';
import { Folder, RefreshCw, ExternalLink, Sparkles, Film } from 'lucide-react';
import { AnimeFolder, Episode, PlaybackProgress } from '../../types';
import { cleanSeriesTitle, extractReleaseTags } from '../../utils/format';
import { EpisodeCard } from './EpisodeCard';

interface FolderBrowserProps {
  libraryRoot?: string;
  folders: AnimeFolder[];
  selectedFolder: AnimeFolder | null;
  history: Record<string, PlaybackProgress>;
  loading: boolean;
  onSelectFolder: (folder: AnimeFolder) => void;
  onChangeRoot?: () => void;
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
  const releaseTags = useMemo(() => {
    if (!selectedFolder) return [];
    const combined = `${selectedFolder.folderName} ${selectedFolder.episodes[0]?.fileName || ''}`;
    return extractReleaseTags(combined);
  }, [selectedFolder]);

  return (
    <div className="space-y-6">
      {/* Anime Folder Tabs / Selector */}
      {folders.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center space-x-2.5">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-400">
              Anime Seasons ({folders.length})
            </h3>
            <button
              onClick={onRefresh}
              disabled={loading}
              className="p-1 rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors disabled:opacity-50"
              title="Refresh Seasons"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
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
              <div className="flex flex-wrap items-center gap-2.5">
                <h2 className="text-xl font-bold text-white tracking-tight" title={selectedFolder.folderName}>
                  {cleanSeriesTitle(selectedFolder.folderName) || selectedFolder.folderName}
                </h2>
                {releaseTags.length > 0 && (
                  <div className="flex items-center gap-1.5">
                    {releaseTags.map((tag) => (
                      <span
                        key={tag}
                        className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-zinc-800/90 text-zinc-300 border border-zinc-700/60"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
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
