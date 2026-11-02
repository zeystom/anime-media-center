import { contextBridge, ipcRenderer } from 'electron';
import { AppSettings, PlaybackProgress, SeasonPreference } from './types';

contextBridge.exposeInMainWorld('electronAPI', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  updateSettings: (settings: Partial<AppSettings>) => ipcRenderer.invoke('update-settings', settings),
  browseFolder: (defaultPath?: string) => ipcRenderer.invoke('browse-folder', defaultPath),
  browseFile: (options?: { title?: string; defaultPath?: string; extensions?: string[] }) =>
    ipcRenderer.invoke('browse-file', options),
  checkBinaries: (paths?: { ffmpegPath?: string; whisperPath?: string }) =>
    ipcRenderer.invoke('check-binaries', paths),
  autoDetectBinaries: () => ipcRenderer.invoke('auto-detect-binaries'),
  openExternalUrl: (url: string) => ipcRenderer.invoke('open-external-url', url),
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
  startWhisperSeason: (folderPath: string, audioTrackNum: number, skipExistingSrt: boolean) =>
    ipcRenderer.invoke('start-whisper-season', folderPath, audioTrackNum, skipExistingSrt),
  cancelWhisper: () => ipcRenderer.invoke('cancel-whisper'),
  getWhisperStatus: () => ipcRenderer.invoke('get-whisper-status'),
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
  openFolderInExplorer: (folderPath: string) => ipcRenderer.invoke('open-folder', folderPath),
  setFullScreen: (flag: boolean) => ipcRenderer.invoke('set-fullscreen', flag),
  isFullScreen: () => ipcRenderer.invoke('is-fullscreen'),
  onFullScreenChange: (callback: (isFull: boolean) => void) => {
    const handler = (_event: any, isFull: boolean) => callback(isFull);
    ipcRenderer.on('fullscreen-change', handler);
    return () => ipcRenderer.removeListener('fullscreen-change', handler);
  },
});
