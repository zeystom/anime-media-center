import React, { useMemo, useState } from 'react';
import { RefreshCw, Film, Search, Star, X, ArrowDownToLine, CheckCircle2, FolderOpen, ArrowUpDown, Heart, Bell } from 'lucide-react';
import { AnimeFolder, PlaybackProgress } from '../../types';
import type { FavouriteAnime, FollowedAnime } from '../../types/notifications';
import { cleanSeriesTitle, formatFileSize, isFolderMovie } from '../../utils/format';

interface FolderBrowserProps {
  libraryRoot?: string;
  folders: AnimeFolder[];
  history: Record<string, PlaybackProgress>;
  followedAnime: FollowedAnime[];
  favouriteAnime: FavouriteAnime[];
  loading: boolean;
  onChangeRoot?: () => void;
  onRefresh: () => void;
  /** Card click navigates to the unified title page — episodes live there. */
  onOpenFolderDetails: (folder: AnimeFolder) => void;
}

type SortMode = 'recent' | 'title' | 'score' | 'episodes' | 'size';
type CollectionFilter = 'all' | 'favourites' | 'followed' | 'watching';

const SORT_LABELS: Record<SortMode, string> = {
  recent: 'Recently watched',
  title: 'Title A-Z',
  score: 'Score',
  episodes: 'Episodes',
  size: 'Disk size',
};

interface FolderWatchStats {
  completed: number;
  total: number;
  /** 0..100 — completed episodes plus the deepest in-progress fraction. */
  percent: number;
  lastWatchedAt: number;
  sizeBytes: number;
  started: boolean;
  finished: boolean;
}

function folderWatchStats(folder: AnimeFolder, history: Record<string, PlaybackProgress>): FolderWatchStats {
  let completed = 0;
  let inProgress = 0;
  let deepestFraction = 0;
  let lastWatchedAt = 0;
  let sizeBytes = 0;
  for (const episode of folder.episodes) {
    sizeBytes += episode.size || 0;
    const progress = history[episode.filePath];
    if (!progress) continue;
    if (progress.completed) completed += 1;
    else if (progress.currentTime > 0) {
      inProgress += 1;
      const fraction = progress.duration > 0 ? Math.min(1, progress.currentTime / progress.duration) : 0;
      deepestFraction = Math.max(deepestFraction, fraction);
    }
    if (progress.lastWatchedAt) lastWatchedAt = Math.max(lastWatchedAt, progress.lastWatchedAt);
  }
  const total = folder.episodes.length || folder.totalEpisodes || 1;
  const percent = Math.min(100, Math.round(((completed + deepestFraction) / total) * 100));
  return {
    completed,
    total,
    percent,
    lastWatchedAt,
    sizeBytes,
    started: completed + inProgress > 0,
    finished: folder.episodes.length > 0 && completed >= folder.episodes.length,
  };
}

/** Library shelf: poster cards navigate straight to the title page — the
 *  episode grid lives there, so the library stays a compact overview even
 *  with dozens of titles. */
export const FolderBrowser: React.FC<FolderBrowserProps> = ({
  folders,
  history,
  followedAnime,
  favouriteAnime,
  loading,
  onChangeRoot,
  onRefresh,
  onOpenFolderDetails,
}) => {
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [sortMode, setSortMode] = useState<SortMode>('recent');
  const [collectionFilter, setCollectionFilter] = useState<CollectionFilter>('all');

  const titleKey = (value: string) => value.toLocaleLowerCase().replace(/\b(season|s)\s*\d+\b/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
  const matchesAnime = (folder: AnimeFolder, item: { anilistId: number | null; title: string; titleKey?: string }) =>
    (folder.anilistId != null && folder.anilistId === item.anilistId) ||
    (item.titleKey ? titleKey(folder.canonicalTitle || folder.folderName) === item.titleKey : titleKey(folder.canonicalTitle || folder.folderName) === titleKey(item.title));
  const isFavourite = (folder: AnimeFolder) => favouriteAnime.some((item) => matchesAnime(folder, item));
  const isFollowed = (folder: AnimeFolder) => followedAnime.some((item) => matchesAnime(folder, { ...item, titleKey: titleKey(item.title) }));

  // Live real-time filter across folder titles, canonical API titles, and genres
  const filteredFolders = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    return folders.filter((f) => {
      const stat = folderWatchStats(f, history);
      if (collectionFilter === 'favourites' && !isFavourite(f)) return false;
      if (collectionFilter === 'followed' && !isFollowed(f)) return false;
      if (collectionFilter === 'watching' && (!stat.started || stat.finished)) return false;
      if (!q) return true;
      const canonical = (f.canonicalTitle || '').toLowerCase();
      const cleaned = cleanSeriesTitle(f.folderName).toLowerCase();
      const raw = f.folderName.toLowerCase();
      const genresMatch = (f.genres || []).some((g) => g.toLowerCase().includes(q));
      return canonical.includes(q) || cleaned.includes(q) || raw.includes(q) || genresMatch;
    });
  }, [folders, history, searchQuery, collectionFilter, favouriteAnime, followedAnime]);

  const stats = useMemo(() => {
    let episodes = 0;
    let sizeBytes = 0;
    let finished = 0;
    let watching = 0;
    let favourites = 0;
    let followed = 0;
    for (const folder of folders) {
      const stat = folderWatchStats(folder, history);
      episodes += folder.episodes.length;
      sizeBytes += stat.sizeBytes;
      if (isFavourite(folder)) favourites += 1;
      if (isFollowed(folder)) followed += 1;
      if (stat.finished) finished += 1;
      else if (stat.started) watching += 1;
    }
    return { episodes, sizeBytes, finished, watching, favourites, followed };
  }, [folders, history, favouriteAnime, followedAnime]);

  const sortedFolders = useMemo(() => {
    const list = [...filteredFolders];
    switch (sortMode) {
      case 'recent':
        return list.sort((a, b) => folderWatchStats(b, history).lastWatchedAt - folderWatchStats(a, history).lastWatchedAt);
      case 'title':
        return list.sort((a, b) => (a.canonicalTitle || a.folderName).localeCompare(b.canonicalTitle || b.folderName));
      case 'score':
        return list.sort((a, b) => (b.averageScore ?? -1) - (a.averageScore ?? -1));
      case 'episodes':
        return list.sort((a, b) => b.episodes.length - a.episodes.length);
      case 'size':
        return list.sort((a, b) => folderWatchStats(b, history).sizeBytes - folderWatchStats(a, history).sizeBytes);
      default:
        return list;
    }
  }, [filteredFolders, sortMode, history]);

  return (
    <div className="mx-auto min-h-full w-full max-w-[1800px] px-6 py-7 2xl:px-12">
      <section className="relative mb-6 overflow-hidden rounded-[26px] border border-white/[0.08] bg-[#12141b] px-6 py-7 shadow-2xl shadow-black/20 md:px-9 md:py-8">
        <div className="pointer-events-none absolute -right-20 -top-32 h-80 w-80 rounded-full bg-rose-500/[0.08] blur-3xl" />
        <div className="pointer-events-none absolute -bottom-36 left-1/3 h-72 w-72 rounded-full bg-violet-500/[0.07] blur-3xl" />
        <div className="relative">
          <div className="flex items-center gap-2 text-rose-300">
            <Film className="h-4 w-4" />
            <span className="text-[10px] font-bold uppercase tracking-[0.22em]">Kaiko / Library</span>
          </div>
          <h1 className="mt-3 text-3xl font-black tracking-tight text-white md:text-4xl">Your anime library</h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-zinc-400">Browse your collection, track your progress, and pick up where you left off.</p>
        </div>
      </section>

      {folders.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-zinc-800/80 bg-zinc-900/40 p-16 text-center shadow-lg">
          <FolderOpen className="w-12 h-12 text-zinc-600 mb-4" />
          <h3 className="text-lg font-bold text-zinc-200">Your library is empty</h3>
          <p className="mt-2 max-w-md text-sm text-zinc-400">
            Download an anime from Discover or point the app at your existing library folder — your collection will show up here.
          </p>
          {onChangeRoot && (
            <button
              type="button"
              onClick={onChangeRoot}
              className="mt-5 px-4 py-2 rounded-xl border border-white/10 bg-zinc-800 text-xs font-semibold text-zinc-200 transition-colors hover:bg-zinc-700 hover:text-white"
            >
              Choose library folder
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {/* Header: collection title, stats chips, sort + live filter */}
          <div className="flex flex-wrap items-end justify-between gap-5 rounded-2xl border border-white/[0.08] bg-white/[0.025] p-6 shadow-[0_20px_60px_rgba(0,0,0,0.18)] backdrop-blur-xl">
            <div className="space-y-3">
              <div className="flex items-center space-x-3">
                <h3 className="flex items-center space-x-2 text-2xl font-bold tracking-tight text-zinc-100">
                  <Film className="h-5 w-5 text-violet-300" />
                  <span>Anime Collection</span>
                  <span className="rounded-full border border-violet-300/20 bg-violet-300/10 px-2.5 py-1 font-mono text-xs font-semibold text-violet-200">
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
              {/* Collection stats: fills the header with useful overview data */}
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded-full border border-white/10 bg-black/30 px-3 py-1 font-mono text-zinc-300">{stats.episodes} episodes</span>
                <span className="rounded-full border border-white/10 bg-black/30 px-3 py-1 font-mono text-zinc-300">{formatFileSize(stats.sizeBytes)}</span>
                {stats.finished > 0 && (
                  <span className="rounded-full border border-emerald-400/25 bg-emerald-500/10 px-3 py-1 font-mono text-emerald-200">{stats.finished} finished</span>
                )}
                <span aria-hidden="true" className="mx-1 h-5 w-px bg-white/15" />
                <div role="group" aria-label="Filter anime collection" className="inline-flex flex-wrap items-center gap-1 rounded-xl border border-white/[0.08] bg-black/25 p-1">
                  {([
                    ['all', 'All', folders.length],
                    ['favourites', 'Favourites', stats.favourites],
                    ['followed', 'Followed', stats.followed],
                    ['watching', 'Watching', stats.watching],
                  ] as [CollectionFilter, string, number][]).map(([value, label, count]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setCollectionFilter(value)}
                      aria-pressed={collectionFilter === value}
                      className={`rounded-lg px-2.5 py-1.5 font-semibold transition-colors ${collectionFilter === value ? 'border border-violet-300/25 bg-violet-400/15 text-violet-100 shadow-sm' : 'border border-transparent text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100'}`}
                    >
                      {label} <span className="ml-0.5 opacity-70">{count}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              {/* Sort control */}
              <div className="relative">
                <ArrowUpDown className="w-4 h-4 text-zinc-500 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <select
                  value={sortMode}
                  onChange={(e) => setSortMode(e.target.value as SortMode)}
                  className="appearance-none w-full min-w-[190px] rounded-xl border border-white/[0.08] bg-[#0d0e12]/90 py-3 pl-11 pr-8 text-sm text-zinc-200 shadow-inner transition-all focus:border-violet-400/50 focus:outline-none focus:ring-2 focus:ring-violet-500/20"
                  title="Sort library"
                >
                  {(Object.keys(SORT_LABELS) as SortMode[]).map((mode) => (
                    <option key={mode} value={mode} className="bg-[#0d0e12]">{SORT_LABELS[mode]}</option>
                  ))}
                </select>
              </div>

              {/* Live Filter / Search Input */}
              <div className="relative min-w-[280px] sm:min-w-[360px]">
                <Search className="w-4 h-4 text-zinc-500 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filter by title or genre..."
                  className="w-full rounded-xl border border-white/[0.08] bg-[#0d0e12]/90 py-3 pl-11 pr-9 text-sm text-zinc-200 shadow-inner transition-all placeholder:text-zinc-500 focus:border-violet-400/50 focus:outline-none focus:ring-2 focus:ring-violet-500/20"
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
          </div>

          {/* Poster shelf: card click opens the unified title page */}
          {sortedFolders.length > 0 ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-5 pt-2 pb-4 sm:grid-cols-[repeat(auto-fill,minmax(168px,1fr))] 2xl:grid-cols-[repeat(auto-fill,minmax(190px,1fr))]">
              {sortedFolders.map((folder) => {
                const stat = folderWatchStats(folder, history);
                const displayTitle = folder.canonicalTitle || cleanSeriesTitle(folder.folderName) || folder.folderName;

                // Primary: Official AniList 2:3 vertical poster!
                // Fallback: First episode's thumbnail/still capture!
                const posterSrc = folder.posterUrl || folder.episodes[0]?.kitsuThumbnail || folder.episodes[0]?.thumbnailUrl;

                return (
                  <div
                    key={folder.folderPath}
                    onClick={() => onOpenFolderDetails(folder)}
                    className="group relative aspect-[2/3] min-w-0 cursor-pointer select-none transition-transform duration-300 ease-out hover:-translate-y-1 hover:scale-[1.015] active:scale-[0.99]"
                  >
                    {/* Inner Card Container with Guaranteed Chromium Border-Radius Clip */}
                    <div
                      className="relative w-full h-full rounded-2xl overflow-hidden bg-zinc-950 border-2 border-white/10 shadow-lg shadow-black/50 transition-colors duration-200 hover:border-white/30"
                      style={{
                        transform: 'translateZ(0)',
                        WebkitMaskImage: '-webkit-radial-gradient(white, black)',
                        backfaceVisibility: 'hidden',
                        isolation: 'isolate',
                      }}
                    >
                      {/* Poster Image with Smooth Hover Zoom */}
                      {posterSrc ? (
                        <img
                          src={posterSrc}
                          alt={displayTitle}
                          className={`w-full h-full object-cover rounded-2xl transition-all duration-500 ease-out bg-zinc-950 group-hover:scale-105 ${
                            folder.isDownloading ? 'blur-md scale-105 opacity-60' : 'opacity-100'
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
                          <span
                            title={folder.downloadProgress !== undefined ? `Downloading (${folder.downloadProgress}%)` : 'Downloading'}
                            className="w-6 h-6 rounded-md bg-amber-500/95 text-white shadow-md border border-amber-400/40 backdrop-blur-md flex items-center justify-center"
                          >
                            <ArrowDownToLine className="w-3.5 h-3.5 animate-pulse" />
                          </span>
                        ) : folder.hasEmbeddedDubtitles ? (
                          <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-purple-600/90 text-white backdrop-blur-md shadow-md border border-purple-400/30">
                            Dub Sub
                          </span>
                        ) : (folder.hasWhisperCount ?? 0) > 0 ? (
                          <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-indigo-600/90 text-white backdrop-blur-md shadow-md border border-indigo-400/30">
                            AI Sub
                          </span>
                        ) : (folder.hasExtSubCount ?? 0) > 0 ? (
                          <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-blue-600/90 text-white backdrop-blur-md shadow-md border border-blue-400/30">
                            Ext Sub
                          </span>
                        ) : folder.hasEmbeddedSubtitles || folder.hasSubtitlesCount > 0 ? (
                          <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-emerald-600/90 text-white backdrop-blur-md shadow-md border border-emerald-400/30">
                            Sub
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-zinc-800/90 text-zinc-400 backdrop-blur-md border border-zinc-700/60">
                            No Sub
                          </span>
                        )}
                        {stat.finished ? (
                          <span title="Fully watched" className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold bg-emerald-500/95 text-white shadow-md border border-emerald-400/40 backdrop-blur-md">
                            <CheckCircle2 className="w-3 h-3" /> Watched
                          </span>
                        ) : isFolderMovie(folder) ? (
                          <span className="px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-wider bg-red-600/95 text-white shadow-md border border-red-400/40 backdrop-blur-md">
                            MOVIE
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded-md text-[10px] font-mono font-bold bg-black/80 text-zinc-200 border border-white/15 backdrop-blur-md">
                            {folder.episodes.length} EPS
                          </span>
                        )}
                      </div>

                      {(isFavourite(folder) || isFollowed(folder)) && (
                        <div className="absolute left-2.5 top-10 z-10 flex flex-wrap gap-1.5 pointer-events-none">
                          {isFavourite(folder) && <span title="Favourite" className="inline-flex items-center gap-1 rounded-md border border-rose-300/30 bg-rose-950/85 px-1.5 py-1 text-[9px] font-bold text-rose-100 shadow-md backdrop-blur"><Heart className="h-3 w-3 fill-current" />Favourite</span>}
                          {isFollowed(folder) && <span title="Followed for new episode alerts" className="inline-flex items-center gap-1 rounded-md border border-emerald-300/30 bg-emerald-950/85 px-1.5 py-1 text-[9px] font-bold text-emerald-100 shadow-md backdrop-blur"><Bell className="h-3 w-3" />Followed</span>}
                        </div>
                      )}

                      {/* Bottom Text, Watch Progress & Score */}
                      <div className="absolute bottom-0 left-0 right-0 p-3 pointer-events-none z-10 flex flex-col justify-end space-y-1.5">
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
                        {/* Watch progress bar: the shelf carries the resume state that
                            used to live in the removed episode grid. */}
                        {stat.percent > 0 && !folder.isDownloading && (
                          <div className="h-1 w-full overflow-hidden rounded-full bg-white/15">
                            <div
                              className={`h-full rounded-full transition-all ${stat.finished ? 'bg-emerald-400' : 'bg-rose-500'}`}
                              style={{ width: `${Math.max(4, stat.percent)}%` }}
                            />
                          </div>
                        )}
                        <p className="text-[10px] text-zinc-400 truncate">
                          {folder.isDownloading && folder.downloadProgress !== undefined
                            ? `Downloading ${folder.downloadProgress}%`
                            : stat.finished
                              ? 'Watched'
                              : stat.started
                                ? `${stat.completed}/${stat.total} watched`
                                : `${folder.episodes.length} episodes`}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            (searchQuery.trim() || collectionFilter !== 'all') && (
              <div className="flex flex-col items-center justify-center py-16 text-center rounded-2xl border border-zinc-800/80 bg-zinc-900/40 p-8 shadow-lg">
                <Search className="w-10 h-10 text-zinc-500 mb-3" />
                <h3 className="text-base font-semibold text-zinc-200">
                  {searchQuery.trim() ? <>No anime found matching <span className="text-red-400 font-bold">"{searchQuery}"</span></> : `No anime in ${collectionFilter === 'favourites' ? 'Favourites' : collectionFilter === 'followed' ? 'Followed' : 'Watching'}`}
                </h3>
                <p className="text-xs text-zinc-400 max-w-sm mt-1">
                  Try another filter or search, or clear the current selection.
                </p>
                <button
                  type="button"
                  onClick={() => { setSearchQuery(''); setCollectionFilter('all'); }}
                  className="mt-4 px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 hover:text-white text-xs font-semibold border border-white/10 transition-colors shadow-sm"
                >
                  Reset filters
                </button>
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
};
