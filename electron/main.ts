import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { storage, autoDetectFfmpegPath, autoDetectWhisperPath } from './storage';
import { streamServer } from './server';
import { probeMkv, extractEmbeddedSubtitle, extractEmbeddedAss, extractEmbeddedFonts, filterFontsForAss, parseSrt, findPrecedingKeyframe, readMkvEmbeddedTitle } from './ffmpeg';
import { whisperManager } from './whisper';
import { AnimeFolder, Episode, PlaybackProgress, SeasonPreference } from './types';
import { getKitsuMetadata, fetchAniSkipTimes } from './kitsu';

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
    if (mkvFiles.length === 0) {
      return [];
    }

    const srtFiles = new Set(files.filter((f) => f.toLowerCase().endsWith('.srt')));
    mkvFiles.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    const settings = storage.getSettings();
    const hasDubtitles = await checkFolderHasDubtitles(path.join(folderPath, mkvFiles[0]), settings.ffmpegPath);

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

      // Extract official embedded MKV container title in <1ms as local fallback
      const embeddedTitle = readMkvEmbeddedTitle(fullPath);
      const officialTitle = kitsuEp?.title || embeddedTitle || null;

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
        kitsuTitle: officialTitle,
        episodeTitle: officialTitle,
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

    // Open in maximized windowed mode (fills screen while keeping Windows taskbar visible)
    mainWindow.maximize();
    mainWindow.once('ready-to-show', () => {
      mainWindow?.maximize();
    });

    // Notify renderer of native window fullscreen transitions
    mainWindow.on('enter-full-screen', () => {
      mainWindow?.webContents.send('fullscreen-change', true);
    });
    mainWindow.on('leave-full-screen', () => {
      mainWindow?.webContents.send('fullscreen-change', false);
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

  ipcMain.handle('browse-file', async (_event, options?: { title?: string; defaultPath?: string; extensions?: string[] }) => {
    const win = mainWindow || BrowserWindow.getFocusedWindow();
    const filters =
      options?.extensions && options.extensions.length > 0
        ? [
            { name: 'Allowed Files', extensions: options.extensions },
            { name: 'All Files (*.*)', extensions: ['*'] },
          ]
        : [
            { name: 'Executable Files (*.exe)', extensions: ['exe'] },
            { name: 'All Files (*.*)', extensions: ['*'] },
          ];

    const res = await dialog.showOpenDialog(win || (undefined as any), {
      title: options?.title || 'Select Executable File',
      defaultPath: options?.defaultPath,
      filters,
      properties: ['openFile'],
    });
    if (!res.canceled && res.filePaths.length > 0) {
      return res.filePaths[0];
    }
    return null;
  });

  ipcMain.handle('check-binaries', async (_event, paths?: { ffmpegPath?: string; whisperPath?: string }) => {
    const settings = storage.getSettings();
    const ffmpegPath = paths?.ffmpegPath !== undefined ? paths.ffmpegPath : settings.ffmpegPath;
    const whisperPath = paths?.whisperPath !== undefined ? paths.whisperPath : settings.whisperPath;

    const ffmpegExists = Boolean(ffmpegPath && fs.existsSync(ffmpegPath));
    const whisperExists = Boolean(whisperPath && fs.existsSync(whisperPath));

    let modelExists = false;
    const modelName = 'large-v3-turbo';
    if (whisperExists) {
      const modelsDir = path.join(path.dirname(whisperPath), '_models');
      if (fs.existsSync(modelsDir)) {
        try {
          const files = fs.readdirSync(modelsDir);
          modelExists = files.some(
            (m) => m.toLowerCase().includes('large-v3-turbo') || m.toLowerCase().includes('large')
          );
        } catch {}
      }
    }

    return {
      ffmpegExists,
      whisperExists,
      modelExists,
      modelName,
    };
  });

  ipcMain.handle('auto-detect-binaries', async () => {
    const whisperPath = autoDetectWhisperPath();
    const ffmpegPath = autoDetectFfmpegPath(whisperPath);
    return {
      ffmpegPath,
      whisperPath,
    };
  });

  ipcMain.handle('open-external-url', async (_event, url: string) => {
    if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
      await shell.openExternal(url);
      return true;
    }
    return false;
  });

  ipcMain.handle('scan-library', async (_event, rootPath?: string | string[]) => {
    const settings = storage.getSettings();
    let targetRoots: string[] = [];

    if (Array.isArray(rootPath) && rootPath.length > 0) {
      targetRoots = rootPath;
    } else if (typeof rootPath === 'string' && rootPath.trim().length > 0) {
      targetRoots = [rootPath.trim()];
    } else if (Array.isArray(settings.libraryFolders) && settings.libraryFolders.length > 0) {
      targetRoots = settings.libraryFolders;
    } else if (settings.defaultLibraryRoot) {
      targetRoots = [settings.defaultLibraryRoot];
    } else {
      targetRoots = [];
    }

    const uniqueRoots = Array.from(new Set(targetRoots.map((r) => path.resolve(r))));
    const port = streamServer.getPort();
    const animeFolders: AnimeFolder[] = [];
    const visitedPaths = new Set<string>();

    for (const targetRoot of uniqueRoots) {
      if (!fs.existsSync(targetRoot)) {
        continue;
      }

      try {
        // 1. Check if the target root itself contains .mkv files
        if (!visitedPaths.has(targetRoot)) {
          const rootEpisodes = await scanFolderForEpisodes(targetRoot, port);
          if (rootEpisodes.length > 0) {
            visitedPaths.add(targetRoot);
            const hasDubtitlesCount = rootEpisodes.filter((e) => e.hasEmbeddedDubtitles).length;
            const kitsuData = await getKitsuMetadata(path.basename(targetRoot));
            animeFolders.push({
              folderPath: targetRoot,
              folderName: path.basename(targetRoot),
              episodes: rootEpisodes,
              hasSubtitlesCount: rootEpisodes.filter((e) => e.hasExternalSrt).length,
              hasDubtitlesCount,
              hasEmbeddedDubtitles: hasDubtitlesCount > 0,
              totalEpisodes: rootEpisodes.length,
              posterUrl: kitsuData?.posterUrl || null,
              bannerUrl: kitsuData?.bannerUrl || null,
              canonicalTitle: kitsuData?.canonicalTitle || null,
              synopsis: kitsuData?.synopsis || null,
              genres: kitsuData?.genres || [],
              averageScore: kitsuData?.averageScore || null,
            });
          }
        }

        // 2. Scan immediate subdirectories concurrently in parallel
        const entries = fs.readdirSync(targetRoot, { withFileTypes: true });
        const dirEntries = entries.filter((e) => e.isDirectory());
        const subFolderPromises = dirEntries.map(async (entry) => {
          const subFolderPath = path.join(targetRoot, entry.name);
          if (visitedPaths.has(subFolderPath)) return null;

          const episodes = await scanFolderForEpisodes(subFolderPath, port);
          if (episodes.length > 0) {
            visitedPaths.add(subFolderPath);
            const hasDubtitlesCount = episodes.filter((e) => e.hasEmbeddedDubtitles).length;
            const kitsuData = await getKitsuMetadata(entry.name);
            return {
              folderPath: subFolderPath,
              folderName: entry.name,
              episodes,
              hasSubtitlesCount: episodes.filter((e) => e.hasExternalSrt).length,
              hasDubtitlesCount,
              hasEmbeddedDubtitles: hasDubtitlesCount > 0,
              totalEpisodes: episodes.length,
              posterUrl: kitsuData?.posterUrl || null,
              bannerUrl: kitsuData?.bannerUrl || null,
              canonicalTitle: kitsuData?.canonicalTitle || null,
              synopsis: kitsuData?.synopsis || null,
              genres: kitsuData?.genres || [],
              averageScore: kitsuData?.averageScore || null,
            } as AnimeFolder;
          }
          return null;
        });

        const resolved = await Promise.all(subFolderPromises);
        for (const item of resolved) {
          if (item) animeFolders.push(item);
        }
      } catch (err) {
        console.error(`Error scanning library at ${targetRoot}:`, err);
      }
    }

    // Sort folders naturally so titles across different drives display cleanly
    animeFolders.sort((a, b) =>
      a.folderName.localeCompare(b.folderName, undefined, { sensitivity: 'base', numeric: true })
    );

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
      // Check if this track is ASS/SSA (probeMkv uses in-memory cache, instant)
      const metadata = await probeMkv(filePath, settings.ffmpegPath);
      const track = metadata.subtitleTracks.find((t) => t.index === trackIndex);
      const isAss = track && /ass|ssa/i.test(track.codec || '');

      if (isAss) {
        // Fast ASS extraction with input packet discard + embedded fonts extraction
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

  ipcMain.handle('get-aniskip-times', async (_event, seriesName: string, episodeNum: number, duration: number) => {
    return await fetchAniSkipTimes(seriesName, episodeNum, duration);
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

  ipcMain.handle('set-fullscreen', async (_event, fullscreen: boolean) => {
    if (!mainWindow) return false;
    mainWindow.setFullScreen(fullscreen);
    if (!fullscreen) {
      mainWindow.maximize();
    }
    return mainWindow.isFullScreen();
  });

  ipcMain.handle('is-fullscreen', async () => {
    return mainWindow ? mainWindow.isFullScreen() : false;
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
