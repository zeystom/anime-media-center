import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { AppSettings, PlaybackProgress, SeasonPreference } from './types';

const DEFAULT_SETTINGS: AppSettings = {
  ffmpegPath: 'C:\\Users\\gogoh\\AppData\\Roaming\\Subtitle Edit\\SpeechToText\\Purfview-Faster-Whisper-XXL\\ffmpeg.exe',
  whisperPath: 'C:\\Users\\gogoh\\AppData\\Roaming\\Subtitle Edit\\SpeechToText\\Purfview-Faster-Whisper-XXL\\faster-whisper-xxl.exe',
  defaultLibraryRoot: 'D:\\films',
  autoPlayNext: true,
  subtitlesFontSize: 28,
  subtitlesOutline: true,
};

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
    try {
      if (fs.existsSync(this.settingsFile)) {
        const raw = fs.readFileSync(this.settingsFile, 'utf-8');
        return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
      }
    } catch (e) {
      console.error('Failed to read settings:', e);
    }
    return { ...DEFAULT_SETTINGS };
  }

  updateSettings(settings: Partial<AppSettings>): AppSettings {
    const current = this.getSettings();
    const updated = { ...current, ...settings };
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
