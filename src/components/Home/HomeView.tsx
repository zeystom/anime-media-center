import React, { useMemo } from 'react';
import { AnimeFolder, Episode, PlaybackProgress, UserLibraryEntry } from '../../types';
import { RailItem, useCatalogSection, useGenrePicks } from '../../hooks/useCatalog';
import { useLocalStatus } from '../../hooks/useLocalStatus';
import { UpNextWidget, UpNextData } from './UpNextWidget';
import { CatalogRail } from './CatalogRail';
import { HomeSchedulePreview } from './HomeSchedulePreview';
import { RecentEpisodesRail } from './RecentEpisodesRail';

interface HomeViewProps {
  upNext: UpNextData | null;
  folders: AnimeFolder[];
  history: Record<string, PlaybackProgress>;
  userEntries: Record<number, UserLibraryEntry>;
  onPlayEpisode: (episode: Episode, startAt?: number) => void;
  onSelectCatalogItem: (item: RailItem) => void;
  onSelectLocalFolder: (folder: AnimeFolder) => void;
  onOpenSchedule: () => void;
  onOpenDiscover: () => void;
}

export const HomeView: React.FC<HomeViewProps> = ({
  upNext,
  folders,
  history,
  userEntries,
  onPlayEpisode,
  onSelectCatalogItem,
  onSelectLocalFolder,
  onOpenSchedule,
  onOpenDiscover,
}) => {
  const season = useCatalogSection('season');
  const trending = useCatalogSection('trending');
  const genrePicks = useGenrePicks();
  const allTime = useCatalogSection('allTime');

  const { statusFor } = useLocalStatus(folders, history, userEntries);

  // Downloaded rail ordering: most recently watched folder first (max
  // lastWatchedAt across the folder's history entries), then name.
  // Computed here because the rail's contract carries no history prop.
  const sortedFolders = useMemo(() => {
    const recency = new Map<string, number>();
    for (const progress of Object.values(history)) {
      if (!progress || !progress.folderPath) continue;
      const current = recency.get(progress.folderPath) || 0;
      if (progress.lastWatchedAt > current) {
        recency.set(progress.folderPath, progress.lastWatchedAt);
      }
    }
    return [...folders].sort((a, b) => {
      const ra = recency.get(a.folderPath) || 0;
      const rb = recency.get(b.folderPath) || 0;
      if (ra !== rb) return rb - ra;
      return a.folderName.localeCompare(b.folderName);
    });
  }, [folders, history]);

  const excludedAnimeIds = useMemo(() => {
    const ids = new Set<number>();
    for (const id of Object.keys(userEntries)) {
      const parsed = Number(id);
      if (Number.isFinite(parsed) && parsed > 0) ids.add(parsed);
    }
    for (const folder of folders) {
      if (typeof folder.anilistId === 'number' && folder.anilistId > 0) ids.add(folder.anilistId);
    }
    // A play-history record means the title has already been started. Resolve
    // its folder back to AniList so it stays out of discovery rails as well.
    const foldersByPath = new Map(folders.map((folder) => [folder.folderPath, folder]));
    for (const progress of Object.values(history)) {
      if (!progress?.folderPath) continue;
      const folder = foldersByPath.get(progress.folderPath);
      if (typeof folder?.anilistId === 'number' && folder.anilistId > 0) ids.add(folder.anilistId);
    }
    return ids;
  }, [folders, history, userEntries]);

  const visibleGenreRails = useMemo(() => genrePicks.rails.map((rail) => ({
    ...rail,
    items: rail.items.filter((item) => !excludedAnimeIds.has(item.anilistId)),
  })), [excludedAnimeIds, genrePicks.rails]);

  return (
    <div className="mx-auto w-full max-w-[1800px] px-6 py-8 2xl:px-12">
      {upNext && (
        <UpNextWidget
          data={upNext}
          onPlay={onPlayEpisode}
          onOpenDetails={() => {
            const folder = sortedFolders.find((item) =>
              item.folderPath === upNext.progress.folderPath ||
              item.folderName === upNext.seasonName ||
              item.canonicalTitle === upNext.seasonName
            )
            if (folder) onSelectLocalFolder(folder)
          }}
        />
      )}

      <RecentEpisodesRail folders={folders} history={history} onPlay={onPlayEpisode} />

      <HomeSchedulePreview onSelect={onSelectCatalogItem} onOpenSchedule={onOpenSchedule} />

      <CatalogRail
        title="Popular This Season"
        items={season.items}
        loading={season.loading}
        emptyHint="Nothing popular this season yet"
        onSelect={onSelectCatalogItem}
        statusFor={statusFor}
        onSeeMore={onOpenDiscover}
      />

      <CatalogRail
        title="Trending Now"
        items={trending.items}
        loading={trending.loading}
        emptyHint="Nothing trending right now"
        onSelect={onSelectCatalogItem}
        statusFor={statusFor}
        onSeeMore={onOpenDiscover}
      />

      {visibleGenreRails.map((rail) => (genrePicks.loading || rail.items.length > 0) && (
        <CatalogRail
          key={rail.genre}
          title={rail.genre}
          items={rail.items}
          loading={genrePicks.loading}
          emptyHint={`No ${rail.genre.toLowerCase()} anime to show`}
          onSelect={onSelectCatalogItem}
          statusFor={statusFor}
          onSeeMore={onOpenDiscover}
        />
      ))}

      <CatalogRail
        title="All Time Popular"
        items={allTime.items}
        loading={allTime.loading}
        emptyHint="Nothing to show yet"
        onSelect={onSelectCatalogItem}
        statusFor={statusFor}
        onSeeMore={onOpenDiscover}
      />
    </div>
  );
};
