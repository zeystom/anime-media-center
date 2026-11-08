/**
 * Persistent store for user-managed anime list statuses (watching / completed
 * / planning / dropped / paused), scores and episode progress.
 *
 * Deliberately standalone: storage.ts is NOT imported so this module can be
 * unit-tested in plain Node.js. The atomic write and rename-with-retry logic
 * are reimplemented locally following the same approach as storage.ts. Mutations
 * are kept in memory and flushed to user-library.json in the baseDir via a 7s
 * debounced atomic write; flush() forces the write immediately.
 */
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { registerMainServices } from './userDataBackup';
import { resolveUserDataPath } from './userDataPath';

export type UserListStatus = 'watching' | 'completed' | 'planning' | 'dropped' | 'paused';

export interface UserLibraryEntry {
  anilistId: number;
  idMal: number | null;
  titleSnapshot: string;
  status: UserListStatus;
  score: number | null;
  progress: number;
  updatedAt: number;
}

const LIBRARY_FILE_NAME = 'user-library.json';
const SAVE_DEBOUNCE_MS = 7000; // 7 second debounce, same as playback history
const VALID_STATUSES: UserListStatus[] = ['watching', 'completed', 'planning', 'dropped', 'paused'];

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
 * Coerces an externally sourced record (backup restore / watchlist import)
 * into a well-formed UserLibraryEntry — mirrors the normalization load()
 * applies to user-library.json.
 */
function normalizeUserLibraryEntry(anilistId: number, raw: Partial<UserLibraryEntry>): UserLibraryEntry {
  return {
    anilistId,
    idMal: typeof raw.idMal === 'number' && Number.isFinite(raw.idMal) ? Math.trunc(raw.idMal) : null,
    titleSnapshot: typeof raw.titleSnapshot === 'string' ? raw.titleSnapshot : '',
    status: VALID_STATUSES.includes(raw.status as UserListStatus) ? (raw.status as UserListStatus) : 'planning',
    score: typeof raw.score === 'number' && Number.isFinite(raw.score) ? raw.score : null,
    progress: typeof raw.progress === 'number' ? Math.max(0, Math.trunc(raw.progress)) : 0,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
  };
}

export class UserLibrary {
  private injectedBaseDir: string | null;
  private resolvedBaseDir: string | null = null;
  private entriesCache: Record<number, UserLibraryEntry> | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private dirty: boolean = false;

  /**
   * @param baseDir optional directory override (used by tests). Defaults to
   * the electron app userData path, resolved lazily with a try/catch and an
   * APPDATA fallback, mirroring storage.ts.
   */
  constructor(baseDir: string | null = null) {
    this.injectedBaseDir = baseDir && baseDir.trim() ? baseDir : null;
  }

  private getBaseDir(): string {
    if (this.injectedBaseDir) {
      return this.injectedBaseDir;
    }
    if (this.resolvedBaseDir) {
      return this.resolvedBaseDir;
    }
    try {
      this.resolvedBaseDir = app ? resolveUserDataPath() : path.join(process.env.APPDATA || '', 'anime-media-center');
    } catch {
      this.resolvedBaseDir = path.join(process.env.APPDATA || '', 'anime-media-center');
    }
    return this.resolvedBaseDir;
  }

  private getLibraryFile(): string {
    return path.join(this.getBaseDir(), LIBRARY_FILE_NAME);
  }

  /**
   * Loads user-library.json into the in-memory cache on first access.
   * Corrupted files are archived to .bak like storage.ts does for history.
   */
  private load(): Record<number, UserLibraryEntry> {
    if (this.entriesCache) {
      return this.entriesCache;
    }

    const entries: Record<number, UserLibraryEntry> = {};
    const file = this.getLibraryFile();

    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (parsed && typeof parsed === 'object') {
          for (const [key, value] of Object.entries(parsed)) {
            const anilistId = Math.trunc(Number(key));
            const entry = value as any;
            if (!Number.isFinite(anilistId) || anilistId <= 0 || !entry || typeof entry !== 'object') continue;
            entries[anilistId] = {
              anilistId,
              idMal: typeof entry.idMal === 'number' ? entry.idMal : null,
              titleSnapshot: typeof entry.titleSnapshot === 'string' ? entry.titleSnapshot : '',
              status: VALID_STATUSES.includes(entry.status) ? entry.status : 'planning',
              score: typeof entry.score === 'number' ? entry.score : null,
              progress: typeof entry.progress === 'number' ? Math.max(0, Math.trunc(entry.progress)) : 0,
              updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : 0,
            };
          }
        }
      } catch (err) {
        console.error('Corrupted user-library.json, archiving to user-library.json.bak:', err);
        try {
          renameSyncWithRetry(file, `${file}.bak`, 3);
        } catch {}
      }
    }

    this.entriesCache = entries;
    return entries;
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.flush();
      }, SAVE_DEBOUNCE_MS);
    }
  }

  /**
   * Returns all library entries keyed by anilistId.
   */
  getAll(): Record<number, UserLibraryEntry> {
    return this.load();
  }

  /**
   * Returns the entry for an anilistId, or null when not in the library.
   */
  get(anilistId: number): UserLibraryEntry | null {
    const id = Math.trunc(Number(anilistId));
    if (!Number.isFinite(id) || id <= 0) return null;
    return this.load()[id] || null;
  }

  /**
   * Creates or updates the entry for `anilistId` with a list status. Existing
   * score/progress are preserved; idMal and titleSnapshot are only overridden
   * when provided (null/empty keeps the stored values). Throws on an invalid
   * status so IPC callers get a clear error.
   */
  setStatus(anilistId: number, idMal: number | null, titleSnapshot: string, status: UserListStatus): UserLibraryEntry {
    const id = Math.trunc(Number(anilistId));
    if (!Number.isFinite(id) || id <= 0) {
      throw new Error(`Invalid anilistId: ${anilistId}`);
    }
    if (!VALID_STATUSES.includes(status)) {
      throw new Error(`Invalid user list status: ${status}`);
    }

    const entries = this.load();
    const existing = entries[id];
    const entry: UserLibraryEntry = {
      anilistId: id,
      idMal: typeof idMal === 'number' && Number.isFinite(idMal) ? Math.trunc(idMal) : existing?.idMal ?? null,
      titleSnapshot:
        typeof titleSnapshot === 'string' && titleSnapshot.trim() ? titleSnapshot.trim() : existing?.titleSnapshot ?? '',
      status,
      score: existing?.score ?? null,
      progress: existing?.progress ?? 0,
      updatedAt: Date.now(),
    };
    entries[id] = entry;
    this.scheduleFlush();
    return entry;
  }

  /**
   * Sets the user score for an existing entry (no-op if the title is not in
   * the library yet). Null clears the score. Returns the updated entry.
   */
  setScore(anilistId: number, score: number | null): UserLibraryEntry | null {
    const id = Math.trunc(Number(anilistId));
    if (!Number.isFinite(id) || id <= 0) return null;

    const entries = this.load();
    const existing = entries[id];
    if (!existing) {
      console.warn(`UserLibrary.setScore ignored: no entry for anilist ${id}`);
      return null;
    }

    let normalized: number | null = null;
    if (typeof score === 'number' && Number.isFinite(score)) {
      normalized = score;
    }

    const entry: UserLibraryEntry = { ...existing, score: normalized, updatedAt: Date.now() };
    entries[id] = entry;
    this.scheduleFlush();
    return entry;
  }

  /**
   * Sets the watched-episode progress for an existing entry (no-op if the
   * title is not in the library yet). Negative values are clamped to 0.
   * Returns the updated entry.
   */
  setProgress(anilistId: number, progress: number): UserLibraryEntry | null {
    const id = Math.trunc(Number(anilistId));
    if (!Number.isFinite(id) || id <= 0) return null;

    const entries = this.load();
    const existing = entries[id];
    if (!existing) {
      console.warn(`UserLibrary.setProgress ignored: no entry for anilist ${id}`);
      return null;
    }

    const normalized = Number.isFinite(progress) ? Math.max(0, Math.trunc(progress)) : 0;
    const entry: UserLibraryEntry = { ...existing, progress: normalized, updatedAt: Date.now() };
    entries[id] = entry;
    this.scheduleFlush();
    return entry;
  }

  /**
   * Removes an entry from the library. Returns true when an entry was removed.
   */
  remove(anilistId: number): boolean {
    const id = Math.trunc(Number(anilistId));
    if (!Number.isFinite(id) || id <= 0) return false;

    const entries = this.load();
    if (!(id in entries)) {
      return false;
    }
    delete entries[id];
    this.scheduleFlush();
    return true;
  }

  /**
   * Phase 4 (backup restore / watchlist import): merges a map of entries
   * keyed by anilistId into the library. For an existing entry the record
   * with the newer updatedAt is the base; missing idMal / score are filled
   * from the other side and progress never regresses (higher of the two).
   * Schedules the regular debounced flush. Returns the number of entries
   * created or updated.
   */
  mergeEntries(entries: Record<number, UserLibraryEntry>): number {
    if (!entries || typeof entries !== 'object') return 0;
    const map = this.load();
    let merged = 0;
    for (const [key, incomingRaw] of Object.entries(entries)) {
      if (!incomingRaw || typeof incomingRaw !== 'object') continue;
      const raw = incomingRaw as Partial<UserLibraryEntry>;
      const anilistId = Math.trunc(Number(raw.anilistId ?? key));
      if (!Number.isFinite(anilistId) || anilistId <= 0) continue;
      const incoming = normalizeUserLibraryEntry(anilistId, raw);
      const existing = map[anilistId];

      let entry: UserLibraryEntry;
      if (!existing) {
        entry = incoming;
      } else {
        const incomingNewer = incoming.updatedAt > existing.updatedAt;
        const base = incomingNewer ? incoming : existing;
        const other = incomingNewer ? existing : incoming;
        entry = {
          anilistId,
          idMal: base.idMal ?? other.idMal ?? null,
          titleSnapshot: base.titleSnapshot || other.titleSnapshot || '',
          status: VALID_STATUSES.includes(base.status) ? base.status : other.status,
          score: base.score ?? other.score ?? null,
          progress: Math.max(existing.progress, incoming.progress),
          updatedAt: Math.max(existing.updatedAt, incoming.updatedAt),
        };
        if (
          entry.idMal === existing.idMal &&
          entry.titleSnapshot === existing.titleSnapshot &&
          entry.status === existing.status &&
          entry.score === existing.score &&
          entry.progress === existing.progress &&
          entry.updatedAt === existing.updatedAt
        ) {
          continue; // nothing changed — do not count or touch updatedAt
        }
      }

      map[anilistId] = entry;
      merged++;
    }
    if (merged > 0) {
      this.scheduleFlush();
    }
    return merged;
  }

  /**
   * Forces a flush of pending changes to user-library.json (no-op when
   * nothing is dirty). Cancels the pending debounce timer.
   */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    if (!this.dirty || !this.entriesCache) return;

    try {
      const dir = this.getBaseDir();
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      saveJsonSync(this.getLibraryFile(), this.entriesCache);
      this.dirty = false;
    } catch (e) {
      console.error('Failed to write user library:', e);
    }
  }
}

export const userLibrary = new UserLibrary();

// Phase 4: expose the singleton to userDataBackup.ts / watchlistIO.ts via
// registration (see storage.ts for the rationale — keeps those modules free
// of static electron imports so plain Node tests can load their helpers).
registerMainServices({ userLibrary });
