import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { app } from 'electron';
import { AppSettings, PlaybackProgress, SeasonPreference } from './types';

export function findExecutableInPath(exeName: string): string | null {
  try {
    const out = execSync(`where.exe ${exeName}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length > 0 && fs.existsSync(lines[0])) {
      return lines[0];
    }
  } catch {}
  return null;
}

export function autoDetectWhisperPath(): string {
  // 1. Subtitle Edit standard AppData location
  const appData = process.env.APPDATA || '';
  const seWhisper = path.join(appData, 'Subtitle Edit', 'SpeechToText', 'Purfview-Faster-Whisper-XXL', 'faster-whisper-xxl.exe');
  if (fs.existsSync(seWhisper)) return seWhisper;

  // 2. Relative bin directory
  const localBin = path.join(process.cwd(), 'bin', 'faster-whisper-xxl.exe');
  if (fs.existsSync(localBin)) return localBin;

  // 3. User profile and root directory candidates
  const userProfile = process.env.USERPROFILE || '';
  const commonDirs = [
    path.join(userProfile, 'Faster-Whisper-XXL', 'faster-whisper-xxl.exe'),
    path.join(userProfile, 'Downloads', 'Faster-Whisper-XXL', 'faster-whisper-xxl.exe'),
    'C:\\Faster-Whisper-XXL\\faster-whisper-xxl.exe',
    'C:\\Program Files\\Faster-Whisper-XXL\\faster-whisper-xxl.exe',
  ];
  for (const p of commonDirs) {
    if (fs.existsSync(p)) return p;
  }

  // 4. PATH lookup
  const fromPath = findExecutableInPath('faster-whisper-xxl.exe');
  if (fromPath) return fromPath;

  return '';
}

export function autoDetectFfmpegPath(knownWhisperPath?: string): string {
  // 1. Next to whisper executable if present
  if (knownWhisperPath && fs.existsSync(knownWhisperPath)) {
    const siblingFfmpeg = path.join(path.dirname(knownWhisperPath), 'ffmpeg.exe');
    if (fs.existsSync(siblingFfmpeg)) return siblingFfmpeg;
  }

  // 2. Subtitle Edit AppData
  const appData = process.env.APPDATA || '';
  const seFfmpeg = path.join(appData, 'Subtitle Edit', 'SpeechToText', 'Purfview-Faster-Whisper-XXL', 'ffmpeg.exe');
  if (fs.existsSync(seFfmpeg)) return seFfmpeg;

  const seFfmpegDirect = path.join(appData, 'Subtitle Edit', 'ffmpeg.exe');
  if (fs.existsSync(seFfmpegDirect)) return seFfmpegDirect;

  // 3. PATH lookup
  const fromPath = findExecutableInPath('ffmpeg.exe');
  if (fromPath) return fromPath;

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
    if (fs.existsSync(c)) return c;
  }

  return '';
}

export function autoDetectLibraryRoots(): string[] {
  // If D:\films exists, prioritize it
  if (fs.existsSync('D:\\films')) {
    return ['D:\\films'];
  }
  const userProfile = process.env.USERPROFILE || '';
  const videosDir = path.join(userProfile, 'Videos');
  if (fs.existsSync(videosDir)) {
    return [videosDir];
  }
  return [];
}

function getDefaultSettings(): AppSettings {
  const whisper = autoDetectWhisperPath();
  const ffmpeg = autoDetectFfmpegPath(whisper);
  const roots = autoDetectLibraryRoots();

  return {
    ffmpegPath: ffmpeg,
    whisperPath: whisper,
    defaultLibraryRoot: roots[0] || '',
    libraryFolders: roots,
    autoPlayNext: true,
    subtitlesFontSize: 28,
    subtitlesOutline: true,
  };
}

export class StorageService {
  private baseDir: string;
  private settingsFile: string;
  private historyFile: string;
  private seasonRulesFile: string;

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
    const defaults = getDefaultSettings();
    try {
      if (fs.existsSync(this.settingsFile)) {
        const raw = fs.readFileSync(this.settingsFile, 'utf-8');
        const parsed = JSON.parse(raw);
        const res: AppSettings = { ...defaults, ...parsed };

        let changed = false;

        // Verify ffmpeg exists; if not, try auto-detection
        if (!res.ffmpegPath || !fs.existsSync(res.ffmpegPath)) {
          const detectedFfmpeg = autoDetectFfmpegPath(res.whisperPath);
          if (detectedFfmpeg && fs.existsSync(detectedFfmpeg)) {
            res.ffmpegPath = detectedFfmpeg;
            changed = true;
          }
        }

        // Verify whisper exists; if not, try auto-detection
        if (!res.whisperPath || !fs.existsSync(res.whisperPath)) {
          const detectedWhisper = autoDetectWhisperPath();
          if (detectedWhisper && fs.existsSync(detectedWhisper)) {
            res.whisperPath = detectedWhisper;
            changed = true;
          }
        }

        // Verify libraryFolders
        if (!Array.isArray(res.libraryFolders) || res.libraryFolders.length === 0) {
          res.libraryFolders = res.defaultLibraryRoot ? [res.defaultLibraryRoot] : (defaults.libraryFolders || []);
          changed = true;
        }

        // If all configured folders do not exist on this machine, fallback to detected roots
        const currentFolders = res.libraryFolders || [];
        const anyExists = currentFolders.some((f) => fs.existsSync(f));
        if (!anyExists && (defaults.libraryFolders?.length || 0) > 0) {
          res.libraryFolders = defaults.libraryFolders || [];
          changed = true;
        }

        if (!res.defaultLibraryRoot && (res.libraryFolders?.length || 0) > 0) {
          res.defaultLibraryRoot = res.libraryFolders![0];
          changed = true;
        }

        if (changed) {
          try {
            fs.writeFileSync(this.settingsFile, JSON.stringify(res, null, 2), 'utf-8');
          } catch {}
        }

        return res;
      }
    } catch (e) {
      console.error('Failed to read settings:', e);
    }
    return defaults;
  }

  updateSettings(settings: Partial<AppSettings>): AppSettings {
    const current = this.getSettings();
    const updated = { ...current, ...settings };
    if (Array.isArray(updated.libraryFolders) && updated.libraryFolders.length > 0) {
      updated.defaultLibraryRoot = updated.libraryFolders[0];
    }
    try {
      fs.writeFileSync(this.settingsFile, JSON.stringify(updated, null, 2), 'utf-8');
    } catch (e) {
      console.error('Failed to write settings:', e);
    }
    return updated;
  }

  getAllPlaybackProgress(): Record<string, PlaybackProgress> {
    try {
      if (fs.existsSync(this.historyFile)) {
        const raw = fs.readFileSync(this.historyFile, 'utf-8');
        return JSON.parse(raw);
      }
    } catch (e) {
      console.error('Failed to read history:', e);
    }
    return {};
  }

  savePlaybackProgress(progress: PlaybackProgress): void {
    const all = this.getAllPlaybackProgress();
    all[progress.filePath] = progress;
    try {
      fs.writeFileSync(this.historyFile, JSON.stringify(all, null, 2), 'utf-8');
    } catch (e) {
      console.error('Failed to write history:', e);
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
    try {
      let rules: Record<string, SeasonPreference> = {};
      if (fs.existsSync(this.seasonRulesFile)) {
        rules = JSON.parse(fs.readFileSync(this.seasonRulesFile, 'utf-8'));
      }
      rules[folderPath] = pref;
      fs.writeFileSync(this.seasonRulesFile, JSON.stringify(rules, null, 2), 'utf-8');
    } catch (e) {
      console.error('Failed to write season rules:', e);
    }
  }
}

export const storage = new StorageService();
