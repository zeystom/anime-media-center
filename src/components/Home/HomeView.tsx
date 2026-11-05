import React, { useMemo } from 'react';
import { AnimeFolder, Episode, PlaybackProgress, UserLibraryEntry } from '../../types';
import { RailItem, useCatalogSection } from '../../hooks/useCatalog';
import { useLocalStatus } from '../../hooks/useLocalStatus';
import { UpNextWidget, UpNextData } from './UpNextWidget';
import { DownloadedRail } from './DownloadedRail';
import { SeasonHero } from './SeasonHero';
import { CatalogRail } from './CatalogRail';

interface HomeViewProps {
  upNext: UpNextData | null;
  folders: AnimeFolder[];
  history: Record<string, PlaybackProgress>;
  userEntries: Record<number, UserLibraryEntry>;
  onPlayEpisode: (episode: Episode, startAt?: number) => void;
  onSelectCatalogItem: (item: RailItem) => void;
  onSelectLocalFolder: (folder: AnimeFolder) => void;
}

export const HomeView: React.FC<HomeViewProps> = ({
  upNext,
  folders,
  history,
  userEntries,
  onPlayEpisode,
  onSelectCatalogItem,
  onSelectLocalFolder,
}) => {
  const airingToday = useCatalogSection('airingToday');
  const season = useCatalogSection('season');
  const trending = useCatalogSection('trending');
  const recommended = useCatalogSection('recommended');
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

  const showRecommended = recommended.loading || recommended.items.length > 0;

  return (
    <div className="mx-auto w-full max-w-7xl px-6 py-6">
      {upNext && <UpNextWidget data={upNext} onPlay={onPlayEpisode} />}

      <DownloadedRail
        folders={sortedFolders}
        onSelectLocalFolder={onSelectLocalFolder}
        statusFor={statusFor}
      />

      <SeasonHero
        items={season.items}
        loading={season.loading}
        onSelect={onSelectCatalogItem}
        statusFor={statusFor}
      />

      <CatalogRail
        title="Airing Today"
        items={airingToday.items}
        loading={airingToday.loading}
        emptyHint="No episodes airing today"
        onSelect={onSelectCatalogItem}
        statusFor={statusFor}
      />

      <CatalogRail
        title="Popular This Season"
        items={season.items}
        loading={season.loading}
        emptyHint="Nothing popular this season yet"
        onSelect={onSelectCatalogItem}
        statusFor={statusFor}
      />

      <CatalogRail
        title="Trending Now"
        items={trending.items}
        loading={trending.loading}
        emptyHint="Nothing trending right now"
        onSelect={onSelectCatalogItem}
        statusFor={statusFor}
      />

      {showRecommended && (
        <CatalogRail
          title="Recommended For You"
          items={recommended.items}
          loading={recommended.loading}
          emptyHint="Watch and download more to get recommendations"
          onSelect={onSelectCatalogItem}
          statusFor={statusFor}
        />
      )}

      <CatalogRail
        title="All Time Popular"
        items={allTime.items}
        loading={allTime.loading}
        emptyHint="Nothing to show yet"
        onSelect={onSelectCatalogItem}
        statusFor={statusFor}
      />
    </div>
  );
};
