import { contextBridge, ipcRenderer } from 'electron';
import { AppSettings, PlaybackProgress, SeasonPreference, DiscoverCatalogParams } from './types';

contextBridge.exposeInMainWorld('electronAPI', {
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggle-maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  isWindowMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  onWindowMaximizedChange: (callback: (isMaximized: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, isMaximized: boolean) => callback(isMaximized);
    ipcRenderer.on('window:maximized-change', handler);
    return () => ipcRenderer.removeListener('window:maximized-change', handler);
  },
  getSettings: () => ipcRenderer.invoke('get-settings'),
  updateSettings: (settings: Partial<AppSettings>) => ipcRenderer.invoke('update-settings', settings),
  browseFolder: (defaultPath?: string) => ipcRenderer.invoke('browse-folder', defaultPath),
  browseFile: (options?: { title?: string; defaultPath?: string; extensions?: string[] }) =>
    ipcRenderer.invoke('browse-file', options),
  checkBinaries: (paths?: { ffmpegPath?: string; whisperPath?: string; modelName?: string; customModelPath?: string }) =>
    ipcRenderer.invoke('check-binaries', paths),
  downloadWhisperModel: (modelName: string) => ipcRenderer.invoke('download-whisper-model', modelName),
  cancelWhisperModelDownload: () => ipcRenderer.invoke('cancel-whisper-model-download'),
  onModelDownloadProgress: (callback: (data: { modelName: string; percent: number | null; text: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { modelName: string; percent: number | null; text: string }) => callback(data);
    ipcRenderer.on('whisper:model-download-progress', handler);
    return () => ipcRenderer.removeListener('whisper:model-download-progress', handler);
  },
  onWhisperModelDownloadStatus: (callback: (data: { isDownloading: boolean; modelName: string | null }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { isDownloading: boolean; modelName: string | null }) => callback(data);
    ipcRenderer.on('whisper:model-download-status', handler);
    return () => ipcRenderer.removeListener('whisper:model-download-status', handler);
  },
  onWhisperModelDownloadComplete: (callback: (data: { modelName: string; success: boolean }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { modelName: string; success: boolean }) => callback(data);
    ipcRenderer.on('whisper:model-download-complete', handler);
    return () => ipcRenderer.removeListener('whisper:model-download-complete', handler);
  },
  autoDetectBinaries: () => ipcRenderer.invoke('auto-detect-binaries'),
  openExternalUrl: (url: string) => ipcRenderer.invoke('open-external-url', url),
  getLibraryCache: (rootPath?: string | string[]) => ipcRenderer.invoke('get-library-cache', rootPath),
  scanLibrary: (rootPath?: string | string[]) => ipcRenderer.invoke('scan-library', rootPath),
  getFolderEpisodes: (folderPath: string) => ipcRenderer.invoke('get-folder-episodes', folderPath),
  probeVideo: (filePath: string) => ipcRenderer.invoke('probe-video', filePath),
  extractSubtitleTrack: (
    filePath: string,
    trackId: string,
    trackIndex: number | null,
    isExternal: boolean,
    externalPath?: string
  ) => ipcRenderer.invoke('extract-subtitle-track', filePath, trackId, trackIndex, isExternal, externalPath),
  warmSubtitles: (filePath: string) => ipcRenderer.invoke('subtitles:warm', filePath),
  onSubtitleFontsReady: (callback: (data: { filePath: string; trackIndex: number; fonts: string[] }) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, data: { filePath: string; trackIndex: number; fonts: string[] }) => callback(data);
    ipcRenderer.on('subtitles:fonts-ready', listener);
    return () => ipcRenderer.removeListener('subtitles:fonts-ready', listener);
  },
  savePlaybackProgress: (progress: PlaybackProgress) => ipcRenderer.invoke('save-playback-progress', progress),
  getAllPlaybackProgress: () => ipcRenderer.invoke('get-all-playback-progress'),
  getSeasonPreference: (folderPath: string) => ipcRenderer.invoke('get-season-preference', folderPath),
  saveSeasonPreference: (folderPath: string, pref: SeasonPreference) => ipcRenderer.invoke('save-season-preference', folderPath, pref),
  getStreamUrl: (filePath: string, audioTrackIndex: number, startTime: number) =>
    ipcRenderer.invoke('get-stream-url', filePath, audioTrackIndex, startTime),
  stopVideoStream: () => ipcRenderer.invoke('stop-video-stream'),
  getThumbnailUrl: (filePath: string, time: number) =>
    ipcRenderer.invoke('get-thumbnail-url', filePath, time),
  getAniSkipTimes: (seriesName: string, episodeNum: number, duration: number) =>
    ipcRenderer.invoke('get-aniskip-times', seriesName, episodeNum, duration),
  startWhisperSeason: (folderPath: string, audioTrackNum: number, skipExistingSrt: boolean, options?: any) =>
    ipcRenderer.invoke('start-whisper-season', folderPath, audioTrackNum, skipExistingSrt, options),
  cancelWhisper: () => ipcRenderer.invoke('cancel-whisper'),
  getWhisperStatus: () => ipcRenderer.invoke('get-whisper-status'),
  getAnimeCharacters: (title: string, anilistId?: number) =>
    ipcRenderer.invoke('get-anime-characters', title, anilistId),
  onWhisperLog: (callback: (log: any) => void) => {
    const handler = (_event: any, log: any) => callback(log);
    ipcRenderer.on('whisper-log', handler);
    return () => ipcRenderer.removeListener('whisper-log', handler);
  },
  onWhisperProgress: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('whisper-progress', handler);
    return () => ipcRenderer.removeListener('whisper-progress', handler);
  },
  onWhisperDone: (callback: (result: any) => void) => {
    const handler = (_event: any, result: any) => callback(result);
    ipcRenderer.on('whisper-done', handler);
    return () => ipcRenderer.removeListener('whisper-done', handler);
  },
  onWhisperEpisodeDone: (callback: (data: { fileName: string; filePath: string; index: number; total: number }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('whisper-episode-done', handler);
    return () => ipcRenderer.removeListener('whisper-episode-done', handler);
  },
  openFolderInExplorer: (folderPath: string) => ipcRenderer.invoke('open-folder', folderPath),
  checkDownloadProgress: (filePaths: string[]) => ipcRenderer.invoke('check-download-progress', filePaths),
  setFullScreen: (flag: boolean) => ipcRenderer.invoke('set-fullscreen', flag),
  isFullScreen: () => ipcRenderer.invoke('is-fullscreen'),
  onFullScreenChange: (callback: (isFull: boolean) => void) => {
    const handler = (_event: any, isFull: boolean) => callback(isFull);
    ipcRenderer.on('fullscreen-change', handler);
    return () => ipcRenderer.removeListener('fullscreen-change', handler);
  },
  onRemoteEpisodesUpdated: (callback: (anilistId: number, result: import('./aniZip').RemoteEpisodesResult) => void) => {
    const handler = (_event: any, anilistId: number, result: import('./aniZip').RemoteEpisodesResult) => callback(anilistId, result);
    ipcRenderer.on('metadata:remote-episodes-updated', handler);
    return () => ipcRenderer.removeListener('metadata:remote-episodes-updated', handler);
  },
  warmRemoteEpisodes: (anilistId: number) => {
    ipcRenderer.send('metadata:remote-episodes-warm', anilistId);
  },
  // Catalog & Metadata Service
  getCatalogTrending: () => ipcRenderer.invoke('catalog:trending'),
  getCatalogSeason: () => ipcRenderer.invoke('catalog:season'),
  getCatalogAllTime: () => ipcRenderer.invoke('catalog:all-time'),
  getCatalogGenrePicks: () => ipcRenderer.invoke('catalog:genre-picks'),
  getAiringSchedule: (weekOffset?: number) => ipcRenderer.invoke('catalog:airing-schedule', weekOffset),
  getCatalogRecommendations: (seeds?: number[]) => ipcRenderer.invoke('catalog:recommendations', seeds),
  searchCatalog: (query: string) => ipcRenderer.invoke('catalog:search', query),
  getDiscoverCatalog: (params: DiscoverCatalogParams) => ipcRenderer.invoke('catalog:discover', params),
  getCatalogDetails: (anilistId: number) => ipcRenderer.invoke('catalog:details', anilistId),
  getUpdatedAgeRatings: (): Promise<Record<string, number>> => ipcRenderer.invoke('age-ratings:get-updated'),
  onAgeRatingsUpdated: (callback: (ratings: Record<string, number>) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, ratings: Record<string, number>) => callback(ratings);
    ipcRenderer.on('age-ratings:updated', listener);
    return () => ipcRenderer.removeListener('age-ratings:updated', listener);
  },
  getCatalogFranchise: (anilistId: number) => ipcRenderer.invoke('catalog:franchise', anilistId),
  getRemoteEpisodes: (anilistId: number) => ipcRenderer.invoke('metadata:remote-episodes', anilistId),
  // User Library
  getUserLibrary: () => ipcRenderer.invoke('user-library:get-all'),
  setUserLibraryStatus: (
    anilistId: number,
    idMal: number | null,
    titleSnapshot: string,
    status: string,
    posterUrl?: string | null,
    totalEpisodes?: number | null
  ) => ipcRenderer.invoke('user-library:set-status', anilistId, idMal, titleSnapshot, status, posterUrl, totalEpisodes),
  setUserLibraryScore: (anilistId: number, score: number | null) =>
    ipcRenderer.invoke('user-library:set-score', anilistId, score),
  setUserLibraryProgress: (anilistId: number, progress: number) =>
    ipcRenderer.invoke('user-library:set-progress', anilistId, progress),
  removeUserLibraryEntry: (anilistId: number) =>
    ipcRenderer.invoke('user-library:remove', anilistId),
  // Library storage management (Phase 4)
  getStorageOverview: () => ipcRenderer.invoke('library:storage-overview'),
  getDiskUsage: (folderPath: string) => ipcRenderer.invoke('library:disk-usage', folderPath),
  deleteAnimeFromPC: (folderPath: string) => ipcRenderer.invoke('library:delete-anime', folderPath),
  deleteEpisodesFromPC: (filePaths: string[]) => ipcRenderer.invoke('library:delete-episodes', filePaths),
  // Documents backup (Phase 4)
  getBackupStatus: () => ipcRenderer.invoke('backup:status'),
  backupNow: () => ipcRenderer.invoke('backup:export-now'),
  detectBackupRestore: () => ipcRenderer.invoke('backup:detect-restore'),
  restoreFromBackup: () => ipcRenderer.invoke('backup:restore'),
  // Watchlist import/export (Phase 4)
  browseSaveFile: (options?: { title?: string; defaultPath?: string; extensions?: string[] }) =>
    ipcRenderer.invoke('browse-save-file', options),
  exportWatchlist: (format: string, filePath: string) => ipcRenderer.invoke('watchlist:export', format, filePath),
  importWatchlist: (filePath: string) => ipcRenderer.invoke('watchlist:import', filePath),
  // P2P / BitTorrent (Phase 5, BYOC)
  getP2pState: () => ipcRenderer.invoke('p2p:get-state'),
  acceptP2pConsent: () => ipcRenderer.invoke('p2p:accept-consent'),
  enableP2p: () => ipcRenderer.invoke('p2p:enable'),
  disableP2p: () => ipcRenderer.invoke('p2p:disable'),
  searchReleases: (params: { title: string; aliases?: string[]; anilistId?: number | null; season?: number | null; part?: number | null; episode?: number | null; episodeCount?: number | null; queryOverride?: string }) =>
    ipcRenderer.invoke('p2p:search', params),
  fetchReleaseDescription: (params: { providerId: string; url: string }) =>
    ipcRenderer.invoke('p2p:release-description', params) as Promise<string>,
  addDownload: (params: { item: import('./types').ReleaseSearchResult; title: string; anilistId?: number | null; episode?: number | null; season?: number | null; targetFolder?: string; downloadRoot?: string }) =>
    ipcRenderer.invoke('p2p:add-download', params),
  pauseDownload: (infoHash: string) => ipcRenderer.invoke('p2p:pause', infoHash),
  resumeDownload: (infoHash: string) => ipcRenderer.invoke('p2p:resume', infoHash),
  cancelDownload: (infoHash: string, removeFiles?: boolean) => ipcRenderer.invoke('p2p:cancel', infoHash, removeFiles),
  setP2pLimits: (limits: { maxConcurrent?: number; seedMinutes?: number }) =>
    ipcRenderer.invoke('p2p:set-limits', limits),
  getP2pProviders: () => ipcRenderer.invoke('p2p:get-providers'),
  saveP2pProviders: (providers: import('./types').RssProvider[]) => ipcRenderer.invoke('p2p:save-providers', providers),
  onP2pStateChanged: (callback: (state: import('./types').P2pState) => void) => {
    const handler = (_event: any, state: import('./types').P2pState) => callback(state);
    ipcRenderer.on('p2p-state-changed', handler);
    return () => ipcRenderer.removeListener('p2p-state-changed', handler);
  },
  // Updater
  getAppVersion: () => ipcRenderer.invoke('updater:get-version'),
  getStartupUpdate: () => ipcRenderer.invoke('updater:get-startup-update'),
  getUpdaterState: () => ipcRenderer.invoke('updater:get-state'),
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  onUpdaterStateChanged: (callback: (state: import('./types').UpdaterState) => void) => {
    const handler = (_event: any, state: import('./types').UpdaterState) => callback(state);
    ipcRenderer.on('updater:state-changed', handler);
    return () => ipcRenderer.removeListener('updater:state-changed', handler);
  },
  onStartupUpdateAvailable: (callback: (info: import('./types').UpdateInfoPayload) => void) => {
    const handler = (_event: any, info: import('./types').UpdateInfoPayload) => callback(info);
    ipcRenderer.on('updater:startup-update-available', handler);
    return () => ipcRenderer.removeListener('updater:startup-update-available', handler);
  },
});
