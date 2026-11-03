import React, { useState, useMemo } from 'react';
import { RefreshCw, ExternalLink, Sparkles, Subtitles, Film, Search, Star, X, ArrowDownToLine } from 'lucide-react';
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
  const [searchQuery, setSearchQuery] = useState<string>('');

  const releaseTags = useMemo(() => {
    if (!selectedFolder) return [];
    const combined = `${selectedFolder.folderName} ${selectedFolder.episodes[0]?.fileName || ''}`;
    return extractReleaseTags(combined);
  }, [selectedFolder]);

  // Live real-time filter across folder titles, canonical API titles, and genres
  const filteredFolders = useMemo(() => {
    if (!searchQuery.trim()) return folders;
    const q = searchQuery.toLowerCase().trim();
    return folders.filter((f) => {
      const canonical = (f.canonicalTitle || '').toLowerCase();
      const cleaned = cleanSeriesTitle(f.folderName).toLowerCase();
      const raw = f.folderName.toLowerCase();
      const genresMatch = (f.genres || []).some((g) => g.toLowerCase().includes(q));
      return canonical.includes(q) || cleaned.includes(q) || raw.includes(q) || genresMatch;
    });
  }, [folders, searchQuery]);

  return (
    <div className="space-y-7">
      {/* Anime Collection Showcase Header & Search Bar */}
      {folders.length > 0 && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center space-x-3">
              <h3 className="text-sm font-extrabold uppercase tracking-wider text-zinc-300 flex items-center space-x-2">
                <Film className="w-4 h-4 text-red-500" />
                <span>Anime Collection</span>
                <span className="text-xs font-mono font-semibold px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400 border border-zinc-700/50">
                  {folders.length}
                </span>
              </h3>
              <button
                onClick={onRefresh}
                disabled={loading}
                className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors disabled:opacity-50"
                title="Refresh Library & Sync Metadata"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-red-400' : ''}`} />
              </button>
            </div>

            {/* Live Filter / Search Input */}
            <div className="relative min-w-[240px] sm:min-w-[300px]">
              <Search className="w-4 h-4 text-zinc-500 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search anime title or genre..."
                className="w-full pl-10 pr-9 py-2 rounded-xl bg-zinc-900/90 border border-white/10 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-red-500/60 focus:ring-1 focus:ring-red-500/30 transition-all shadow-inner"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors"
                  title="Clear search"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* Vertical 2:3 Anime Poster Cards Showcase */}
          <div className="flex items-stretch space-x-5 overflow-x-auto pt-2 pb-7 px-3 scrollbar-none sm:scrollbar-thin">
            {filteredFolders.map((folder) => {
              const isSelected = selectedFolder?.folderPath === folder.folderPath;
              const displayTitle =
                folder.canonicalTitle || cleanSeriesTitle(folder.folderName) || folder.folderName;

              // Primary: Official AniList 2:3 vertical poster!
              // Fallback: First episode's thumbnail/still capture!
              const posterSrc =
                folder.posterUrl ||
                folder.episodes[0]?.kitsuThumbnail ||
                folder.episodes[0]?.thumbnailUrl;

              return (
                <div
                  key={folder.folderPath}
                  onClick={() => onSelectFolder(folder)}
                  className="group relative shrink-0 w-36 sm:w-44 md:w-48 aspect-[2/3] cursor-pointer select-none transition-transform duration-300 ease-out hover:scale-[1.03] active:scale-[0.99]"
                >
                  {/* Soft Ambient Selection Glow (Permeates outside without being clipped) */}
                  <div
                    className={`absolute -inset-1 rounded-2xl bg-red-600/35 blur-md pointer-events-none transition-opacity duration-300 ${
                      isSelected ? 'opacity-100' : 'opacity-0'
                    }`}
                  />

                  {/* Inner Card Container with Guaranteed Chromium Border-Radius Clip */}
                  <div
                    className={`relative w-full h-full rounded-2xl overflow-hidden bg-zinc-950 border-2 transition-colors duration-200 ${
                      isSelected
                        ? 'border-red-500 shadow-[0_4px_16px_rgba(239,68,68,0.3)]'
                        : 'border-white/10 hover:border-white/30 shadow-lg shadow-black/50'
                    }`}
                    style={{
                      transform: 'translateZ(0)',
                      WebkitMaskImage: '-webkit-radial-gradient(white, black)',
                      backfaceVisibility: 'hidden',
                      isolation: 'isolate',
                    }}
                  >
                    {/* Poster Image with Subtle Depth Blur on Selected & Smooth Hover Zoom */}
                    {posterSrc ? (
                      <img
                        src={posterSrc}
                        alt={displayTitle}
                        className={`w-full h-full object-cover rounded-2xl transition-all duration-500 ease-out bg-zinc-950 group-hover:scale-105 ${
                          isSelected ? 'blur-[1.5px] scale-[1.02] opacity-90' : 'opacity-100'
                        }`}
                        style={{
                          transform: 'translateZ(0)',
                          backfaceVisibility: 'hidden',
                        }}
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-full h-full bg-gradient-to-br from-zinc-800 to-zinc-950 flex flex-col items-center justify-center p-4 text-center rounded-2xl">
                        <Film className="w-10 h-10 text-zinc-600 mb-2" />
                        <span className="text-xs font-bold text-zinc-300 line-clamp-2">{displayTitle}</span>
                      </div>
                    )}

                    {/* Vignette Gradients */}
                    <div className="absolute inset-0 bg-gradient-to-t from-black/95 via-black/35 to-black/20 group-hover:via-black/20 transition-all pointer-events-none" />

                    {/* Top Badges: Subtitle Status & Episode Count */}
                    <div className="absolute top-2.5 left-2.5 right-2.5 flex items-center justify-between pointer-events-none z-10">
                      {folder.isDownloading ? (
                        <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-amber-500/95 text-white backdrop-blur-md shadow-md border border-amber-400/40 flex items-center space-x-1">
                          <ArrowDownToLine className="w-3 h-3 animate-pulse" />
                          <span>Downloading</span>
                        </span>
                      ) : folder.hasEmbeddedDubtitles ? (
                        <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-purple-600/90 text-white backdrop-blur-md shadow-md border border-purple-400/30">
                          Dub Sub
                        </span>
                      ) : (folder.hasWhisperCount ?? 0) > 0 ? (
                        <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-indigo-600/90 text-white backdrop-blur-md shadow-md border border-indigo-400/30">
                          AI Sub
                        </span>
                      ) : (folder.hasExtSubCount ?? 0) > 0 || folder.hasSubtitlesCount > 0 ? (
                        <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-blue-600/90 text-white backdrop-blur-md shadow-md border border-blue-400/30">
                          Ext Sub
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-zinc-800/90 text-zinc-400 backdrop-blur-md border border-zinc-700/60">
                          No Sub
                        </span>
                      )}
                      <span className="px-2 py-0.5 rounded-md text-[10px] font-mono font-bold bg-black/80 text-zinc-200 border border-white/15 backdrop-blur-md">
                        {folder.episodes.length} EPS
                      </span>
                    </div>

                    {/* Bottom Text & Score - Razor sharp typography without blur */}
                    <div className="absolute bottom-0 left-0 right-0 p-3 pointer-events-none z-10 flex flex-col justify-end space-y-1">
                      {folder.averageScore && (
                        <div className="flex items-center space-x-1 text-amber-400 text-[10px] font-bold">
                          <Star className="w-3 h-3 fill-amber-400" />
                          <span>{(folder.averageScore / 10).toFixed(1)}</span>
                        </div>
                      )}
                      <h4
                        className="text-xs sm:text-sm font-extrabold text-white tracking-tight line-clamp-2 group-hover:text-red-400 transition-colors drop-shadow-sm"
                        title={displayTitle}
                      >
                        {displayTitle}
                      </h4>
                      <p className="text-[10px] text-zinc-400 truncate">
                        {folder.folderName}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {filteredFolders.length === 0 && searchQuery && (
            <div className="text-center py-8 text-xs text-zinc-500">
              No anime found matching <span className="text-zinc-300 font-semibold">"{searchQuery}"</span>
            </div>
          )}
        </div>
      )}

      {/* Selected Anime Details Header & Actions */}
      {selectedFolder ? (
        <div className="space-y-4 pt-1">
          <div className="relative rounded-2xl overflow-hidden border border-white/10 bg-zinc-900/60 p-5 md:p-6 shadow-xl backdrop-blur-sm">
            {/* Cinematic banner ambient background if bannerUrl exists */}
            {selectedFolder.bannerUrl && (
              <>
                <img
                  src={selectedFolder.bannerUrl}
                  alt=""
                  className="absolute inset-0 w-full h-full object-cover blur-2xl opacity-20 scale-110 pointer-events-none"
                />
                <div className="absolute inset-0 bg-gradient-to-r from-zinc-950 via-zinc-950/85 to-transparent pointer-events-none" />
              </>
            )}

            <div className="relative z-10 flex flex-wrap items-center justify-between gap-5">
              <div className="space-y-2 max-w-3xl">
                <div className="flex flex-wrap items-center gap-2.5">
                  <h2
                    className="text-xl sm:text-2xl font-black text-white tracking-tight"
                    title={selectedFolder.folderName}
                  >
                    {selectedFolder.canonicalTitle ||
                      cleanSeriesTitle(selectedFolder.folderName) ||
                      selectedFolder.folderName}
                  </h2>
                  {releaseTags.length > 0 && (
                    <div className="flex items-center gap-1.5">
                      {releaseTags.map((tag) => (
                        <span
                          key={tag}
                          className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-zinc-800 text-zinc-300 border border-zinc-700/60"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {selectedFolder.genres && selectedFolder.genres.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                    {selectedFolder.genres.map((g) => (
                      <span
                        key={g}
                        className="px-2 py-0.5 rounded text-[10px] font-medium bg-white/5 text-zinc-300 border border-white/10"
                      >
                        {g}
                      </span>
                    ))}
                  </div>
                )}

                {selectedFolder.synopsis && (
                  <p className="text-xs text-zinc-400 line-clamp-2 leading-relaxed pt-0.5 max-w-2xl">
                    {selectedFolder.synopsis}
                  </p>
                )}

                {(() => {
                  const badges: React.ReactNode[] = [];
                  if (selectedFolder.isDownloading) {
                    badges.push(
                      <span
                        key="downloading"
                        className="inline-flex items-center space-x-1.5 px-2 py-0.5 rounded bg-amber-500/15 border border-amber-500/30 text-amber-300 font-semibold"
                      >
                        <ArrowDownToLine className="w-3 h-3 text-amber-400 animate-pulse" />
                        <span>Downloading in Progress</span>
                      </span>
                    );
                  }
                  if (selectedFolder.hasEmbeddedDubtitles) {
                    badges.push(
                      <span
                        key="dub"
                        className="inline-flex items-center space-x-1 px-2 py-0.5 rounded bg-purple-500/15 border border-purple-500/30 text-purple-300 font-semibold"
                      >
                        <Subtitles className="w-3 h-3 text-purple-400" />
                        <span>Dub Sub Embedded</span>
                      </span>
                    );
                  }
                  if ((selectedFolder.hasWhisperCount ?? 0) > 0) {
                    badges.push(
                      <span
                        key="ai"
                        className="inline-flex items-center space-x-1 px-2 py-0.5 rounded bg-indigo-500/15 border border-indigo-500/30 text-indigo-300 font-semibold"
                      >
                        <Subtitles className="w-3 h-3 text-indigo-400" />
                        <span>
                          {selectedFolder.hasWhisperCount} / {selectedFolder.totalEpisodes} AI Sub
                        </span>
                      </span>
                    );
                  }
                  if ((selectedFolder.hasExtSubCount ?? 0) > 0) {
                    badges.push(
                      <span
                        key="ext"
                        className="inline-flex items-center space-x-1 px-2 py-0.5 rounded bg-blue-500/15 border border-blue-500/30 text-blue-300 font-semibold"
                      >
                        <Subtitles className="w-3 h-3 text-blue-400" />
                        <span>
                          {selectedFolder.hasExtSubCount} / {selectedFolder.totalEpisodes} Ext Sub
                        </span>
                      </span>
                    );
                  }
                  if (badges.length === 0) {
                    badges.push(
                      <span
                        key="none"
                        className="inline-flex items-center space-x-1 px-2 py-0.5 rounded bg-zinc-800/80 text-zinc-400 border border-zinc-700/60 font-medium text-[11px]"
                      >
                        <Subtitles className="w-3 h-3 text-zinc-500" />
                        <span>No Subtitles</span>
                      </span>
                    );
                  }

                  const items: React.ReactNode[] = [
                    <span key="count">{selectedFolder.episodes.length} Episodes found</span>,
                    ...badges,
                  ];

                  return (
                    <p className="text-xs text-zinc-400 pt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                      {items.map((el, i) => (
                        <React.Fragment key={i}>
                          {i > 0 && <span className="text-zinc-600 select-none">•</span>}
                          {el}
                        </React.Fragment>
                      ))}
                    </p>
                  );
                })()}
              </div>

              <div className="flex items-center space-x-2.5 shrink-0">
                <button
                  onClick={() => onOpenWhisper(selectedFolder)}
                  disabled={selectedFolder.isDownloading}
                  className={`flex items-center space-x-2 px-4 py-2.5 rounded-xl border text-xs font-bold transition-all shadow-sm ${
                    selectedFolder.isDownloading
                      ? 'bg-zinc-800/40 text-zinc-500 border-zinc-700/40 cursor-not-allowed opacity-60'
                      : 'bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/40 hover:scale-[1.02]'
                  }`}
                  title={selectedFolder.isDownloading ? 'Cannot transcribe while torrent is downloading' : 'Whisper Batch Subtitles'}
                >
                  <Sparkles className="w-4 h-4 text-indigo-400" />
                  <span>Whisper Batch Subtitles</span>
                </button>

                <button
                  onClick={() => onOpenInExplorer(selectedFolder.folderPath)}
                  className="p-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700/60 text-xs transition-colors shadow-sm"
                  title="Open Folder in Windows Explorer"
                >
                  <ExternalLink className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>

          {/* Episode Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 pt-1">
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
      ) : loading ? (
        <div className="flex flex-col items-center justify-center py-24 text-center rounded-2xl border border-zinc-800/40 bg-zinc-900/20 p-8">
          <div className="w-10 h-10 rounded-full border-4 border-red-600/20 border-t-red-600 animate-spin mb-4" />
          <h3 className="text-base font-semibold text-zinc-200">Scanning Library & Syncing Metadata...</h3>
          <p className="text-xs text-zinc-500 max-w-sm mt-1">
            Analyzing media files and episodes in {libraryRoot}
          </p>
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
