import React, { lazy, Suspense, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { AlertCircle, X } from 'lucide-react';
import { Navbar } from './components/Navbar';
import { HomeView } from './components/Home/HomeView';
import type { DetailSource } from './components/AnimeDetail/AnimeDetailView';
import { CompletionPrompt, CompletionPromptData } from './components/common/CompletionPrompt';
import { AnimeFolder, Episode, AppSettings, PlaybackProgress, UserLibraryEntry, P2pState, UpdateInfoPayload } from './types';
import { useLocalStatus } from './hooks/useLocalStatus';
import { ToastProvider, showGlobalToast } from './components/Toast';
import { getPathBasename, getPathDirname, formatFileSize, cleanSeriesTitle, cleanEpisodeTitle } from './utils/format';
import { toRailItem } from './hooks/useCatalog';
import type { RailItem } from './hooks/useCatalog';
import type { AppNotification, FavouriteAnime, FollowedAnime } from './types/notifications';
import { UpdatePromptModal } from './components/UpdatePromptModal';

const AnimeDetailView = lazy(() => import('./components/AnimeDetail/AnimeDetailView').then((module) => ({ default: module.AnimeDetailView })));
const VideoPlayer = lazy(() => import('./components/Player/VideoPlayer').then((module) => ({ default: module.VideoPlayer })));
const WhisperStudio = lazy(() => import('./components/WhisperStudio/WhisperStudio').then((module) => ({ default: module.WhisperStudio })));
const SettingsModal = lazy(() => import('./components/SettingsModal').then((module) => ({ default: module.SettingsModal })));
const DiscoverView = lazy(() => import('./components/Home/DiscoverView').then((module) => ({ default: module.DiscoverView })));
const FolderBrowser = lazy(() => import('./components/Library/FolderBrowser').then((module) => ({ default: module.FolderBrowser })));
const ScheduleView = lazy(() => import('./components/Schedule/ScheduleView').then((module) => ({ default: module.ScheduleView })));
const DownloadsView = lazy(() => import('./components/Downloads/DownloadsView').then((module) => ({ default: module.DownloadsView })));

interface CompletionPromptState extends CompletionPromptData {
  folderPath: string;
}

function findLastWatchedFolder(
  folders: AnimeFolder[],
  history: Record<string, PlaybackProgress>
): AnimeFolder | null {
  if (folders.length === 0) return null;

  const historyList = Object.values(history)
    .filter((h) => h.lastWatchedAt && h.lastWatchedAt > 0)
    .sort((a, b) => b.lastWatchedAt - a.lastWatchedAt);

  if (historyList.length > 0) {
    for (const recent of historyList) {
      if (recent.folderPath) {
        const match = folders.find(
          (f) => f.folderPath.toLowerCase() === recent.folderPath.toLowerCase()
        );
        if (match) return match;
      }
      if (recent.filePath) {
        const match = folders.find((f) =>
          f.episodes.some((e) => e.filePath.toLowerCase() === recent.filePath.toLowerCase())
        );
        if (match) return match;
      }
    }
  }

  return folders[0];
}

const NOTIFICATIONS_STORAGE_KEY = 'anime-center.notifications.v1';
const AIRING_WATCH_STORAGE_KEY = 'anime-center.airing-watch.v1';
const FOLLOWED_ANIME_STORAGE_KEY = 'anime-center.followed-anime.v1';
const FAVOURITE_ANIME_STORAGE_KEY = 'kaiko.favourite-anime.v1';

function readNotifications(): AppNotification[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(NOTIFICATIONS_STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed.slice(0, 200) : [];
  } catch {
    return [];
  }
}

function readFollowedAnime(): FollowedAnime[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(FOLLOWED_ANIME_STORAGE_KEY) || '[]');
    return Array.isArray(parsed)
      ? parsed.filter((item) => item && Number.isInteger(item.anilistId) && typeof item.title === 'string')
      : [];
  } catch {
    return [];
  }
}

function readFavouriteAnime(): FavouriteAnime[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(FAVOURITE_ANIME_STORAGE_KEY) || '[]');
    return Array.isArray(parsed)
      ? parsed.filter((item) => item && typeof item.titleKey === 'string' && typeof item.title === 'string')
      : [];
  } catch {
    return [];
  }
}

function normalizeAnimeTitle(value: string | null | undefined): string {
  return (value || '').toLocaleLowerCase().replace(/\b(season|s)\s*\d+\b/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
}

function airingMatchesLibrary(entry: { anilistId: number; title: string }, folders: AnimeFolder[]): boolean {
  const normalizedTitle = normalizeAnimeTitle(entry.title);
  return folders.some((folder) => {
    if (folder.anilistId != null) return folder.anilistId === entry.anilistId;
    return [folder.canonicalTitle, folder.folderName].some((title) => {
      const normalizedFolder = normalizeAnimeTitle(title);
      return normalizedFolder.length >= 5 && normalizedFolder === normalizedTitle;
    });
  });
}

export const App: React.FC = () => {
  // Navigation & View state
  const [currentTab, setCurrentTab] = useState<'home' | 'discover' | 'library' | 'schedule' | 'downloads' | 'whisper'>('home');
  const [visitedTabs, setVisitedTabs] = useState<Set<string>>(() => new Set(['home']));
  const [discoverInitialGenre, setDiscoverInitialGenre] = useState<string | null>(null);
  const [activePlayerEpisode, setActivePlayerEpisode] = useState<Episode | null>(null);
  const [playerInitialTime, setPlayerInitialTime] = useState<number>(0);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [isWhisperActive, setIsWhisperActive] = useState<boolean>(false);
  const [detailSource, setDetailSource] = useState<DetailSource | null>(null);
  const [navbarBackdropProgress, setNavbarBackdropProgress] = useState(1);
  const [whisperMounted, setWhisperMounted] = useState(false);
  const [settingsMounted, setSettingsMounted] = useState(false);
  const [startupUpdate, setStartupUpdate] = useState<UpdateInfoPayload | null>(null);
  const [appVersion, setAppVersion] = useState<string>('1.0.7');

  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;
    if (typeof api.getAppVersion === 'function') {
      api.getAppVersion().then((v) => { if (v) setAppVersion(v); }).catch(() => {});
    }
    if (typeof api.getStartupUpdate === 'function') {
      api.getStartupUpdate().then((info) => { if (info) setStartupUpdate(info); }).catch(() => {});
    }
    if (typeof api.onStartupUpdateAvailable === 'function') {
      const unsub = api.onStartupUpdateAvailable((info) => {
        setStartupUpdate(info);
      });
      return () => {
        unsub();
      };
    }
  }, []);

  useEffect(() => {
    if (currentTab === 'whisper') setWhisperMounted(true);
  }, [currentTab]);

  useEffect(() => {
    if (settingsOpen) setSettingsMounted(true);
  }, [settingsOpen]);

  const updateNavbarBackdropProgress = useCallback((progress: number) => {
    const next = Math.max(0, Math.min(1, Math.round(progress * 40) / 40));
    setNavbarBackdropProgress((current) => Math.abs(current - next) < 0.025 ? current : next);
  }, []);

  useEffect(() => {
    setNavbarBackdropProgress(1);
  }, [currentTab, detailSource]);

  // Library & Data state
  const [settings, setSettings] = useState<AppSettings>({
    ffmpegPath: '',
    whisperPath: '',
    defaultLibraryRoot: '',
    libraryFolders: [],
    autoPlayNext: true,
    subtitlesFontSize: 38,
    subtitlesOutline: true,
    subtitlesTextColor: '#ffffff',
    subtitlesFontFamily: 'sans',
    subtitlesBgStyle: 'none',
    animeTitleLanguage: 'english',
    subtitlesOutlineWidth: 'thick',
    subtitlesOutlineColor: '#000000',
    releaseSelectionMode: 'automatic',
    preferredTorrentAudioLanguages: ['en'],
    preferredTorrentSubtitleLanguages: ['en'],
  });

  const [folders, setFolders] = useState<AnimeFolder[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<AnimeFolder | null>(null);

  // Keep incomplete torrents out of the library until their files are ready.
  const visibleFolders = useMemo(() => {
    return folders.filter((folder) => !folder.isDownloading);
  }, [folders]);

  useEffect(() => {
    if (selectedFolder?.isDownloading) {
      setSelectedFolder(visibleFolders[0] || null);
    }
  }, [selectedFolder, visibleFolders]);
  const [history, setHistory] = useState<Record<string, PlaybackProgress>>({});
  const [userEntries, setUserEntries] = useState<Record<number, UserLibraryEntry>>({});
  const [notifications, setNotifications] = useState<AppNotification[]>(readNotifications);
  const [followedAnime, setFollowedAnime] = useState<FollowedAnime[]>(readFollowedAnime);
  const [favouriteAnime, setFavouriteAnime] = useState<FavouriteAnime[]>(readFavouriteAnime);
  const [initialDownloadEpisode, setInitialDownloadEpisode] = useState<number | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [binaryStatus, setBinaryStatus] = useState<{ ffmpegExists: boolean; whisperExists: boolean }>({
    ffmpegExists: true,
    whisperExists: true,
  });
  const [bannerDismissed, setBannerDismissed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('kaiko:missing-tools-notice-dismissed') === 'true';
    } catch {
      return false;
    }
  });

  // Keep visited tabs mounted so their state survives navigation, but don't
  // mount hidden pages (and start their catalog work) during the cold launch.
  useEffect(() => {
    setVisitedTabs((previous) => previous.has(currentTab) ? previous : new Set(previous).add(currentTab));
  }, [currentTab]);

  // Season-completion suggestion: offers to free downloaded files when a
  // season finishes playing. Dismissed folders stay muted for the session.
  const [completionPrompt, setCompletionPrompt] = useState<CompletionPromptState | null>(null);
  const dismissedFoldersRef = useRef<Set<string>>(new Set());

  const isScanningRef = useRef(false);
  const scanPendingRef = useRef(false);

  // P2P / BitTorrent (Phase 5): drives the Navbar P2P indicator and the
  // download lifecycle notifications (started → progress → completed/error).
  const [p2pState, setP2pState] = useState<P2pState | null>(null);
  const prevJobStatusRef = useRef<Record<string, string>>({});
  const p2pSeededRef = useRef(false);
  const prevProgressRef = useRef<Record<string, number>>({});

  const addNotification = useCallback((notification: Omit<AppNotification, 'id' | 'createdAt' | 'read'>) => {
    const item: AppNotification = {
      ...notification,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      read: false,
    };
    setNotifications((previous) => [item, ...previous].slice(0, 200));
    const toastType = item.tone === 'purple'
      ? 'purple'
      : item.tone === 'green'
        ? 'success'
        : item.tone === 'amber'
          ? 'warning'
          : item.tone === 'red'
            ? 'error'
            : 'info';
    showGlobalToast(`${item.title}: ${item.message}`, toastType, 5000);
  }, []);

  // Download notifications share a stable id derived from the torrent's
  // infoHash: the started → progress → completed transitions UPDATE one item
  // in place (progress bar in the panel) instead of spamming new entries.
  const upsertDownloadNotification = useCallback((notification: Omit<AppNotification, 'createdAt' | 'read'>) => {
    setNotifications((previous) => {
      const index = notification.infoHash
        ? previous.findIndex((item) => item.infoHash === notification.infoHash)
        : -1;
      if (index === -1) {
        return [{ ...notification, createdAt: Date.now(), read: false }, ...previous].slice(0, 200);
      }
      const updated = [...previous];
      updated[index] = { ...updated[index], ...notification };
      return updated;
    });
  }, []);

  useEffect(() => {
    try { localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, JSON.stringify(notifications)); } catch {}
  }, [notifications]);

  useEffect(() => {
    try { localStorage.setItem(FOLLOWED_ANIME_STORAGE_KEY, JSON.stringify(followedAnime)); } catch {}
  }, [followedAnime]);

  useEffect(() => {
    try { localStorage.setItem(FAVOURITE_ANIME_STORAGE_KEY, JSON.stringify(favouriteAnime)); } catch {}
  }, [favouriteAnime]);

  const markNotificationRead = useCallback((id: string) => {
    setNotifications((previous) => previous.map((item) => item.id === id ? { ...item, read: true } : item));
  }, []);

  const markAllNotificationsRead = useCallback(() => {
    setNotifications((previous) => previous.map((item) => ({ ...item, read: true })));
  }, []);

  const clearNotifications = useCallback(() => setNotifications([]), []);
  const dismissNotification = useCallback((id: string) => {
    setNotifications((previous) => previous.filter((item) => item.id !== id));
  }, []);

  const toggleFollowAnime = useCallback((anime: FollowedAnime, follow: boolean) => {
    setFollowedAnime((previous) => follow
      ? previous.some((item) => item.anilistId === anime.anilistId)
        ? previous.map((item) => item.anilistId === anime.anilistId ? anime : item)
        : [anime, ...previous]
      : previous.filter((item) => item.anilistId !== anime.anilistId));
    addNotification({
      kind: 'follow',
      tone: follow ? 'green' : 'amber',
      title: follow ? 'Anime followed' : 'Follow removed',
      message: follow
        ? `${anime.title} will be tracked for new episodes.`
        : `${anime.title} will no longer be tracked for new episodes.`,
      anilistId: anime.anilistId,
      posterUrl: anime.posterUrl,
    });
  }, [addNotification]);

  const toggleFavouriteAnime = useCallback((anime: FavouriteAnime, favourite: boolean) => {
    setFavouriteAnime((previous) => favourite
      ? previous.some((item) => (anime.anilistId != null && item.anilistId === anime.anilistId) || item.titleKey === anime.titleKey)
        ? previous.map((item) => (anime.anilistId != null && item.anilistId === anime.anilistId) || item.titleKey === anime.titleKey ? anime : item)
        : [anime, ...previous]
      : previous.filter((item) => !((anime.anilistId != null && item.anilistId === anime.anilistId) || item.titleKey === anime.titleKey)));
    showGlobalToast(favourite ? `${anime.title} added to favourites` : `${anime.title} removed from favourites`, 'success');
  }, []);

  const checkBinariesStatus = useCallback(async (appSettings: AppSettings) => {
    if (!window.electronAPI) return;
    try {
      const status = await window.electronAPI.checkBinaries({
        ffmpegPath: appSettings.ffmpegPath,
        whisperPath: appSettings.whisperPath,
      });
      setBinaryStatus({
        ffmpegExists: status.ffmpegExists,
        whisperExists: status.whisperExists,
      });
    } catch {}
  }, []);

  const refreshUserEntries = useCallback(async () => {
    if (!window.electronAPI) return;
    try {
      const entries = await window.electronAPI.getUserLibrary();
      setUserEntries(entries || {});
    } catch {}
  }, []);

  // Applies a P2P state snapshot and toasts on job status transitions to
  // completed / error. The first snapshot only seeds the ref (no toasts for
  // jobs that were already finished before the app started).
  const handleP2pState = useCallback((state: P2pState) => {
    setP2pState(state);
    const prev = prevJobStatusRef.current;
    const next: Record<string, string> = {};
    for (const job of state.jobs) {
      next[job.infoHash] = job.status;
      const before = prev[job.infoHash];
      const poster = folders.find((f) => f.anilistId === job.anilistId)?.posterUrl ?? null;
      const suffix = job.episode != null ? ` · Episode ${job.episode}` : '';

      if (!p2pSeededRef.current) continue;

      // New job: announce the start with a live progress notification.
      if (before === undefined && (job.status === 'downloading' || job.status === 'connecting' || job.status === 'queued')) {
        showGlobalToast(`${job.title} download started`, 'info', 5000);
        upsertDownloadNotification({
          kind: 'download',
          tone: 'blue',
          id: `dl:${job.infoHash}`,
          infoHash: job.infoHash,
          state: 'downloading',
          progress: Math.max(0, Math.min(100, job.progress ?? 0)),
          title: 'Download started',
          message: `${job.title}${suffix} — searching peers and downloading.`,
          anilistId: job.anilistId ?? undefined,
          posterUrl: poster,
          episode: job.episode ?? undefined,
        });
        prevProgressRef.current[job.infoHash] = job.progress ?? 0;
        continue;
      }

      if (before && before !== job.status) {
        if (job.status === 'completed') {
          showGlobalToast(`Downloaded "${job.title}" — it is now in your library`, 'success');
          upsertDownloadNotification({
            kind: 'download',
            tone: 'green',
            id: `dl:${job.infoHash}`,
            infoHash: job.infoHash,
            state: 'completed',
            progress: 100,
            title: 'Download complete',
            message: `${job.title}${suffix} is ready in your library.`,
            anilistId: job.anilistId ?? undefined,
            posterUrl: poster,
            episode: job.episode ?? undefined,
          });
        } else if (job.status === 'error') {
          showGlobalToast(
            job.error ? `Download failed: ${job.error}` : `Download failed for "${job.title}"`,
            'warning'
          );
          upsertDownloadNotification({
            kind: 'download',
            tone: 'red',
            id: `dl:${job.infoHash}`,
            infoHash: job.infoHash,
            state: 'error',
            title: 'Download failed',
            message: job.error ? `${job.title}${suffix} — ${job.error}` : `${job.title}${suffix} failed.`,
            anilistId: job.anilistId ?? undefined,
            posterUrl: poster,
            episode: job.episode ?? undefined,
          });
        }
        continue;
      }

      // Live progress ticks while downloading (throttled to 2% steps so the
      // localStorage persistence is not hammered on every poll).
      if (job.status === 'downloading' && typeof job.progress === 'number') {
        const last = prevProgressRef.current[job.infoHash];
        if (last == null || Math.abs(job.progress - last) >= 2) {
          prevProgressRef.current[job.infoHash] = job.progress;
          upsertDownloadNotification({
            kind: 'download',
            tone: 'cyan',
            id: `dl:${job.infoHash}`,
            infoHash: job.infoHash,
            state: 'downloading',
            progress: Math.max(0, Math.min(100, job.progress)),
            title: 'Downloading',
            message: `${job.title}${suffix}`,
            anilistId: job.anilistId ?? undefined,
            posterUrl: poster,
            episode: job.episode ?? undefined,
          });
        }
      }
    }
    prevJobStatusRef.current = next;
    // A cancelled job removes its live "downloading" notification — a frozen
    // progress bar for a torrent that no longer exists is noise.
    setNotifications((previous) => {
      const stale = previous.some((item) => item.state === 'downloading' && item.infoHash && !state.jobs.some((job) => job.infoHash === item.infoHash));
      return stale
        ? previous.filter((item) => !(item.state === 'downloading' && item.infoHash && !state.jobs.some((job) => job.infoHash === item.infoHash)))
        : previous;
    });
    p2pSeededRef.current = true;
  }, [folders, upsertDownloadNotification]);

  // P2P state: initial load + live subscription (unsubscribed on unmount).
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.getP2pState || !api?.onP2pStateChanged) return;
    let cancelled = false;
    api
      .getP2pState()
      .then((state) => {
        if (!cancelled) handleP2pState(state);
      })
      .catch(() => {});
    const unsubscribe = api.onP2pStateChanged((state) => {
      if (!cancelled) handleP2pState(state);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [handleP2pState]);

  // Watch AniList airing entries for library titles and titles explicitly
  // followed by the user. Persist upcoming entries so episodes airing while
  // the app is closed still produce a notification on the next poll.
  useEffect(() => {
    if ((!folders.length && !followedAnime.length) || !window.electronAPI?.getAiringSchedule) return;
    let cancelled = false;
    const pollAiring = async () => {
      try {
        const scheduleEntries = await window.electronAPI.getAiringSchedule(0);
        if (cancelled || !Array.isArray(scheduleEntries)) return;
        const followedEpisodeCounts = new Map<number, number>();
        const followedEntries = await Promise.all(followedAnime.map(async (anime) => {
          try {
            const details = await window.electronAPI.getCatalogDetails(anime.anilistId);
            if (details?.episodesCount != null) followedEpisodeCounts.set(anime.anilistId, details.episodesCount);
            const next = details?.nextAiringEpisode;
            if (!next) return null;
            return {
              anilistId: anime.anilistId,
              idMal: details.idMal,
              title: details.title.english || details.title.romaji || anime.title,
              posterUrl: details.posterUrl || anime.posterUrl,
              episode: next.episode,
              airingAt: next.airingAt,
            };
          } catch {
            return null;
          }
        }));
        const entries = [...scheduleEntries, ...followedEntries.filter((entry): entry is NonNullable<typeof entry> => !!entry)];
        if (cancelled) return;
        let saved: {
          initialized?: boolean;
          upcoming?: Array<string | {
            key?: string;
            entry?: { anilistId: number; title: string; posterUrl: string | null; episode: number; airingAt: number };
          }>;
        } = {};
        try { saved = JSON.parse(localStorage.getItem(AIRING_WATCH_STORAGE_KEY) || '{}'); } catch {}
        const upcoming = new Map<string, { anilistId: number; title: string; posterUrl: string | null; episode: number; airingAt: number }>();
        for (const item of saved.upcoming || []) {
          if (item && typeof item === 'object' && typeof item.key === 'string' && item.entry) {
            upcoming.set(item.key, item.entry);
          } else if (typeof item === 'string') {
            // Ignore keys written by an older watcher format; the metadata is
            // needed to notify reliably if AniList drops an aired row.
          }
        }
        for (const [key, entry] of upcoming) {
          if (!airingMatchesLibrary(entry, folders) && !followedAnime.some((anime) => anime.anilistId === entry.anilistId)) {
            upcoming.delete(key);
          }
        }
        const initialized = saved.initialized === true;
        const now = Math.floor(Date.now() / 1000);
        const presentKeys = new Set<string>();
        const announce = (entry: { anilistId: number; title: string; posterUrl: string | null; episode: number; airingAt: number }) => {
          const followed = followedAnime.find((item) => item.anilistId === entry.anilistId);
          const episodeCount = followed?.episodesCount ?? followedEpisodeCounts.get(entry.anilistId) ?? null;
          const finalEpisode = episodeCount != null && entry.episode >= episodeCount;
          addNotification({
            kind: 'airing',
            tone: finalEpisode ? 'purple' : 'green',
            finalEpisode,
            title: finalEpisode ? 'Final episode aired' : 'New episode aired',
            message: `${entry.title} · Episode ${entry.episode} has aired. Search your release sources to download it.`,
            anilistId: entry.anilistId,
            posterUrl: entry.posterUrl,
            episode: entry.episode,
          });
        };
        for (const entry of entries) {
          if (!entry || entry.episode == null || (!airingMatchesLibrary(entry, folders) && !followedAnime.some((item) => item.anilistId === entry.anilistId))) continue;
          const key = `${entry.anilistId}:${entry.episode}`;
          presentKeys.add(key);
          const savedEntry = {
            anilistId: entry.anilistId,
            title: entry.title,
            posterUrl: entry.posterUrl,
            episode: entry.episode,
            airingAt: entry.airingAt,
          };
          if (entry.airingAt > now) {
            upcoming.set(key, savedEntry);
          } else if (initialized && upcoming.has(key)) {
            announce(savedEntry);
            upcoming.delete(key);
          } else if (entry.airingAt <= now) {
            // An entry may not have been present in a poll while the app was
            // asleep; if it was watched beforehand, report it once now.
            const prior = upcoming.get(key);
            if (initialized && prior) announce(prior);
            upcoming.delete(key);
          }
        }
        // Some catalog responses drop an airing row as soon as it airs. Use
        // its persisted schedule snapshot to deliver the pending notification.
        if (initialized) {
          for (const [key, entry] of upcoming) {
            if (entry.airingAt <= now && !presentKeys.has(key)) {
              announce(entry);
              upcoming.delete(key);
            }
          }
        }
        try {
          localStorage.setItem(AIRING_WATCH_STORAGE_KEY, JSON.stringify({ initialized: true, upcoming: [...upcoming].map(([key, entry]) => ({ key, entry })) }));
        } catch {}
      } catch (error) {
        console.warn('Could not check airing updates:', error);
      }
    };
    void pollAiring();
    const timer = window.setInterval(() => void pollAiring(), 15 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [folders, followedAnime, addNotification]);

  // VPN tunnel status removed — user manages their own network safety

  // 1. Load Settings and History on Startup
  const loadInitialData = useCallback(async () => {
    if (!window.electronAPI) {
      setLoading(false);
      return;
    }

    try {
      const appSettings = await window.electronAPI.getSettings();
      setSettings(appSettings);
      checkBinariesStatus(appSettings);

      const watchHistory = await window.electronAPI.getAllPlaybackProgress();
      setHistory(watchHistory);
      refreshUserEntries();

      // Reuse the last completed scan on startup. A full scan reads metadata
      // from every video file, which can wake a media HDD and delay the home
      // hero. Explicit refreshes still perform a fresh scan and update cache.
      const roots = appSettings.libraryFolders?.length
        ? appSettings.libraryFolders
        : appSettings.defaultLibraryRoot ? [appSettings.defaultLibraryRoot] : [];
      const cachedFolders = await window.electronAPI.getLibraryCache(roots);
      const scannedFolders = cachedFolders ?? await window.electronAPI.scanLibrary(roots);
      setFolders(scannedFolders);

      if (scannedFolders.length > 0) {
        const lastWatchedFolder = findLastWatchedFolder(scannedFolders, watchHistory);
        setSelectedFolder(lastWatchedFolder || scannedFolders[0]);
      }
    } catch (e) {
      console.error('Failed to load initial library data:', e);
    } finally {
      setLoading(false);
    }
  }, [checkBinariesStatus, refreshUserEntries]);

  useEffect(() => {
    loadInitialData();

    if (!window.electronAPI) return;

    // Check whisper status on mount
    window.electronAPI
      .getWhisperStatus()
      .then((status) => {
        if (status && status.isRunning) {
          setIsWhisperActive(true);
        }
      })
      .catch(() => {});

    const unsubProgress = window.electronAPI.onWhisperProgress(() => {
      setIsWhisperActive(true);
    });

    const unsubDone = window.electronAPI.onWhisperDone((result) => {
      setIsWhisperActive(false);
      if (result && result.completedCount > 0) {
        addNotification({
          kind: 'whisper',
          title: 'Whisper Batch Completed',
          message: `Generated AI subtitles for ${result.completedCount} episode${result.completedCount === 1 ? '' : 's'}.`,
          tone: 'green',
        });
      }
    });

    const unsubEpisodeDone = window.electronAPI?.onWhisperEpisodeDone?.((data) => {
      const displayTitle = cleanEpisodeTitle(data.fileName).displayTitle || data.fileName;
      addNotification({
        kind: 'whisper',
        title: 'Episode Subtitles Ready',
        message: `Generated subtitles for "${displayTitle}" (${data.index + 1}/${data.total})`,
        tone: 'purple',
      });
    });

    const unsubModelComplete = window.electronAPI?.onWhisperModelDownloadComplete?.((data) => {
      addNotification({
        kind: 'whisper',
        title: 'Model Ready',
        message: `Whisper model "${data.modelName}" is downloaded and ready to use.`,
        tone: 'green',
      });
    });

    return () => {
      unsubProgress();
      unsubDone();
      if (unsubEpisodeDone) unsubEpisodeDone();
      if (unsubModelComplete) unsubModelComplete();
    };
  }, [loadInitialData, addNotification]);

  // Refresh Library with concurrent scan protection
  const handleRefreshLibrary = useCallback(async () => {
    if (!window.electronAPI) return;
    if (isScanningRef.current) {
      scanPendingRef.current = true;
      return;
    }
    isScanningRef.current = true;
    setLoading(true);
    try {
      do {
        scanPendingRef.current = false;
        const watchHistory = await window.electronAPI.getAllPlaybackProgress();
        setHistory(watchHistory);

        const scanned = await window.electronAPI.scanLibrary();
        setFolders(scanned);

        const userLib = await window.electronAPI.getUserLibrary();
        if (userLib) setUserEntries(userLib);

        if (scanned.length > 0) {
          setSelectedFolder((prev) => {
            const exists = scanned.find((f) => f.folderPath === prev?.folderPath);
            return exists || findLastWatchedFolder(scanned, watchHistory) || scanned[0];
          });
        } else {
          setSelectedFolder(null);
        }
      } while (scanPendingRef.current);
    } catch (err) {
      console.error('Error refreshing library:', err);
    } finally {
      isScanningRef.current = false;
      setLoading(false);
    }
  }, []);

  // Once the torrent engine has moved completed files out of staging, refresh
  // the library automatically so the title appears without an extra click.
  const refreshedTorrentJobsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!p2pState) return;
    const completed = new Set(
      p2pState.jobs
        .filter((job) => job.status === 'completed' || job.status === 'seeding')
        .map((job) => job.infoHash)
    );
    const previous = refreshedTorrentJobsRef.current;
    refreshedTorrentJobsRef.current = completed;
    if (previous === null) return; // Initial queue snapshot is not a new completion.
    if ([...completed].some((infoHash) => !previous.has(infoHash))) {
      void handleRefreshLibrary();
    }
  }, [p2pState, handleRefreshLibrary]);

  // Active Download Watcher: polls active torrents every 1.5 seconds while downloading
  // so progress percentage updates smoothly in real-time, and playback unlocks instantly when complete!
  useEffect(() => {
    if (!window.electronAPI?.checkDownloadProgress) return;

    // Check if any episode in any folder has isDownloading: true
    const downloadingEpisodes = folders
      .flatMap((f) => f.episodes)
      .filter((e) => e.isDownloading);

    if (downloadingEpisodes.length === 0) return;

    const activePaths = downloadingEpisodes.map((e) => e.filePath);

    const interval = setInterval(async () => {
      try {
        const statuses = await window.electronAPI.checkDownloadProgress(activePaths);
        let hasChanges = false;

        setFolders((prevFolders) => {
          let anyFolderUpdated = false;
          const nextFolders = prevFolders.map((folder) => {
            let epUpdated = false;
            const nextEpisodes = folder.episodes.map((ep) => {
              const status = statuses[ep.filePath];
              if (
                status &&
                (status.isDownloading !== ep.isDownloading ||
                  status.downloadProgress !== ep.downloadProgress)
              ) {
                epUpdated = true;
                anyFolderUpdated = true;
                hasChanges = true;
                return {
                  ...ep,
                  isDownloading: status.isDownloading,
                  downloadProgress: status.downloadProgress,
                };
              }
              return ep;
            });

            if (!epUpdated) return folder;

            // Recalculate folder-level download status
            const isSingleMovie = nextEpisodes.length === 1;
            let folderIsDl = false;
            let folderProg: number | undefined = undefined;

            if (isSingleMovie) {
              folderIsDl = Boolean(nextEpisodes[0].isDownloading);
              folderProg = nextEpisodes[0].downloadProgress;
            } else {
              folderIsDl = nextEpisodes.every((e) => e.isDownloading);
              if (folderIsDl) {
                const total = nextEpisodes.reduce((acc, e) => acc + (e.downloadProgress || 0), 0);
                folderProg = Math.round(total / nextEpisodes.length);
              }
            }

            return {
              ...folder,
              episodes: nextEpisodes,
              isDownloading: folderIsDl,
              downloadProgress: folderProg,
            };
          });

          return anyFolderUpdated ? nextFolders : prevFolders;
        });

        // Keep selectedFolder strictly in sync with the updated episodes
        if (hasChanges) {
          setSelectedFolder((prev) => {
            if (!prev) return prev;
            let changed = false;
            const nextEpisodes = prev.episodes.map((ep) => {
              const st = statuses[ep.filePath];
              if (
                st &&
                (st.isDownloading !== ep.isDownloading ||
                  st.downloadProgress !== ep.downloadProgress)
              ) {
                changed = true;
                return {
                  ...ep,
                  isDownloading: st.isDownloading,
                  downloadProgress: st.downloadProgress,
                };
              }
              return ep;
            });

            if (!changed) return prev;

            const isMovie = nextEpisodes.length === 1;
            const isDl = isMovie
              ? Boolean(nextEpisodes[0].isDownloading)
              : nextEpisodes.every((e) => e.isDownloading);
            const prog = isMovie ? nextEpisodes[0].downloadProgress : undefined;

            return {
              ...prev,
              episodes: nextEpisodes,
              isDownloading: isDl,
              downloadProgress: prog,
            };
          });
        }
      } catch (err) {
        console.error('Error polling download progress:', err);
      }
    }, 1500);

    return () => clearInterval(interval);
  }, [folders]);

  // Find most recently watched episode or next up episode across all anime folders
  const mostRecentWatched = useMemo(() => {
    // Collect all valid history records sorted by lastWatchedAt descending
    const allHistory = Object.values(history).filter(
      (h) => (h.currentTime > 5 || h.completed) && h.lastWatchedAt && h.lastWatchedAt > 0
    );
    if (allHistory.length === 0) return null;

    allHistory.sort((a, b) => b.lastWatchedAt - a.lastWatchedAt);

    // 1. Try finding from the most recent history records:
    for (const record of allHistory) {
      // Find the folder corresponding to this history entry
      const folder = visibleFolders.find((f) => f.folderPath === record.folderPath)
        || visibleFolders.find((f) => f.episodes.some((e) => e.filePath === record.filePath));

      if (!folder || folder.episodes.length === 0) continue;

      const epIndex = folder.episodes.findIndex((e) => e.filePath === record.filePath);
      if (epIndex === -1) continue;

      const currentEp = folder.episodes[epIndex];

      // CASE A: The episode is in-progress (not completed) and ready to play:
      if (!record.completed && !currentEp.isDownloading) {
        return {
          progress: record,
          episode: currentEp,
          seasonName: folder.canonicalTitle || folder.folderName,
          folder,
          isUpNext: false,
        };
      }

      // CASE B: The episode was COMPLETED (reached ending or >90% watched)!
      // Seamlessly advance to the NEXT unwatched episode in this same anime series:
      if (record.completed) {
        const nextEpisodes = folder.episodes.slice(epIndex + 1);
        const nextEp = nextEpisodes.find((e) => {
          const epHist = history[e.filePath];
          return (!epHist || !epHist.completed) && !e.isDownloading;
        });

        if (nextEp) {
          const nextProgress: PlaybackProgress = history[nextEp.filePath] || {
            filePath: nextEp.filePath,
            folderPath: folder.folderPath,
            fileName: nextEp.fileName,
            episodeNumber: nextEp.episodeNumber,
            currentTime: 0,
            duration: nextEp.duration || 0,
            lastWatchedAt: record.lastWatchedAt,
            completed: false,
          };

          return {
            progress: nextProgress,
            episode: nextEp,
            seasonName: folder.canonicalTitle || folder.folderName,
            folder,
            isUpNext: true,
          };
        }
        // If there are no further episodes in this season/folder, loop continues to previous history items
      }
    }

    // 2. Fallback: If all watched episodes are completed and have no next episode,
    // show the most recent completed episode so user can rewatch if desired.
    for (const record of allHistory) {
      const folder = visibleFolders.find((f) => f.folderPath === record.folderPath)
        || visibleFolders.find((f) => f.episodes.some((e) => e.filePath === record.filePath));
      if (!folder) continue;
      const currentEp = folder.episodes.find((e) => e.filePath === record.filePath);
      if (currentEp && !currentEp.isDownloading) {
        return {
          progress: record,
          episode: currentEp,
          seasonName: folder.canonicalTitle || folder.folderName,
          folder,
          isUpNext: false,
        };
      }
    }

    return null;
  }, [history, visibleFolders]);

  // Resolves catalog items (rails, schedule) against local library state for badges
  const { statusFor } = useLocalStatus(visibleFolders, history, userEntries);

  // Change Root Directory
  const handleChangeRoot = async () => {
    if (!window.electronAPI) return;
    try {
      const newRoot = await window.electronAPI.browseFolder(settings.defaultLibraryRoot);
      if (newRoot) {
        const updatedFolders = Array.from(new Set([...(settings.libraryFolders || []), newRoot]));
        const updated = await window.electronAPI.updateSettings({
          defaultLibraryRoot: newRoot,
          libraryFolders: updatedFolders,
        });
        setSettings(updated);
        setLoading(true);
        const scanned = await window.electronAPI.scanLibrary();
        setFolders(scanned);

        const userLib = await window.electronAPI.getUserLibrary();
        if (userLib) setUserEntries(userLib);
        setSelectedFolder(findLastWatchedFolder(scanned, history) || (scanned.length > 0 ? scanned[0] : null));
        setLoading(false);
      }
    } catch (err) {
      console.error('Error changing root directory:', err);
      setLoading(false);
    }
  };

  // Play Episode
  const handlePlayEpisode = (episode: Episode, startAt = 0) => {
    if (episode.isDownloading) {
      showGlobalToast(
        'This media is currently downloading in your torrent client and cannot be played yet.',
        'warning'
      );
      return;
    }
    const parentFolder = folders.find((f) => f.episodes.some((e) => e.filePath === episode.filePath));
    if (parentFolder) {
      setSelectedFolder(parentFolder);
    }
    const saved = history[episode.filePath];
    const initial = startAt > 0 ? startAt : (saved?.currentTime && !saved.completed ? saved.currentTime : 0);
    setPlayerInitialTime(initial);
    setActivePlayerEpisode(episode);

    // Automatically enter fullscreen when starting playback
    if (window.electronAPI?.setFullScreen) {
      window.electronAPI.setFullScreen(true).catch(() => {});
    }
  };

  // Close Player & Refresh Progress
  const handleClosePlayer = async () => {
    // Automatically exit fullscreen and return to maximized windowed mode (taskbar visible)
    if (window.electronAPI?.setFullScreen) {
      await window.electronAPI.setFullScreen(false).catch(() => {});
    }
    setActivePlayerEpisode(null);
    const watchHistory = await window.electronAPI.getAllPlaybackProgress();
    setHistory(watchHistory);
    refreshUserEntries();
  };

  // Switch episode inside Player
  const handlePlayerEpisodeChange = (newEpisode: Episode) => {
    const parentFolder = folders.find((f) => f.episodes.some((e) => e.filePath === newEpisode.filePath));
    if (parentFolder) {
      setSelectedFolder(parentFolder);
    }
    setActivePlayerEpisode(newEpisode);
    setPlayerInitialTime(0);
  };

  // Fired by the player once per episode when it crosses the completion
  // threshold. Suggests freeing the downloaded files when the whole season is
  // finished (single-episode folders, or every later episode already watched
  // or still downloading). Files-only deletion: history and progress persist.
  const handleEpisodeCompleted = useCallback(
    (episode: Episode) => {
      const parentFolder = folders.find((f) => f.episodes.some((e) => e.filePath === episode.filePath));
      if (!parentFolder) return;
      if (dismissedFoldersRef.current.has(parentFolder.folderPath)) return;

      const epIndex = parentFolder.episodes.findIndex((e) => e.filePath === episode.filePath);
      const laterEpisodes = parentFolder.episodes.slice(epIndex + 1);
      const seasonFinished =
        parentFolder.episodes.length === 1 ||
        laterEpisodes.every((e) => history[e.filePath]?.completed || e.isDownloading);
      if (!seasonFinished) return;

      const sizeBytes = parentFolder.episodes.reduce((acc, e) => acc + (e.size || 0), 0);
      setCompletionPrompt({
        title: parentFolder.canonicalTitle || parentFolder.folderName,
        sizeBytes,
        folderPath: parentFolder.folderPath,
      });
    },
    [folders, history]
  );

  const handleCompletionPromptKeep = () => {
    if (completionPrompt) {
      dismissedFoldersRef.current.add(completionPrompt.folderPath);
    }
    setCompletionPrompt(null);
  };

  const handleCompletionPromptDelete = async () => {
    if (!completionPrompt) return;
    const { folderPath, sizeBytes } = completionPrompt;
    dismissedFoldersRef.current.add(folderPath);
    setCompletionPrompt(null);
    try {
      const res = await window.electronAPI.deleteAnimeFromPC(folderPath);
      if (res?.success) {
        showGlobalToast(`Freed ${formatFileSize(res.deletedBytes ?? sizeBytes)}`, 'success');
      } else {
        showGlobalToast(res?.error || 'Failed to delete files from PC', 'error');
      }
    } catch (err) {
      console.error('Failed to delete anime from PC:', err);
      showGlobalToast('Failed to delete files from PC', 'error');
    }
    handleRefreshLibrary();
  };

  // Open Whisper Studio with preselected folder
  const handleOpenWhisperForFolder = (folder: AnimeFolder) => {
    setSelectedFolder(folder);
    setCurrentTab('whisper');
  };

  // Save Settings - Only rescan library if libraryFolders changed
  const handleSaveSettings = async (newSettings: Partial<AppSettings>) => {
    const prevFolders = settings.libraryFolders || (settings.defaultLibraryRoot ? [settings.defaultLibraryRoot] : []);
    const updated = await window.electronAPI.updateSettings(newSettings);
    setSettings(updated);
    checkBinariesStatus(updated);

    const newFolders = updated.libraryFolders || (updated.defaultLibraryRoot ? [updated.defaultLibraryRoot] : []);
    const foldersChanged =
      prevFolders.length !== newFolders.length ||
      prevFolders.some((f, idx) => f !== newFolders[idx]);

    if (foldersChanged) {
      handleRefreshLibrary();
    }
  };

  const handleCloseSettings = useCallback(() => {
    setSettingsOpen(false);
  }, []);

  // Resolve current active anime folder for player (with fallback for BUG-01)
  const currentPlayingFolder = useMemo<AnimeFolder | null>(() => {
    if (!activePlayerEpisode) return null;
    const found = folders.find((f) =>
      f.episodes.some((e) => e.filePath === activePlayerEpisode.filePath)
    );
    if (found) return found;
    if (selectedFolder) return selectedFolder;

    // Fallback AnimeFolder so VideoPlayer always mounts cleanly and never locks the UI
    const folderPath = getPathDirname(activePlayerEpisode.filePath) || '';
    const folderName = getPathBasename(folderPath) || activePlayerEpisode.title || 'Playing Media';
    return {
      folderPath,
      folderName,
      canonicalTitle: activePlayerEpisode.title || folderName,
      episodes: [activePlayerEpisode],
      totalEpisodes: 1,
      hasSubtitlesCount:
        activePlayerEpisode.hasExternalSrt ||
        activePlayerEpisode.hasEmbeddedSubtitles ||
        activePlayerEpisode.hasEmbeddedDubtitles ||
        activePlayerEpisode.hasWhisperSrt
          ? 1
          : 0,
      isDownloading: false,
    };
  }, [activePlayerEpisode, folders, selectedFolder]);

  // Global Escape key listener: rescues the user if player unmounted, errored, or lost focus
  useEffect(() => {
    if (!activePlayerEpisode) return;
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (e.defaultPrevented) return;

        // Ensure pressing Escape when an episode drawer or modal is open
        // does not close the entire video player prematurely.
        const isDrawerOpen = Boolean(
          document.querySelector('.translate-x-0') ||
          document.querySelector('[aria-label="Close Episodes Drawer"]')
            ?.closest('.pointer-events-auto')
        );

        const isModalOpen = Boolean(
          document.querySelector('.glass-dropdown') ||
          document.querySelector('[role="dialog"]') ||
          document.querySelector('[data-modal="true"]')
        );

        if (isDrawerOpen || isModalOpen) {
          return;
        }

        handleClosePlayer();
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [activePlayerEpisode, handleClosePlayer]);

  // This is a single-page app, so the native mouse Back button must never
  // traverse Chromium's document history (which also contains the startup
  // splash page). Handle Back as an app-level stack instead.
  useEffect(() => {
    const navigateBack = () => {
      if (activePlayerEpisode) {
        handleClosePlayer();
      } else if (settingsOpen) {
        setSettingsOpen(false);
      } else if (detailSource) {
        setInitialDownloadEpisode(null);
        setDetailSource(null);
      } else if (currentTab !== 'home') {
        setCurrentTab('home');
      }
    };

    const suppressMouseNavigation = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      // Run on mouse-down because preventing its default action can suppress
      // the later auxclick event in Chromium.
      if (event.type === 'mousedown' && event.button === 3) navigateBack();
    };

    // Prevent Chromium from navigating away and handle Back exactly once.
    window.addEventListener('mousedown', suppressMouseNavigation, true);
    window.addEventListener('mouseup', suppressMouseNavigation, true);
    window.addEventListener('auxclick', suppressMouseNavigation, true);
    return () => {
      window.removeEventListener('mousedown', suppressMouseNavigation, true);
      window.removeEventListener('mouseup', suppressMouseNavigation, true);
      window.removeEventListener('auxclick', suppressMouseNavigation, true);
    };
  }, [detailSource, currentTab, activePlayerEpisode, settingsOpen, handleClosePlayer]);

  return (
    <ToastProvider>
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#0b0c10] font-sans text-zinc-100">
      {/* Top Navbar - Only rendered in Menu/Library/Whisper views */}
      {!activePlayerEpisode && (
        <>
          <Navbar
            currentTab={currentTab}
            backdropImage={detailSource
              ? detailSource.kind === 'catalog'
                ? detailSource.item.bannerUrl || detailSource.item.posterUrl
                : detailSource.folder.bannerUrl || detailSource.folder.posterUrl
              : currentTab === 'home'
                ? mostRecentWatched?.folder?.bannerUrl || mostRecentWatched?.folder?.posterUrl
                : null}
            backdropMode={detailSource ? 'anime' : 'ambient'}
            backdropProgress={navbarBackdropProgress}
            onSelectTab={(tab) => {
              setInitialDownloadEpisode(null);
              setDetailSource(null);
              setCurrentTab(tab);
            }}
            onOpenSettings={() => setSettingsOpen(true)}
            onSelectSearchItem={(item) => {
              setInitialDownloadEpisode(null);
              setDetailSource({ kind: 'catalog', item });
            }}
            notifications={notifications}
            onNotificationRead={markNotificationRead}
            onDismissNotification={dismissNotification}
            onMarkAllNotificationsRead={markAllNotificationsRead}
            onClearNotifications={clearNotifications}
            onNotificationAction={(item) => {
              if (item.kind === 'airing' && item.anilistId && item.episode) {
                setInitialDownloadEpisode(item.episode);
                setDetailSource({
                  kind: 'catalog',
                  item: toRailItem({
                    anilistId: item.anilistId,
                    idMal: null,
                    title: item.title,
                    posterUrl: item.posterUrl ?? null,
                    episode: item.episode,
                    airingAt: Math.floor(item.createdAt / 1000),
                  }),
                });
              } else if (item.kind === 'download') {
                setDetailSource(null);
                setCurrentTab('downloads');
              } else if (item.kind === 'whisper') {
                setDetailSource(null);
                setCurrentTab('whisper');
              }
            }}
            isWhisperActive={isWhisperActive}
            downloadsActive={!!p2pState?.enabled && p2pState.jobs.some((j) => j.status === 'downloading' || j.status === 'connecting' || j.status === 'queued')}
            p2pIndicator={(() => {
              if (!p2pState?.enabled) {
                return { enabled: false, status: 'P2P Off', icon: 'HardDrive', bgColor: 'bg-zinc-800', textColor: 'text-zinc-400' }
              }
              if (p2pState.jobs.some((j) => j.status === 'downloading' || j.status === 'connecting')) {
                return { enabled: true, status: 'Downloading', icon: 'HardDrive', bgColor: 'bg-indigo-500/20', textColor: 'text-indigo-300' }
              }
              if (p2pState.jobs.some((j) => j.status === 'seeding')) {
                return { enabled: true, status: 'Seeding', icon: 'ShieldCheck', bgColor: 'bg-emerald-500/20', textColor: 'text-emerald-300' }
              }
              return { enabled: true, status: 'Idle', icon: 'ShieldCheck', bgColor: 'bg-zinc-700', textColor: 'text-zinc-300' }
            })()}
          />
        </>
      )}

      {/* Main Content Area - Persists tab states without destroying components */}
      <main
        className={`flex-1 overflow-hidden relative flex flex-col ${
          activePlayerEpisode ? 'hidden' : 'block'
        }`}
      >
        {/* Home Tab View */}
        {(visitedTabs.has('home') || currentTab === 'home') && <div
          className={`h-full overflow-y-auto ${currentTab === 'home' ? 'block' : 'hidden'}`}
          onScroll={(event) => {
            const hero = event.currentTarget.querySelector<HTMLElement>('[data-backdrop-hero]');
            if (!hero) {
              updateNavbarBackdropProgress(0);
              return;
            }
            const heroRect = hero.getBoundingClientRect();
            const containerTop = event.currentTarget.getBoundingClientRect().top;
            const progress = heroRect.height > 0
              ? Math.max(0, Math.min(1, (heroRect.bottom - containerTop) / heroRect.height))
              : 0;
            updateNavbarBackdropProgress(progress);
          }}
        >
          <HomeView
            upNext={
              mostRecentWatched
                ? {
                    progress: mostRecentWatched.progress,
                    episode: mostRecentWatched.episode,
                    seasonName: mostRecentWatched.seasonName,
                    posterUrl: mostRecentWatched.folder?.posterUrl,
                    bannerUrl: mostRecentWatched.folder?.bannerUrl,
                    anilistId: mostRecentWatched.folder?.anilistId,
                    isUpNext: mostRecentWatched.isUpNext,
                  }
                : null
            }
            folders={visibleFolders}
            history={history}
            userEntries={userEntries}
            onPlayEpisode={handlePlayEpisode}
            onSelectCatalogItem={(item) => setDetailSource({ kind: 'catalog', item })}
            onSelectLocalFolder={(folder) => setDetailSource({ kind: 'local', folder })}
            onOpenSchedule={() => setCurrentTab('schedule')}
            onOpenDiscover={() => setCurrentTab('discover')}
          />
        </div>}

        {/* Discover tab: genre-based catalog page with full-library search kept in the navbar. */}
        {(visitedTabs.has('discover') || currentTab === 'discover') && <div className={`h-full overflow-y-auto ${currentTab === 'discover' ? 'block' : 'hidden'}`}>
          <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-zinc-500">Loading Discover…</div>}>
            <DiscoverView
              folders={visibleFolders}
              history={history}
              userEntries={userEntries}
              settings={settings}
              initialGenre={discoverInitialGenre}
              onClearInitialGenre={() => setDiscoverInitialGenre(null)}
              onSelectItem={(item) => setDetailSource({ kind: 'catalog', item })}
            />
          </Suspense>
        </div>}

        {/* Library Tab View */}
        {(visitedTabs.has('library') || currentTab === 'library') && <div className={`h-full overflow-y-auto ${currentTab === 'library' ? 'block' : 'hidden'}`}>
          <div className="w-full">
            {/* Library shelf: cards open the unified title page */}
            <Suspense fallback={<div className="py-12 text-center text-sm text-zinc-500">Loading Library…</div>}>
              <FolderBrowser
                libraryRoot={
                  settings.libraryFolders && settings.libraryFolders.length > 1
                    ? `${settings.libraryFolders.length} folders (${settings.libraryFolders.map((f) => getPathBasename(f)).join(', ')})`
                    : settings.defaultLibraryRoot
                }
                folders={visibleFolders}
                history={history}
                followedAnime={followedAnime}
                favouriteAnime={favouriteAnime}
                userEntries={userEntries}
                loading={loading}
                onChangeRoot={handleChangeRoot}
                onRefresh={handleRefreshLibrary}
                onOpenFolderDetails={(folder, collectionOnly) => {
                  if (collectionOnly && folder.anilistId != null) {
                    const item: RailItem = {
                      anilistId: folder.anilistId,
                      title: folder.canonicalTitle || folder.folderName,
                      posterUrl: folder.posterUrl || null,
                      bannerUrl: folder.bannerUrl || null,
                      averageScore: folder.averageScore ?? null,
                      episodesCount: folder.totalEpisodes || null,
                    };
                    setDetailSource({ kind: 'catalog', item });
                  } else {
                    setDetailSource({ kind: 'local', folder });
                  }
                }}
              />
            </Suspense>
          </div>
        </div>}

        {/* Schedule Tab View */}
        {(visitedTabs.has('schedule') || currentTab === 'schedule') && <div className={`h-full overflow-y-auto ${currentTab === 'schedule' ? 'block' : 'hidden'}`}>
          <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-zinc-500">Loading Schedule…</div>}>
            <ScheduleView
              onSelectItem={(item) => setDetailSource({ kind: 'catalog', item })}
              statusFor={statusFor}
              followedAnime={followedAnime}
            />
          </Suspense>
        </div>}

        {/* Downloads Tab View (storage usage + files-only deletion) */}
        {(visitedTabs.has('downloads') || currentTab === 'downloads') && <div className={`h-full overflow-y-auto ${currentTab === 'downloads' ? 'block' : 'hidden'}`}>
          <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-zinc-500">Loading Downloads…</div>}>
            <DownloadsView onRefreshLibrary={handleRefreshLibrary} folders={visibleFolders} />
          </Suspense>
        </div>}

        {/* Whisper Studio Tab View (Never unmounted so active jobs & terminal logs are preserved) */}
        {whisperMounted && (
          <div className={`h-full flex-1 min-h-0 ${currentTab === 'whisper' ? 'flex flex-col' : 'hidden'}`}>
            <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-zinc-500">Loading Whisper Studio…</div>}>
              <WhisperStudio
                initialFolder={selectedFolder}
                whisperExists={binaryStatus.whisperExists}
                onRefreshLibrary={handleRefreshLibrary}
                onOpenSettings={() => setSettingsOpen(true)}
                settings={settings}
                onSaveSettings={handleSaveSettings}
                isActiveTab={currentTab === 'whisper'}
                folders={visibleFolders}
              />
            </Suspense>
          </div>
        )}
      </main>

      {/* Anime Detail Overlay (fixed z-40; the fullscreen player at z-50 stays above it).
          Intentionally kept while detailSource is set: unmounts during playback and
          re-appears right after the player closes. */}
      {detailSource && !activePlayerEpisode && (
        <Suspense fallback={<div className="fixed inset-0 z-40 flex items-center justify-center bg-[#0b0c10] text-sm text-zinc-400">Loading title…</div>}>
        <AnimeDetailView
          source={detailSource}
          initialDownloadEpisode={initialDownloadEpisode}
          settings={settings}
          onSelectGenre={(genre) => {
            setDetailSource(null);
            setDiscoverInitialGenre(genre);
            setCurrentTab('discover');
          }}
          p2pState={p2pState}
          isFollowing={followedAnime.some((item) => item.anilistId === (detailSource.kind === 'catalog' ? detailSource.item.anilistId : detailSource.folder.anilistId))}
          onToggleFollow={toggleFollowAnime}
          isFavourite={favouriteAnime.some((item) => {
            const id = detailSource.kind === 'catalog' ? detailSource.item.anilistId : detailSource.folder.anilistId;
            const title = detailSource.kind === 'catalog' ? detailSource.item.title : (detailSource.folder.canonicalTitle || detailSource.folder.folderName);
            const titleKey = title.toLocaleLowerCase().replace(/\b(season|s)\s*\d+\b/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
            return (id != null && item.anilistId === id) || item.titleKey === titleKey;
          })}
          onToggleFavourite={toggleFavouriteAnime}
          onBackdropProgressChange={updateNavbarBackdropProgress}
          folders={visibleFolders}
          history={history}
          userEntries={userEntries}
          onClose={() => {
            setInitialDownloadEpisode(null);
            setDetailSource(null);
          }}
          onPlayEpisode={handlePlayEpisode}
          onOpenRelated={(item) => setDetailSource({
            kind: 'catalog',
            item: {
              anilistId: item.anilistId,
              title: item.title.english || item.title.romaji || '',
              posterUrl: item.posterUrl,
              bannerUrl: item.bannerUrl,
              averageScore: item.averageScore,
              episodesCount: item.episodesCount,
              format: item.format || undefined,
              status: item.status || undefined,
              genres: item.genres,
              seasonYear: item.seasonYear,
            },
          })}
          onLibraryChanged={handleRefreshLibrary}
          onUserEntryChange={(entry) => {
            setUserEntries((prev) => ({ ...prev, [entry.anilistId]: entry }));
          }}
          onUserEntryRemove={(id) => {
            setUserEntries((prev) => {
              const next = { ...prev };
              delete next[id];
              return next;
            });
          }}
          onOpenWhisper={(folder) => {
            setSelectedFolder(folder);
            setInitialDownloadEpisode(null);
            setDetailSource(null);
            setCurrentTab('whisper');
          }}
        />
        </Suspense>
      )}

      {/* Fullscreen Video Player Modal or Safe Recovery Screen (BUG-01) */}
      {activePlayerEpisode &&
        (currentPlayingFolder ? (
          <Suspense fallback={<div className="fixed inset-0 z-50 flex items-center justify-center bg-[#0f0f12] text-sm text-zinc-400">Loading player…</div>}>
          <VideoPlayer
            episode={activePlayerEpisode}
            seasonEpisodes={currentPlayingFolder.episodes}
            folderPath={currentPlayingFolder.folderPath}
            folder={currentPlayingFolder}
            animeTitle={currentPlayingFolder.canonicalTitle || cleanSeriesTitle(currentPlayingFolder.folderName) || currentPlayingFolder.folderName}
            initialTime={playerInitialTime}
            settings={settings}
            onUpdateSettings={(updated) => setSettings((prev) => ({ ...prev, ...updated }))}
            history={history}
            onClose={handleClosePlayer}
            onEpisodeChange={handlePlayerEpisodeChange}
            onEpisodeCompleted={handleEpisodeCompleted}
          />
          </Suspense>
        ) : (
          <div className="fixed inset-0 z-50 bg-[#0f0f12] flex flex-col items-center justify-center p-6 text-center">
            <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-8 max-w-md shadow-2xl flex flex-col items-center">
              <AlertCircle className="w-12 h-12 text-rose-500 mb-4 animate-pulse" />
              <h2 className="text-xl font-bold text-zinc-100 mb-2">Playback Initialization Error</h2>
              <p className="text-sm text-zinc-400 mb-6">
                Unable to locate library metadata for this episode.
              </p>
              <button
                onClick={handleClosePlayer}
                className="px-6 py-2.5 bg-rose-600 hover:bg-rose-500 text-white font-medium rounded-xl transition-colors shadow-lg shadow-rose-900/30"
              >
                Return to Library (Esc)
              </button>
            </div>
          </div>
        ))}

      {/* Season-completion suggestion (hidden while the player covers the screen) */}
      {completionPrompt && !activePlayerEpisode && (
        <CompletionPrompt
          data={{ title: completionPrompt.title, sizeBytes: completionPrompt.sizeBytes }}
          onDelete={handleCompletionPromptDelete}
          onKeep={handleCompletionPromptKeep}
        />
      )}

      {/* Settings Modal */}
      {settingsMounted && <Suspense fallback={null}><SettingsModal
        isOpen={settingsOpen}
        onClose={handleCloseSettings}
        settings={settings}
        onSave={handleSaveSettings}
      /></Suspense>}

      {/* Startup Update Prompt */}
      {startupUpdate && (
        <UpdatePromptModal
          isOpen={Boolean(startupUpdate)}
          onClose={() => setStartupUpdate(null)}
          updateInfo={startupUpdate}
          appVersion={appVersion}
          onUpdateSettings={handleSaveSettings}
        />
      )}
    </div>
    </ToastProvider>
  );
};
