import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { storage } from './storage';
import { streamServer } from './server';
import { probeMkv, extractEmbeddedSubtitle, extractEmbeddedAss, extractEmbeddedFonts, filterFontsForAss, parseSrt, findPrecedingKeyframe } from './ffmpeg';
import { whisperManager } from './whisper';
import { AnimeFolder, Episode, PlaybackProgress, SeasonPreference } from './types';
import { getKitsuMetadata } from './kitsu';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Disable DirectComposition video hardware overlays (MPO) to prevent mailbox desync & black screen crashes on UI hovers
app.commandLine.appendSwitch('disable-direct-composition-video-overlays');
app.commandLine.appendSwitch('disable-features', 'DirectCompositionVideoOverlays');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

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

const dubtitleFolderCache = new Map<string, boolean>();

async function checkFolderHasDubtitles(firstMkvPath: string, ffmpegPath: string): Promise<boolean> {
  const folder = path.dirname(firstMkvPath);
  if (dubtitleFolderCache.has(folder)) {
    return dubtitleFolderCache.get(folder)!;
  }
  try {
    const meta = await probeMkv(firstMkvPath, ffmpegPath);
    const hasDub = Boolean(meta.hasEmbeddedDubtitles);
    dubtitleFolderCache.set(folder, hasDub);
    return hasDub;
  } catch (e) {
    dubtitleFolderCache.set(folder, false);
    return false;
  }
}

async function scanFolderForEpisodes(folderPath: string, port: number): Promise<Episode[]> {
  if (!fs.existsSync(folderPath)) return [];

  try {
    const files = fs.readdirSync(folderPath);
    const mkvFiles = files.filter((f) => f.toLowerCase().endsWith('.mkv'));
    const srtFiles = new Set(files.filter((f) => f.toLowerCase().endsWith('.srt')));

    mkvFiles.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    const settings = storage.getSettings();
    let hasDubtitles = false;
    if (mkvFiles.length > 0) {
      hasDubtitles = await checkFolderHasDubtitles(path.join(folderPath, mkvFiles[0]), settings.ffmpegPath);
    }

    // Attempt to fetch Kitsu anime metadata in parallel (or from local cache)
    const folderName = path.basename(folderPath);
    const kitsuData = await getKitsuMetadata(folderName);

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

      // Match numeric episode index for Kitsu metadata
      const numMatch =
        file.match(/s\d+e(\d+)/i) ||
        file.match(/\b(?:e|ep|episode)[_.\s-]*(\d+)\b/i) ||
        file.match(/\b\d+x(\d+)\b/i) ||
        file.match(/[-_.\s](\d{1,3})[-_.\s]/);
      const numericIndex = numMatch ? parseInt(numMatch[1], 10) : null;
      const kitsuEp = numericIndex !== null && kitsuData ? kitsuData.episodes[numericIndex] : null;

      episodes.push({
        filePath: fullPath,
        fileName: file,
        episodeNumber: epNum,
        title: baseName,
        size: stat.size,
        hasExternalSrt,
        externalSrtPath,
        hasEmbeddedDubtitles: hasDubtitles,
        thumbnailUrl: `http://127.0.0.1:${port}/thumb?file=${encodeURIComponent(fullPath)}&type=card`,
        kitsuThumbnail: kitsuEp?.thumbnailUrl || null,
        kitsuTitle: kitsuEp?.title || null,
        episodeTitle: kitsuEp?.title || null,
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
    // Set AppUserModelId for Windows taskbar & Start Menu integration
    if (process.platform === 'win32') {
      app.setAppUserModelId('com.animemediacenter.app');
    }

    // Determine custom application icon
    const iconIco = path.join(__dirname, '../app-icon.ico');
    const iconPng = path.join(__dirname, '../app-icon.png');
    const appIcon = fs.existsSync(iconIco) ? iconIco : fs.existsSync(iconPng) ? iconPng : undefined;

    // Start local streaming server
    const serverPort = await streamServer.start();

    // Disable application menu completely to remove File, Edit, View, Window, Help
    Menu.setApplicationMenu(null);

    mainWindow = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 1024,
      minHeight: 700,
      backgroundColor: '#0f0f12',
      title: 'Anime Media Center & Whisper Studio',
      icon: appIcon,
      autoHideMenuBar: true, // Auto-hide menu bar on Windows/Linux
      webPreferences: {
        preload: fs.existsSync(path.join(__dirname, 'preload.cjs'))
          ? path.join(__dirname, 'preload.cjs')
          : path.join(__dirname, 'preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: false, // Required for smooth local HTTP Matroska stream playback
        backgroundThrottling: false,
      },
    });

    // Monitor child processes for hardware GPU recovery
    app.on('child-process-gone', (_event: any, details: any) => {
      console.warn('[Electron] Child process gone:', details.type, details.reason);
    });

    mainWindow.setMenu(null);
    mainWindow.removeMenu();

    // Setup IPC Handlers (Guarded against duplicate registration)
    setupIpcHandlers();

    // Toggle DevTools with F12 or Ctrl+Shift+I
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
        mainWindow?.webContents.toggleDevTools();
        event.preventDefault();
      }
    });

    // Forward renderer console to Node terminal
    mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      console.log(`[Renderer] [${level}] ${message} (${sourceId}:${line})`);
    });

    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      console.error('[Electron] Render process gone:', details.reason, details.exitCode);
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
      const rootEpisodes = await scanFolderForEpisodes(targetRoot, port);
      if (rootEpisodes.length > 0) {
        const hasDubtitlesCount = rootEpisodes.filter((e) => e.hasEmbeddedDubtitles).length;
        animeFolders.push({
          folderPath: targetRoot,
          folderName: path.basename(targetRoot),
          episodes: rootEpisodes,
          hasSubtitlesCount: rootEpisodes.filter((e) => e.hasExternalSrt).length,
          hasDubtitlesCount,
          hasEmbeddedDubtitles: hasDubtitlesCount > 0,
          totalEpisodes: rootEpisodes.length,
        });
      }

      // 2. Scan immediate subdirectories
      const entries = fs.readdirSync(targetRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const subFolderPath = path.join(targetRoot, entry.name);
          const episodes = await scanFolderForEpisodes(subFolderPath, port);
          if (episodes.length > 0) {
            const hasDubtitlesCount = episodes.filter((e) => e.hasEmbeddedDubtitles).length;
            animeFolders.push({
              folderPath: subFolderPath,
              folderName: entry.name,
              episodes,
              hasSubtitlesCount: episodes.filter((e) => e.hasExternalSrt).length,
              hasDubtitlesCount,
              hasEmbeddedDubtitles: hasDubtitlesCount > 0,
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
    return await scanFolderForEpisodes(folderPath, streamServer.getPort());
  });

  ipcMain.handle('probe-video', async (_event, filePath) => {
    const settings = storage.getSettings();
    return await probeMkv(filePath, settings.ffmpegPath);
  });

  ipcMain.handle('stop-video-stream', async () => {
    streamServer.stopActiveStreams();
    return { success: true };
  });

  ipcMain.handle('extract-subtitle-track', async (_event, filePath, trackId, trackIndex, isExternal, externalPath) => {
    const settings = storage.getSettings();
    const port = streamServer.getPort();

    if (isExternal && externalPath && fs.existsSync(externalPath)) {
      const content = fs.readFileSync(externalPath, 'utf-8');
      return {
        format: 'srt',
        port,
        cues: parseSrt(content),
      };
    }

    if (trackIndex !== null && trackIndex !== undefined) {
      // Check if this track is ASS/SSA
      const metadata = await probeMkv(filePath, settings.ffmpegPath);
      const track = metadata.subtitleTracks.find((t) => t.index === trackIndex);
      const isAss = track && /ass|ssa/i.test(track.codec || '');

      if (isAss) {
        const [assContent, rawFonts] = await Promise.all([
          extractEmbeddedAss(filePath, trackIndex, settings.ffmpegPath),
          extractEmbeddedFonts(filePath, settings.ffmpegPath, port),
        ]);
        const fonts = filterFontsForAss(assContent, rawFonts);
        return {
          format: 'ass',
          content: assContent,
          fonts,
          port,
          cues: [],
        };
      } else {
        const content = await extractEmbeddedSubtitle(filePath, trackIndex, settings.ffmpegPath);
        return {
          format: 'srt',
          port,
          cues: parseSrt(content),
        };
      }
    }

    return {
      format: 'srt',
      port,
      cues: [],
    };
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
    const settings = storage.getSettings();
    const actualStartTime = await findPrecedingKeyframe(filePath, startTime, settings.ffmpegPath);
    const port = streamServer.getPort();
    // Pass the keyframe-aligned actualStartTime to the server, not the raw startTime.
    // This ensures FFmpeg seeks to the exact same keyframe that actualStartTime represents,
    // preventing timestamp misalignment between the stream and the UI.
    const url = `http://127.0.0.1:${port}/stream?file=${encodeURIComponent(filePath)}&audioTrack=${audioTrackIndex}&startTime=${actualStartTime}&_t=${Date.now()}`;
    return {
      url,
      actualStartTime,
    };
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

  ipcMain.handle('get-whisper-status', async () => {
    return whisperManager.getStatus();
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
