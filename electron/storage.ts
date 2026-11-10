import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { app } from 'electron';
import { AnimeFolder, AppSettings, PlaybackProgress, SeasonPreference } from './types';
import { registerMainServices } from './userDataBackup';
import { resolveUserDataPath } from './userDataPath';

/**
 * Object keys that must never be written through dynamic assignment when
 * merging externally sourced records (JSON.parse can surface them and an
 * assignment like `out['__proto__'] = x` would mutate the prototype).
 */
const UNSAFE_RECORD_KEYS = ['__proto__', 'constructor', 'prototype'];
const TORRENT_LANGUAGE_CODES = new Set(['en', 'ja', 'de', 'fr', 'es', 'it', 'ru', 'pt', 'zh', 'ko']);

function normalizeTorrentLanguages(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  return [...new Set(value.filter((language): language is string => typeof language === 'string' && TORRENT_LANGUAGE_CODES.has(language)))];
}

const exePathCache = new Map<string, { path: string | null; time: number }>();

export function findExecutableInPath(exeName: string): string | null {
  const cached = exePathCache.get(exeName);
  if (cached && Date.now() - cached.time < 60000) {
    return cached.path;
  }
  let result: string | null = null;
  try {
    const out = execSync(`where.exe ${exeName}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length > 0 && fs.existsSync(lines[0])) {
      result = lines[0];
    }
  } catch {}
  exePathCache.set(exeName, { path: result, time: Date.now() });
  return result;
}

let cachedAutoWhisper: { path: string; time: number } | null = null;

export function autoDetectWhisperPath(forceFresh = false): string {
  if (!forceFresh && cachedAutoWhisper && Date.now() - cachedAutoWhisper.time < 60000) {
    return cachedAutoWhisper.path;
  }

  let result = '';

  // 1. Subtitle Edit standard AppData location
  const appData = process.env.APPDATA || '';
  const seWhisper = path.join(appData, 'Subtitle Edit', 'SpeechToText', 'Purfview-Faster-Whisper-XXL', 'faster-whisper-xxl.exe');
  if (fs.existsSync(seWhisper)) {
    result = seWhisper;
  } else {
    // 2. Relative bin directory
    const localBin = path.join(process.cwd(), 'bin', 'faster-whisper-xxl.exe');
    if (fs.existsSync(localBin)) {
      result = localBin;
    } else {
      // 3. User profile and root directory candidates
      const userProfile = process.env.USERPROFILE || '';
      const commonDirs = [
        path.join(userProfile, 'Faster-Whisper-XXL', 'faster-whisper-xxl.exe'),
        path.join(userProfile, 'Downloads', 'Faster-Whisper-XXL', 'faster-whisper-xxl.exe'),
        'C:\\Faster-Whisper-XXL\\faster-whisper-xxl.exe',
        'C:\\Program Files\\Faster-Whisper-XXL\\faster-whisper-xxl.exe',
      ];
      for (const p of commonDirs) {
        if (fs.existsSync(p)) {
          result = p;
          break;
        }
      }

      // 4. PATH lookup
      if (!result) {
        const fromPath = findExecutableInPath('faster-whisper-xxl.exe');
        if (fromPath) result = fromPath;
      }
    }
  }

  cachedAutoWhisper = { path: result, time: Date.now() };
  return result;
}

let cachedAutoFfmpeg: { path: string; time: number; forWhisper?: string } | null = null;

export function autoDetectFfmpegPath(knownWhisperPath?: string, forceFresh = false): string {
  if (
    !forceFresh &&
    cachedAutoFfmpeg &&
    Date.now() - cachedAutoFfmpeg.time < 60000 &&
    cachedAutoFfmpeg.forWhisper === knownWhisperPath
  ) {
    return cachedAutoFfmpeg.path;
  }

  let result = '';

  // 1. Packaged application resources (bundled in NSIS installer: resources/bin/ffmpeg.exe)
  try {
    if (process.resourcesPath) {
      const bundled = path.join(process.resourcesPath, 'bin', 'ffmpeg.exe');
      if (fs.existsSync(bundled)) {
        result = bundled;
      }
    }
  } catch {}

  // 2. Project local or portable bin folder
  if (!result) {
    const localBin = path.join(process.cwd(), 'bin', 'ffmpeg.exe');
    if (fs.existsSync(localBin)) {
      result = localBin;
    }
  }

  // 3. Executable sibling directory (app.getPath('exe') / process.execPath)
  if (!result) {
    try {
      const execDir = path.dirname(process.execPath);
      const candidates = [
        path.join(execDir, 'bin', 'ffmpeg.exe'),
        path.join(execDir, 'resources', 'bin', 'ffmpeg.exe'),
        path.join(execDir, 'ffmpeg.exe'),
      ];
      for (const c of candidates) {
        if (fs.existsSync(c)) {
          result = c;
          break;
        }
      }
    } catch {}
  }

  // 4. Next to whisper executable if present
  if (!result && knownWhisperPath && fs.existsSync(knownWhisperPath)) {
    const siblingFfmpeg = path.join(path.dirname(knownWhisperPath), 'ffmpeg.exe');
    if (fs.existsSync(siblingFfmpeg)) {
      result = siblingFfmpeg;
    }
  }

  if (!result) {
    // 5. Subtitle Edit AppData
    const appData = process.env.APPDATA || '';
    const seFfmpeg = path.join(appData, 'Subtitle Edit', 'SpeechToText', 'Purfview-Faster-Whisper-XXL', 'ffmpeg.exe');
    if (fs.existsSync(seFfmpeg)) {
      result = seFfmpeg;
    } else {
      const seFfmpegDirect = path.join(appData, 'Subtitle Edit', 'ffmpeg.exe');
      if (fs.existsSync(seFfmpegDirect)) {
        result = seFfmpegDirect;
      } else {
        // 3. PATH lookup
        const fromPath = findExecutableInPath('ffmpeg.exe');
        if (fromPath) {
          result = fromPath;
        } else {
          // 4. Common Windows installations
          const localAppData = process.env.LOCALAPPDATA || '';
          const userProfile = process.env.USERPROFILE || '';
          const candidates = [
            path.join(process.cwd(), 'bin', 'ffmpeg.exe'),
            'C:\\ffmpeg\\bin\\ffmpeg.exe',
            'C:\\ffmpeg\\ffmpeg.exe',
            'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
            'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe',
            path.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
            path.join(userProfile, 'scoop', 'shims', 'ffmpeg.exe'),
          ];
          for (const c of candidates) {
            if (fs.existsSync(c)) {
              result = c;
              break;
            }
          }
        }
      }
    }
  }

  cachedAutoFfmpeg = { path: result, time: Date.now(), forWhisper: knownWhisperPath };
  return result;
}

export function autoDetectLibraryRoots(): string[] {
  const userProfile = process.env.USERPROFILE || '';
  const videosDir = path.join(userProfile, 'Videos');
  if (fs.existsSync(videosDir)) {
    return [videosDir];
  }
  return [];
}

export function renameSyncWithRetry(src: string, dest: string, maxRetries = 5): void {
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

  // Fallback if rename continues failing after retries on Windows NTFS:
  // copy and unlink tmp file
  try {
    fs.copyFileSync(src, dest);
    try {
      fs.unlinkSync(src);
    } catch {}
  } catch (copyErr) {
    throw lastError || copyErr;
  }
}

export function saveJsonSync(targetFile: string, data: any): void {
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

export class StorageService {
  private baseDir: string;
  private settingsFile: string;
  private historyFile: string;
  private seasonRulesFile: string;
  private libraryCacheFile: string;

  private cachedSettings: AppSettings | null = null;
  private settingsMtime: number = 0;

  private historyCache: Record<string, PlaybackProgress> | null = null;
  private seasonRulesCache: Record<string, SeasonPreference> | null = null;
  private historySaveTimer: NodeJS.Timeout | null = null;
  private historyDirty: boolean = false;

  constructor() {
    try {
      this.baseDir = app ? resolveUserDataPath() : path.join(process.env.APPDATA || '', 'anime-media-center');
    } catch {
      this.baseDir = path.join(process.env.APPDATA || '', 'anime-media-center');
    }

    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }

    this.settingsFile = path.join(this.baseDir, 'settings.json');
    this.historyFile = path.join(this.baseDir, 'history.json');
    this.seasonRulesFile = path.join(this.baseDir, 'season-rules.json');
    this.libraryCacheFile = path.join(this.baseDir, 'library-cache.json');
  }

  getLibraryCache(roots: string[]): AnimeFolder[] | null {
    try {
      if (!fs.existsSync(this.libraryCacheFile)) return null;
      const parsed = JSON.parse(fs.readFileSync(this.libraryCacheFile, 'utf-8'));
      const normalize = (items: string[]) => items.map((item) => path.resolve(item).toLowerCase()).sort();
      if (!Array.isArray(parsed?.roots) || !Array.isArray(parsed?.folders)) return null;
      if (JSON.stringify(normalize(parsed.roots)) !== JSON.stringify(normalize(roots))) return null;
      return parsed.folders as AnimeFolder[];
    } catch {
      return null;
    }
  }

  saveLibraryCache(roots: string[], folders: AnimeFolder[]): void {
    try {
      saveJsonSync(this.libraryCacheFile, { version: 1, roots, folders, savedAt: Date.now() });
    } catch (error) {
      console.warn('[Storage] Could not save library scan cache:', error);
    }
  }

  getThumbnailDir(): string {
    const dir = path.join(this.baseDir, 'thumbnails');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  getSubtitleCacheDir(): string {
    const dir = path.join(this.baseDir, 'subtitles_cache');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  getMetadataCacheDir(): string {
    const dir = path.join(this.baseDir, 'metadata_cache');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  getSettings(): AppSettings {
    try {
      if (fs.existsSync(this.settingsFile)) {
        const stat = fs.statSync(this.settingsFile);
        if (this.cachedSettings && stat.mtimeMs === this.settingsMtime) {
          return this.cachedSettings;
        }

        const raw = fs.readFileSync(this.settingsFile, 'utf-8');
        const parsed = JSON.parse(raw);

        // Keep saved libraryFolders as is without rewriting file (allow empty list)
        const libraryFolders = Array.isArray(parsed.libraryFolders)
          ? parsed.libraryFolders
          : parsed.defaultLibraryRoot
          ? [parsed.defaultLibraryRoot]
          : autoDetectLibraryRoots();

        const defaultLibraryRoot = parsed.defaultLibraryRoot || (libraryFolders[0] || '');

        // Auto-detect only if user path is empty string/undefined; never mutate file
        let ffmpegPath = typeof parsed.ffmpegPath === 'string' ? parsed.ffmpegPath : '';
        let whisperPath = typeof parsed.whisperPath === 'string' ? parsed.whisperPath : '';

        if (!whisperPath) {
          whisperPath = autoDetectWhisperPath();
        }
        if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
          ffmpegPath = autoDetectFfmpegPath(whisperPath);
        }

        const whisperModel =
          typeof parsed.whisperModel === 'string' && parsed.whisperModel.trim()
            ? parsed.whisperModel.trim()
            : 'large-v3-turbo';

        const customModelPath =
          typeof parsed.customModelPath === 'string'
            ? parsed.customModelPath.trim()
            : undefined;

        // Start from everything persisted on disk, then normalize the known
        // fields below. The P2P block (enableP2P, p2pConsentAcceptedAt,
        // rssProviders, limits, downloadTargetFolder) is intentionally not in
        // the normalizer — rebuilding `res` from a fixed whitelist made every
        // partial updateSettings() drop the other persisted blocks (provider
        // and engine settings were lost after restart).
        const persisted: Partial<AppSettings> =
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? Object.fromEntries(
                Object.entries(parsed).filter(([key]) => !UNSAFE_RECORD_KEYS.includes(key))
              )
            : {};

        const res: AppSettings = {
          ...persisted,
          ffmpegPath,
          whisperPath,
          whisperModel,
          ...(customModelPath ? { customModelPath } : {}),
          defaultLibraryRoot,
          libraryFolders,
          autoPlayNext: parsed.autoPlayNext ?? true,
          checkForUpdatesOnStartup: parsed.checkForUpdatesOnStartup ?? true,
          autoUpdate: parsed.autoUpdate ?? true,
          subtitlesFontSize: parsed.subtitlesFontSize ?? 38,
          subtitlesOutline: true,
          subtitlesTextColor: parsed.subtitlesTextColor || '#ffffff',
          subtitlesFontFamily: parsed.subtitlesFontFamily || 'sans',
          subtitlesBgStyle: parsed.subtitlesBgStyle || 'none',
          subtitlesOutlineWidth: parsed.subtitlesOutlineWidth || 'thick',
          subtitlesOutlineColor: parsed.subtitlesOutlineColor || '#000000',
          releaseSelectionMode: parsed.releaseSelectionMode === 'manual' ? 'manual' : 'automatic',
          preferredTorrentAudioLanguages: normalizeTorrentLanguages(parsed.preferredTorrentAudioLanguages, ['en']),
          preferredTorrentSubtitleLanguages: normalizeTorrentLanguages(parsed.preferredTorrentSubtitleLanguages, ['en']),
          animeTitleLanguage: ['english', 'romaji', 'native'].includes(parsed.animeTitleLanguage) ? parsed.animeTitleLanguage : 'english',
        };

        this.cachedSettings = res;
        this.settingsMtime = stat.mtimeMs;
        return res;
      }
    } catch (e) {
      console.error('Failed to read settings:', e);
    }

    // Default settings in memory (no disk write)
    const whisper = autoDetectWhisperPath();
    const ffmpeg = autoDetectFfmpegPath(whisper);
    const roots = autoDetectLibraryRoots();
    const defaults: AppSettings = {
      ffmpegPath: ffmpeg,
      whisperPath: whisper,
      whisperModel: 'large-v3-turbo',
      customModelPath: '',
      defaultLibraryRoot: roots[0] || '',
      libraryFolders: roots,
      autoPlayNext: true,
      checkForUpdatesOnStartup: true,
      autoUpdate: true,
      subtitlesFontSize: 38,
      subtitlesOutline: true,
      subtitlesTextColor: '#ffffff',
      subtitlesFontFamily: 'sans',
      subtitlesBgStyle: 'none',
      subtitlesOutlineWidth: 'thick',
      subtitlesOutlineColor: '#000000',
      releaseSelectionMode: 'automatic',
      preferredTorrentAudioLanguages: ['en'],
      preferredTorrentSubtitleLanguages: ['en'],
      animeTitleLanguage: 'english',
      enableP2P: false,
      p2pConsentAcceptedAt: null,
      rssProviders: [],
    };
    this.cachedSettings = defaults;
    return defaults;
  }

  updateSettings(settings: Partial<AppSettings>): AppSettings {
    const current = this.getSettings();
    const updated = { ...current, ...settings };
    if (Array.isArray(updated.libraryFolders) && updated.libraryFolders.length > 0) {
      updated.defaultLibraryRoot = updated.libraryFolders[0];
    } else if (Array.isArray(updated.libraryFolders) && updated.libraryFolders.length === 0) {
      updated.defaultLibraryRoot = '';
    }

    try {
      saveJsonSync(this.settingsFile, updated);
      const stat = fs.statSync(this.settingsFile);
      this.settingsMtime = stat.mtimeMs;
      this.cachedSettings = updated;
    } catch (e) {
      console.error('Failed to write settings:', e);
    }
    return updated;
  }

  getAllPlaybackProgress(): Record<string, PlaybackProgress> {
    if (this.historyCache !== null) {
      return this.historyCache;
    }

    if (fs.existsSync(this.historyFile)) {
      try {
        const raw = fs.readFileSync(this.historyFile, 'utf-8');
        this.historyCache = JSON.parse(raw);
        return this.historyCache!;
      } catch (e) {
        console.error('Corrupted history.json, archiving to history.json.bak:', e);
        try {
          renameSyncWithRetry(this.historyFile, `${this.historyFile}.bak`, 3);
        } catch {}
        this.historyCache = {};
        return this.historyCache;
      }
    }

    this.historyCache = {};
    return this.historyCache;
  }

  savePlaybackProgress(progress: PlaybackProgress): void {
    const all = this.getAllPlaybackProgress();
    all[progress.filePath] = progress;
    this.historyDirty = true;

    if (!this.historySaveTimer) {
      this.historySaveTimer = setTimeout(() => {
        this.flushHistory();
      }, 7000); // 7 second debounce
    }
  }

  flushHistory(): void {
    if (this.historySaveTimer) {
      clearTimeout(this.historySaveTimer);
      this.historySaveTimer = null;
    }

    if (!this.historyDirty || !this.historyCache) return;

    try {
      saveJsonSync(this.historyFile, this.historyCache);
      this.historyDirty = false;
    } catch (e) {
      console.error('Failed to write history:', e);
    }
  }

  getSeasonPreference(folderPath: string): SeasonPreference | null {
    if (this.seasonRulesCache !== null) {
      return this.seasonRulesCache[folderPath] || null;
    }
    try {
      if (fs.existsSync(this.seasonRulesFile)) {
        const raw = fs.readFileSync(this.seasonRulesFile, 'utf-8');
        this.seasonRulesCache = JSON.parse(raw);
        return this.seasonRulesCache![folderPath] || null;
      }
    } catch (e) {
      console.error('Failed to read season rules:', e);
    }
    this.seasonRulesCache = {};
    return null;
  }

  saveSeasonPreference(folderPath: string, pref: SeasonPreference): void {
    try {
      let rules: Record<string, SeasonPreference> = {};
      if (this.seasonRulesCache !== null) {
        rules = { ...this.seasonRulesCache };
      } else if (fs.existsSync(this.seasonRulesFile)) {
        try {
          rules = JSON.parse(fs.readFileSync(this.seasonRulesFile, 'utf-8'));
        } catch {}
      }
      rules[folderPath] = pref;
      saveJsonSync(this.seasonRulesFile, rules);
      this.seasonRulesCache = rules;
    } catch (e) {
      console.error('Failed to write season rules:', e);
    }
  }

  /**
   * Phase 4 (Documents backup): returns the full season-rules map, reusing the
   * existing season-rules.json read/cache path. Additive — does not alter any
   * existing method.
   */
  getAllSeasonRules(): Record<string, SeasonPreference> {
    if (this.seasonRulesCache !== null) {
      return this.seasonRulesCache;
    }
    try {
      if (fs.existsSync(this.seasonRulesFile)) {
        const raw = fs.readFileSync(this.seasonRulesFile, 'utf-8');
        this.seasonRulesCache = JSON.parse(raw);
        return this.seasonRulesCache!;
      }
    } catch (e) {
      console.error('Failed to read season rules:', e);
    }
    this.seasonRulesCache = {};
    return this.seasonRulesCache;
  }

  /**
   * Phase 4 (backup/watchlist restore): merges externally sourced playback
   * records into the history cache. For existing keys the record with the
   * newer lastWatchedAt wins (ties go to the incoming record); new keys are
   * added. Marks the history dirty and schedules the regular 7s debounced
   * flush. Returns the number of records added or updated.
   */
  mergePlaybackProgress(records: Record<string, PlaybackProgress>): number {
    if (!records || typeof records !== 'object') return 0;
    const all = this.getAllPlaybackProgress();
    let merged = 0;
    for (const [key, incoming] of Object.entries(records)) {
      if (UNSAFE_RECORD_KEYS.includes(key) || !key || !incoming || typeof incoming !== 'object') continue;
      if (typeof incoming.lastWatchedAt !== 'number' || !Number.isFinite(incoming.lastWatchedAt)) continue;
      const normalized: PlaybackProgress = typeof incoming.filePath === 'string' && incoming.filePath
        ? incoming
        : { ...incoming, filePath: key };
      const existing = all[key];
      if (!existing || normalized.lastWatchedAt >= existing.lastWatchedAt) {
        all[key] = normalized;
        merged++;
      }
    }
    if (merged > 0) {
      this.historyDirty = true;
      if (!this.historySaveTimer) {
        this.historySaveTimer = setTimeout(() => {
          this.flushHistory();
        }, 7000); // 7 second debounce
      }
    }
    return merged;
  }

  /**
   * Phase 4 (backup/watchlist restore): merges externally sourced per-folder
   * season preferences (incoming values win — preferences carry no timestamp)
   * and persists the merged map immediately via the regular atomic write path.
   * Returns the number of rules added or updated.
   */
  mergeSeasonRules(rules: Record<string, SeasonPreference>): number {
    if (!rules || typeof rules !== 'object') return 0;
    let merged = 0;
    const current: Record<string, SeasonPreference> = {};
    for (const [key, pref] of Object.entries(this.getAllSeasonRules())) {
      if (UNSAFE_RECORD_KEYS.includes(key)) continue;
      current[key] = pref;
    }
    for (const [key, pref] of Object.entries(rules)) {
      if (UNSAFE_RECORD_KEYS.includes(key) || !key || !pref || typeof pref !== 'object') continue;
      current[key] = pref;
      merged++;
    }
    if (merged > 0) {
      try {
        saveJsonSync(this.seasonRulesFile, current);
        this.seasonRulesCache = current;
      } catch (e) {
        console.error('Failed to merge season rules:', e);
        return 0;
      }
    }
    return merged;
  }

  /**
   * Phase 4 (Documents backup): absolute path of history.json, used to detect
   * a fresh userData install where a backup restore is available but no local
   * playback history exists on disk yet.
   */
  getHistoryFilePath(): string {
    return this.historyFile;
  }
}

export const storage = new StorageService();

// Phase 4: expose the singleton (plus a documents-dir resolver) to
// userDataBackup.ts / watchlistIO.ts via registration instead of a static
// import from their side, so those modules stay free of electron imports and
// can be loaded by plain Node tests.
registerMainServices({
  storage,
  resolveDocumentsDir: () => {
    try {
      return app.getPath('documents');
    } catch {
      return '';
    }
  },
});
