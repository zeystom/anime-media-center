export * from '../../electron/types';

export interface StreamInfo {
  url: string;
  actualStartTime: number;
}

export interface ElectronAPI {
  getSettings: () => Promise<import('../../electron/types').AppSettings>;
  updateSettings: (settings: Partial<import('../../electron/types').AppSettings>) => Promise<import('../../electron/types').AppSettings>;
  browseFolder: (defaultPath?: string) => Promise<string | null>;
  scanLibrary: (rootPath?: string) => Promise<import('../../electron/types').AnimeFolder[]>;
  getFolderEpisodes: (folderPath: string) => Promise<import('../../electron/types').Episode[]>;
  probeVideo: (filePath: string) => Promise<import('../../electron/types').VideoMetadata>;
  extractSubtitleTrack: (filePath: string, trackId: string, trackIndex: number | null, isExternal: boolean, externalPath?: string) => Promise<import('../../electron/types').SubtitleCue[]>;
  savePlaybackProgress: (progress: import('../../electron/types').PlaybackProgress) => Promise<void>;
  getAllPlaybackProgress: () => Promise<Record<string, import('../../electron/types').PlaybackProgress>>;
  getSeasonPreference: (folderPath: string) => Promise<import('../../electron/types').SeasonPreference | null>;
  saveSeasonPreference: (folderPath: string, pref: import('../../electron/types').SeasonPreference) => Promise<void>;
  getStreamUrl: (filePath: string, audioTrackIndex: number, startTime: number) => Promise<StreamInfo>;
  getThumbnailUrl: (filePath: string, time: number) => Promise<string>;
  startWhisperSeason: (folderPath: string, audioTrackNum: number, skipExistingSrt: boolean) => Promise<{ success: boolean; error?: string }>;
  cancelWhisper: () => Promise<void>;
  onWhisperLog: (callback: (log: import('../../electron/types').WhisperLogMessage) => void) => () => void;
  onWhisperProgress: (callback: (data: { currentFile: string; progress: number; queue: import('../../electron/types').WhisperQueueItem[] }) => void) => () => void;
  onWhisperDone: (callback: (result: { completedCount: number; failedCount: number }) => void) => () => void;
  openFolderInExplorer: (folderPath: string) => Promise<void>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
