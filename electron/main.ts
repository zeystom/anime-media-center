import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { storage, autoDetectFfmpegPath, autoDetectWhisperPath } from './storage';
import { streamServer } from './server';
import { probeMkv, extractEmbeddedSubtitle, extractEmbeddedAss, extractEmbeddedFonts, filterFontsForAss, parseSrt, findPrecedingKeyframe, readMkvEmbeddedTitle, readContainerDuration, cleanupOldCaches } from './ffmpeg';
import { whisperManager } from './whisper';
import { findExternalSubtitles } from './subtitles';
import { AnimeFolder, Episode, PlaybackProgress, SeasonPreference, VIDEO_EXTENSIONS } from './types';
import { getKitsuMetadata, fetchAniSkipTimes } from './kitsu';
import { extractEpisodeNumber } from './episodes';
import { checkEpisodeDownloading, isFolderDownloading } from './torrents';
import { getTrending, getPopularSeason, getAllTimePopular, getAiringSchedule, getRecommendations, searchCatalog, getCatalogDetails } from './catalog';
import { fetchAniZipMappings } from './aniZip';
import { userLibrary, UserListStatus } from './userLibrary';
import { computeDiskUsage, computeStorageOverview, deleteAnime, deleteEpisodes } from './libraryManager';
import { syncBackupNow, getBackupStatus, detectRestoreState, restoreFromBackup, scheduleBackupSync } from './userDataBackup';
import { exportWatchlist, importWatchlist, MAL_ONLY_ANILIST_ID_BASE } from './watchlistIO';
import { initTorrentEngine, engineSetEnabled, engineAddDownload, enginePause, engineResume, engineCancel, engineGetState, engineShutdown } from './torrentEngine';
import { detectVpnStatus } from './vpnGuard';
import { searchProviders, rankReleasesForEpisode } from './indexers';

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

async function asyncPool<T, R>(poolLimit: number, array: T[], iteratorFn: (item: T) => Promise<R>): Promise<R[]> {
  const ret: Promise<R>[] = [];
  const executing: Promise<any>[] = [];
  for (const item of array) {
    const p = Promise.resolve().then(() => iteratorFn(item));
    ret.push(p);
    if (poolLimit <= array.length) {
      const e: Promise<any> = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= poolLimit) {
        await Promise.race(executing);
      }
    }
  }
  return Promise.all(ret);
}

function getEffectiveAnimeFolderName(folderPath: string, rootPath?: string): string {
  const base = path.basename(folderPath);
  const parent = path.dirname(folderPath);

  // If directly under root, use base folder name
  if (rootPath && path.resolve(parent) === path.resolve(rootPath)) {
    return base;
  }

  // If base folder name is generic (e.g. "Season 1", "Movie", "Specials", "OVA"), combine with parent
  const isGeneric = /^(?:season\s*\d+|s\d+|part\s*\d+|cour\s*\d+|movie|movies|specials?|ova|oad|extra|bonus)$/i.test(base);
  if (isGeneric) {
    const parentBase = path.basename(parent);
    return `${parentBase} ${base}`;
  }

  return base;
}

interface FolderSubtitleFlags {
  hasDubtitles: boolean;
  hasEmbeddedSubtitles: boolean;
}

const folderSubtitleCache = new Map<string, FolderSubtitleFlags>();

async function checkFolderSubtitles(
  videoFiles: string[],
  folderPath: string,
  ffmpegPath: string
): Promise<FolderSubtitleFlags> {
  if (folderSubtitleCache.has(folderPath)) {
    return folderSubtitleCache.get(folderPath)!;
  }
  const sample = videoFiles.slice(0, 3);
  let foundDub = false;
  let foundSub = false;

  for (const file of sample) {
    try {
      const meta = await probeMkv(path.join(folderPath, file), ffmpegPath);
      if (meta.hasEmbeddedDubtitles) {
        foundDub = true;
      }
      if (
        meta.hasEmbeddedSubtitles ||
        meta.subtitleTracks.some(
          (s) => (s.language === 'eng' || s.language === 'en') && !s.isSigns
        )
      ) {
        foundSub = true;
      }
      if (foundDub && foundSub) break;
    } catch {}
  }

  const result = { hasDubtitles: foundDub, hasEmbeddedSubtitles: foundSub };
  folderSubtitleCache.set(folderPath, result);
  return result;
}

async function scanFolderForEpisodes(folderPath: string, port: number, targetRoot?: string): Promise<Episode[]> {
  if (!fs.existsSync(folderPath)) return [];

  try {
    const files = fs.readdirSync(folderPath);
    const videoFiles = files.filter((f) => VIDEO_EXTENSIONS.some((ext) => f.toLowerCase().endsWith(ext)));
    if (videoFiles.length === 0) {
      return [];
    }

    const srtFiles = new Set(files.filter((f) => f.toLowerCase().endsWith('.srt')));
    const allFilesLower = new Set(files.map((f) => f.toLowerCase()));
    videoFiles.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    const settings = storage.getSettings();
    const { hasDubtitles, hasEmbeddedSubtitles } = await checkFolderSubtitles(
      videoFiles,
      folderPath,
      settings.ffmpegPath
    );

    // Resolve canonical anime folder name (e.g. "Frieren Season 1" instead of "Season 1")
    const folderName = getEffectiveAnimeFolderName(folderPath, targetRoot);
    const kitsuData = await getKitsuMetadata(folderName);

    const history = storage.getAllPlaybackProgress();
    const episodes: Episode[] = [];

    for (const file of videoFiles) {
      const fullPath = path.join(folderPath, file);
      const stat = fs.statSync(fullPath);
      const baseName = path.parse(file).name;
      const { episodeNum, label: epNum } = extractEpisodeNumber(file);
      const dlStatus = checkEpisodeDownloading(fullPath, allFilesLower, stat);

      // Populate episode duration: history cached, or instant container duration
      const cachedProgress = history[fullPath];
      let duration: number | undefined =
        cachedProgress?.duration && cachedProgress.duration > 0
          ? cachedProgress.duration
          : undefined;

      if (!duration) {
        const containerDur = readContainerDuration(fullPath);
        if (containerDur && containerDur > 0) {
          duration = Math.round(containerDur);
        }
      }

      // Check external subtitles using unified finder
      const extSubs = findExternalSubtitles(fullPath);
      const hasExternalSrt = extSubs.length > 0;
      const hasWhisperSrt = extSubs.some((s) => s.isWhisper);
      const externalSrtPath = extSubs[0]?.filePath;

      // Match numeric episode index for Kitsu metadata
      const kitsuEp = episodeNum !== null && kitsuData ? kitsuData.episodes[episodeNum] : null;

      // Extract official embedded MKV container title in <1ms as local fallback
      const embeddedTitle = readMkvEmbeddedTitle(fullPath);
      const officialTitle = kitsuEp?.title || embeddedTitle || null;

      // If standalone movie (1 file) or episode thumbnail missing, fall back to API banner or poster
      const kitsuThumb =
        kitsuEp?.thumbnailUrl ||
        (videoFiles.length === 1 ? kitsuData?.bannerUrl || kitsuData?.posterUrl : null) ||
        null;

      episodes.push({
        filePath: fullPath,
        fileName: file,
        episodeNumber: epNum,
        title: baseName,
        size: stat.size,
        duration,
        hasExternalSrt,
        hasWhisperSrt,
        externalSrtPath,
        hasEmbeddedDubtitles: hasDubtitles,
        hasEmbeddedSubtitles: hasEmbeddedSubtitles,
        thumbnailUrl: `http://127.0.0.1:${port}/thumb?file=${encodeURIComponent(fullPath)}&type=card${duration ? `&duration=${duration}` : ''}`,
        kitsuThumbnail: kitsuThumb,
        kitsuTitle: officialTitle,
        episodeTitle: officialTitle,
        isDownloading: dlStatus.isDownloading,
        downloadProgress: dlStatus.downloadProgress,
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

function findMediaFolders(rootDir: string, maxDepth = 4): string[] {
  const mediaDirs: string[] = [];
  const visited = new Set<string>();
  const ignoredPatterns = /^(?:\$recycle\.bin|system volume information|\.git|\.cache|node_modules|temp|tmp|\.idea|\.vscode)$/i;

  function traverse(currentDir: string, depth: number) {
    if (depth > maxDepth || visited.has(currentDir)) return;
    visited.add(currentDir);

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    // Check if current directory contains any video files (.mkv / .mp4)
    const hasVideo = entries.some(
      (e) => e.isFile() && VIDEO_EXTENSIONS.some((ext) => e.name.toLowerCase().endsWith(ext))
    );
    if (hasVideo) {
      mediaDirs.push(currentDir);
    }

    // Recursively check subdirectories
    if (depth < maxDepth) {
      for (const entry of entries) {
        if (entry.isDirectory() && !ignoredPatterns.test(entry.name)) {
          traverse(path.join(currentDir, entry.name), depth + 1);
        }
      }
    }
  }

  traverse(rootDir, 0);
  return mediaDirs;
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

    // Background 60-day cleanup of old thumbnails & subtitles
    setTimeout(() => {
      try {
        cleanupOldCaches();
      } catch {}
    }, 5000);

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

  // Torrent engine (BYOC): only ever starts when the user enabled P2P and accepted the consent modal.
  initTorrentEngine({
    getSettings: () => storage.getSettings(),
    onState: (state) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('p2p-state-changed', state);
      }
    },
    persistDir: path.join(app.getPath('userData'), 'torrents'),
  });

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
            (m) => m.toLowerCase().includes('large-v3-turbo')
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
        // Recursively find all media directories containing .mkv files up to 4 levels deep
        const discoveredMediaDirs = findMediaFolders(targetRoot, 4);

        const resolved = await asyncPool(3, discoveredMediaDirs, async (folderPath) => {
          if (visitedPaths.has(folderPath)) return null;
          visitedPaths.add(folderPath);

          const episodes = await scanFolderForEpisodes(folderPath, port, targetRoot);
          if (episodes.length === 0) return null;

          const folderFiles = fs.readdirSync(folderPath);
          const folderDl = isFolderDownloading(folderPath, folderFiles, episodes);
          const hasDubtitlesCount = episodes.filter((e) => e.hasEmbeddedDubtitles).length;
          const hasEmbSubCount = episodes.filter((e) => e.hasEmbeddedSubtitles).length;

          const effectiveName = getEffectiveAnimeFolderName(folderPath, targetRoot);
          const kitsuData = await getKitsuMetadata(effectiveName);

          return {
            folderPath,
            folderName: effectiveName,
            episodes,
            isDownloading: folderDl.isDownloading,
            downloadProgress: folderDl.downloadProgress,
            hasSubtitlesCount: episodes.filter((e) => e.hasExternalSrt).length,
            hasWhisperCount: episodes.filter((e) => e.hasWhisperSrt).length,
            hasExtSubCount: episodes.filter((e) => e.hasExternalSrt && !e.hasWhisperSrt).length,
            hasDubtitlesCount,
            hasEmbeddedDubtitles: hasDubtitlesCount > 0,
            hasEmbeddedSubtitles: hasEmbSubCount > 0,
            totalEpisodes: episodes.length,
            posterUrl: kitsuData?.posterUrl || null,
            bannerUrl: kitsuData?.bannerUrl || null,
            canonicalTitle: kitsuData?.canonicalTitle || null,
            anilistId: kitsuData?.anilistId ?? null,
            synopsis: kitsuData?.synopsis || null,
            genres: kitsuData?.genres || [],
            averageScore: kitsuData?.averageScore || null,
          } as AnimeFolder;
        });

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

  ipcMain.handle('check-download-progress', async (_event, filePaths: string[]) => {
    if (!Array.isArray(filePaths) || filePaths.length === 0) return {};
    const results: Record<string, { isDownloading: boolean; downloadProgress?: number }> = {};
    for (const filePath of filePaths) {
      if (!fs.existsSync(filePath)) {
        results[filePath] = { isDownloading: true, downloadProgress: 0 };
        continue;
      }
      try {
        const dir = path.dirname(filePath);
        const filesInDir = new Set(fs.readdirSync(dir).map((f) => f.toLowerCase()));
        const stat = fs.statSync(filePath);
        results[filePath] = checkEpisodeDownloading(filePath, filesInDir, stat);
      } catch {
        results[filePath] = { isDownloading: true };
      }
    }
    return results;
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
      const ext = path.extname(externalPath).toLowerCase();
      if (ext === '.ass' || ext === '.ssa') {
        const rawFonts = await extractEmbeddedFonts(filePath, settings.ffmpegPath, port);
        const fonts = filterFontsForAss(content, rawFonts);
        return {
          format: 'ass',
          content,
          fonts,
          port,
          cues: [],
        };
      }
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
    scheduleBackupSync();
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

  // ---- Catalog & Metadata Service (global AniList catalog + remote episode lists) ----
  ipcMain.handle('catalog:trending', async () => {
    return getTrending();
  });

  ipcMain.handle('catalog:season', async () => {
    return getPopularSeason();
  });

  ipcMain.handle('catalog:all-time', async () => {
    return getAllTimePopular();
  });

  ipcMain.handle('catalog:airing-schedule', async (_event, weekOffset?: number) => {
    return getAiringSchedule(Number.isFinite(weekOffset) ? Number(weekOffset) : 0);
  });

  ipcMain.handle('catalog:recommendations', async (_event, seeds?: number[]) => {
    // Personal seed = titles the user is watching or has completed in their local user library.
    const librarySeeds = Object.values(userLibrary.getAll())
      .filter((e) => (e.status === 'watching' || e.status === 'completed') && e.anilistId < MAL_ONLY_ANILIST_ID_BASE)
      .map((e) => e.anilistId);
    const effectiveSeeds = Array.isArray(seeds) && seeds.length > 0 ? seeds : librarySeeds;
    if (effectiveSeeds.length === 0) return [];
    return getRecommendations(effectiveSeeds);
  });

  ipcMain.handle('catalog:search', async (_event, query: string) => {
    return searchCatalog(query);
  });

  ipcMain.handle('catalog:details', async (_event, anilistId: number) => {
    return getCatalogDetails(anilistId);
  });

  ipcMain.handle('metadata:remote-episodes', async (_event, anilistId: number) => {
    return fetchAniZipMappings(anilistId);
  });

  // ---- User Library (watching/completed/planning/dropped statuses + scores) ----
  ipcMain.handle('user-library:get-all', async () => {
    return userLibrary.getAll();
  });

  ipcMain.handle('user-library:set-status', async (_event, anilistId: number, idMal: number | null, titleSnapshot: string, status: UserListStatus) => {
    return userLibrary.setStatus(anilistId, idMal, titleSnapshot, status);
  });

  ipcMain.handle('user-library:set-score', async (_event, anilistId: number, score: number | null) => {
    return userLibrary.setScore(anilistId, score);
  });

  ipcMain.handle('user-library:set-progress', async (_event, anilistId: number, progress: number) => {
    return userLibrary.setProgress(anilistId, progress);
  });

  // ---- Library storage management (explicit user-driven deletion, no auto-cleanup) ----
  ipcMain.handle('library:storage-overview', async () => {
    const settings = storage.getSettings();
    const roots = Array.isArray(settings.libraryFolders) ? settings.libraryFolders : [];
    return computeStorageOverview(roots);
  });

  ipcMain.handle('library:disk-usage', async (_event, folderPath: string) => {
    return computeDiskUsage(folderPath);
  });

  ipcMain.handle('library:delete-anime', async (_event, folderPath: string) => {
    const settings = storage.getSettings();
    const roots = Array.isArray(settings.libraryFolders) ? settings.libraryFolders : [];
    return deleteAnime(folderPath, { allowedRoots: roots });
  });

  ipcMain.handle('library:delete-episodes', async (_event, filePaths: string[]) => {
    const settings = storage.getSettings();
    const roots = Array.isArray(settings.libraryFolders) ? settings.libraryFolders : [];
    return deleteEpisodes(filePaths, { allowedRoots: roots });
  });

  // ---- Documents backup (Documents/AnimeCenter/user_library_backup.json) ----
  ipcMain.handle('backup:status', async () => {
    return getBackupStatus();
  });

  ipcMain.handle('backup:export-now', async () => {
    return syncBackupNow();
  });

  ipcMain.handle('backup:detect-restore', async () => {
    return detectRestoreState();
  });

  ipcMain.handle('backup:restore', async () => {
    return restoreFromBackup();
  });

  // ---- Watchlist export/import (AnimeCenter JSON + MAL XML) ----
  ipcMain.handle('browse-save-file', async (_event, options?: { title?: string; defaultPath?: string; extensions?: string[] }) => {
    const win = mainWindow || BrowserWindow.getFocusedWindow();
    const filters =
      options?.extensions && options.extensions.length > 0
        ? [
            { name: 'Allowed Files', extensions: options.extensions },
            { name: 'All Files (*.*)', extensions: ['*'] },
          ]
        : [{ name: 'All Files (*.*)', extensions: ['*'] }];
    const res = await dialog.showSaveDialog(win || (undefined as any), {
      title: options?.title || 'Save File',
      defaultPath: options?.defaultPath,
      filters,
    });
    if (!res.canceled && res.filePath) {
      return res.filePath;
    }
    return null;
  });

  ipcMain.handle('watchlist:export', async (_event, format: 'json' | 'mal-xml', filePath: string) => {
    return exportWatchlist(format, filePath);
  });

  ipcMain.handle('watchlist:import', async (_event, filePath: string) => {
    return importWatchlist(filePath);
  });

  // ---- P2P / BitTorrent (BYOC — user-provided indexers, engine opt-in only) ----
  ipcMain.handle('p2p:get-state', async () => {
    return engineGetState();
  });

  ipcMain.handle('p2p:accept-consent', async () => {
    storage.updateSettings({ p2pConsentAcceptedAt: Date.now() });
    return engineGetState();
  });

  ipcMain.handle('p2p:enable', async () => {
    return engineSetEnabled(true);
  });

  ipcMain.handle('p2p:disable', async () => {
    return engineSetEnabled(false);
  });

  ipcMain.handle('p2p:vpn-status', async () => {
    return detectVpnStatus();
  });

  ipcMain.handle('p2p:search', async (_event, params: { title: string; anilistId?: number | null; season?: number | null; episode?: number | null }) => {
    const settings = storage.getSettings();
    const providers = (Array.isArray(settings.rssProviders) ? settings.rssProviders : []).filter((p) => p.enabled);
    const query = (params && typeof params.title === 'string') ? params.title : '';
    if (!query.trim() || providers.length === 0) return [];
    const results = await searchProviders(providers, { query, season: params?.season ?? null, episode: params?.episode ?? null });
    return rankReleasesForEpisode(results, {
      animeTitle: query,
      season: params?.season ?? null,
      episode: params?.episode ?? null,
    });
  });

  ipcMain.handle('p2p:add-download', async (_event, params) => {
    return engineAddDownload(params || ({} as any));
  });

  ipcMain.handle('p2p:pause', async (_event, infoHash: string) => {
    return enginePause(infoHash);
  });

  ipcMain.handle('p2p:resume', async (_event, infoHash: string) => {
    return engineResume(infoHash);
  });

  ipcMain.handle('p2p:cancel', async (_event, infoHash: string, removeFiles?: boolean) => {
    return engineCancel(infoHash, Boolean(removeFiles));
  });

  ipcMain.handle('p2p:set-limits', async (_event, limits: { maxConcurrent?: number; downloadSpeedMBps?: number; uploadSpeedMBps?: number; seedMinutes?: number }) => {
    const patch: Record<string, number> = {};
    if (limits && typeof limits.maxConcurrent === 'number' && Number.isFinite(limits.maxConcurrent)) patch.maxConcurrentDownloads = Math.max(1, Math.min(6, Math.round(limits.maxConcurrent)));
    if (limits && typeof limits.downloadSpeedMBps === 'number' && Number.isFinite(limits.downloadSpeedMBps)) patch.downloadSpeedLimitMBps = Math.max(0, limits.downloadSpeedMBps);
    if (limits && typeof limits.uploadSpeedMBps === 'number' && Number.isFinite(limits.uploadSpeedMBps)) patch.uploadSpeedLimitMBps = Math.max(0, limits.uploadSpeedMBps);
    if (limits && typeof limits.seedMinutes === 'number' && Number.isFinite(limits.seedMinutes)) patch.seedMinutesAfterComplete = Math.max(0, limits.seedMinutes);
    return storage.updateSettings(patch);
  });

  ipcMain.handle('p2p:get-providers', async () => {
    return storage.getSettings().rssProviders || [];
  });

  ipcMain.handle('p2p:save-providers', async (_event, providers) => {
    storage.updateSettings({ rssProviders: Array.isArray(providers) ? providers : [] });
    return { success: true };
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  storage.flushHistory();
  userLibrary.flush();
  streamServer.stop();
  whisperManager.cancel();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  storage.flushHistory();
  userLibrary.flush();
  syncBackupNow();
  engineShutdown();
  streamServer.stop();
  whisperManager.cancel();
});
