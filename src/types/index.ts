export * from '../../electron/types';

export type {
  CatalogItem,
  CatalogRelatedTitle,
  AiringEntry,
  CatalogNextAiringEpisode,
  GenrePickRail,
} from '../../electron/catalog';
export type { RemoteEpisodeInfo, RemoteEpisodesResult } from '../../electron/aniZip';
export type { UserLibraryEntry, UserListStatus } from '../../electron/userLibrary';

// Storage overview shapes (implemented by electron/libraryManager.ts — structurally identical)
export interface StorageTitleUsage {
  folderPath: string;
  folderName: string;
  canonicalTitle?: string | null;
  posterUrl?: string | null;
  anilistId?: number | null;
  totalBytes: number;
  episodeCount: number;
}

export interface StorageOverview {
  titles: StorageTitleUsage[];
  totalBytes: number;
  freeBytes: number | null;
}

import type { CatalogItem, CatalogRelatedTitle, AiringEntry, DiscoverCatalogPage, GenrePickRail } from '../../electron/catalog';
import type { RemoteEpisodeInfo, RemoteEpisodesResult } from '../../electron/aniZip';
import type { UserLibraryEntry, UserListStatus } from '../../electron/userLibrary';
import type { P2pState, VpnStatus, ReleaseSearchResult, RssProvider, AppSettings, ReleaseSearchResponse } from '../../electron/types';

export interface StreamInfo {
  url: string;
  actualStartTime: number;
}

export interface ElectronAPI {
  minimizeWindow: () => Promise<void>;
  toggleMaximizeWindow: () => Promise<boolean>;
  closeWindow: () => Promise<void>;
  isWindowMaximized: () => Promise<boolean>;
  onWindowMaximizedChange: (callback: (isMaximized: boolean) => void) => () => void;
  getSettings: () => Promise<import('../../electron/types').AppSettings>;
  updateSettings: (settings: Partial<import('../../electron/types').AppSettings>) => Promise<import('../../electron/types').AppSettings>;
  browseFolder: (defaultPath?: string) => Promise<string | null>;
  browseFile: (options?: { title?: string; defaultPath?: string; extensions?: string[] }) => Promise<string | null>;
  checkBinaries: (paths?: { ffmpegPath?: string; whisperPath?: string; modelName?: string; customModelPath?: string }) => Promise<{
    ffmpegExists: boolean;
    whisperExists: boolean;
    modelExists: boolean;
    modelName: string;
    installedModels?: string[];
    detectedCustomModels?: string[];
    customModelPath?: string;
  }>;
  downloadWhisperModel?: (modelName: string) => Promise<{ success: boolean; modelName?: string; error?: string }>;
  cancelWhisperModelDownload?: () => Promise<boolean>;
  onModelDownloadProgress?: (callback: (data: { modelName: string; percent: number | null; text: string }) => void) => () => void;
  autoDetectBinaries: () => Promise<{ ffmpegPath: string; whisperPath: string }>;
  openExternalUrl: (url: string) => Promise<boolean>;
  getLibraryCache: (rootPath?: string | string[]) => Promise<import('../../electron/types').AnimeFolder[] | null>;
  scanLibrary: (rootPath?: string | string[]) => Promise<import('../../electron/types').AnimeFolder[]>;
  getFolderEpisodes: (folderPath: string) => Promise<import('../../electron/types').Episode[]>;
  probeVideo: (filePath: string) => Promise<import('../../electron/types').VideoMetadata>;
  extractSubtitleTrack: (filePath: string, trackId: string, trackIndex: number | null, isExternal: boolean, externalPath?: string) => Promise<import('../../electron/types').SubtitleTrackPayload>;
  warmSubtitles?: (filePath: string) => Promise<{ success: boolean }>;
  onSubtitleFontsReady?: (callback: (data: { filePath: string; trackIndex: number; fonts: string[] }) => void) => () => void;
  savePlaybackProgress: (progress: import('../../electron/types').PlaybackProgress) => Promise<void>;
  getAllPlaybackProgress: () => Promise<Record<string, import('../../electron/types').PlaybackProgress>>;
  getSeasonPreference: (folderPath: string) => Promise<import('../../electron/types').SeasonPreference | null>;
  saveSeasonPreference: (folderPath: string, pref: import('../../electron/types').SeasonPreference) => Promise<void>;
  getStreamUrl: (filePath: string, audioTrackIndex: number, startTime: number) => Promise<StreamInfo>;
  stopVideoStream: () => Promise<void>;
  getThumbnailUrl: (filePath: string, time: number) => Promise<string>;
  getAniSkipTimes: (seriesName: string, episodeNum: number, duration: number) => Promise<{ op?: { start: number; end: number }; ed?: { start: number; end: number } } | null>;
  startWhisperSeason: (
    folderPath: string,
    audioTrackNum: number,
    skipExistingSrt: boolean,
    options?: import('../../electron/types').WhisperOptions
  ) => Promise<{ success: boolean; error?: string }>;
  cancelWhisper: () => Promise<void>;
  getWhisperStatus: () => Promise<import('../../electron/types').WhisperStatus>;
  getAnimeCharacters: (title: string, anilistId?: number) => Promise<{ id: number; title: string; characters: string[] } | null>;
  onWhisperLog: (callback: (log: import('../../electron/types').WhisperLogMessage) => void) => () => void;
  onWhisperProgress: (callback: (data: {
    currentFile: string;
    progress: number;
    speed?: string;
    queue: import('../../electron/types').WhisperQueueItem[];
    liveCues?: import('../../electron/types').WhisperLiveCue[];
  }) => void) => () => void;
  onWhisperDone: (callback: (result: { completedCount: number; failedCount: number }) => void) => () => void;
  openFolderInExplorer: (folderPath: string) => Promise<void>;
  checkDownloadProgress: (filePaths: string[]) => Promise<Record<string, { isDownloading: boolean; downloadProgress?: number }>>;
  setFullScreen: (flag: boolean) => Promise<boolean>;
  isFullScreen: () => Promise<boolean>;
  onFullScreenChange: (callback: (isFull: boolean) => void) => () => void;
  /** Fired on progressive episodes-pipeline pushes (first snapshot, hedge
   *  page, retries, final) — the payload is delivered with the event. */
  onRemoteEpisodesUpdated: (callback: (anilistId: number, result: RemoteEpisodesResult) => void) => () => void;
  /** Fire-and-forget hover prefetch of the episodes pipeline. */
  warmRemoteEpisodes: (anilistId: number) => void;
  // Catalog & Metadata Service
  getCatalogTrending: () => Promise<CatalogItem[]>;
  getCatalogSeason: () => Promise<CatalogItem[]>;
  getCatalogAllTime: () => Promise<CatalogItem[]>;
  getCatalogGenrePicks: () => Promise<GenrePickRail[]>;
  getAiringSchedule: (weekOffset?: number) => Promise<AiringEntry[]>;
  getCatalogRecommendations: (seeds?: number[]) => Promise<CatalogItem[]>;
  searchCatalog: (query: string) => Promise<CatalogItem[]>;
  getDiscoverCatalog: (params: import('../../electron/types').DiscoverCatalogParams) => Promise<DiscoverCatalogPage>;
  getCatalogDetails: (anilistId: number) => Promise<CatalogItem | null>;
  getUpdatedAgeRatings: () => Promise<Record<string, number>>;
  onAgeRatingsUpdated: (callback: (ratings: Record<string, number>) => void) => () => void;
  getCatalogFranchise: (anilistId: number) => Promise<CatalogRelatedTitle[]>;
  getRemoteEpisodes: (anilistId: number) => Promise<RemoteEpisodesResult>;
  // User Library
  getUserLibrary: () => Promise<Record<number, UserLibraryEntry>>;
  setUserLibraryStatus: (
    anilistId: number,
    idMal: number | null,
    titleSnapshot: string,
    status: UserListStatus,
    posterUrl?: string | null,
    totalEpisodes?: number | null
  ) => Promise<UserLibraryEntry | null>;
  setUserLibraryScore: (anilistId: number, score: number | null) => Promise<UserLibraryEntry | null>;
  setUserLibraryProgress: (anilistId: number, progress: number) => Promise<UserLibraryEntry | null>;
  removeUserLibraryEntry: (anilistId: number) => Promise<boolean>;
  // Library storage management (Phase 4)
  getStorageOverview: () => Promise<StorageOverview>;
  getDiskUsage: (folderPath: string) => Promise<{ totalBytes: number; episodeCount: number }>;
  deleteAnimeFromPC: (folderPath: string) => Promise<{ success: boolean; deletedBytes?: number; error?: string }>;
  deleteEpisodesFromPC: (filePaths: string[]) => Promise<{ success: boolean; deletedBytes?: number; error?: string }>;
  // Documents backup (Phase 4)
  getBackupStatus: () => Promise<{ exists: boolean; path: string; lastSyncedAt?: number; sizeBytes?: number }>;
  backupNow: () => Promise<{ success: boolean; path: string; error?: string }>;
  detectBackupRestore: () => Promise<{ available: boolean; path: string; userDataHistoryMissing: boolean; exportedAt?: number }>;
  restoreFromBackup: () => Promise<{ success: boolean; restored?: { history: number; seasonRules: number; userLibrary: number }; error?: string }>;
  // Watchlist import/export (Phase 4)
  browseSaveFile: (options?: { title?: string; defaultPath?: string; extensions?: string[] }) => Promise<string | null>;
  exportWatchlist: (format: 'json' | 'mal-xml', filePath: string) => Promise<{ success: boolean; count?: number; error?: string }>;
  importWatchlist: (filePath: string) => Promise<{ success: boolean; imported?: number; skipped?: number; error?: string }>;
  // P2P / BitTorrent (Phase 5, BYOC)
  getP2pState: () => Promise<P2pState>;
  acceptP2pConsent: () => Promise<P2pState>;
  enableP2p: () => Promise<{ success: boolean; error?: string }>;
  disableP2p: () => Promise<{ success: boolean }>;
  getVpnStatus: () => Promise<VpnStatus>;
  searchReleases: (params: { title: string; aliases?: string[]; anilistId?: number | null; season?: number | null; part?: number | null; episode?: number | null; episodeCount?: number | null; episodeDurationMinutes?: number | null; queryOverride?: string }) => Promise<ReleaseSearchResponse>;
  fetchReleaseDescription: (params: { providerId: string; url: string }) => Promise<string>;
  addDownload: (params: { item: ReleaseSearchResult; title: string; anilistId?: number | null; episode?: number | null; season?: number | null; targetFolder?: string; downloadRoot?: string }) => Promise<{ success: boolean; infoHash?: string; error?: string }>;
  pauseDownload: (infoHash: string) => Promise<{ success: boolean }>;
  resumeDownload: (infoHash: string) => Promise<{ success: boolean }>;
  cancelDownload: (infoHash: string, removeFiles?: boolean) => Promise<{ success: boolean; error?: string }>;
  setP2pLimits: (limits: { maxConcurrent?: number; downloadSpeedMBps?: number; uploadSpeedMBps?: number; seedMinutes?: number }) => Promise<AppSettings>;
  getP2pProviders: () => Promise<RssProvider[]>;
  saveP2pProviders: (providers: RssProvider[]) => Promise<{ success: boolean; error?: string }>;
  onP2pStateChanged: (callback: (state: P2pState) => void) => () => void;
  // Updater
  getAppVersion: () => Promise<string>;
  getUpdaterState: () => Promise<import('../../electron/types').UpdaterState>;
  checkForUpdates: () => Promise<import('../../electron/types').UpdaterState>;
  downloadUpdate: () => Promise<{ success: boolean; error?: string }>;
  installUpdate: () => Promise<{ success: boolean }>;
  onUpdaterStateChanged: (callback: (state: import('../../electron/types').UpdaterState) => void) => () => void;
  onStartupUpdateAvailable: (callback: (info: import('../../electron/types').UpdateInfoPayload) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
