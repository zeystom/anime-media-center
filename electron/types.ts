export interface AudioTrack {
  index: number;         // FFmpeg overall stream index (e.g. 1, 2)
  audioIndex: number;    // 0-based audio stream index for -map 0:a:<index> (0, 1...)
  language: string;      // 'eng', 'jpn', etc.
  languageName: string;  // 'English', 'Japanese', etc.
  codec: string;         // 'eac3', 'flac', 'aac', etc.
  title: string;         // e.g. 'English E-AC-3 2.0', 'Japanese FLAC 2.0'
  isDefault: boolean;
}

export interface SubtitleTrack {
  id: string;            // 'ext-<hash>' or 'emb-<index>'
  index: number | null;  // FFmpeg stream index if embedded, null if external
  type: 'external' | 'embedded';
  filePath?: string;     // path to .srt if external or cached
  language: string;      // 'eng', 'jpn', 'spa', etc.
  languageName: string;  // 'English', 'Spanish', etc.
  codec?: string;        // 'subrip', 'ass'
  title: string;         // 'Whisper AI (External)', 'English [CR]', etc.
  isForced: boolean;
  isDefault: boolean;
  isSigns: boolean;      // True if signs, songs, or forced
  isDubtitle: boolean;   // True if dubtitle / dialogue
}

export interface SubtitleCue {
  id: number;
  start: number; // in seconds
  end: number;   // in seconds
  text: string;
}

export interface SubtitleTrackPayload {
  format: 'ass' | 'srt';
  content?: string;
  fonts?: string[];
  port?: number;
  cues?: SubtitleCue[];
}

export interface VideoMetadata {
  filePath: string;
  fileName: string;
  title: string;
  duration: number; // in seconds
  audioTracks: AudioTrack[];
  subtitleTracks: SubtitleTrack[];
  hasExternalSrt: boolean;
  externalSrtPath?: string;
  hasEmbeddedDubtitles?: boolean;
}

export interface Episode {
  filePath: string;
  fileName: string;
  episodeNumber: string; // e.g. 'S01E01' or 'E01'
  title: string;
  size: number;
  duration?: number;
  hasExternalSrt: boolean;
  externalSrtPath?: string;
  hasEmbeddedDubtitles?: boolean;
  thumbnailUrl?: string;
  kitsuThumbnail?: string | null;
  kitsuTitle?: string | null;
  episodeTitle?: string | null;
}

export interface AnimeFolder {
  folderPath: string;
  folderName: string;
  episodes: Episode[];
  hasSubtitlesCount: number;
  hasDubtitlesCount?: number;
  hasEmbeddedDubtitles?: boolean;
  totalEpisodes: number;
}

export interface PlaybackProgress {
  filePath: string;
  folderPath: string;
  fileName: string;
  episodeNumber: string;
  currentTime: number;
  duration: number;
  lastWatchedAt: number;
  completed: boolean;
}

export interface SeasonPreference {
  preferredAudioLanguage: string; // default 'eng'
  preferredAudioIndex?: number;
  mainSubtitleTrackId?: string;   // default prioritizes external or dialogue
  topSubtitleTrackId?: string;    // default signs/forced or null
  topSubEnabled: boolean;
  subSyncOffset: number;          // in seconds (-0.5, 0.5, etc.)
}

export interface AppSettings {
  ffmpegPath: string;
  whisperPath: string;
  defaultLibraryRoot: string;
  autoPlayNext: boolean;
  subtitlesFontSize: number;
  subtitlesOutline: boolean;
}

export interface WhisperQueueItem {
  id: string;
  filePath: string;
  fileName: string;
  duration?: number;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'skipped';
  progress: number;
  speed?: string;
  error?: string;
}

export interface WhisperLogMessage {
  type: 'stdout' | 'stderr' | 'info' | 'error' | 'success';
  text: string;
  timestamp: number;
}

export interface WhisperStatus {
  isRunning: boolean;
  folderPath?: string;
  currentFile: string;
  progress: number;
  queue: WhisperQueueItem[];
  logs: WhisperLogMessage[];
}
