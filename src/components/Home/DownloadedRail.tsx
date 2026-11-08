import React, { useMemo, useState, useEffect } from 'react';
import { Download } from 'lucide-react';
import { AnimeFolder } from '../../types';
import { formatFileSize } from '../../utils/format';
import { LocalBadgeState } from '../../hooks/useLocalStatus';
import { StatusBadges } from '../common/StatusBadges';
import { HorizontalScroller } from '../common/HorizontalScroller';

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
  const previewImages = folder.episodes
    // Local thumbnailUrl invokes FFmpeg against the original video. Home cards
    // should use remote stills only and never wake a media drive for artwork.
    .map((episode) => episode.kitsuThumbnail)
    .filter((url): url is string => Boolean(url))
    .slice(0, 4);

  return (
    <button
      onClick={() => onSelectLocalFolder(folder)}
      className="group w-[168px] shrink-0 cursor-pointer text-left focus:outline-none xl:w-[190px]"
      title={displayName}
    >
      <div className="relative aspect-[1.28/1] w-full overflow-hidden rounded-2xl border border-white/[0.09] bg-zinc-900 shadow-lg shadow-black/25 transition-all duration-200 group-hover:-translate-y-1 group-hover:border-violet-300/30 group-hover:shadow-xl group-hover:shadow-violet-950/20">
        {previewImages.length > 0 ? (
          <div className="grid h-full w-full grid-cols-2 gap-[2px] bg-black">
            {previewImages.map((src, index) => <img key={`${src}-${index}`} src={src} alt="" draggable={false} loading="lazy" className="h-full min-h-0 w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" />)}
            {previewImages.length < 4 && folder.posterUrl && !imgFailed && <img src={folder.posterUrl} alt="" draggable={false} onError={() => setImgFailed(true)} className="h-full min-h-0 w-full object-cover" />}
          </div>
        ) : folder.posterUrl && !imgFailed ? (
          <img src={folder.posterUrl} alt={displayName} draggable={false} loading="lazy" onError={() => setImgFailed(true)} className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center bg-gradient-to-br from-violet-950/40 to-zinc-950 p-2 text-center">
            <span className="text-xl font-black tracking-wider text-zinc-700 group-hover:text-zinc-500 transition-colors">
              {displayName.charAt(0).toUpperCase()}
            </span>
          </div>
        )}
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black via-black/75 to-transparent px-3 pb-2.5 pt-8">
          <p className="line-clamp-1 text-xs font-bold text-white">{displayName}</p>
          <p className="mt-0.5 text-[10px] text-zinc-300">{folder.totalEpisodes} episodes · {formatFileSize(totalBytes)}</p>
        </div>
        {badgeState && (
          <div className="absolute left-2 top-2 z-10 max-w-[calc(100%-16px)]">
            <StatusBadges state={badgeState} size="sm" />
          </div>
        )}
      </div>
    </button>
  );
};

export const DownloadedRail: React.FC<DownloadedRailProps> = ({ folders, onSelectLocalFolder, statusFor }) => {
  return (
    <section className="home-rail-section mb-10">
      <div className="mb-4 flex items-center gap-3">
        <h2 className="text-lg font-black uppercase tracking-wide text-white">Downloaded collection</h2>
        {folders.length > 0 && <span className="rounded-full border border-white/10 bg-white/[0.06] px-2.5 py-1 text-[10px] font-bold text-zinc-300">{folders.length} series</span>}
      </div>
      {folders.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-zinc-800/80 bg-zinc-900/40 py-10 text-center">
          <Download className="mb-2 h-6 w-6 text-zinc-700" />
          <p className="text-sm text-zinc-500">Nothing downloaded yet</p>
        </div>
      ) : (
        <HorizontalScroller label="Downloaded collection" className="flex gap-4 overflow-x-auto pb-3">
          {folders.map((folder) => (
            <LocalFolderCard
              key={folder.folderPath}
              folder={folder}
              onSelectLocalFolder={onSelectLocalFolder}
              statusFor={statusFor}
            />
          ))}
        </HorizontalScroller>
      )}
    </section>
  );
};
