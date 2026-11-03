export * from '../../electron/types';

export interface StreamInfo {
  url: string;
  actualStartTime: number;
}

export interface ElectronAPI {
  getSettings: () => Promise<import('../../electron/types').AppSettings>;
  updateSettings: (settings: Partial<import('../../electron/types').AppSettings>) => Promise<import('../../electron/types').AppSettings>;
  browseFolder: (defaultPath?: string) => Promise<string | null>;
  browseFile: (options?: { title?: string; defaultPath?: string; extensions?: string[] }) => Promise<string | null>;
  checkBinaries: (paths?: { ffmpegPath?: string; whisperPath?: string }) => Promise<{
    ffmpegExists: boolean;
    whisperExists: boolean;
    modelExists: boolean;
    modelName: string;
  }>;
  autoDetectBinaries: () => Promise<{ ffmpegPath: string; whisperPath: string }>;
  openExternalUrl: (url: string) => Promise<boolean>;
  scanLibrary: (rootPath?: string | string[]) => Promise<import('../../electron/types').AnimeFolder[]>;
  getFolderEpisodes: (folderPath: string) => Promise<import('../../electron/types').Episode[]>;
  probeVideo: (filePath: string) => Promise<import('../../electron/types').VideoMetadata>;
  extractSubtitleTrack: (filePath: string, trackId: string, trackIndex: number | null, isExternal: boolean, externalPath?: string) => Promise<import('../../electron/types').SubtitleTrackPayload>;
  savePlaybackProgress: (progress: import('../../electron/types').PlaybackProgress) => Promise<void>;
  getAllPlaybackProgress: () => Promise<Record<string, import('../../electron/types').PlaybackProgress>>;
  getSeasonPreference: (folderPath: string) => Promise<import('../../electron/types').SeasonPreference | null>;
  saveSeasonPreference: (folderPath: string, pref: import('../../electron/types').SeasonPreference) => Promise<void>;
  getStreamUrl: (filePath: string, audioTrackIndex: number, startTime: number) => Promise<StreamInfo>;
  stopVideoStream: () => Promise<void>;
  getThumbnailUrl: (filePath: string, time: number) => Promise<string>;
  getAniSkipTimes: (seriesName: string, episodeNum: number, duration: number) => Promise<{ op?: { start: number; end: number }; ed?: { start: number; end: number } } | null>;
  startWhisperSeason: (folderPath: string, audioTrackNum: number, skipExistingSrt: boolean) => Promise<{ success: boolean; error?: string }>;
  cancelWhisper: () => Promise<void>;
  getWhisperStatus: () => Promise<import('../../electron/types').WhisperStatus>;
  onWhisperLog: (callback: (log: import('../../electron/types').WhisperLogMessage) => void) => () => void;
  onWhisperProgress: (callback: (data: { currentFile: string; progress: number; queue: import('../../electron/types').WhisperQueueItem[] }) => void) => () => void;
  onWhisperDone: (callback: (result: { completedCount: number; failedCount: number }) => void) => () => void;
  openFolderInExplorer: (folderPath: string) => Promise<void>;
  checkDownloadProgress: (filePaths: string[]) => Promise<Record<string, { isDownloading: boolean; downloadProgress?: number }>>;
  setFullScreen: (flag: boolean) => Promise<boolean>;
  isFullScreen: () => Promise<boolean>;
  onFullScreenChange: (callback: (isFull: boolean) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
