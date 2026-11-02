import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { storage } from './storage';
import { streamServer } from './server';
import { probeMkv, extractEmbeddedSubtitle, parseSrt } from './ffmpeg';
import { whisperManager } from './whisper';
import { AnimeFolder, Episode, PlaybackProgress, SeasonPreference } from './types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Crucial: Hardware HEVC Decoding support for Chromium on Windows
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

let mainWindow: BrowserWindow | null = null;

function parseEpisodeNumber(filename: string): string {
  // Try matching S01E02, s1e2, etc.
  const seMatch = filename.match(/s(\d+)e(\d+)/i);
  if (seMatch) {
    return `S${seMatch[1].padStart(2, '0')}E${seMatch[2].padStart(2, '0')}`;
  }

  // Try matching E01, EP01, Episode 01
  const epMatch = filename.match(/(?:ep|episode|e)[.\s_-]*(\d+)/i);
  if (epMatch) {
    return `E${epMatch[1].padStart(2, '0')}`;
  }

  // Try matching standalone numbers like [01] or - 01
  const numMatch = filename.match(/[-_\[\s](\d{2})[-_\]\s]/);
  if (numMatch) {
    return `E${numMatch[1]}`;
  }

  return 'EP';
}

function scanFolderForEpisodes(folderPath: string, port: number): Episode[] {
  if (!fs.existsSync(folderPath)) return [];

  try {
    const files = fs.readdirSync(folderPath);
    const mkvFiles = files.filter((f) => f.toLowerCase().endsWith('.mkv'));
    const srtFiles = new Set(files.filter((f) => f.toLowerCase().endsWith('.srt')));

    const episodes: Episode[] = [];

    for (const file of mkvFiles) {
      const fullPath = path.join(folderPath, file);
      const stat = fs.statSync(fullPath);
      const baseName = path.parse(file).name;
      const epNum = parseEpisodeNumber(file);

      // Check if .srt exists matching this file
      let hasExternalSrt = false;
      let externalSrtPath: string | undefined;

      const directSrt = `${baseName}.srt`;
      if (srtFiles.has(directSrt)) {
        hasExternalSrt = true;
        externalSrtPath = path.join(folderPath, directSrt);
      } else {
        // Find any srt that starts with baseName
        for (const s of srtFiles) {
          if (s.startsWith(baseName)) {
            hasExternalSrt = true;
            externalSrtPath = path.join(folderPath, s);
            break;
          }
        }
      }

      episodes.push({
        filePath: fullPath,
        fileName: file,
        episodeNumber: epNum,
        title: baseName,
        size: stat.size,
        hasExternalSrt,
        externalSrtPath,
        thumbnailUrl: `http://127.0.0.1:${port}/thumb?file=${encodeURIComponent(fullPath)}&time=60`,
      });
    }

    // Sort episodes naturally (E01, E02...)
    episodes.sort((a, b) => a.fileName.localeCompare(b.fileName, undefined, { numeric: true, sensitivity: 'base' }));

    return episodes;
  } catch (err) {
    console.error(`Error scanning folder ${folderPath}:`, err);
    return [];
  }
}

async function createWindow() {
  try {
    // Start local streaming server
    const serverPort = await streamServer.start();

    mainWindow = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 1024,
      minHeight: 700,
      backgroundColor: '#0f0f12',
      title: 'Anime Media Center & Whisper Studio',
      webPreferences: {
        preload: fs.existsSync(path.join(__dirname, 'preload.cjs'))
          ? path.join(__dirname, 'preload.cjs')
          : path.join(__dirname, 'preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: false, // Required for smooth local HTTP Matroska stream playback
      },
    });

    // Setup IPC Handlers (Guarded against duplicate registration)
    setupIpcHandlers();

    // Toggle DevTools with F12 or Ctrl+Shift+I
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
        mainWindow?.webContents.toggleDevTools();
        event.preventDefault();
      }
    });

    // In dev mode, load Vite dev server; in production, load dist index.html
    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      console.error(`[Electron] Page failed to load: (${errorCode}) ${errorDescription}`);
    });

    if (process.env.VITE_DEV_SERVER_URL) {
      mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    } else {
      mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
    }

    mainWindow.on('closed', () => {
      mainWindow = null;
    });
  } catch (err) {
    console.error('Failed to create Electron window:', err);
  }
}

let ipcHandlersSetup = false;
function setupIpcHandlers() {
  if (ipcHandlersSetup) return;
  ipcHandlersSetup = true;

  ipcMain.handle('get-settings', async () => {
    return storage.getSettings();
  });

  ipcMain.handle('update-settings', async (_event, newSettings) => {
    return storage.updateSettings(newSettings);
  });

  ipcMain.handle('browse-folder', async (_event, defaultPath) => {
    const win = mainWindow || BrowserWindow.getFocusedWindow();
    const res = await dialog.showOpenDialog(win || (undefined as any), {
      title: 'Select Anime Folder or Library Root',
      defaultPath: defaultPath || storage.getSettings().defaultLibraryRoot,
      properties: ['openDirectory'],
    });
    if (!res.canceled && res.filePaths.length > 0) {
      return res.filePaths[0];
    }
    return null;
  });

  ipcMain.handle('scan-library', async (_event, rootPath) => {
    const settings = storage.getSettings();
    const targetRoot = rootPath || settings.defaultLibraryRoot;
    const port = streamServer.getPort();

    if (!fs.existsSync(targetRoot)) {
      return [];
    }

    const animeFolders: AnimeFolder[] = [];

    try {
      // 1. Check if the target root itself contains .mkv files
      const rootEpisodes = scanFolderForEpisodes(targetRoot, port);
      if (rootEpisodes.length > 0) {
        animeFolders.push({
          folderPath: targetRoot,
          folderName: path.basename(targetRoot),
          episodes: rootEpisodes,
          hasSubtitlesCount: rootEpisodes.filter((e) => e.hasExternalSrt).length,
          totalEpisodes: rootEpisodes.length,
        });
      }

      // 2. Scan immediate subdirectories
      const entries = fs.readdirSync(targetRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const subFolderPath = path.join(targetRoot, entry.name);
          const episodes = scanFolderForEpisodes(subFolderPath, port);
          if (episodes.length > 0) {
            animeFolders.push({
              folderPath: subFolderPath,
              folderName: entry.name,
              episodes,
              hasSubtitlesCount: episodes.filter((e) => e.hasExternalSrt).length,
              totalEpisodes: episodes.length,
            });
          }
        }
      }
    } catch (err) {
      console.error('Error scanning library:', err);
    }

    return animeFolders;
  });

  ipcMain.handle('get-folder-episodes', async (_event, folderPath) => {
    return scanFolderForEpisodes(folderPath, streamServer.getPort());
  });

  ipcMain.handle('probe-video', async (_event, filePath) => {
    const settings = storage.getSettings();
    return await probeMkv(filePath, settings.ffmpegPath);
  });

  ipcMain.handle('extract-subtitle-track', async (_event, filePath, trackId, trackIndex, isExternal, externalPath) => {
    const settings = storage.getSettings();

    if (isExternal && externalPath && fs.existsSync(externalPath)) {
      const content = fs.readFileSync(externalPath, 'utf-8');
      return parseSrt(content);
    }

    if (trackIndex !== null && trackIndex !== undefined) {
      const content = await extractEmbeddedSubtitle(filePath, trackIndex, settings.ffmpegPath);
      return parseSrt(content);
    }

    return [];
  });

  ipcMain.handle('save-playback-progress', async (_event, progress: PlaybackProgress) => {
    storage.savePlaybackProgress(progress);
  });

  ipcMain.handle('get-all-playback-progress', async () => {
    return storage.getAllPlaybackProgress();
  });

  ipcMain.handle('get-season-preference', async (_event, folderPath: string) => {
    return storage.getSeasonPreference(folderPath);
  });

  ipcMain.handle('save-season-preference', async (_event, folderPath: string, pref: SeasonPreference) => {
    storage.saveSeasonPreference(folderPath, pref);
  });

  ipcMain.handle('get-stream-url', async (_event, filePath: string, audioTrackIndex: number, startTime: number) => {
    const port = streamServer.getPort();
    return `http://127.0.0.1:${port}/stream?file=${encodeURIComponent(filePath)}&audioTrack=${audioTrackIndex}&startTime=${startTime}`;
  });

  ipcMain.handle('get-thumbnail-url', async (_event, filePath: string, time: number) => {
    const port = streamServer.getPort();
    return `http://127.0.0.1:${port}/thumb?file=${encodeURIComponent(filePath)}&time=${time}`;
  });

  ipcMain.handle('start-whisper-season', async (_event, folderPath: string, audioTrackNum: number, skipExistingSrt: boolean) => {
    if (!mainWindow) return { success: false, error: 'No main window' };
    return await whisperManager.startQueue(folderPath, audioTrackNum, skipExistingSrt, mainWindow);
  });

  ipcMain.handle('cancel-whisper', async () => {
    whisperManager.cancel();
  });

  ipcMain.handle('open-folder', async (_event, folderPath: string) => {
    shell.openPath(folderPath);
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  streamServer.stop();
  whisperManager.cancel();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  streamServer.stop();
  whisperManager.cancel();
});
