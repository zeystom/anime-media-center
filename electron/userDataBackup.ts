/**
 * Documents auto-backup for user data (settings, playback history, season
 * rules, user library) plus the main-process service registry shared with
 * watchlistIO.ts.
 *
 * Design notes:
 * - The pure helpers (buildBackupPayload / writeBackup / readBackup and
 *   getBackupFilePath with an explicit documents dir) are deliberately free
 *   of electron imports so plain Node tests can import this module directly.
 * - storage.ts and userLibrary.ts register their singletons (and an electron
 *   documents-dir resolver) via registerMainServices at module load. The
 *   convenience wrappers therefore stay fully synchronous — important for the
 *   quit-time syncBackupNow() call — without dragging the electron/storage
 *   graph into the module namespace. In plain Node nothing registers and the
 *   wrappers fail with a clear error.
 * - The atomic write and rename-with-retry logic are reimplemented locally
 *   following the same approach as storage.ts's saveJsonSync.
 */
import fs from 'fs';
import path from 'path';
import type { PlaybackProgress, SeasonPreference } from './types.ts';
import type { StorageService } from './storage.ts';
import type { UserLibrary, UserLibraryEntry } from './userLibrary.ts';

export interface BackupPayload {
  format: 'animecenter-backup';
  version: 1;
  exportedAt: number;
  settings?: unknown;
  history?: Record<string, unknown>;
  seasonRules?: Record<string, unknown>;
  userLibrary?: Record<string, unknown>;
}

export interface RestoreResult {
  success: boolean;
  restored?: { history: number; seasonRules: number; userLibrary: number };
  error?: string;
}

export interface BackupServices {
  /** StorageService singleton (registered by storage.ts). */
  storage?: StorageService;
  /** UserLibrary singleton (registered by userLibrary.ts). */
  userLibrary?: UserLibrary;
  /** electron app.getPath('documents') with try/catch (registered by storage.ts). */
  resolveDocumentsDir?: () => string;
}

const BACKUP_DIR_NAME = 'AnimeCenter';
const BACKUP_FILE_NAME = 'user_library_backup.json';
const BACKUP_DEBOUNCE_MS = 10000; // 10 second debounce

// ---------------------------------------------------------------------------
// Main-process service registry (also consumed by watchlistIO.ts)
// ---------------------------------------------------------------------------

const mainServices: BackupServices = {};

/**
 * Phase 4: partial registration of main-process singletons. Called once at
 * module load by storage.ts and userLibrary.ts; repeated calls merge into the
 * registry so each module only supplies what it owns.
 */
export function registerMainServices(services: BackupServices): void {
  if (!services || typeof services !== 'object') return;
  if (services.storage) mainServices.storage = services.storage;
  if (services.userLibrary) mainServices.userLibrary = services.userLibrary;
  if (services.resolveDocumentsDir) mainServices.resolveDocumentsDir = services.resolveDocumentsDir;
}

/**
 * Returns the registered storage + userLibrary singletons or throws a clear
 * error when this module is loaded outside the Electron main process (tests).
 */
export function requireMainServices(): { storage: StorageService; userLibrary: UserLibrary } {
  if (!mainServices.storage || !mainServices.userLibrary) {
    throw new Error('AnimeCenter services not registered (only available in the Electron main process)');
  }
  return { storage: mainServices.storage, userLibrary: mainServices.userLibrary };
}

// ---------------------------------------------------------------------------
// Pure helpers (no electron imports — covered by test-watchlist-io.js)
// ---------------------------------------------------------------------------

/**
 * renameSync with brief spin-wait retries for Windows EPERM/EBUSY/EACCES and a
 * copy+unlink fallback — mirrors storage.ts's renameSyncWithRetry.
 */
function renameSyncWithRetry(src: string, dest: string, maxRetries = 5): void {
  let lastError: any = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      fs.renameSync(src, dest);
      return;
    } catch (err: any) {
      lastError = err;
      if (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES') {
        const delayMs = (attempt + 1) * 30;
        const start = Date.now();
        while (Date.now() - start < delayMs) {
          // brief synchronous spin wait
        }
      } else {
        throw err;
      }
    }
  }

  // Fallback if rename continues failing after retries on Windows NTFS
  try {
    fs.copyFileSync(src, dest);
    try {
      fs.unlinkSync(src);
    } catch {}
  } catch (copyErr) {
    throw lastError || copyErr;
  }
}

/**
 * Atomic JSON write via temp file + rename — mirrors storage.ts saveJsonSync.
 */
function saveJsonSync(targetFile: string, data: any): void {
  const tmpFile = `${targetFile}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
    renameSyncWithRetry(tmpFile, targetFile, 5);
  } catch (e) {
    console.error(`Failed to atomic write to ${targetFile}:`, e);
    throw e;
  } finally {
    try {
      if (fs.existsSync(tmpFile)) {
        fs.unlinkSync(tmpFile);
      }
    } catch {}
  }
}

/**
 * Builds a versioned backup payload from the provided data maps. Keys are
 * only included when the corresponding data was supplied.
 */
export function buildBackupPayload(deps: {
  settings?: unknown;
  history?: Record<string, unknown>;
  seasonRules?: Record<string, unknown>;
  userLibrary?: Record<string, unknown>;
}): BackupPayload {
  const payload: BackupPayload = {
    format: 'animecenter-backup',
    version: 1,
    exportedAt: Date.now(),
  };
  if (deps.settings !== undefined) payload.settings = deps.settings;
  if (deps.history) payload.history = deps.history;
  if (deps.seasonRules) payload.seasonRules = deps.seasonRules;
  if (deps.userLibrary) payload.userLibrary = deps.userLibrary;
  return payload;
}

/**
 * Atomically writes the payload (temp file + rename with retry).
 */
export function writeBackup(filePath: string, payload: BackupPayload): void {
  saveJsonSync(filePath, payload);
}

/**
 * Reads and validates a backup file. Returns null when the file is missing,
 * unreadable, corrupt JSON, or not an animecenter-backup v1 payload.
 */
export function readBackup(filePath: string): BackupPayload | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.format !== 'animecenter-backup' || parsed.version !== 1) return null;
    return parsed as BackupPayload;
  } catch {
    return null;
  }
}

/**
 * Resolves the documents directory: electron app.getPath('documents') when
 * the resolver was registered, otherwise USERPROFILE/Documents (mirrors the
 * defensive pattern used for the userData dir in storage.ts).
 */
function resolveDocumentsDir(): string {
  try {
    const viaApp = mainServices.resolveDocumentsDir?.();
    if (typeof viaApp === 'string' && viaApp.trim()) return viaApp;
  } catch {}
  return path.join(process.env.USERPROFILE || '', 'Documents');
}

/**
 * Returns <documentsDir>/AnimeCenter/user_library_backup.json without any
 * filesystem side effects.
 */
function buildBackupPath(documentsDir?: string): string {
  const dir = documentsDir && documentsDir.trim() ? documentsDir : resolveDocumentsDir();
  return path.join(dir, BACKUP_DIR_NAME, BACKUP_FILE_NAME);
}

/**
 * Returns the backup file path (<documents>/AnimeCenter/user_library_backup.json)
 * and makes sure the AnimeCenter directory exists (mkdir -p).
 */
export function getBackupFilePath(documentsDir?: string): string {
  const filePath = buildBackupPath(documentsDir);
  const backupDir = path.dirname(filePath);
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }
  return filePath;
}

// ---------------------------------------------------------------------------
// Main-process convenience wrappers (registered services required)
// ---------------------------------------------------------------------------

/**
 * Collects settings, playback history, season rules and the user library from
 * the live singletons and atomically writes the Documents backup. Fully
 * synchronous so it is safe to call on app quit.
 */
export function syncBackupNow(): { success: boolean; path: string; error?: string } {
  try {
    const { storage, userLibrary } = requireMainServices();
    const filePath = getBackupFilePath();
    const payload = buildBackupPayload({
      settings: storage.getSettings(),
      history: storage.getAllPlaybackProgress() as Record<string, unknown>,
      seasonRules: storage.getAllSeasonRules() as Record<string, unknown>,
      userLibrary: userLibrary.getAll() as unknown as Record<string, unknown>,
    });
    writeBackup(filePath, payload);
    return { success: true, path: filePath };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error('Documents backup failed:', error);
    return { success: false, path: '', error };
  }
}

/**
 * Reports whether a Documents backup currently exists, when it was last
 * written (payload exportedAt) and its size. Never creates directories.
 */
export function getBackupStatus(): { exists: boolean; path: string; lastSyncedAt?: number; sizeBytes?: number } {
  const filePath = buildBackupPath();
  if (!fs.existsSync(filePath)) {
    return { exists: false, path: filePath };
  }
  let lastSyncedAt: number | undefined;
  try {
    lastSyncedAt = readBackup(filePath)?.exportedAt;
  } catch {}
  let sizeBytes: number | undefined;
  try {
    sizeBytes = fs.statSync(filePath).size;
  } catch {}
  return { exists: true, path: filePath, lastSyncedAt, sizeBytes };
}

/**
 * Detects whether a restorable backup exists and whether the local userData
 * has no playback history yet (the classic "fresh install" restore case).
 */
export function detectRestoreState(): { available: boolean; path: string; userDataHistoryMissing: boolean; exportedAt?: number } {
  const filePath = buildBackupPath();
  const backup = readBackup(filePath);
  if (!backup) {
    return { available: false, path: filePath, userDataHistoryMissing: false };
  }
  let userDataHistoryMissing = false;
  try {
    const { storage } = requireMainServices();
    // Persist pending playback progress first so the on-disk check is accurate.
    storage.flushHistory();
    userDataHistoryMissing = !fs.existsSync(storage.getHistoryFilePath());
  } catch {}
  return { available: true, path: filePath, userDataHistoryMissing, exportedAt: backup.exportedAt };
}

/**
 * Restores history, season rules and the user library from the Documents
 * backup via the additive merge methods (existing newer records win, nothing
 * is overwritten by older data, settings are intentionally NOT restored).
 * Returns per-store merged counts.
 */
export function restoreFromBackup(): RestoreResult {
  try {
    const filePath = buildBackupPath();
    const backup = readBackup(filePath);
    if (!backup) {
      return { success: false, error: `No valid backup found at ${filePath}` };
    }
    const { storage, userLibrary: library } = requireMainServices();
    const history = storage.mergePlaybackProgress((backup.history ?? {}) as Record<string, PlaybackProgress>);
    const seasonRules = storage.mergeSeasonRules((backup.seasonRules ?? {}) as Record<string, SeasonPreference>);
    const libraryCount = library.mergeEntries((backup.userLibrary ?? {}) as unknown as Record<number, UserLibraryEntry>);
    // Persist immediately — a restore should not depend on the debounced timers.
    storage.flushHistory();
    library.flush();
    return {
      success: true,
      restored: { history, seasonRules, userLibrary: libraryCount },
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error('Documents backup restore failed:', error);
    return { success: false, error };
  }
}

// ---------------------------------------------------------------------------
// Debounced auto-backup (call sites in main.ts: after flush events + on quit)
// ---------------------------------------------------------------------------

let backupTimer: NodeJS.Timeout | null = null;

/**
 * Schedules a Documents backup 10s after the last call (debounced). Call
 * sites: after flushHistory / userLibrary flush events and — for a guaranteed
 * synchronous write — call syncBackupNow() directly on quit.
 */
export function scheduleBackupSync(): void {
  if (backupTimer) {
    clearTimeout(backupTimer);
  }
  backupTimer = setTimeout(() => {
    backupTimer = null;
    const res = syncBackupNow();
    if (!res.success) {
      console.error('Scheduled documents backup failed:', res.error);
    }
  }, BACKUP_DEBOUNCE_MS);
}
