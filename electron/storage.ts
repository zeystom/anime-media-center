import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { app } from 'electron';
import { AppSettings, PlaybackProgress, SeasonPreference } from './types';

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

  // 1. Next to whisper executable if present
  if (knownWhisperPath && fs.existsSync(knownWhisperPath)) {
    const siblingFfmpeg = path.join(path.dirname(knownWhisperPath), 'ffmpeg.exe');
    if (fs.existsSync(siblingFfmpeg)) {
      result = siblingFfmpeg;
    }
  }

  if (!result) {
    // 2. Subtitle Edit AppData
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

export class StorageService {
  private baseDir: string;
  private settingsFile: string;
  private historyFile: string;
  private seasonRulesFile: string;

  private cachedSettings: AppSettings | null = null;
  private settingsMtime: number = 0;

  private historyCache: Record<string, PlaybackProgress> | null = null;
  private historySaveTimer: NodeJS.Timeout | null = null;
  private historyDirty: boolean = false;

  constructor() {
    try {
      this.baseDir = app ? app.getPath('userData') : path.join(process.env.APPDATA || '', 'anime-media-center');
    } catch {
      this.baseDir = path.join(process.env.APPDATA || '', 'anime-media-center');
    }

    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }

    this.settingsFile = path.join(this.baseDir, 'settings.json');
    this.historyFile = path.join(this.baseDir, 'history.json');
    this.seasonRulesFile = path.join(this.baseDir, 'season-rules.json');
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
        if (!ffmpegPath) {
          ffmpegPath = autoDetectFfmpegPath(whisperPath);
        }

        const res: AppSettings = {
          ffmpegPath,
          whisperPath,
          defaultLibraryRoot,
          libraryFolders,
          autoPlayNext: parsed.autoPlayNext ?? true,
          subtitlesFontSize: parsed.subtitlesFontSize ?? 28,
          subtitlesOutline: parsed.subtitlesOutline ?? true,
          hideDownloadingAnime: parsed.hideDownloadingAnime ?? false,
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
      defaultLibraryRoot: roots[0] || '',
      libraryFolders: roots,
      autoPlayNext: true,
      subtitlesFontSize: 28,
      subtitlesOutline: true,
      hideDownloadingAnime: false,
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

    const tmpFile = `${this.settingsFile}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmpFile, JSON.stringify(updated, null, 2), 'utf-8');
      fs.renameSync(tmpFile, this.settingsFile);
      const stat = fs.statSync(this.settingsFile);
      this.settingsMtime = stat.mtimeMs;
      this.cachedSettings = updated;
    } catch (e) {
      console.error('Failed to write settings:', e);
      try {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      } catch {}
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
          fs.renameSync(this.historyFile, `${this.historyFile}.bak`);
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

    const tmpFile = `${this.historyFile}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmpFile, JSON.stringify(this.historyCache, null, 2), 'utf-8');
      fs.renameSync(tmpFile, this.historyFile);
      this.historyDirty = false;
    } catch (e) {
      console.error('Failed to write history:', e);
      try {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      } catch {}
    }
  }

  getSeasonPreference(folderPath: string): SeasonPreference | null {
    try {
      if (fs.existsSync(this.seasonRulesFile)) {
        const raw = fs.readFileSync(this.seasonRulesFile, 'utf-8');
        const rules = JSON.parse(raw);
        return rules[folderPath] || null;
      }
    } catch (e) {
      console.error('Failed to read season rules:', e);
    }
    return null;
  }

  saveSeasonPreference(folderPath: string, pref: SeasonPreference): void {
    const tmpFile = `${this.seasonRulesFile}.${Date.now()}.tmp`;
    try {
      let rules: Record<string, SeasonPreference> = {};
      if (fs.existsSync(this.seasonRulesFile)) {
        try {
          rules = JSON.parse(fs.readFileSync(this.seasonRulesFile, 'utf-8'));
        } catch {}
      }
      rules[folderPath] = pref;
      fs.writeFileSync(tmpFile, JSON.stringify(rules, null, 2), 'utf-8');
      fs.renameSync(tmpFile, this.seasonRulesFile);
    } catch (e) {
      console.error('Failed to write season rules:', e);
      try {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      } catch {}
    }
  }
}

export const storage = new StorageService();
