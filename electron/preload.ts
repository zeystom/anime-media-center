import { contextBridge, ipcRenderer } from 'electron';
import { AppSettings, PlaybackProgress, SeasonPreference } from './types';

contextBridge.exposeInMainWorld('electronAPI', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  updateSettings: (settings: Partial<AppSettings>) => ipcRenderer.invoke('update-settings', settings),
  browseFolder: (defaultPath?: string) => ipcRenderer.invoke('browse-folder', defaultPath),
  scanLibrary: (rootPath?: string) => ipcRenderer.invoke('scan-library', rootPath),
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
  getThumbnailUrl: (filePath: string, time: number) =>
    ipcRenderer.invoke('get-thumbnail-url', filePath, time),
  startWhisperSeason: (folderPath: string, audioTrackNum: number, skipExistingSrt: boolean) =>
    ipcRenderer.invoke('start-whisper-season', folderPath, audioTrackNum, skipExistingSrt),
  cancelWhisper: () => ipcRenderer.invoke('cancel-whisper'),
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
});
