import React, { useMemo, useState, useEffect } from 'react';
import { Download } from 'lucide-react';
import { AnimeFolder } from '../../types';
import { formatFileSize } from '../../utils/format';
import { LocalBadgeState } from '../../hooks/useLocalStatus';
import { StatusBadges } from '../common/StatusBadges';

interface DownloadedRailProps {
  folders: AnimeFolder[];
  onSelectLocalFolder: (folder: AnimeFolder) => void;
  statusFor: (ref: { anilistId?: number | null; title?: string | null; apiEpisodesCount?: number | null }) => LocalBadgeState | null;
}

interface LocalCardProps {
  folder: AnimeFolder;
  onSelectLocalFolder: (folder: AnimeFolder) => void;
  statusFor: DownloadedRailProps['statusFor'];
}

const LocalFolderCard: React.FC<LocalCardProps> = ({ folder, onSelectLocalFolder, statusFor }) => {
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => {
    setImgFailed(false);
  }, [folder.posterUrl]);

  const totalBytes = useMemo(
    () => folder.episodes.reduce((sum, ep) => sum + (ep.size || 0), 0),
    [folder.episodes]
  );
  const badgeState = useMemo(
    () =>
      statusFor({
        anilistId: null,
        title: folder.canonicalTitle || folder.folderName,
        apiEpisodesCount: folder.totalEpisodes ?? null,
      }),
    [statusFor, folder.canonicalTitle, folder.folderName, folder.totalEpisodes]
  );
  const displayName = folder.canonicalTitle || folder.folderName;

  return (
    <button
      onClick={() => onSelectLocalFolder(folder)}
      className="group w-[110px] shrink-0 cursor-pointer text-left focus:outline-none"
      title={displayName}
    >
      <div className="relative aspect-[2/3] w-[110px] overflow-hidden rounded-xl border border-zinc-800/80 bg-zinc-900 shadow-sm transition-all duration-200 group-hover:-translate-y-0.5 group-hover:border-zinc-700 group-hover:shadow-xl group-hover:shadow-black/40">
        {folder.posterUrl && !imgFailed ? (
          <img
            src={folder.posterUrl}
            alt={displayName}
            loading="lazy"
            onError={() => setImgFailed(true)}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center bg-gradient-to-br from-zinc-900 to-zinc-950 p-2 text-center">
            <span className="text-xl font-black tracking-wider text-zinc-700 group-hover:text-zinc-500 transition-colors">
              {displayName.charAt(0).toUpperCase()}
            </span>
          </div>
        )}
        {badgeState && (
          <div className="absolute left-1.5 top-1.5 z-10 max-w-[calc(100%-12px)]">
            <StatusBadges state={badgeState} size="sm" />
          </div>
        )}
      </div>
      <div className="mt-2 px-0.5">
        <p className="line-clamp-1 text-xs font-semibold text-zinc-100 group-hover:text-red-400 transition-colors">
          {displayName}
        </p>
        <p className="mt-0.5 text-[11px] text-zinc-500">
          {folder.totalEpisodes} eps · {formatFileSize(totalBytes)}
        </p>
      </div>
    </button>
  );
};

export const DownloadedRail: React.FC<DownloadedRailProps> = ({ folders, onSelectLocalFolder, statusFor }) => {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-zinc-200">Downloaded</h2>
      {folders.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-zinc-800/80 bg-zinc-900/40 py-10 text-center">
          <Download className="mb-2 h-6 w-6 text-zinc-700" />
          <p className="text-sm text-zinc-500">Nothing downloaded yet</p>
        </div>
      ) : (
        <div className="scrollbar-none flex gap-3 overflow-x-auto pb-2">
          {folders.map((folder) => (
            <LocalFolderCard
              key={folder.folderPath}
              folder={folder}
              onSelectLocalFolder={onSelectLocalFolder}
              statusFor={statusFor}
            />
          ))}
        </div>
      )}
    </section>
  );
};
