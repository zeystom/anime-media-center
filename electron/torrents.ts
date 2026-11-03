import fs from 'fs';
import path from 'path';

export interface TorrentEpisodeStatus {
  isDownloading: boolean;
  downloadProgress?: number; // 0..100 percentage
}

export interface TorrentFolderStatus {
  isDownloading: boolean;
  downloadProgress?: number; // 0..100 percentage
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  isDownloading: boolean;
  progress?: number;
  checkedAt: number;
}

// Memory cache to accelerate recursive directory scanning
const statusCache = new Map<string, CacheEntry>();

const TEMP_COMPANION_EXTENSIONS = [
  '.!qb',
  '.!ut',
  '.part',
  '.crdownload',
  '.downloading',
  '.aria2',
  '.fdmdownload',
  '.bc!',
  '.tixati',
  '.piece',
  '.vuzedl',
  '.incomplete',
  '.tmp',
];

function calculateSampleProgress(
  fullPath: string,
  logicalSize: number,
  filesInDir: Set<string>,
  fileName: string,
  matchedExt: string
): number | undefined {
  if (logicalSize <= 0) return 0;

  let targetPath = fullPath;
  if (!fs.existsSync(targetPath)) {
    const companionPath = path.join(path.dirname(fullPath), `${path.basename(fullPath)}${matchedExt}`);
    if (fs.existsSync(companionPath)) {
      targetPath = companionPath;
    } else {
      return undefined;
    }
  }

  try {
    const fileStat = fs.statSync(targetPath);
    if (fileStat.size > 0 && fileStat.size < logicalSize * 0.99) {
      return Math.min(99, Math.max(1, Math.round((fileStat.size / logicalSize) * 100)));
    }

    const fd = fs.openSync(targetPath, 'r');
    try {
      const checkPoints = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95];
      const buf = Buffer.alloc(16384);
      let nonZeroCount = 0;
      for (const frac of checkPoints) {
        const offset = Math.floor(fileStat.size * frac);
        const bytesRead = fs.readSync(fd, buf, 0, 16384, offset);
        if (bytesRead > 0) {
          let hasData = false;
          for (let i = 0; i < bytesRead; i++) {
            if (buf[i] !== 0) {
              hasData = true;
              break;
            }
          }
          if (hasData) nonZeroCount++;
        }
      }
      return Math.min(99, Math.max(1, Math.round((nonZeroCount / checkPoints.length) * 100)));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/**
 * Checks whether an anime episode file is currently incomplete or actively being downloaded
 * by a torrent client (qBittorrent, uTorrent, Transmission, Deluge, etc.) or web downloader.
 *
 * Employs a multi-layered verification strategy:
 * 1. Companion / temporary extensions (.!qb, .part, .crdownload, etc.)
 * 2. Zero-byte / stub file check
 * 3. Sparse file allocation check (NTFS / POSIX AllocationSize via stat.blocks)
 * 4. EBML / Container header integrity verification
 * 5. EBML / Container tail non-zero verification
 * 6. Multi-point sample probing across internal offsets to catch non-sparse preallocated zeroes
 */
export function checkEpisodeDownloading(
  fullPath: string,
  filesInDir: Set<string>,
  stat: fs.Stats
): TorrentEpisodeStatus {
  const fileName = path.basename(fullPath).toLowerCase();
  const now = Date.now();

  // Cache lookup:
  // Only completed/ready files (isDownloading: false) are cached for fast library traversal.
  // Incomplete/downloading files are NEVER cached for progress - we always read
  // the live cluster allocation and disk blocks to provide smooth, real-time download percentage updates!
  const cached = statusCache.get(fullPath);
  if (cached && !cached.isDownloading && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    if (now - cached.checkedAt < 300000) {
      return { isDownloading: false };
    }
  }

  // 1. Companion temporary files (qBittorrent, uTorrent, Transmission, etc.)
  for (const ext of TEMP_COMPANION_EXTENSIONS) {
    if (
      filesInDir.has(`${fileName}${ext}`) ||
      fileName.endsWith(ext) ||
      fileName.includes(`${ext}.`)
    ) {
      let progress =
        stat.blocks && stat.size > 0
          ? Math.min(99, Math.max(0, Math.round(((stat.blocks * 512) / stat.size) * 100)))
          : undefined;

      if (progress === undefined && stat.size > 0) {
        progress = calculateSampleProgress(fullPath, stat.size, filesInDir, fileName, ext);
      }

      const res: TorrentEpisodeStatus = { isDownloading: true, downloadProgress: progress };
      statusCache.set(fullPath, { ...res, progress, mtimeMs: stat.mtimeMs, size: stat.size, checkedAt: now });
      return res;
    }
  }

  // 2. 0-byte or stub files (< 512 KB cannot contain valid anime episode video stream)
  if (stat.size === 0 || stat.size < 512 * 1024) {
    const res: TorrentEpisodeStatus = { isDownloading: true, downloadProgress: 0 };
    statusCache.set(fullPath, { ...res, progress: 0, mtimeMs: stat.mtimeMs, size: stat.size, checkedAt: now });
    return res;
  }

  // 3. Sparse File Cluster Allocation Check (Windows NTFS, Linux Ext4/XFS, macOS APFS):
  // Modern torrent clients default to sparse file allocation on Windows & POSIX so they do not
  // synchronously zero-fill gigabytes of disk space when adding a torrent.
  // In Node.js / libuv, stat.blocks represents the number of 512-byte blocks allocated on disk.
  // For any fully downloaded uncompressed video file, allocatedBytes >= stat.size (due to cluster alignment).
  // If allocatedBytes is less than 99% of stat.size, unallocated clusters exist = download is incomplete!
  if (stat.blocks && stat.size > 5 * 1024 * 1024) {
    const allocatedBytes = stat.blocks * 512;
    if (allocatedBytes < stat.size * 0.99) {
      const progress = Math.min(99, Math.max(0, Math.round((allocatedBytes / stat.size) * 100)));
      const res: TorrentEpisodeStatus = { isDownloading: true, downloadProgress: progress };
      statusCache.set(fullPath, { ...res, progress, mtimeMs: stat.mtimeMs, size: stat.size, checkedAt: now });
      return res;
    }
  }

  // 4. Deep Content Verification for non-sparse pre-allocated zero files:
  if (stat.size > 5 * 1024 * 1024) {
    try {
      const fd = fs.openSync(fullPath, 'r');
      try {
        // A. Header Check
        const headBuf = Buffer.alloc(16);
        fs.readSync(fd, headBuf, 0, 16, 0);

        if (fileName.endsWith('.mkv')) {
          // Matroska EBML Header signature: 0x1A 0x45 0xDF 0xA3
          if (headBuf[0] !== 0x1A || headBuf[1] !== 0x45 || headBuf[2] !== 0xDF || headBuf[3] !== 0xA3) {
            const res: TorrentEpisodeStatus = { isDownloading: true, downloadProgress: 0 };
            statusCache.set(fullPath, { ...res, progress: 0, mtimeMs: stat.mtimeMs, size: stat.size, checkedAt: now });
            return res;
          }
        } else {
          // Generic video: if the first 16 bytes are all 0x00, the file was pre-allocated but never started
          let headAllZero = true;
          for (let i = 0; i < 16; i++) {
            if (headBuf[i] !== 0) {
              headAllZero = false;
              break;
            }
          }
          if (headAllZero) {
            const res: TorrentEpisodeStatus = { isDownloading: true, downloadProgress: 0 };
            statusCache.set(fullPath, { ...res, progress: 0, mtimeMs: stat.mtimeMs, size: stat.size, checkedAt: now });
            return res;
          }
        }

        // B. Tail Check:
        // Completed Matroska containers have EBML Cues/SeekHead/Tags written in the last 16 KB.
        // If the tail 16 KB is entirely zero, the download has not finished.
        const tailCheckSize = Math.min(16384, stat.size);
        const tailBuf = Buffer.alloc(tailCheckSize);
        fs.readSync(fd, tailBuf, 0, tailCheckSize, stat.size - tailCheckSize);
        let tailAllZero = true;
        for (let i = 0; i < tailCheckSize; i++) {
          if (tailBuf[i] !== 0) {
            tailAllZero = false;
            break;
          }
        }

        // C. Multi-Point Checkpoint Sampling across internal file offsets:
        // Encoded video bitstreams (H.264/HEVC/Opus) have near-maximal entropy and NEVER contain
        // 16 KB of pure zeroes in valid media frames. If any internal checkpoint contains all zeroes,
        // it indicates an unwritten pre-allocated piece.
        const checkPoints = [0.05, 0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90, 0.95];
        const sampleBuf = Buffer.alloc(16384);
        let zeroCheckpoints = 0;

        for (const frac of checkPoints) {
          const offset = Math.floor(stat.size * frac);
          const bytesRead = fs.readSync(fd, sampleBuf, 0, 16384, offset);
          if (bytesRead > 0) {
            let zeroCount = 0;
            for (let i = 0; i < bytesRead; i++) {
              if (sampleBuf[i] === 0) zeroCount++;
            }
            if (zeroCount >= bytesRead * 0.98) {
              zeroCheckpoints++;
            }
          }
        }

        if (tailAllZero || zeroCheckpoints > 0) {
          let progress: number | undefined;
          if (stat.blocks && stat.size > 0) {
            progress = Math.min(99, Math.max(0, Math.round(((stat.blocks * 512) / stat.size) * 100)));
          } else {
            const nonZero = checkPoints.length - zeroCheckpoints;
            progress = Math.min(
              99,
              Math.max(1, Math.round((nonZero / (checkPoints.length + (tailAllZero ? 1 : 0))) * 100))
            );
          }
          const res: TorrentEpisodeStatus = { isDownloading: true, downloadProgress: progress };
          statusCache.set(fullPath, { ...res, progress, mtimeMs: stat.mtimeMs, size: stat.size, checkedAt: now });
          return res;
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // If unable to read tail or checkpoints, do not block
    }
  }

  const res: TorrentEpisodeStatus = { isDownloading: false };
  statusCache.set(fullPath, { ...res, mtimeMs: stat.mtimeMs, size: stat.size, checkedAt: now });
  return res;
}

/**
 * Backward-compatible helper returning boolean.
 */
export function isEpisodeDownloading(
  fullPath: string,
  filesInDir: Set<string>,
  stat: fs.Stats
): boolean {
  return checkEpisodeDownloading(fullPath, filesInDir, stat).isDownloading;
}

/**
 * Checks whether an anime season folder is completely downloading or contains partially ready episodes.
 */
export function isFolderDownloading(
  folderPath: string,
  files: string[],
  episodes: Array<{ isDownloading?: boolean; size?: number; downloadProgress?: number }>
): TorrentFolderStatus {
  // If no playable episodes yet exist in folder, check for companion temp files
  if (episodes.length === 0) {
    const tempRegex = /\.(?:!qb|!ut|part|crdownload|downloading|aria2|fdmdownload|bc!|tixati)$/i;
    const isDl = files.some((f) => tempRegex.test(f));
    return { isDownloading: isDl, downloadProgress: isDl ? 0 : undefined };
  }

  // 1. Single Movie Folder (episodes.length === 1):
  // Directly mirrors the movie episode's downloading status and progress
  if (episodes.length === 1) {
    const ep = episodes[0];
    return {
      isDownloading: Boolean(ep.isDownloading),
      downloadProgress: ep.downloadProgress,
    };
  }

  // 2. If ALL episodes are downloading:
  if (episodes.every((e) => e.isDownloading)) {
    const totalProg = episodes.reduce((acc, e) => acc + (e.downloadProgress || 0), 0);
    const avgProg = Math.round(totalProg / episodes.length);
    return { isDownloading: true, downloadProgress: avgProg };
  }

  // 3. If high majority (>80% of bytes) is downloading:
  const totalSize = episodes.reduce((acc, ep) => acc + (ep.size || 0), 0);
  const dlSize = episodes.filter((ep) => ep.isDownloading).reduce((acc, ep) => acc + (ep.size || 0), 0);
  if (totalSize > 0 && dlSize / totalSize > 0.8) {
    return { isDownloading: true };
  }

  return { isDownloading: false };
}

export const checkTorrentProgress = checkEpisodeDownloading;
