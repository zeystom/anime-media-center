import fs from 'fs';
import path from 'path';
import { VIDEO_EXTENSIONS } from './types.ts';
import { isPathInside, findAllowedRootFor } from './pathSafety.ts';

/**
 * Per-title disk usage entry for the storage overview.
 * `folderPath` is the absolute release folder; `folderName` matches the
 * effective name the library scan would show (see resolveReleaseFolderName).
 */
export interface StorageTitleUsage {
  folderPath: string;
  folderName: string;
  totalBytes: number;
  episodeCount: number;
}

/**
 * Aggregate storage picture across all library roots.
 * `freeBytes` is the available-to-user bytes of the first root that reports
 * statfs data, or null when no root can be queried.
 */
export interface StorageOverview {
  titles: StorageTitleUsage[];
  totalBytes: number;
  freeBytes: number | null;
}

// Directory names never scanned, mirroring the library scan in main.ts.
const IGNORED_DIR_PATTERN = /^(?:\$recycle\.bin|system volume information|\.git|\.cache|node_modules|temp|tmp|\.idea|\.vscode)$/i;

// Maximum release-folder depth below a library root, mirroring main.ts.
const MAX_SCAN_DEPTH = 4;

/**
 * Resolves the effective display name of a release folder, matching
 * getEffectiveAnimeFolderName() in main.ts: a folder directly under the
 * library root keeps its base name; a generically named folder
 * ('Season 1', 'Movie', 'Specials', ...) is prefixed with its parent name.
 */
function resolveReleaseFolderName(folderPath: string, rootPath?: string): string {
  const base = path.basename(folderPath);
  const parent = path.dirname(folderPath);

  // If directly under root, use base folder name
  if (rootPath && path.resolve(parent) === path.resolve(rootPath)) {
    return base;
  }

  // If base folder name is generic (e.g. "Season 1", "Movie", "Specials", "OVA"), combine with parent
  const isGeneric = /^(?:season\s*\d+|s\d+|part\s*\d+|cour\s*\d+|movie|movies|specials?|ova|oad|extra|bonus)$/i.test(base);
  if (isGeneric) {
    const parentBase = path.basename(parent);
    return `${parentBase} ${base}`;
  }

  return base;
}

/**
 * Lists release folders (directories containing at least one video file) under
 * `rootDir`, using the same depth (<=4) and ignore rules as the library scan
 * in main.ts. Directory symlinks are not followed.
 */
function listReleaseFolders(rootDir: string, maxDepth = MAX_SCAN_DEPTH): string[] {
  const mediaDirs: string[] = [];
  const visited = new Set<string>();

  function traverse(currentDir: string, depth: number) {
    if (depth > maxDepth || visited.has(currentDir)) return;
    visited.add(currentDir);

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    // Check if current directory contains any video files (.mkv / .mp4)
    const hasVideo = entries.some(
      (e) => e.isFile() && VIDEO_EXTENSIONS.some((ext) => e.name.toLowerCase().endsWith(ext))
    );
    if (hasVideo) {
      mediaDirs.push(currentDir);
    }

    // Recursively check subdirectories
    if (depth < maxDepth) {
      for (const entry of entries) {
        if (entry.isDirectory() && !IGNORED_DIR_PATTERN.test(entry.name)) {
          traverse(path.join(currentDir, entry.name), depth + 1);
        }
      }
    }
  }

  traverse(rootDir, 0);
  return mediaDirs;
}

/**
 * Recursively sums file sizes under `dir` and counts episode files whose name
 * ends with one of `extensions`. All files (videos, subtitles, extras, ...)
 * count toward totalBytes since they all occupy disk space. Unreadable
 * entries are skipped rather than failing the whole computation.
 */
function computeFolderStatsSync(dir: string, extensions: readonly string[]): { totalBytes: number; episodeCount: number } {
  let totalBytes = 0;
  let episodeCount = 0;

  const walk = (current: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      let size = 0;
      try {
        size = fs.statSync(fullPath).size;
      } catch {
        continue;
      }
      totalBytes += size;
      if (extensions.some((ext) => entry.name.toLowerCase().endsWith(ext))) {
        episodeCount++;
      }
    }
  };

  walk(dir);
  return { totalBytes, episodeCount };
}

/**
 * Resolves a path to its real filesystem location (symlinks/junctions and
 * '..' segments resolved). Falls back to path.resolve when the path does not
 * exist so security comparisons still run on a normalized absolute path.
 */
function resolveRealPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Deduplicates and resolves library roots to canonical absolute paths.
 */
function resolveUniqueRoots(allowedRoots: string[]): string[] {
  const resolved = new Set<string>();
  for (const root of allowedRoots) {
    if (!root || typeof root !== 'string') continue;
    resolved.add(resolveRealPath(root));
  }
  return Array.from(resolved);
}

/**
 * Computes disk usage of a single release folder.
 * totalBytes covers every file inside (recursively); episodeCount only counts
 * files matching `opts.extensions` (default: VIDEO_EXTENSIONS). A missing or
 * unreadable folder yields zeros rather than throwing.
 */
export async function computeDiskUsage(folderPath: string, opts?: { extensions?: readonly string[] }): Promise<{ totalBytes: number; episodeCount: number }> {
  const extensions = opts?.extensions ?? VIDEO_EXTENSIONS;
  if (!folderPath || typeof folderPath !== 'string') return { totalBytes: 0, episodeCount: 0 };
  return computeFolderStatsSync(folderPath, extensions);
}

/**
 * Builds the storage overview across all `libraryRoots`:
 * - one StorageTitleUsage per release folder found (folders containing at
 *   least one video file, depth <= 4, ignored dirs skipped),
 * - titles sorted by totalBytes descending,
 * - totalBytes as the sum over all titles (nested release folders each count
 *   as their own title, so overlapping trees may be counted per title),
 * - freeBytes from the first root that reports statfs data (bavail * bsize,
 *   i.e. available-to-user bytes), or null when none can be queried.
 *
 * Read-only: never modifies or deletes anything.
 */
export async function computeStorageOverview(libraryRoots: string[]): Promise<StorageOverview> {
  const titles: StorageTitleUsage[] = [];

  const roots = resolveUniqueRoots(Array.isArray(libraryRoots) ? libraryRoots : []);
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const folder of listReleaseFolders(root)) {
      const stats = computeFolderStatsSync(folder, VIDEO_EXTENSIONS);
      titles.push({
        folderPath: folder,
        folderName: resolveReleaseFolderName(folder, root),
        totalBytes: stats.totalBytes,
        episodeCount: stats.episodeCount
      });
    }
  }

  titles.sort((a, b) => b.totalBytes - a.totalBytes);
  const totalBytes = titles.reduce((sum, t) => sum + t.totalBytes, 0);
  const freeBytes = await readFreeBytes(roots);

  return { titles, totalBytes, freeBytes };
}

/**
 * Returns available-to-user bytes (bavail * bsize) for the first root that
 * statfs reports successfully; roots that are missing or unqueryable are
 * skipped. Returns null when no root yields data.
 */
async function readFreeBytes(roots: string[]): Promise<number | null> {
  for (const root of roots) {
    try {
      const stat = await fs.promises.statfs(root);
      return stat.bavail * stat.bsize;
    } catch {
      // Root missing or statfs unsupported; try the next root.
    }
  }
  return null;
}

/**
 * Explicitly deletes one release folder (recursively) and returns the number
 * of bytes it occupied. Deletion is ALWAYS an explicit user action triggered
 * from the UI — this module contains no scheduled, background, or batch
 * cleanup of any kind, and nothing is ever deleted automatically.
 *
 * Guards (all resolved through the real filesystem path, so '..' traversal
 * and symlink indirection cannot escape them):
 * - the folder must exist and be a directory,
 * - its real path must be inside exactly one allowed library root,
 * - the real path must not BE a library root itself.
 *
 * On success: { success: true, deletedBytes }. On refusal/failure:
 * { success: false, error } — nothing is deleted unless every guard passes.
 */
export function deleteAnime(folderPath: string, opts: { allowedRoots: string[] }): { success: boolean; deletedBytes?: number; error?: string } {
  if (!folderPath || typeof folderPath !== 'string') {
    return { success: false, error: 'Invalid folder path' };
  }
  const allowedRoots = Array.isArray(opts?.allowedRoots) ? opts.allowedRoots : [];
  if (allowedRoots.length === 0) {
    return { success: false, error: 'No allowed library roots configured' };
  }

  let realPath: string;
  try {
    const stat = fs.statSync(folderPath);
    if (!stat.isDirectory()) {
      return { success: false, error: 'Path is not a directory' };
    }
    realPath = fs.realpathSync(folderPath);
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      return { success: false, error: 'Folder not found' };
    }
    return { success: false, error: `Cannot access folder: ${err?.message || err}` };
  }

  const roots = resolveUniqueRoots(allowedRoots);
  const containingRoots = roots.filter((root) => isPathInside(realPath, root));
  if (containingRoots.length === 0) {
    return { success: false, error: 'Folder is outside all allowed library roots' };
  }
  if (containingRoots.length > 1) {
    return { success: false, error: 'Folder is claimed by multiple library roots; refusing to delete' };
  }
  const root = containingRoots[0];
  if (path.relative(root, realPath) === '') {
    return { success: false, error: 'Refusing to delete a library root itself' };
  }

  // Compute the byte footprint first so it can be reported even though the
  // folder is gone after removal.
  const { totalBytes } = computeFolderStatsSync(realPath, VIDEO_EXTENSIONS);

  try {
    fs.rmSync(realPath, { recursive: true, force: true });
  } catch (err: any) {
    if (err?.code === 'EBUSY' || err?.code === 'EPERM') {
      return { success: false, error: 'File is in use by another process; close it and try again' };
    }
    return { success: false, error: `Failed to delete folder: ${err?.message || err}` };
  }

  return { success: true, deletedBytes: totalBytes };
}

/**
 * Explicitly deletes individual episode files. Deletion is ALWAYS an explicit
 * user action triggered from the UI — this module contains no scheduled,
 * background, or batch cleanup of any kind, and nothing is ever deleted
 * automatically.
 *
 * Every file is guarded independently: it must exist, must be a regular file,
 * and its real path must be inside an allowed library root (resolve-normalized,
 * so '..' traversal or symlinks pointing outside a root are refused). Files
 * failing a guard are left untouched and reported in `error`.
 *
 * On success: { success: true, deletedBytes } (sum of removed file sizes).
 * On partial failure: { success: false, deletedBytes, error } where
 * deletedBytes only counts files that were actually removed.
 */
export function deleteEpisodes(filePaths: string[], opts: { allowedRoots: string[] }): { success: boolean; deletedBytes?: number; error?: string } {
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    return { success: false, error: 'No files specified' };
  }
  const allowedRoots = Array.isArray(opts?.allowedRoots) ? opts.allowedRoots : [];
  if (allowedRoots.length === 0) {
    return { success: false, error: 'No allowed library roots configured' };
  }

  const roots = resolveUniqueRoots(allowedRoots);
  let deletedBytes = 0;
  let deletedCount = 0;
  const failures: string[] = [];

  for (const filePath of filePaths) {
    if (!filePath || typeof filePath !== 'string') {
      failures.push('<invalid path>: skipped');
      continue;
    }

    let realPath: string;
    let size = 0;
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        failures.push(`${filePath}: not a regular file`);
        continue;
      }
      size = stat.size;
      realPath = fs.realpathSync(filePath);
    } catch (err: any) {
      failures.push(`${filePath}: ${err?.code === 'ENOENT' ? 'file not found' : (err?.message || 'cannot access file')}`);
      continue;
    }

    if (!findAllowedRootFor(realPath, roots)) {
      failures.push(`${filePath}: outside all allowed library roots`);
      continue;
    }

    try {
      fs.unlinkSync(realPath);
      deletedBytes += size;
      deletedCount++;
    } catch (err: any) {
      if (err?.code === 'EBUSY' || err?.code === 'EPERM') {
        failures.push(`${filePath}: file is in use by another process`);
      } else {
        failures.push(`${filePath}: ${err?.message || 'failed to delete'}`);
      }
    }
  }

  if (failures.length > 0) {
    const deletedNote = deletedCount > 0 ? `; deleted ${deletedCount} file(s) before failing` : '';
    return {
      success: false,
      deletedBytes,
      error: `Failed to delete ${failures.length} of ${filePaths.length} file(s)${deletedNote}: ${failures.join('; ')}`
    };
  }

  return { success: true, deletedBytes };
}
