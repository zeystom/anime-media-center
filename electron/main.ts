import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from 'electron';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { storage, autoDetectFfmpegPath, autoDetectWhisperPath } from './storage';
import { resolveUserDataPath } from './userDataPath';
import { streamServer } from './server';
import { probeMkv, extractEmbeddedSubtitle, extractEmbeddedAss, extractEmbeddedFonts, getFolderHash, getCachedFolderFonts, filterFontsForAss, parseSrt, readMkvEmbeddedTitle, readContainerDuration, cleanupOldCaches } from './ffmpeg';
import { whisperManager } from './whisper';
import { findExternalSubtitles } from './subtitles';
import { AnimeFolder, Episode, PlaybackProgress, SeasonPreference, VIDEO_EXTENSIONS, ReleaseSearchResult, ProviderReport, DiscoverCatalogParams } from './types';
import { getKitsuMetadata, fetchAniSkipTimes } from './kitsu';
import { extractEpisodeNumber } from './episodes';
import { parseReleaseCore } from '../src/lib/releaseParser/regexEngine.ts';
import { checkEpisodeDownloading, isFolderDownloading } from './torrents';
import { getTrending, getPopularSeason, getAllTimePopular, getAiringSchedule, getRecommendations, getGenrePicks, getDiscoverCatalog, searchCatalog, getCatalogDetails, getCatalogFranchise } from './catalog';
import { queryAnimeCharacters } from './anilist';
import { fetchRemoteEpisodes, isAniZipCacheFresh, setRemoteEpisodesUpdateListener } from './aniZip';
import { warmFribbIndex } from './fribb';
import { userLibrary, UserListStatus } from './userLibrary';
import { getUpdatedAgeRatings, startAgeRatingsUpdater } from './ageRatings';
import { computeDiskUsage, computeStorageOverview, deleteAnime, deleteEpisodes } from './libraryManager';
import { syncBackupNow, getBackupStatus, detectRestoreState, restoreFromBackup, scheduleBackupSync } from './userDataBackup';
import { exportWatchlist, importWatchlist, MAL_ONLY_ANILIST_ID_BASE } from './watchlistIO';
import { initTorrentEngine, engineSetEnabled, engineAddDownload, enginePause, engineResume, engineCancel, engineGetState, engineShutdown } from './torrentEngine';
import { searchProviders, rankReleasesForEpisode, isExplicitEpisodeMismatch, explicitReleasePart, isExplicitPartMismatch, getEpisodeReleaseSizeWarning, sanitizeSearchQuery, extractInfoHash, fetchReleaseDescription, inspectReleaseResults, computeTitleRelevance } from './indexers';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;

// Short-lived p2p search cache (provider fetches + description inspection are
// episode-independent; draining a season queue fires one search per episode).
const SEARCH_CACHE_TTL_MS = 120_000;
const searchResultCache = new Map<string, { inspected: ReleaseSearchResult[]; reports: ProviderReport[]; fetchedAt: number }>();

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

function isBonusVideoFile(fileName: string): boolean {
  const parsed = parseReleaseCore(fileName)
  return parsed.releaseType === 'NCOP' || parsed.releaseType === 'NCED' ||
    /(?:^|[ ._()[\]-])(?:creditless|ncop|nced|opening|ending|trailer|preview|teaser|promo|pv|cm)(?:$|[ ._()[\]-])/i.test(fileName)
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
    const videoFiles = files.filter((f) =>
      VIDEO_EXTENSIONS.some((ext) => f.toLowerCase().endsWith(ext)) && !isBonusVideoFile(f)
    );
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
      const hasExternalDub = extSubs.some((s) => s.isDubtitle);
      const externalSrtPath = extSubs[0]?.filePath;

      // Match numeric episode index for Kitsu metadata
      const kitsuEp = episodeNum !== null && kitsuData ? kitsuData.episodes[episodeNum] : null;

      // Extract official embedded MKV container title in <1ms as local fallback
      const embeddedTitle = readMkvEmbeddedTitle(fullPath);
      const cleanOfficialTitle = (value: string | null | undefined): string | null => {
        const title = value?.trim();
        if (!title || title.length > 120 || /[\[\]]/.test(title) || /[\u3040-\u30ff\u3400-\u9fff]/u.test(title)) return null;
        // Container titles sometimes contain the raw release filename instead
        // of an episode name (e.g. [NF WebRip 2160p H265 ...]). Never surface
        // those technical tags as the official title in the library UI.
        if (/\b(?:2160p|1080p|720p|480p|web[- ]?rip|web[- ]?dl|bluray|bdrip|h\.?265|x265|hevc|e[- ]?ac[- ]?3|multi[- ]audio|dual[- ]audio|netflix|repack|proper)\b/i.test(title)) return null;
        return title;
      };
      const officialTitle = cleanOfficialTitle(kitsuEp?.title) || cleanOfficialTitle(embeddedTitle);

      // Episode stills stay episode-specific. A single file may be an
      // incomplete season download, so never substitute the series poster.
      const kitsuThumb = kitsuEp?.thumbnailUrl || null;

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
        hasEmbeddedDubtitles: hasDubtitles || hasExternalDub,
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
  const ignoredPatterns = /^(?:\.anime-center-staging|\$recycle\.bin|system volume information|\.git|\.cache|node_modules|temp|tmp|\.idea|\.vscode)$/i;

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

    // Start the local server in the background while the bootstrap window is visible.
    void streamServer.start().catch((error) => {
      console.error('[Electron] Failed to start local streaming server:', error);
    });

    // Disable application menu completely to remove File, Edit, View, Window, Help
    Menu.setApplicationMenu(null);

    const startup = app as typeof app & {
      __kaikoStartupSplash?: BrowserWindow;
      __kaikoStartupShownAt?: number;
    };
    mainWindow = startup.__kaikoStartupSplash || new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 1024,
      minHeight: 700,
      show: false,
      paintWhenInitiallyHidden: true,
      backgroundColor: '#09080f',
      title: 'Kaiko',
      icon: appIcon,
      autoHideMenuBar: true, // Auto-hide menu bar on Windows/Linux
      // Hide the system title bar so the renderer can draw glass-styled window
      // controls that share the live Navbar backdrop.
      titleBarStyle: 'hidden',
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
    if (process.platform === 'win32' && appIcon) {
      const relaunchPath = app.isPackaged ? process.execPath : path.join(app.getAppPath(), 'Kaiko.exe');
      mainWindow.setAppDetails({
        appId: 'com.animemediacenter.app',
        appIconPath: appIcon,
        relaunchCommand: `"${relaunchPath}"`,
        relaunchDisplayName: 'Kaiko',
      });
    }
    // Bootstrap already sized the reused window to the display work area.
    // Maximizing a hidden HWND here can expose it before Chromium paints.

    // Monitor child processes for hardware GPU recovery
    app.on('child-process-gone', (_event: any, details: any) => {
      console.warn('[Electron] Child process gone:', details.type, details.reason);
    });

    mainWindow.setMenu(null);
    mainWindow.removeMenu();

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

    // Keep this single native window on the animated startup page for at least
    // 2.3 seconds, then navigate the same WebContents to the app UI.
    const elapsed = startup.__kaikoStartupShownAt ? Date.now() - startup.__kaikoStartupShownAt : 2300;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, 2300 - elapsed)));
    if (process.env.VITE_DEV_SERVER_URL) {
      await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    } else {
      await mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
    }

    // The startup animation and the main UI intentionally share one
    // WebContents. Remove the splash document from Chromium's Back/Forward
    // stack, otherwise a mouse Back click can restore the splash page and
    // leave the user staring at a loading screen instead of the app.
    if (!mainWindow.isDestroyed()) mainWindow.webContents.navigationHistory.clear();

    // Refresh the local age-rating index in the background. On first install
    // this starts immediately; the renderer keeps its bundled snapshot until
    // the fresh copy is ready.
    startAgeRatingsUpdater((ratings) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('age-ratings:updated', ratings);
      }
    });

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

  ipcMain.handle('age-ratings:get-updated', () => getUpdatedAgeRatings());

  // Torrent engine (BYOC): only ever starts when the user enabled P2P and accepted the consent modal.
  initTorrentEngine({
    getSettings: () => storage.getSettings(),
    onState: (state) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('p2p-state-changed', state);
      }
    },
    persistDir: path.join(resolveUserDataPath(), 'torrents'),
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

  ipcMain.handle('get-library-cache', async (_event, rootPath?: string | string[]) => {
    const settings = storage.getSettings();
    const roots = Array.isArray(rootPath) && rootPath.length > 0
      ? rootPath
      : typeof rootPath === 'string' && rootPath.trim()
        ? [rootPath.trim()]
        : Array.isArray(settings.libraryFolders) && settings.libraryFolders.length > 0
          ? settings.libraryFolders
          : settings.defaultLibraryRoot ? [settings.defaultLibraryRoot] : [];
    const cached = storage.getLibraryCache(roots);
    if (!cached) return null;
    const port = streamServer.getPort();
    // The local media server chooses its port at runtime, so refresh cached
    // thumbnail URLs without touching any media on the library drive.
    return cached.map((folder) => ({
      ...folder,
      episodes: folder.episodes.map((episode) => ({
        ...episode,
        thumbnailUrl: `http://127.0.0.1:${port}/thumb?file=${encodeURIComponent(episode.filePath)}&type=card${episode.duration ? `&duration=${episode.duration}` : ''}`,
      })),
    }));
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
          // Bind folder metadata to an AniList entry that can hold every
          // scanned file: rebroadcast/extended editions share their title
          // with shorter originals (Haruhi 2006 14-ep vs the 2009 28-ep).
          const maxEpisodeNumber = episodes.reduce((max, ep) => {
            const n = parseInt(String(ep?.episodeNumber ?? ''), 10);
            return Number.isFinite(n) && n > max ? n : max;
          }, 0);
          const kitsuData = await getKitsuMetadata(
            effectiveName,
            maxEpisodeNumber > 0 ? maxEpisodeNumber : episodes.length || null
          );

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

    storage.saveLibraryCache(uniqueRoots, animeFolders);
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
      const content = await fs.promises.readFile(externalPath, 'utf-8');
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
          fontsPending: false,
        };
      }
      return {
        format: 'srt',
        port,
        cues: parseSrt(content),
        fontsPending: false,
      };
    }

    if (trackIndex !== null && trackIndex !== undefined) {
      // Check if this track is ASS/SSA (probeMkv uses in-memory cache, instant)
      const metadata = await probeMkv(filePath, settings.ffmpegPath);
      const track = metadata.subtitleTracks.find((t) => t.index === trackIndex);
      const isAss = track && /ass|ssa/i.test(track.codec || '');

      if (isAss) {
        const folderHash = getFolderHash(filePath);
        const cachedFonts = getCachedFolderFonts(folderHash, port);
        const assContentPromise = extractEmbeddedAss(filePath, trackIndex, settings.ffmpegPath);

        // Fast path 1: Folder fonts are already cached! (0 ms font delay)
        if (cachedFonts.length > 0) {
          const assContent = await assContentPromise;
          const fonts = filterFontsForAss(assContent, cachedFonts);
          return {
            format: 'ass',
            content: assContent,
            fonts,
            port,
            cues: [],
            fontsPending: false,
          };
        }

        // Fast path 2: File has no font attachments
        if (metadata.hasFontAttachments === false) {
          const assContent = await assContentPromise;
          return {
            format: 'ass',
            content: assContent,
            fonts: [],
            port,
            cues: [],
            fontsPending: false,
          };
        }

        // Slow path: First time opening this release without cache
        const fontsPromise = extractEmbeddedFonts(filePath, settings.ffmpegPath, port);

        // Race font extraction with a fast 150ms deadline
        const fontRace = await Promise.race([
          fontsPromise.then((rawFonts) => ({ done: true as const, rawFonts })),
          new Promise<{ done: false }>((resolve) => setTimeout(() => resolve({ done: false }), 150)),
        ]);

        const assContent = await assContentPromise;

        if (fontRace.done) {
          const fonts = filterFontsForAss(assContent, fontRace.rawFonts);
          return {
            format: 'ass',
            content: assContent,
            fonts,
            port,
            cues: [],
            fontsPending: false,
          };
        }

        // Two-phase: return ASS content now so video and subtitles start immediately!
        // When fonts finish, send IPC event 'subtitles:fonts-ready' to enhance styling in place
        fontsPromise
          .then((rawFonts) => {
            const fonts = filterFontsForAss(assContent, rawFonts);
            if (fonts.length > 0) {
              for (const win of BrowserWindow.getAllWindows()) {
                if (!win.isDestroyed()) {
                  win.webContents.send('subtitles:fonts-ready', { filePath, trackIndex, fonts });
                }
              }
            }
          })
          .catch(() => {});

        return {
          format: 'ass',
          content: assContent,
          fonts: [],
          port,
          cues: [],
          fontsPending: true,
        };
      } else {
        const content = await extractEmbeddedSubtitle(filePath, trackIndex, settings.ffmpegPath);
        return {
          format: 'srt',
          port,
          cues: parseSrt(content),
          fontsPending: false,
        };
      }
    }

    return {
      format: 'srt',
      port,
      cues: [],
      fontsPending: false,
    };
  });

  ipcMain.handle('subtitles:warm', async (_event, filePath: string) => {
    if (!filePath || typeof filePath !== 'string' || !fs.existsSync(filePath)) {
      return { success: false };
    }
    const settings = storage.getSettings();
    const port = streamServer.getPort();
    try {
      const metadata = await probeMkv(filePath, settings.ffmpegPath);
      if (!metadata || !metadata.subtitleTracks) return { success: false };

      const mainTrack =
        metadata.subtitleTracks.find((s) => !s.isSigns && (s.language === 'eng' || s.language === 'en')) ||
        metadata.subtitleTracks.find((s) => s.type === 'embedded');

      if (mainTrack && mainTrack.index !== null) {
        const isAss = /ass|ssa/i.test(mainTrack.codec || '');
        if (isAss) {
          await Promise.all([
            extractEmbeddedAss(filePath, mainTrack.index, settings.ffmpegPath),
            metadata.hasFontAttachments !== false
              ? extractEmbeddedFonts(filePath, settings.ffmpegPath, port)
              : Promise.resolve([]),
          ]);
        }
      }
      return { success: true };
    } catch {
      return { success: false };
    }
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
    // FFmpeg already seeks to the closest preceding keyframe when the stream
    // starts. Spawning a second FFmpeg process to probe that keyframe made
    // every button/timeline seek wait on disk and often returned bad PTS math.
    const actualStartTime = Math.max(0, Number.isFinite(startTime) ? startTime : 0);
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

  ipcMain.handle('start-whisper-season', async (_event, folderPath: string, audioTrackNum: number, skipExistingSrt: boolean, options?: any) => {
    if (!mainWindow) return { success: false, error: 'No main window' };
    return await whisperManager.startQueue(folderPath, audioTrackNum, skipExistingSrt, mainWindow, options);
  });

  ipcMain.handle('cancel-whisper', async () => {
    whisperManager.cancel();
  });

  ipcMain.handle('get-whisper-status', async () => {
    return whisperManager.getStatus();
  });

  ipcMain.handle('get-anime-characters', async (_event, title: string, anilistId?: number) => {
    if (anilistId && Number.isFinite(anilistId) && anilistId > 0) {
      const byId = await queryAnimeCharacters(anilistId);
      if (byId && byId.characters.length > 0) return byId;
    }
    if (title && title.trim()) {
      return await queryAnimeCharacters(title.trim());
    }
    return null;
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

  ipcMain.handle('catalog:genre-picks', async () => {
    return getGenrePicks();
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

  ipcMain.handle('catalog:discover', async (_event, params: DiscoverCatalogParams) => {
    const librarySeeds = Object.values(userLibrary.getAll())
      .filter((entry) => (entry.status === 'watching' || entry.status === 'completed') && entry.anilistId < MAL_ONLY_ANILIST_ID_BASE)
      .map((entry) => entry.anilistId);
    return getDiscoverCatalog(params, librarySeeds);
  });

  ipcMain.handle('catalog:details', async (_event, anilistId: number) => {
    return getCatalogDetails(anilistId);
  });

  ipcMain.handle('catalog:franchise', async (_event, anilistId: number) => {
    return getCatalogFranchise(anilistId);
  });

  ipcMain.handle('metadata:remote-episodes', async (_event, anilistId: number) => {
    return fetchRemoteEpisodes(anilistId);
  });

  // The episodes pipeline pushes progressive payloads: the first usable
  // snapshot arrives within ~1 s, retries/Kitsu pages push further updates.
  setRemoteEpisodesUpdateListener((anilistId, result) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('metadata:remote-episodes-updated', anilistId, result);
    }
  });

  // Hover-prefetch: warm the pipeline while the cursor rests on a card.
  // Debounce lives in the renderer; here a fresh-cache skip + a small interval
  // guard keep a rail sweep from producing any network traffic.
  let lastWarmStartedAt = 0;
  ipcMain.on('metadata:remote-episodes-warm', (_event, anilistId: number) => {
    const id = Math.trunc(Number(anilistId));
    if (!Number.isFinite(id) || id <= 0) return;
    if (isAniZipCacheFresh(id)) return;
    if (Date.now() - lastWarmStartedAt < 700) return;
    lastWarmStartedAt = Date.now();
    void fetchRemoteEpisodes(id).catch(() => {});
  });

  const fribbWarmTimer = setTimeout(() => void warmFribbIndex(), 5000);
  fribbWarmTimer.unref?.();

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
    // Persist the opt-in so the engine's settings gate (enableP2P + consent) passes
    storage.updateSettings({ enableP2P: true });
    return engineSetEnabled(true);
  });

  ipcMain.handle('p2p:disable', async () => {
    storage.updateSettings({ enableP2P: false });
    return engineSetEnabled(false);
  });

  ipcMain.handle('p2p:search', async (_event, params: {
    title: string
    aliases?: string[]
    anilistId?: number | null
    season?: number | null
    part?: number | null
    episode?: number | null
    episodeCount?: number | null
    episodeDurationMinutes?: number | null
    queryOverride?: string
  }) => {
    const settings = storage.getSettings();
    const providers = (Array.isArray(settings.rssProviders) ? settings.rssProviders : []).filter((p) => p.enabled);
    if (providers.length === 0) return { results: [], reports: [], queries: [] };
    const title = params && typeof params.title === 'string' ? params.title : '';
    const titlePart = explicitReleasePart(title);
    const requestedPart = Number.isInteger(params?.part) && Number(params.part) > 0 ? Number(params.part) : titlePart;
    // Build the query set: manual override wins; otherwise the sanitized
    // primary title plus romaji/english aliases (max 3 queries). Romaji and
    // English titles carry most Nyaa releases, so CJK aliases sort below them
    // and the 3-query cap can never drop the main title.
    const override = params && typeof params.queryOverride === 'string' ? params.queryOverride : '';
    const isCjk = (value: string) => /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(value);
    const rawCandidates = override.trim()
      ? [override]
      : [title, ...(Array.isArray(params?.aliases) ? (params.aliases as string[]) : [])];
    const candidates = override.trim()
      ? rawCandidates
      : [
          ...rawCandidates.filter((value) => !!value && !isCjk(value)),
          ...rawCandidates.filter((value) => !!value && isCjk(value)),
        ];
    const queries: string[] = [];
    for (const candidate of candidates) {
      const sanitized = sanitizeSearchQuery(candidate || '');
      if (sanitized && !queries.includes(sanitized)) queries.push(sanitized);
      if (queries.length >= 3) break;
    }
    if (queries.length === 0) return { results: [], reports: [], queries: [] };
    const refs = [title, ...(Array.isArray(params?.aliases) ? (params.aliases as string[]) : [])];
    const withRelevance = (list: ReleaseSearchResult[]) =>
      list.map((release) => ({ ...release, titleRelevance: computeTitleRelevance(release.title, refs) }));

    // Short-lived cache: draining a season queue fires one search per episode,
    // and provider fetches + description inspections are the expensive part
    // (they are episode-independent). Ranking and episode-dependent filters
    // re-run per request below.
    const cacheKey = queries.join(' || ');
    let cached = searchResultCache.get(cacheKey);
    if (!cached || Date.now() - cached.fetchedAt > SEARCH_CACHE_TTL_MS) {
      // Search every query across all enabled providers, merging and deduping by infoHash.
      const allResults: ReleaseSearchResult[] = [];
      const attemptReports: ProviderReport[] = [];
      const seen = new Set<string>();
      for (const query of queries) {
        const { results, reports } = await searchProviders(providers, {
          query,
          season: params?.season ?? null,
          part: requestedPart,
          episode: params?.episode ?? null,
        });
        for (const result of results) {
          const key = extractInfoHash(result.downloadUrl) || `${result.title.toLowerCase()}|${result.sizeBytes ?? ''}`;
          if (seen.has(key)) continue;
          seen.add(key);
          allResults.push(result);
        }
        attemptReports.push(...reports);
      }
      // One report per provider across queries: an ok report wins, otherwise keep the first error.
      const reportByProvider = new Map<string, ProviderReport>();
      for (const report of attemptReports) {
        const existing = reportByProvider.get(report.providerId);
        if (!existing || (!existing.ok && report.ok)) reportByProvider.set(report.providerId, report);
      }
      // Wrong-show results (titleRelevance 'none') are dropped BEFORE the
      // description inspection so its request budget is spent on the right
      // show only.
      const relevant = withRelevance(rankReleasesForEpisode(allResults, {
        animeTitle: title,
        season: params?.season ?? null,
        part: requestedPart,
        episode: params?.episode ?? null,
      })).filter((release) => release.titleRelevance !== 'none');
      // Feed metadata is frequently incomplete. Inspect the strongest candidates
      // before ranking so automatic mode cannot mistake an unknown track list for
      // a confirmed English dub/sub release.
      const inspectedResults = await inspectReleaseResults(relevant, providers, 40);
      cached = { inspected: inspectedResults, reports: [...reportByProvider.values()], fetchedAt: Date.now() };
      searchResultCache.set(cacheKey, cached);
      if (searchResultCache.size > 24) {
        const oldest = [...searchResultCache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)[0];
        if (oldest) searchResultCache.delete(oldest[0]);
      }
    }
    // Per-request ranking of the cached inspected set for THIS episode, then
    // the episode-dependent filter (explicit wrong-episode titles).
    const ranked = withRelevance(rankReleasesForEpisode(cached.inspected, {
      animeTitle: title,
      season: params?.season ?? null,
      part: requestedPart,
      episode: params?.episode ?? null,
    }));
    const compatible = ranked.filter((release) =>
      !isExplicitPartMismatch(release, requestedPart) &&
      (params?.episode == null || !isExplicitEpisodeMismatch(release, params.episode))
    );
    console.log(`[P2P] search "${queries.join('" / "')}" -> ${compatible.length} compatible results (${ranked.length - compatible.length} wrong-part/episode result(s) skipped)`);
    const annotated = compatible.map((release) => ({
      ...release,
      sizeWarning: params?.episode != null
        ? getEpisodeReleaseSizeWarning(release.sizeBytes, params?.episodeDurationMinutes, release.title)
        : null,
    }))
    const results = [
      ...annotated.filter((release) => !release.sizeWarning),
      ...annotated.filter((release) => !!release.sizeWarning),
    ]
    return {
      results,
      reports: cached.reports,
      queries,
      skippedWrongEpisodeCount: ranked.length - compatible.length,
    };
  });

  ipcMain.handle('p2p:add-download', async (_event, params) => {
    return engineAddDownload(params || ({} as any));
  });

  ipcMain.handle('p2p:release-description', async (_event, params: { providerId?: string; url?: string }) => {
    const settings = storage.getSettings();
    return fetchReleaseDescription(
      typeof params?.providerId === 'string' ? params.providerId : '',
      typeof params?.url === 'string' ? params.url : '',
      Array.isArray(settings.rssProviders) ? settings.rssProviders : [],
    );
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
    // Provider URLs are part of the search environment. Discard old failures
    // immediately so a corrected indexer can be retried without restarting.
    searchResultCache.clear();
    return { success: true };
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  storage.flushHistory();
  userLibrary.flush();
  streamServer.stop();
  whisperManager.cancel();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  storage.flushHistory();
  userLibrary.flush();
  syncBackupNow();
  engineShutdown();
  streamServer.stop();
  whisperManager.cancel();
});
