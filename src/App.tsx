import React, { lazy, Suspense, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { AlertCircle, X } from 'lucide-react';
import { Navbar } from './components/Navbar';
import { HomeView, DiscoverNavigationTarget } from './components/Home/HomeView';
import type { DetailSource } from './components/AnimeDetail/AnimeDetailView';
import { CompletionPrompt, CompletionPromptData } from './components/common/CompletionPrompt';
import { AnimeFolder, DiscoverMode, Episode, AppSettings, PlaybackProgress, UserLibraryEntry, P2pState, UpdateInfoPayload } from './types';
import type { CatalogRelatedTitle } from './types';
import { useLocalStatus } from './hooks/useLocalStatus';
import { ToastProvider, showGlobalToast } from './components/Toast';
import { getPathBasename, getPathDirname, formatFileSize, cleanSeriesTitle, cleanEpisodeTitle, isFolderMovie } from './utils/format';
import { toRailItem } from './hooks/useCatalog';
import type { RailItem } from './hooks/useCatalog';
import { useActiveHeroBannerUrl } from './utils/heroBanner';
import { markScrollActivity } from './utils/scrollState';
import { resolveNotificationActionMeta, type AppNotification, type FavouriteAnime, type FollowedAnime, type LibraryCollectionFilter, type SettingsTabId } from './types/notifications';
import { UpdatePromptModal } from './components/UpdatePromptModal';
import {
  buildCatalogSearchAliases,
  findAllLocalFolders,
  inferReleasePreferenceFromEpisodes,
  mergeLocalFolders,
  parseNumericEpisodeNumber,
  pickAutomaticEpisodeRelease,
  readAnimeReleasePreference,
  type QueuedEpisodeDownload,
} from './utils/releaseSelection';
import { parseReleaseCore } from './lib/releaseParser/regexEngine.ts';
import { detectSeasonFromTitle, getTorrentLanguageLabel } from './lib/releaseParser/releaseClassification.ts';

export type { QueuedEpisodeDownload };

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
const AUTO_DL_RETRIES_STORAGE_KEY = 'anime-center.auto-dl-retries.v1';
const AUTO_DL_RETRY_MINUTES = [35, 60, 180, 360, 720, 1440];

interface AutoDownloadRetryItem {
  key: string;
  anilistId: number;
  episode: number;
  title: string;
  posterUrl: string | null;
  airedAtMs: number;
  nextRetryAtMs: number;
  attempts: number;
}

function readAutoDownloadRetries(): AutoDownloadRetryItem[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(AUTO_DL_RETRIES_STORAGE_KEY) || '[]');
    return Array.isArray(parsed)
      ? parsed.filter((item) => item && typeof item.key === 'string' && Number.isInteger(item.anilistId) && Number.isInteger(item.episode))
      : [];
  } catch {
    return [];
  }
}

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
  const [discoverInitialMode, setDiscoverInitialMode] = useState<Exclude<DiscoverMode, 'search'> | null>(null);
  const [discoverInitialGenre, setDiscoverInitialGenre] = useState<string | null>(null);
  const [activePlayerEpisode, setActivePlayerEpisode] = useState<Episode | null>(null);
  // Mirrors `activePlayerEpisode` for non-reactive readers (toast gating in
  // addNotification) so IPC listeners never re-subscribe on play/stop.
  const isPlayerOpenRef = useRef(false);
  const [playerInitialTime, setPlayerInitialTime] = useState<number>(0);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTabId | undefined>(undefined);
  const [libraryInitialFilter, setLibraryInitialFilter] = useState<LibraryCollectionFilter | null>(null);
  const handleClearLibraryFilter = useCallback(() => setLibraryInitialFilter(null), []);
  const handlePlayEpisodeRef = useRef<(episode: Episode, startAt?: number) => void>(() => {});
  const handleClosePlayerRef = useRef<() => Promise<void>>(async () => {});
  const [isWhisperActive, setIsWhisperActive] = useState<boolean>(false);
  const [detailSource, setDetailSource] = useState<DetailSource | null>(null);
  // Navbar backdrop progress lives OUTSIDE React state: scroll updates flow
  // through a tiny pub-sub so only the navbar re-renders per scroll step —
  // never the whole Home/Discover/Details page tree (scroll FPS).
  const navbarProgressEmitter = useRef<{ value: number; listeners: Set<(progress: number) => void> }>({
    value: 1,
    listeners: new Set(),
  });
  const [whisperMounted, setWhisperMounted] = useState(false);
  const [settingsMounted, setSettingsMounted] = useState(false);
  const [startupUpdate, setStartupUpdate] = useState<UpdateInfoPayload | null>(null);
  const [appVersion, setAppVersion] = useState<string>('1.0.11');

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
    const emitter = navbarProgressEmitter.current;
    // Navbar drives backdrop opacity/transform directly via DOM refs (no React
    // re-renders), so smooth continuous steps are essentially free.
    const next = Math.max(0, Math.min(1, progress));
    if (next !== 0 && next !== 1 && Math.abs(emitter.value - next) < 0.004) return;
    if (emitter.value === next) return;
    emitter.value = next;
    emitter.listeners.forEach((listener) => listener(next));
  }, []);

  const homeBackdropRafRef = useRef<number | null>(null);
  const homeHeroElRef = useRef<HTMLElement | null>(null);
  const homeHeroHeightRef = useRef<number>(0);
  const homeHeroObserverRef = useRef<ResizeObserver | null>(null);

  useEffect(() => () => {
    if (homeBackdropRafRef.current != null) window.cancelAnimationFrame(homeBackdropRafRef.current);
    homeHeroObserverRef.current?.disconnect();
  }, []);

  // Records scroll activity in a lightweight timestamp instead of mutating
  // DOM attributes on scroll containers (which triggered 21ms+ full-tree
  // style recalculations across 3,000+ nodes on every scroll start/stop).
  const markScrolling = useCallback(() => {
    markScrollActivity(150);
  }, []);

  useEffect(() => {
    const emitter = navbarProgressEmitter.current;
    if (emitter.value !== 1) {
      emitter.value = 1;
      emitter.listeners.forEach((listener) => listener(1));
    }
  }, [currentTab, detailSource]);

  // Stable handlers for the memoized page views below: identical identities
  // let React.memo skip entire page trees during unrelated App re-renders
  // (P2P progress bursts, notification churn, ...).
  const handleSelectTab = useCallback((tab: 'home' | 'discover' | 'library' | 'schedule' | 'downloads' | 'whisper') => {
    setInitialDownloadEpisode(null);
    setDetailSource(null);
    setCurrentTab(tab);
  }, []);
  const handleOpenSettings = useCallback((tab?: SettingsTabId) => {
    setSettingsInitialTab(typeof tab === 'string' ? tab : undefined);
    setSettingsMounted(true);
    setSettingsOpen(true);
  }, []);
  const handleSelectCatalogItem = useCallback((item: RailItem) => setDetailSource({ kind: 'catalog', item }), []);
  const handleSelectLocalFolder = useCallback((folder: AnimeFolder) => setDetailSource({ kind: 'local', folder }), []);
  const handleSelectSearchItem = useCallback((item: RailItem) => {
    setInitialDownloadEpisode(null);
    setDetailSource({ kind: 'catalog', item });
  }, []);
  const handleCloseDetails = useCallback(() => {
    setInitialDownloadEpisode(null);
    setDetailSource(null);
  }, []);
  const handleOpenSchedule = useCallback(() => setCurrentTab('schedule'), []);
  const handleOpenDiscover = useCallback((target?: DiscoverNavigationTarget) => {
    setDetailSource(null);
    if (target?.genre) {
      setDiscoverInitialGenre(target.genre);
      setDiscoverInitialMode(target.mode ?? null);
    } else if (target?.mode) {
      setDiscoverInitialGenre(null);
      setDiscoverInitialMode(target.mode);
    }
    setCurrentTab('discover');
  }, []);
  const handleSelectGenre = useCallback((genre: string) => {
    setDetailSource(null);
    setDiscoverInitialGenre(genre);
    setCurrentTab('discover');
  }, []);
  const handleClearDiscoverMode = useCallback(() => setDiscoverInitialMode(null), []);
  const handleClearDiscoverGenre = useCallback(() => setDiscoverInitialGenre(null), []);
  const handleOpenRelated = useCallback((item: CatalogRelatedTitle) => {
    setDetailSource({
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
    });
  }, []);
  const handleUserEntryChange = useCallback((entry: UserLibraryEntry) => {
    setUserEntries((prev) => ({ ...prev, [entry.anilistId]: entry }));
  }, []);
  const handleUserEntryRemove = useCallback((id: number) => {
    setUserEntries((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);
  const handleOpenWhisperFolder = useCallback((folder: AnimeFolder) => {
    setSelectedFolder(folder);
    setInitialDownloadEpisode(null);
    setDetailSource(null);
    setCurrentTab('whisper');
  }, []);

  // Library & Data state
  const [settings, setSettings] = useState<AppSettings>({
    ffmpegPath: '',
    whisperPath: '',
    defaultLibraryRoot: '',
    libraryFolders: [],
    autoPlayNext: true,
    navbarBlur: true,
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
    defaultAudioLanguage: 'auto',
    defaultSubtitleLanguage: 'auto',
    defaultSubtitleType: 'auto',
    defaultTopSubMode: 'auto',
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
  const [queuedEpisodeDownloads, setQueuedEpisodeDownloads] = useState<QueuedEpisodeDownload[]>([]);
  const [activeEpisodeQueueJob, setActiveEpisodeQueueJob] = useState<QueuedEpisodeDownload | null>(null);
  const [manualPickRequest, setManualPickRequest] = useState<{ anilistId: number; episode: number } | null>(null);
  const [autoDownloadRetries, setAutoDownloadRetries] = useState<AutoDownloadRetryItem[]>(readAutoDownloadRetries);
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
  const visibleFoldersActionRef = useRef<AnimeFolder[]>([]);
  visibleFoldersActionRef.current = visibleFolders;

  const markNotificationRead = useCallback((id: string) => {
    setNotifications((previous) => previous.map((item) => item.id === id ? { ...item, read: true } : item));
  }, []);

  const exitPlayerIfOpen = useCallback(() => {
    if (isPlayerOpenRef.current) {
      void handleClosePlayerRef.current();
    }
  }, []);

  const handleOpenLibraryFilter = useCallback((filter: LibraryCollectionFilter) => {
    exitPlayerIfOpen();
    setInitialDownloadEpisode(null);
    setDetailSource(null);
    setLibraryInitialFilter(filter);
    setCurrentTab('library');
  }, [exitPlayerIfOpen]);

  const handleNotificationAction = useCallback((item: AppNotification) => {
    const { actionType } = resolveNotificationActionMeta(item);
    const currentFolders = visibleFoldersActionRef.current;

    const findMatchingFolder = (): AnimeFolder | null => {
      if (item.folderPath) {
        const cleanTarget = item.folderPath.replace(/[/\\]+$/, '').toLowerCase();
        const byPath = currentFolders.find(
          (f) => f.folderPath.replace(/[/\\]+$/, '').toLowerCase() === cleanTarget
        );
        if (byPath) return byPath;
      }
      if (item.anilistId != null) {
        const byId = currentFolders.find((f) => f.anilistId === item.anilistId);
        if (byId) return byId;
      }
      const normTitle = normalizeAnimeTitle(item.animeTitle);
      if (normTitle.length >= 4) {
        const byTitle = currentFolders.find((f) => {
          const cf = normalizeAnimeTitle(f.canonicalTitle);
          const ff = normalizeAnimeTitle(f.folderName);
          return cf === normTitle || ff === normTitle;
        });
        if (byTitle) return byTitle;
      }
      return null;
    };

    const resolvedTitle =
      item.animeTitle ||
      (item.message.includes(' · ') ? item.message.split(' · ')[0] : item.title);

    if (actionType === 'open-settings') {
      handleOpenSettings(item.settingsTab || 'general');
      return;
    }

    if (actionType === 'open-library') {
      handleOpenLibraryFilter(
        item.libraryFilter || (item.kind === 'follow' ? 'followed' : 'all')
      );
      return;
    }

    if (actionType === 'open-downloads') {
      exitPlayerIfOpen();
      setInitialDownloadEpisode(null);
      setDetailSource(null);
      setCurrentTab('downloads');
      return;
    }

    if (actionType === 'open-whisper') {
      exitPlayerIfOpen();
      const folder = findMatchingFolder();
      if (folder) {
        setSelectedFolder(folder);
      }
      setInitialDownloadEpisode(null);
      setDetailSource(null);
      setCurrentTab('whisper');
      return;
    }

    if (actionType === 'play-episode') {
      if (item.filePath) {
        const targetLower = item.filePath.toLowerCase();
        for (const folder of currentFolders) {
          const ep = folder.episodes.find((entry) => entry.filePath.toLowerCase() === targetLower);
          if (ep && !ep.isDownloading) {
            setInitialDownloadEpisode(null);
            setDetailSource(null);
            handlePlayEpisodeRef.current(ep);
            return;
          }
        }
      }
      exitPlayerIfOpen();
      const folder = findMatchingFolder();
      if (folder) setSelectedFolder(folder);
      setInitialDownloadEpisode(null);
      setDetailSource(null);
      setCurrentTab('whisper');
      return;
    }

    if (actionType === 'manual-pick' && item.anilistId && item.episode) {
      exitPlayerIfOpen();
      setInitialDownloadEpisode(null);
      setManualPickRequest({ anilistId: item.anilistId, episode: item.episode });
      setDetailSource({
        kind: 'catalog',
        item: toRailItem({
          anilistId: item.anilistId,
          idMal: null,
          title: resolvedTitle,
          posterUrl: item.posterUrl ?? null,
          episode: item.episode,
          airingAt: Math.floor(item.createdAt / 1000),
        }),
      });
      return;
    }

    if (actionType === 'find-episode' && item.anilistId && item.episode) {
      exitPlayerIfOpen();
      setInitialDownloadEpisode(item.episode);
      setDetailSource({
        kind: 'catalog',
        item: toRailItem({
          anilistId: item.anilistId,
          idMal: null,
          title: resolvedTitle,
          posterUrl: item.posterUrl ?? null,
          episode: item.episode,
          airingAt: Math.floor(item.createdAt / 1000),
        }),
      });
      return;
    }

    if (actionType === 'open-anime') {
      exitPlayerIfOpen();
      const localFolder = findMatchingFolder();
      if (localFolder) {
        setInitialDownloadEpisode(null);
        setDetailSource({ kind: 'local', folder: localFolder });
        return;
      }
      if (item.anilistId) {
        setInitialDownloadEpisode(null);
        setDetailSource({
          kind: 'catalog',
          item: toRailItem({
            anilistId: item.anilistId,
            idMal: null,
            title: resolvedTitle,
            posterUrl: item.posterUrl ?? null,
            episode: item.episode ?? 1,
            airingAt: Math.floor(item.createdAt / 1000),
          }),
        });
        return;
      }
      setDetailSource(null);
      setCurrentTab('downloads');
    }
  }, [exitPlayerIfOpen, handleOpenLibraryFilter, handleOpenSettings]);

  const addNotification = useCallback((notification: Omit<AppNotification, 'id' | 'createdAt' | 'read'>) => {
    const item: AppNotification = {
      ...notification,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: Date.now(),
      read: false,
    };
    setNotifications((previous) => [item, ...previous].slice(0, 200));
    // Subtitle-generation events (whisper) stay silent while an episode plays
    // in the player — no toast over the video, the entry still lands in the
    // notification center for later.
    if (item.kind === 'whisper' && isPlayerOpenRef.current) return;
    const toastType = item.tone === 'purple'
      ? 'purple'
      : item.tone === 'green'
        ? 'success'
        : item.tone === 'amber'
          ? 'warning'
          : item.tone === 'red'
            ? 'error'
            : 'info';
    const { actionType, actionLabel } = resolveNotificationActionMeta(item);
    showGlobalToast(item.message, toastType, 5200, {
      title: item.title,
      posterUrl: item.posterUrl,
      kind: item.kind,
      notificationId: item.id,
      actionLabel: actionLabel ?? undefined,
      onMarkRead: () => markNotificationRead(item.id),
      onAction: actionType ? () => handleNotificationAction(item) : undefined,
    });
  }, [handleNotificationAction, markNotificationRead]);

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

  // Keep the toast-gate ref in lockstep with the player overlay state.
  useEffect(() => {
    isPlayerOpenRef.current = activePlayerEpisode !== null;
  }, [activePlayerEpisode]);

  useEffect(() => {
    try { localStorage.setItem(FOLLOWED_ANIME_STORAGE_KEY, JSON.stringify(followedAnime)); } catch {}
  }, [followedAnime]);

  useEffect(() => {
    try { localStorage.setItem(FAVOURITE_ANIME_STORAGE_KEY, JSON.stringify(favouriteAnime)); } catch {}
  }, [favouriteAnime]);

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
        ? previous.map((item) => item.anilistId === anime.anilistId ? { ...item, ...anime } : item)
        : [anime, ...previous]
      : previous.filter((item) => item.anilistId !== anime.anilistId));
    if (!follow) {
      setAutoDownloadRetries((previous) => previous.filter((item) => item.anilistId !== anime.anilistId));
    }
    addNotification({
      kind: 'follow',
      tone: follow ? 'green' : 'amber',
      title: follow ? 'Saved to Library · Following' : 'Removed from Following',
      animeTitle: anime.title,
      message: follow
        ? `${anime.title} was added to Following in your Library — new episodes will be tracked.`
        : `${anime.title} was removed from Following in your Library.`,
      anilistId: anime.anilistId,
      posterUrl: anime.posterUrl,
      actionType: 'open-library',
      libraryFilter: 'followed',
      actionLabel: 'View Following',
    });
  }, [addNotification]);

  const p2pStateRef = useRef(p2pState);
  p2pStateRef.current = p2pState;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const visibleFoldersRef = useRef(visibleFolders);
  visibleFoldersRef.current = visibleFolders;
  const followedAnimeRef = useRef(followedAnime);
  followedAnimeRef.current = followedAnime;
  const detailSourceRef = useRef(detailSource);
  detailSourceRef.current = detailSource;
  const autoDownloadRetriesRef = useRef(autoDownloadRetries);
  autoDownloadRetriesRef.current = autoDownloadRetries;
  const activeEpisodeQueueJobRef = useRef(activeEpisodeQueueJob);
  activeEpisodeQueueJobRef.current = activeEpisodeQueueJob;
  const episodeWorkerBusyRef = useRef(false);
  const retryWorkerBusyRef = useRef(false);

  useEffect(() => {
    try { localStorage.setItem(AUTO_DL_RETRIES_STORAGE_KEY, JSON.stringify(autoDownloadRetries)); } catch {}
  }, [autoDownloadRetries]);

  const scheduleAutoDownloadRetry = useCallback((entry: {
    anilistId: number;
    episode: number;
    title: string;
    posterUrl: string | null;
    airedAtMs: number;
  }) => {
    const key = `${entry.anilistId}:${entry.episode}`;
    const firstRetryAtMs = Math.max(Date.now(), entry.airedAtMs + AUTO_DL_RETRY_MINUTES[0] * 60_000);
    setAutoDownloadRetries((previous) => {
      if (previous.some((item) => item.key === key)) return previous;
      return [
        ...previous,
        {
          key,
          anilistId: entry.anilistId,
          episode: entry.episode,
          title: entry.title,
          posterUrl: entry.posterUrl,
          airedAtMs: entry.airedAtMs,
          nextRetryAtMs: firstRetryAtMs,
          attempts: 0,
        },
      ].slice(-60);
    });
  }, []);

  const updateFollowAutoDownload = useCallback((
    anilistId: number,
    autoDownload: boolean,
    preferredDownloadRoot?: string | null,
  ) => {
    setFollowedAnime((previous) =>
      previous.map((item) =>
        item.anilistId === anilistId
          ? {
              ...item,
              autoDownload,
              preferredDownloadRoot: preferredDownloadRoot !== undefined ? preferredDownloadRoot : item.preferredDownloadRoot,
            }
          : item,
      ),
    );
    if (!autoDownload) {
      setAutoDownloadRetries((previous) => previous.filter((item) => item.anilistId !== anilistId));
    }
    const followed = followedAnimeRef.current.find((item) => item.anilistId === anilistId);
    showGlobalToast(
      followed
        ? `${followed.title} — ${autoDownload ? 'auto-download enabled in Following.' : 'auto-download disabled.'}`
        : autoDownload
          ? 'Auto-download enabled for new episodes'
          : 'Auto-download disabled for new episodes',
      autoDownload ? 'success' : 'info',
      3800,
      {
        title: autoDownload ? 'Auto-Download Enabled' : 'Auto-Download Paused',
        posterUrl: followed?.posterUrl,
        kind: 'follow',
        actionLabel: 'View Following',
        onAction: () => handleOpenLibraryFilter('followed'),
      },
    );
  }, [handleOpenLibraryFilter]);

  const enqueueEpisodeDownloads = useCallback((items: QueuedEpisodeDownload[]) => {
    if (!Array.isArray(items) || items.length === 0) return;
    const jobs = p2pStateRef.current?.jobs || [];
    const activeJob = activeEpisodeQueueJobRef.current;
    setQueuedEpisodeDownloads((previous) => {
      const next = [...previous];
      for (const item of items) {
        if (!item || !Number.isFinite(item.anilistId) || !Number.isInteger(item.episode) || item.episode <= 0) continue;
        const alreadyDownloading = jobs.some((job) =>
          job.status !== 'error'
          && job.anilistId === item.anilistId
          && (
            job.episodes?.includes(item.episode)
            || job.episode === item.episode
            || (job.episode == null && (job.filesProgress || []).some((file) => {
              const parsed = parseReleaseCore(file.name);
              return parsed.episodeNumbers.includes(item.episode) || parsed.episodeNumber === item.episode;
            }))
          ),
        );
        if (alreadyDownloading) continue;
        if (activeJob && activeJob.anilistId === item.anilistId && activeJob.episode === item.episode) continue;
        if (next.some((existing) => existing.anilistId === item.anilistId && existing.episode === item.episode)) continue;
        next.push(item);
      }
      return next;
    });
  }, []);

  const toggleFavouriteAnime = useCallback((anime: FavouriteAnime, favourite: boolean) => {
    setFavouriteAnime((previous) => favourite
      ? previous.some((item) => (anime.anilistId != null && item.anilistId === anime.anilistId) || item.titleKey === anime.titleKey)
        ? previous.map((item) => (anime.anilistId != null && item.anilistId === anime.anilistId) || item.titleKey === anime.titleKey ? anime : item)
        : [anime, ...previous]
      : previous.filter((item) => !((anime.anilistId != null && item.anilistId === anime.anilistId) || item.titleKey === anime.titleKey)));
    showGlobalToast(
      favourite
        ? `${anime.title} was added to Favourites in your Library.`
        : `${anime.title} was removed from Favourites in your Library.`,
      'success',
      4200,
      {
        title: favourite ? 'Saved to Library · Favourites' : 'Removed from Favourites',
        posterUrl: anime.posterUrl,
        actionLabel: 'View Favourites',
        onAction: () => handleOpenLibraryFilter('favourites'),
      },
    );
  }, [handleOpenLibraryFilter]);

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
      const matchedFolder = folders.find((f) => f.anilistId != null && f.anilistId === job.anilistId) ?? null;
      const followedMatch = job.anilistId != null
        ? followedAnimeRef.current.find((f) => f.anilistId === job.anilistId) ?? null
        : null;
      const poster = matchedFolder?.posterUrl ?? followedMatch?.posterUrl ?? null;
      const suffix = job.episode != null ? ` · Episode ${job.episode}` : '';

      if (!p2pSeededRef.current) continue;

      // New job: announce the start with a live progress notification.
      if (before === undefined && (job.status === 'downloading' || job.status === 'connecting' || job.status === 'queued')) {
        const startedId = `dl:${job.infoHash}`;
        const startedMessage = `${job.title}${suffix} — searching peers and downloading.`;
        upsertDownloadNotification({
          kind: 'download',
          tone: 'blue',
          id: startedId,
          infoHash: job.infoHash,
          state: 'downloading',
          progress: Math.max(0, Math.min(100, job.progress ?? 0)),
          title: 'Download started',
          animeTitle: job.title,
          message: startedMessage,
          anilistId: job.anilistId ?? undefined,
          folderPath: matchedFolder?.folderPath ?? null,
          posterUrl: poster,
          episode: job.episode ?? undefined,
          actionType: 'open-downloads',
          actionLabel: 'Downloads',
        });
        showGlobalToast(startedMessage, 'info', 4800, {
          title: 'Download started',
          posterUrl: poster,
          kind: 'download',
          notificationId: startedId,
          actionLabel: 'Downloads',
          onMarkRead: () => markNotificationRead(startedId),
          onAction: () => {
            exitPlayerIfOpen();
            setDetailSource(null);
            setCurrentTab('downloads');
          },
        });
        prevProgressRef.current[job.infoHash] = job.progress ?? 0;
        continue;
      }

      if (before && before !== job.status) {
        if (job.status === 'completed') {
          const completedId = `dl:${job.infoHash}`;
          const canOpenAnime = Boolean(job.anilistId || matchedFolder?.folderPath);
          const completedNotif: Omit<AppNotification, 'createdAt' | 'read'> = {
            kind: 'download',
            tone: 'green',
            id: completedId,
            infoHash: job.infoHash,
            state: 'completed',
            progress: 100,
            title: 'Download complete',
            animeTitle: job.title,
            message: `${job.title}${suffix} is ready in your library.`,
            anilistId: job.anilistId ?? undefined,
            folderPath: matchedFolder?.folderPath ?? null,
            posterUrl: poster,
            episode: job.episode ?? undefined,
            actionType: canOpenAnime ? 'open-anime' : 'open-downloads',
            actionLabel: canOpenAnime ? 'Open Anime' : 'Downloads',
          };
          upsertDownloadNotification(completedNotif);
          showGlobalToast(completedNotif.message, 'success', 5500, {
            title: 'Download complete',
            posterUrl: poster,
            kind: 'download',
            notificationId: completedId,
            actionLabel: completedNotif.actionLabel,
            onMarkRead: () => markNotificationRead(completedId),
            onAction: () =>
              handleNotificationAction({
                ...completedNotif,
                createdAt: Date.now(),
                read: false,
              }),
          });
        } else if (job.status === 'error') {
          const errorId = `dl:${job.infoHash}`;
          const errMessage = job.error ? `${job.title}${suffix} — ${job.error}` : `${job.title}${suffix} failed.`;
          upsertDownloadNotification({
            kind: 'download',
            tone: 'red',
            id: errorId,
            infoHash: job.infoHash,
            state: 'error',
            title: 'Download failed',
            animeTitle: job.title,
            message: errMessage,
            anilistId: job.anilistId ?? undefined,
            folderPath: matchedFolder?.folderPath ?? null,
            posterUrl: poster,
            episode: job.episode ?? undefined,
            actionType: 'open-downloads',
            actionLabel: 'View Error',
          });
          showGlobalToast(errMessage, 'warning', 5500, {
            title: 'Download failed',
            posterUrl: poster,
            kind: 'download',
            notificationId: errorId,
            actionLabel: 'View Error',
            onMarkRead: () => markNotificationRead(errorId),
            onAction: () => {
              exitPlayerIfOpen();
              setDetailSource(null);
              setCurrentTab('downloads');
            },
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
            animeTitle: job.title,
            message: `${job.title}${suffix}`,
            anilistId: job.anilistId ?? undefined,
            folderPath: matchedFolder?.folderPath ?? null,
            posterUrl: poster,
            episode: job.episode ?? undefined,
            actionType: 'open-downloads',
            actionLabel: 'Downloads',
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
  }, [folders, upsertDownloadNotification, markNotificationRead, handleNotificationAction, exitPlayerIfOpen]);

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
        const finishedCandidateIds = new Set<number>();
        const followedEntries = await Promise.all(followedAnime.map(async (anime) => {
          try {
            const details = await window.electronAPI.getCatalogDetails(anime.anilistId);
            if (details?.episodesCount != null) followedEpisodeCounts.set(anime.anilistId, details.episodesCount);
            if (details?.status === 'FINISHED' && !details.nextAiringEpisode) {
              finishedCandidateIds.add(anime.anilistId);
            }
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
            animeTitle: entry.title,
            message: `${entry.title} · Episode ${entry.episode} has aired. Search your release sources to download it.`,
            anilistId: entry.anilistId,
            posterUrl: entry.posterUrl,
            episode: entry.episode,
            actionType: 'find-episode',
            actionLabel: `Find EP ${entry.episode}`,
          });
          if (followed?.autoDownload && p2pStateRef.current?.enabled) {
            scheduleAutoDownloadRetry({
              anilistId: entry.anilistId,
              episode: entry.episode,
              title: entry.title,
              posterUrl: entry.posterUrl,
              airedAtMs: entry.airingAt * 1000,
            });
          }
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
        if (finishedCandidateIds.size > 0) {
          const toUnfollow = new Set(
            [...finishedCandidateIds].filter(
              (id) => ![...upcoming.values()].some((pendingEntry) => pendingEntry.anilistId === id),
            ),
          );
          if (toUnfollow.size > 0) {
            setFollowedAnime((previous) => previous.filter((item) => !toUnfollow.has(item.anilistId)));
          }
        }
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
  }, [folders, followedAnime, addNotification, scheduleAutoDownloadRetry]);

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
          actionType: 'open-whisper',
          actionLabel: 'Whisper Studio',
        });
      }
    });

    const unsubEpisodeDone = window.electronAPI?.onWhisperEpisodeDone?.((data) => {
      const displayTitle = cleanEpisodeTitle(data.fileName).displayTitle || data.fileName;
      const epFolderPath = getPathDirname(data.filePath) || null;
      const matchingFolder = epFolderPath
        ? visibleFoldersActionRef.current.find(
            (f) => f.folderPath.replace(/[/\\]+$/, '').toLowerCase() === epFolderPath.replace(/[/\\]+$/, '').toLowerCase()
          )
        : undefined;
      addNotification({
        kind: 'whisper',
        title: 'Episode Subtitles Ready',
        animeTitle: matchingFolder?.canonicalTitle || matchingFolder?.folderName || undefined,
        message: `Generated subtitles for "${displayTitle}" (${data.index + 1}/${data.total})`,
        tone: 'purple',
        anilistId: matchingFolder?.anilistId ?? undefined,
        posterUrl: matchingFolder?.posterUrl ?? null,
        filePath: data.filePath,
        folderPath: epFolderPath,
        actionType: 'play-episode',
        actionLabel: 'Watch',
      });
      handleRefreshLibrary();
    });

    const unsubModelComplete = window.electronAPI?.onWhisperModelDownloadComplete?.((data) => {
      addNotification({
        kind: 'whisper',
        title: 'Model Ready',
        message: `Whisper model "${data.modelName}" is downloaded and ready to use.`,
        tone: 'green',
        actionType: 'open-whisper',
        actionLabel: 'Whisper Studio',
      });
    });

    const unsubEngineProgress = window.electronAPI?.onWhisperEngineDownloadProgress?.((data) => {
      if (data.phase === 'completed') {
        window.electronAPI.getSettings().then((updated) => {
          setSettings(updated);
          checkBinariesStatus(updated);
        });
        addNotification({
          kind: 'whisper',
          title: 'Faster-Whisper Ready',
          message: 'Faster-Whisper-XXL engine has been downloaded and configured successfully.',
          tone: 'green',
          actionType: 'open-whisper',
          actionLabel: 'Whisper Studio',
        });
      }
    });

    return () => {
      unsubProgress();
      unsubDone();
      if (unsubEpisodeDone) unsubEpisodeDone();
      if (unsubModelComplete) unsubModelComplete();
      if (unsubEngineProgress) unsubEngineProgress();
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
            const exists = scanned.find(
              (f) => f.folderPath.replace(/[/\\]+$/, '').toLowerCase() === prev?.folderPath?.replace(/[/\\]+$/, '').toLowerCase()
            );
            return exists || findLastWatchedFolder(scanned, watchHistory) || scanned[0];
          });
        } else {
          setSelectedFolder(null);
        }

        // Live update active anime detail view if currently open
        setDetailSource((prev) => {
          if (!prev || prev.kind !== 'local') return prev;
          const updated = scanned.find(
            (f) => f.folderPath.replace(/[/\\]+$/, '').toLowerCase() === prev.folder.folderPath.replace(/[/\\]+$/, '').toLowerCase()
          );
          return updated ? { kind: 'local', folder: updated } : prev;
        });
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

  // Persistent episode auto-download queue: runs in App so queuing several
  // episodes (e.g. "Download aired (7)") continues smoothly across navigation.
  useEffect(() => {
    const api = window.electronAPI;
    if (episodeWorkerBusyRef.current || queuedEpisodeDownloads.length === 0 || !p2pState?.enabled || !api?.searchReleases || !api.addDownload) {
      return;
    }
    const job = queuedEpisodeDownloads[0];
    episodeWorkerBusyRef.current = true;
    setActiveEpisodeQueueJob(job);

    void (async () => {
      try {
        const currentSettings = settingsRef.current;
        if (currentSettings.releaseSelectionMode === 'manual') {
          const activeDetailId = detailSourceRef.current?.kind === 'catalog'
            ? detailSourceRef.current.item.anilistId
            : detailSourceRef.current?.folder.anilistId;
          if (activeDetailId === job.anilistId) {
            setManualPickRequest({ anilistId: job.anilistId, episode: job.episode });
          }
          return;
        }

        const response = await api.searchReleases({
          title: job.title,
          aliases: job.aliases,
          anilistId: job.anilistId,
          season: job.season,
          part: job.part,
          episode: job.episode,
          episodeCount: job.episodeCount,
          episodeDurationMinutes: job.episodeDurationMinutes,
          mediaFormat: job.mediaFormat,
          franchiseSeasons: job.franchiseSeasons,
        });

        const mergedLocal = mergeLocalFolders(
          findAllLocalFolders(visibleFoldersRef.current, { anilistId: job.anilistId, title: job.title }),
        );
        const animePref = {
          ...inferReleasePreferenceFromEpisodes(mergedLocal?.episodes || []),
          ...(readAnimeReleasePreference(job.anilistId) || {}),
        };
        const audioPreferences = currentSettings.preferredTorrentAudioLanguages ?? ['en'];
        const subtitlePreferences = currentSettings.preferredTorrentSubtitleLanguages ?? ['en'];
        const { best, usedEnglishDubFallback, fallbackAudioLanguage, hasJapaneseSubAlternative } = pickAutomaticEpisodeRelease(
          response?.results ?? [],
          { audioPreferences, subtitlePreferences, animePref },
        );

        if (!best && (response?.results?.length ?? 0) > 0) {
          if (!job.background) {
            const englishDubOnly = audioPreferences.includes('en') && !audioPreferences.some((c) => c !== 'ja' && c !== 'en');
            const activeDetailId = detailSourceRef.current?.kind === 'catalog'
              ? detailSourceRef.current.item.anilistId
              : detailSourceRef.current?.folder.anilistId;
            if (activeDetailId === job.anilistId) {
              setManualPickRequest({ anilistId: job.anilistId, episode: job.episode });
            }
            showGlobalToast(
              hasJapaneseSubAlternative
                ? (englishDubOnly
                  ? `No English dub for episode ${job.episode} yet (Japanese sub available). Choose manually.`
                  : `No preferred dub for episode ${job.episode} yet (subtitled release available). Choose manually.`)
                : `No release matched your preferences for episode ${job.episode}. Choose manually.`,
              'warning',
              5200,
              {
                title: `${job.title} · Episode ${job.episode}`,
                actionLabel: 'Choose Release',
                onAction: () => {
                  exitPlayerIfOpen();
                  setInitialDownloadEpisode(null);
                  setManualPickRequest({ anilistId: job.anilistId, episode: job.episode });
                  setDetailSource({
                    kind: 'catalog',
                    item: toRailItem({
                      anilistId: job.anilistId,
                      idMal: null,
                      title: job.title,
                      posterUrl: mergedLocal?.posterUrl ?? null,
                      episode: job.episode,
                      airingAt: Math.floor(Date.now() / 1000),
                    }),
                  });
                },
              },
            );
          }
          return;
        }

        if (!best) {
          if (!job.background) {
            const justAired = job.airedAtMs != null && Date.now() >= job.airedAtMs && Date.now() - job.airedAtMs < 3 * 3600_000;
            if (justAired) {
              showGlobalToast(`Episode ${job.episode} aired recently — releases usually appear within 1–2 hours.`, 'warning');
            } else {
              const providerError = response?.reports?.find((report) => !report.ok)?.error;
              const skipped = response?.skippedWrongEpisodeCount ?? 0;
              showGlobalToast(
                skipped > 0
                  ? `No release for episode ${job.episode} was found; ${skipped} mismatched result(s) were skipped.`
                  : providerError
                    ? `No release found: ${providerError}`
                    : `No release found for episode ${job.episode}.`,
                'error',
                5000,
                {
                  title: `${job.title} · Episode ${job.episode}`,
                  actionLabel: 'Indexers Settings',
                  onAction: () => handleOpenSettings('downloads'),
                },
              );
            }
          }
          return;
        }

        const dest = job.targetFolder
          ? { targetFolder: job.targetFolder }
          : job.downloadRoot
            ? { downloadRoot: job.downloadRoot }
            : mergedLocal?.folderPath
              ? { targetFolder: mergedLocal.folderPath }
              : {};

        const result = await api.addDownload({
          item: best,
          title: job.title,
          anilistId: job.anilistId,
          episode: job.episode,
          season: job.season,
          mediaFormat: job.mediaFormat,
          episodeCount: job.episodeCount,
          mediaAliases: job.contentTitleAliases,
          franchiseSeasons: job.franchiseSeasons,
          ...dest,
        });

        if (!job.background) {
          if (result?.success && usedEnglishDubFallback) {
            const fallbackLabel = fallbackAudioLanguage === 'en' || !fallbackAudioLanguage
              ? 'English dub'
              : `${getTorrentLanguageLabel(fallbackAudioLanguage)} audio`;
            const missingSubNote = fallbackAudioLanguage === 'en' || !fallbackAudioLanguage
              ? 'No release with both English dub and English subtitles was found.'
              : 'No release with matching subtitles was found.';
            showGlobalToast(
              `Episode ${job.episode} queued with ${fallbackLabel}: ${best.title}. ${missingSubNote} You can create subtitles in Whisper Studio.`,
              'warning',
              5600,
              {
                title: `${job.title} · Ep ${job.episode}`,
                posterUrl: mergedLocal?.posterUrl ?? null,
                kind: 'whisper',
                actionLabel: 'Whisper Studio',
                onAction: () => {
                  exitPlayerIfOpen();
                  if (mergedLocal) setSelectedFolder(mergedLocal);
                  setDetailSource(null);
                  setCurrentTab('whisper');
                },
              },
            );
          } else if (result?.success) {
            showGlobalToast(`Episode ${job.episode} queued: ${best.title}`, 'success', 4500, {
              title: job.title,
              posterUrl: mergedLocal?.posterUrl ?? null,
              kind: 'download',
              actionLabel: 'Downloads',
              onAction: () => {
                exitPlayerIfOpen();
                setDetailSource(null);
                setCurrentTab('downloads');
              },
            });
          } else {
            showGlobalToast(result?.error || `Failed to queue episode ${job.episode}`, 'error', 4800, {
              title: `${job.title} · Episode ${job.episode}`,
              kind: 'download',
              actionLabel: 'Downloads',
              onAction: () => {
                exitPlayerIfOpen();
                setDetailSource(null);
                setCurrentTab('downloads');
              },
            });
          }
        }
        if (result?.success) {
          void handleRefreshLibrary();
        }
      } catch (err) {
        console.error(`Automatic release search failed for episode ${job.episode}:`, err);
        if (!job.background) {
          showGlobalToast(err instanceof Error ? err.message : `Release search failed for episode ${job.episode}`, 'error');
        }
      } finally {
        episodeWorkerBusyRef.current = false;
        setActiveEpisodeQueueJob(null);
        setQueuedEpisodeDownloads((pending) =>
          pending.filter((entry) => !(entry.anilistId === job.anilistId && entry.episode === job.episode)),
        );
      }
    })();
  }, [queuedEpisodeDownloads, p2pState?.enabled, handleRefreshLibrary]);

  // Follow auto-download retry scheduler: retries newly aired episodes at
  // +35m, +60m, +3h, +6h, +12h, +24h so tracker upload lag never fails silently.
  const hasAutoDownloadRetries = autoDownloadRetries.length > 0;
  useEffect(() => {
    const api = window.electronAPI;
    if (!p2pState?.enabled || !hasAutoDownloadRetries || !api?.searchReleases || !api.addDownload) return;
    let cancelled = false;

    const processDueRetries = async () => {
      if (retryWorkerBusyRef.current || cancelled) return;
      const due = autoDownloadRetriesRef.current.filter((item) => item.nextRetryAtMs <= Date.now());
      if (due.length === 0) return;

      retryWorkerBusyRef.current = true;
      try {
        for (const item of due) {
          if (cancelled) break;
          const followed = followedAnimeRef.current.find((f) => f.anilistId === item.anilistId);
          if (!followed || !followed.autoDownload) {
            setAutoDownloadRetries((prev) => prev.filter((r) => r.key !== item.key));
            continue;
          }

          const mergedFolder = mergeLocalFolders(
            findAllLocalFolders(visibleFoldersRef.current, { anilistId: item.anilistId, title: item.title }),
          );
          const alreadyLocal = (mergedFolder?.episodes || []).some(
            (ep) => !ep.isDownloading && parseNumericEpisodeNumber(ep.fileName, ep.episodeNumber) === item.episode,
          );
          const jobs = p2pStateRef.current?.jobs || [];
          const alreadyActive = jobs.some((job) =>
            job.status !== 'error'
            && job.anilistId === item.anilistId
            && (job.episodes?.includes(item.episode) || job.episode === item.episode),
          );
          if (alreadyLocal || alreadyActive) {
            setAutoDownloadRetries((prev) => prev.filter((r) => r.key !== item.key));
            continue;
          }

          const details = await api.getCatalogDetails(item.anilistId).catch(() => null);
          const related = await api.getCatalogFranchise(item.anilistId).catch(() => [] as CatalogRelatedTitle[]);
          const format = String(details?.format || '').toUpperCase();
          const seasonEligible = !format || ['TV', 'TV_SHORT', 'OVA', 'SPECIAL'].includes(format);
          const franchiseSeasonInfo = seasonEligible
            ? await api.getCatalogFranchiseSeasons?.(item.anilistId).catch(() => null)
            : null;
          const searchTitle = details?.title?.english || details?.title?.romaji || item.title;
          const aliases = buildCatalogSearchAliases(searchTitle, details, related);
          const season = format === 'MOVIE'
            ? null
            : (franchiseSeasonInfo?.ownSeason ?? detectSeasonFromTitle(searchTitle));
          const franchiseSeasons = format === 'MOVIE' ? [] : (franchiseSeasonInfo?.chain ?? []);
          const contentAliases = Array.from(new Set(
            [details?.title?.english, details?.title?.romaji, ...(details?.synonyms || [])]
              .filter((v): v is string => typeof v === 'string' && v.trim().length > 0),
          ));

          const response = await api.searchReleases({
            title: searchTitle,
            aliases,
            anilistId: item.anilistId,
            season,
            part: null,
            episode: item.episode,
            episodeCount: details?.episodesCount ?? null,
            episodeDurationMinutes: details?.durationMinutes ?? null,
            mediaFormat: details?.format ?? null,
            franchiseSeasons,
          }).catch(() => null);

          const currentSettings = settingsRef.current;
          const animePref = {
            ...inferReleasePreferenceFromEpisodes(mergedFolder?.episodes || []),
            ...(readAnimeReleasePreference(item.anilistId) || {}),
          };
          const { best } = pickAutomaticEpisodeRelease(response?.results ?? [], {
            audioPreferences: currentSettings.preferredTorrentAudioLanguages ?? ['en'],
            subtitlePreferences: currentSettings.preferredTorrentSubtitleLanguages ?? ['en'],
            animePref,
          });

          if (best) {
            const dest = mergedFolder?.folderPath
              ? { targetFolder: mergedFolder.folderPath }
              : followed.preferredDownloadRoot
                ? { downloadRoot: followed.preferredDownloadRoot }
                : {};
            const addRes = await api.addDownload({
              item: best,
              title: searchTitle,
              anilistId: item.anilistId,
              episode: item.episode,
              season,
              mediaFormat: details?.format ?? null,
              episodeCount: details?.episodesCount ?? null,
              mediaAliases: contentAliases,
              franchiseSeasons,
              ...dest,
            }).catch(() => null);

            if (addRes?.success) {
              setAutoDownloadRetries((prev) => prev.filter((r) => r.key !== item.key));
              void handleRefreshLibrary();
              addNotification({
                kind: 'download',
                tone: 'green',
                title: 'Auto-downloading episode',
                animeTitle: searchTitle,
                message: `${searchTitle} · Episode ${item.episode} queued automatically.`,
                anilistId: item.anilistId,
                folderPath: mergedFolder?.folderPath ?? null,
                posterUrl: details?.posterUrl || item.posterUrl,
                episode: item.episode,
                actionType: 'open-downloads',
                actionLabel: 'Downloads',
              });
              continue;
            }
          }

          const nextAttempts = item.attempts + 1;
          if (nextAttempts >= AUTO_DL_RETRY_MINUTES.length) {
            setAutoDownloadRetries((prev) => prev.filter((r) => r.key !== item.key));
            addNotification({
              kind: 'airing',
              tone: 'amber',
              title: "Auto-download couldn't find episode",
              animeTitle: searchTitle,
              message: `${searchTitle} · Episode ${item.episode} wasn't found automatically — click to search manually.`,
              anilistId: item.anilistId,
              posterUrl: details?.posterUrl || item.posterUrl,
              episode: item.episode,
              actionType: 'manual-pick',
              actionLabel: 'Choose Release',
            });
          } else {
            const nextRetryAtMs = Math.max(
              Date.now() + 60_000,
              item.airedAtMs + AUTO_DL_RETRY_MINUTES[nextAttempts] * 60_000,
            );
            setAutoDownloadRetries((prev) =>
              prev.map((r) => (r.key === item.key ? { ...r, attempts: nextAttempts, nextRetryAtMs } : r)),
            );
          }
        }
      } finally {
        retryWorkerBusyRef.current = false;
      }
    };

    void processDueRetries();
    const timer = window.setInterval(() => void processDueRetries(), 2 * 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [p2pState?.enabled, hasAutoDownloadRetries, autoDownloadRetries.length, addNotification, handleRefreshLibrary]);

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

    const buildUpNext = (targetFolder: AnimeFolder, nextEp: Episode, record: PlaybackProgress) => {
      const nextProgress: PlaybackProgress = history[nextEp.filePath] || {
        filePath: nextEp.filePath,
        folderPath: targetFolder.folderPath,
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
        seasonName: targetFolder.canonicalTitle || targetFolder.folderName,
        folder: targetFolder,
        isUpNext: true,
      };
    };

    // 1. Try finding from the most recent history records:
    for (const record of allHistory) {
      // Find the folder corresponding to this history entry
      const folder = visibleFolders.find((f) => f.folderPath === record.folderPath)
        || visibleFolders.find((f) => f.episodes.some((e) => e.filePath === record.filePath));

      if (!folder || folder.episodes.length === 0) {
        // Watched files (or whole season folder) may have been deleted to free
        // disk space before newer episodes arrived on the same or another drive.
        if (record.completed) {
          const watchedNum = parseNumericEpisodeNumber(record.fileName, record.episodeNumber);
          const inferredTitle = (record.folderPath ? getPathBasename(record.folderPath) : '') || cleanSeriesTitle(record.fileName);
          const merged = inferredTitle ? mergeLocalFolders(findAllLocalFolders(visibleFolders, { title: inferredTitle })) : null;
          if (merged && merged.episodes.length > 0) {
            const nextEp = merged.episodes.find((e) => {
              const epHist = history[e.filePath];
              const epNum = parseNumericEpisodeNumber(e.fileName, e.episodeNumber);
              return !e.isDownloading
                && (!epHist || !epHist.completed)
                && (watchedNum == null || epNum == null || epNum > watchedNum);
            });
            if (nextEp) return buildUpNext(merged, nextEp, record);
          }
        }
        continue;
      }

      const mergedForFolder = mergeLocalFolders(
        findAllLocalFolders(visibleFolders, { anilistId: folder.anilistId, title: folder.canonicalTitle || folder.folderName }),
      ) ?? folder;
      const episodeList = mergedForFolder.episodes;
      const epIndex = episodeList.findIndex((e) => e.filePath === record.filePath);

      if (epIndex === -1) {
        if (record.completed) {
          const watchedNum = parseNumericEpisodeNumber(record.fileName, record.episodeNumber);
          const nextEp = episodeList.find((e) => {
            const epHist = history[e.filePath];
            const epNum = parseNumericEpisodeNumber(e.fileName, e.episodeNumber);
            return !e.isDownloading
              && (!epHist || !epHist.completed)
              && (watchedNum == null || epNum == null || epNum > watchedNum);
          });
          if (nextEp) return buildUpNext(mergedForFolder, nextEp, record);
        }
        continue;
      }

      const currentEp = episodeList[epIndex];

      // CASE A: The episode is in-progress (not completed) and ready to play:
      if (!record.completed && !currentEp.isDownloading) {
        return {
          progress: record,
          episode: currentEp,
          seasonName: mergedForFolder.canonicalTitle || mergedForFolder.folderName,
          folder: mergedForFolder,
          isUpNext: false,
        };
      }

      // CASE B: The episode was COMPLETED (reached ending or >90% watched)!
      // Seamlessly advance to the NEXT unwatched episode across merged library drives:
      if (record.completed) {
        const nextEpisodes = episodeList.slice(epIndex + 1);
        const nextEp = nextEpisodes.find((e) => {
          const epHist = history[e.filePath];
          return (!epHist || !epHist.completed) && !e.isDownloading;
        });

        if (nextEp) {
          return buildUpNext(mergedForFolder, nextEp, record);
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
  const handlePlayEpisode = useCallback((episode: Episode, startAt = 0) => {
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
  }, [folders, history]);
  handlePlayEpisodeRef.current = handlePlayEpisode;

  // Close Player & Refresh Progress
  const handleClosePlayer = useCallback(async () => {
    // Automatically exit fullscreen and return to maximized windowed mode (taskbar visible)
    if (window.electronAPI?.setFullScreen) {
      await window.electronAPI.setFullScreen(false).catch(() => {});
    }
    setActivePlayerEpisode(null);
    const watchHistory = await window.electronAPI.getAllPlaybackProgress();
    setHistory(watchHistory);
    refreshUserEntries();
  }, [refreshUserEntries]);
  handleClosePlayerRef.current = handleClosePlayer;

  // Switch episode inside Player
  const handlePlayerEpisodeChange = (newEpisode: Episode, startAt?: number) => {
    const parentFolder = folders.find((f) => f.episodes.some((e) => e.filePath === newEpisode.filePath));
    if (parentFolder) {
      setSelectedFolder(parentFolder);
    }
    const saved = history[newEpisode.filePath];
    const initial =
      typeof startAt === 'number' && startAt >= 0
        ? startAt
        : (saved?.currentTime && !saved.completed ? saved.currentTime : 0);
    setPlayerInitialTime(initial);
    setActivePlayerEpisode(newEpisode);
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
  const settingsSaveGenRef = useRef(0);
  const handleSaveSettings = useCallback(async (newSettings: Partial<AppSettings>) => {
    const gen = ++settingsSaveGenRef.current;
    const prevFolders = settings.libraryFolders || (settings.defaultLibraryRoot ? [settings.defaultLibraryRoot] : []);
    const updated = await window.electronAPI.updateSettings(newSettings);
    if (gen !== settingsSaveGenRef.current) return;
    setSettings(updated);
    if (
      Object.prototype.hasOwnProperty.call(newSettings, 'ffmpegPath')
      || Object.prototype.hasOwnProperty.call(newSettings, 'whisperPath')
      || Object.prototype.hasOwnProperty.call(newSettings, 'whisperModel')
      || Object.prototype.hasOwnProperty.call(newSettings, 'customModelPath')
    ) {
      checkBinariesStatus(updated);
    }

    const newFolders = updated.libraryFolders || (updated.defaultLibraryRoot ? [updated.defaultLibraryRoot] : []);
    const foldersChanged =
      prevFolders.length !== newFolders.length ||
      prevFolders.some((f, idx) => f !== newFolders[idx]);

    if (foldersChanged) {
      handleRefreshLibrary();
    }
  }, [settings.libraryFolders, settings.defaultLibraryRoot, handleRefreshLibrary]);

  const handleCloseSettings = useCallback(() => {
    setSettingsOpen(false);
    setSettingsInitialTab(undefined);
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

  // Two-finger touchpad swipe-back tracking (see the history-sentinel effect below).
  const swipeAccumRef = useRef(0);
  const swipeDirRef = useRef(0);
  const swipeLastTsRef = useRef(0);

  // This is a single-page app, so the native mouse Back button must never
  // traverse Chromium's document history (which also contains the startup
  // splash page). Handle Back as an app-level stack instead. The touchpad
  // two-finger swipe gesture (and Alt+Left) fire Chromium history traversal
  // that cannot be prevented, so a sentinel history entry is kept: any
  // traversal lands back on this same document (popstate) and re-runs the
  // exact same app-level back action as the mouse Back button.
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

    // Horizontal swipe-back from raw wheel deltas. Only counts when the wheel
    // motion is clearly horizontal, nothing horizontally scrollable consumes
    // it, and enough distance (~2/3 of a trackpad swipe) accumulated in one
    // gesture without a direction flip.
    const canConsumeHorizontalScroll = (start: EventTarget | null, direction: number): boolean => {
      const startEl = start instanceof Element ? start : start instanceof Node ? start.parentElement : null;
      if (startEl) {
        const rail =
          startEl.closest('.horizontal-rail') ??
          startEl.closest('.horizontal-scroller-wrap')?.querySelector('.horizontal-rail');
        if (rail && rail.scrollWidth > rail.clientWidth + 2) return true;
      }
      let el = startEl;
      while (el && el !== document.body) {
        if (el.scrollWidth > el.clientWidth + 1) {
          const style = window.getComputedStyle(el);
          const scrollableX = style.overflowX === 'auto' || style.overflowX === 'scroll' || style.overflowX === 'overlay';
          if (scrollableX) {
            if (el.classList.contains('horizontal-rail')) return true;
            const atStart = el.scrollLeft <= 0;
            const atEnd = el.scrollLeft >= el.scrollWidth - el.clientWidth - 1;
            if (!(direction < 0 ? atEnd : atStart)) return true;
          }
        }
        el = el.parentElement;
      }
      return false;
    };
    const handleHorizontalSwipe = (event: WheelEvent) => {
      if (event.defaultPrevented) {
        swipeAccumRef.current = 0;
        return;
      }
      const now = Date.now();
      // Cooldown so momentum/inertia events can't immediately re-trigger.
      if (now - swipeLastTsRef.current < 1200) {
        swipeAccumRef.current = 0;
        return;
      }
      const rawDx = event.deltaMode === 1 ? event.deltaX * 16 : event.deltaX;
      const rawDy = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      if (Math.abs(rawDx) < 4 || Math.abs(rawDx) < Math.abs(rawDy) * 1.5) {
        swipeAccumRef.current = 0;
        swipeDirRef.current = 0;
        return;
      }
      const dir = Math.sign(rawDx);
      if (dir !== swipeDirRef.current) {
        swipeDirRef.current = dir;
        swipeAccumRef.current = 0;
      }
      if (canConsumeHorizontalScroll(event.target, dir)) {
        swipeAccumRef.current = 0;
        return;
      }
      swipeAccumRef.current += Math.abs(rawDx);
      if (dir < 0 && swipeAccumRef.current > 350) {
        swipeAccumRef.current = 0;
        swipeDirRef.current = 0;
        swipeLastTsRef.current = now;
        navigateBack();
      }
    };

    // Keep one sentinel entry ahead so swipe-triggered traversal stays inside
    // this document. Re-pushed after every popstate; skipped when the current
    // entry already is the sentinel, so the stack doesn't grow unboundedly.
    const pushGuardEntry = () => {
      try {
        if (!window.history.state?.kaikoGuard) window.history.pushState({ kaikoGuard: true }, '');
      } catch {}
    };
    const handlePopState = () => {
      navigateBack();
      pushGuardEntry();
    };

    pushGuardEntry();
    // Prevent Chromium from navigating away and handle Back exactly once.
    window.addEventListener('mousedown', suppressMouseNavigation, true);
    window.addEventListener('mouseup', suppressMouseNavigation, true);
    window.addEventListener('auxclick', suppressMouseNavigation, true);
    window.addEventListener('popstate', handlePopState);
    // Fallback for precision touchpads where the two-finger horizontal swipe
    // never becomes a history traversal (Windows): track mostly-horizontal
    // wheel deltas and trigger back once enough distance accumulates — unless
    // a horizontally scrollable container consumes the scroll first.
    window.addEventListener('wheel', handleHorizontalSwipe, { passive: true });
    return () => {
      window.removeEventListener('mousedown', suppressMouseNavigation, true);
      window.removeEventListener('mouseup', suppressMouseNavigation, true);
      window.removeEventListener('auxclick', suppressMouseNavigation, true);
      window.removeEventListener('popstate', handlePopState);
      window.removeEventListener('wheel', handleHorizontalSwipe);
    };
  }, [detailSource, currentTab, activePlayerEpisode, settingsOpen, handleClosePlayer]);

  const p2pIndicator = useMemo(() => {
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
  }, [p2pState]);

  const navbarAnimeId = activePlayerEpisode
    ? null
    : detailSource
      ? detailSource.kind === 'catalog'
        ? detailSource.item.anilistId
        : detailSource.folder.anilistId ?? null
      : currentTab === 'home'
        ? mostRecentWatched?.folder?.anilistId ?? null
        : null;
  const navbarFallbackImage = activePlayerEpisode
    ? null
    : detailSource
      ? detailSource.kind === 'catalog'
        ? (detailSource.item.anilistId ? detailSource.item.posterUrl : detailSource.item.bannerUrl || detailSource.item.posterUrl)
        : (detailSource.folder.anilistId ? detailSource.folder.posterUrl : detailSource.folder.bannerUrl || detailSource.folder.posterUrl)
      : currentTab === 'home'
        ? (mostRecentWatched?.folder?.anilistId ? mostRecentWatched?.folder?.posterUrl : mostRecentWatched?.folder?.bannerUrl || mostRecentWatched?.folder?.posterUrl)
        : null;
  const navbarBackdropImage = useActiveHeroBannerUrl(navbarAnimeId, navbarFallbackImage);
  const homeUpNextData = useMemo(
    () =>
      mostRecentWatched
        ? {
            progress: mostRecentWatched.progress,
            episode: mostRecentWatched.episode,
            seasonName: mostRecentWatched.seasonName,
            posterUrl: mostRecentWatched.folder?.posterUrl,
            bannerUrl: mostRecentWatched.folder?.bannerUrl,
            anilistId: mostRecentWatched.folder?.anilistId,
            isUpNext: mostRecentWatched.isUpNext,
            isMovie: mostRecentWatched.folder ? isFolderMovie(mostRecentWatched.folder) : false,
          }
        : null,
    [mostRecentWatched],
  );

  const activeDetailAnilistId = detailSource
    ? detailSource.kind === 'catalog'
      ? detailSource.item.anilistId
      : detailSource.folder.anilistId ?? null
    : null;
  const activeDetailFollowEntry = useMemo(
    () => (activeDetailAnilistId != null ? followedAnime.find((item) => item.anilistId === activeDetailAnilistId) ?? null : null),
    [followedAnime, activeDetailAnilistId],
  );
  const activeDetailQueuedEpisodes = useMemo(
    () =>
      activeDetailAnilistId != null
        ? queuedEpisodeDownloads
            .filter((item) => item.anilistId === activeDetailAnilistId)
            .map((item) => item.episode)
        : [],
    [queuedEpisodeDownloads, activeDetailAnilistId],
  );
  const activeDetailManualPickEpisode =
    manualPickRequest && activeDetailAnilistId != null && manualPickRequest.anilistId === activeDetailAnilistId
      ? manualPickRequest.episode
      : null;
  const clearManualPickRequest = useCallback(() => setManualPickRequest(null), []);
  useEffect(() => {
    setManualPickRequest((prev) => (prev && prev.anilistId === activeDetailAnilistId ? prev : null));
  }, [activeDetailAnilistId]);

  return (
    <ToastProvider>
      <div className="animate-app-enter relative flex h-screen w-screen flex-col overflow-hidden bg-[#07060A] font-sans text-zinc-100">
      {/* Top Navbar - Only rendered in Menu/Library/Whisper views */}
      {!activePlayerEpisode && (
        <>
          <Navbar
            currentTab={currentTab}
            backdropImage={navbarBackdropImage}
            backdropMode={detailSource ? 'anime' : 'ambient'}
            backdropEmitter={navbarProgressEmitter}
            blurEnabled={settings.navbarBlur ?? true}
            onSelectTab={handleSelectTab}
            onOpenSettings={handleOpenSettings}
            onSelectSearchItem={handleSelectSearchItem}
            notifications={notifications}
            onNotificationRead={markNotificationRead}
            onDismissNotification={dismissNotification}
            onMarkAllNotificationsRead={markAllNotificationsRead}
            onClearNotifications={clearNotifications}
            onNotificationAction={handleNotificationAction}
            isWhisperActive={isWhisperActive}
            downloadsActive={!!p2pState?.enabled && p2pState.jobs.some((j) => j.status === 'downloading' || j.status === 'connecting' || j.status === 'queued')}
            p2pIndicator={p2pIndicator}
          />
        </>
      )}

      {/* Main Content Area - Persists tab states without destroying components */}
      <main
        className={`flex-1 overflow-hidden relative flex flex-col ${
          activePlayerEpisode ? 'hidden' : 'block'
        }`}
      >
        {/* Home Tab View — full-bleed hero starts beneath the translucent navbar
            when UpNext is mounted; otherwise pt-[72px] keeps rails clear of it. */}
        {(visitedTabs.has('home') || currentTab === 'home') && <div
          className={`h-full overflow-y-auto scroll-composited ${mostRecentWatched ? '' : 'pt-[72px]'} ${currentTab === 'home' ? 'block' : 'hidden'}`}
          onScroll={(event) => {
            const container = event.currentTarget;
            const scrollTop = container.scrollTop;
            markScrolling();
            const cachedHeight = homeHeroHeightRef.current;
            if (scrollTop > (cachedHeight > 0 ? cachedHeight : 1300)) {
              updateNavbarBackdropProgress(0);
              return;
            }
            if (homeBackdropRafRef.current != null) return;
            homeBackdropRafRef.current = window.requestAnimationFrame(() => {
              homeBackdropRafRef.current = null;
              let hero = homeHeroElRef.current;
              if (!hero || !container.contains(hero)) {
                hero = container.querySelector<HTMLElement>('[data-backdrop-hero]');
                homeHeroElRef.current = hero;
                homeHeroObserverRef.current?.disconnect();
                if (hero) {
                  homeHeroHeightRef.current = hero.offsetHeight;
                  if (typeof ResizeObserver !== 'undefined') {
                    const ro = new ResizeObserver(() => {
                      if (homeHeroElRef.current) {
                        homeHeroHeightRef.current = homeHeroElRef.current.offsetHeight;
                      }
                    });
                    ro.observe(hero);
                    homeHeroObserverRef.current = ro;
                  }
                } else {
                  homeHeroHeightRef.current = 0;
                }
              }
              if (!hero) {
                updateNavbarBackdropProgress(0);
                return;
              }
              const heroHeight = homeHeroHeightRef.current || hero.offsetHeight;
              const progress = heroHeight > 0
                ? Math.max(0, Math.min(1, 1 - container.scrollTop / heroHeight))
                : 0;
              updateNavbarBackdropProgress(progress);
            });
          }}
        >
          <HomeView
            upNext={homeUpNextData}
            folders={visibleFolders}
            history={history}
            userEntries={userEntries}
            followedAnime={followedAnime}
            onPlayEpisode={handlePlayEpisode}
            onSelectCatalogItem={handleSelectCatalogItem}
            onSelectLocalFolder={handleSelectLocalFolder}
            onOpenSchedule={handleOpenSchedule}
            onOpenDiscover={handleOpenDiscover}
          />
        </div>}

        {/* Discover tab: genre-based catalog page with full-library search kept in the navbar. */}
        {(visitedTabs.has('discover') || currentTab === 'discover') && <div className={`h-full overflow-y-auto scroll-composited tab-scroll-symmetric pt-[72px] ${currentTab === 'discover' ? 'block' : 'hidden'}`} onScroll={markScrolling}>
          <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-zinc-500">Loading Discover…</div>}>
            <DiscoverView
              folders={visibleFolders}
              history={history}
              userEntries={userEntries}
              settings={settings}
              initialMode={discoverInitialMode}
              onClearInitialMode={handleClearDiscoverMode}
              initialGenre={discoverInitialGenre}
              onClearInitialGenre={handleClearDiscoverGenre}
              onSelectItem={handleSelectCatalogItem}
            />
          </Suspense>
        </div>}

        {/* Library Tab View */}
        {(visitedTabs.has('library') || currentTab === 'library') && <div className={`h-full overflow-y-auto scroll-composited tab-scroll-symmetric pt-[72px] ${currentTab === 'library' ? 'block' : 'hidden'}`} onScroll={markScrolling}>
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
              initialFilter={libraryInitialFilter}
              onClearInitialFilter={handleClearLibraryFilter}
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
        </div>}

        {/* Schedule Tab View */}
        {(visitedTabs.has('schedule') || currentTab === 'schedule') && <div className={`h-full overflow-y-auto scroll-composited tab-scroll-symmetric pt-[72px] ${currentTab === 'schedule' ? 'block' : 'hidden'}`}>
          <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-zinc-500">Loading Schedule…</div>}>
            <ScheduleView
              onSelectItem={handleSelectCatalogItem}
              statusFor={statusFor}
              followedAnime={followedAnime}
            />
          </Suspense>
        </div>}

        {/* Downloads Tab View (storage usage + files-only deletion) */}
        {(visitedTabs.has('downloads') || currentTab === 'downloads') && <div className={`h-full overflow-y-auto scroll-composited tab-scroll-symmetric pt-[72px] ${currentTab === 'downloads' ? 'block' : 'hidden'}`}>
          <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-zinc-500">Loading Downloads…</div>}>
            <DownloadsView onRefreshLibrary={handleRefreshLibrary} folders={visibleFolders} />
          </Suspense>
        </div>}

        {/* Whisper Studio Tab View (Never unmounted so active jobs & terminal logs are preserved) */}
        {whisperMounted && (
          <div className={`h-full flex-1 min-h-0 pt-[72px] ${currentTab === 'whisper' ? 'flex flex-col' : 'hidden'}`}>
            <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-zinc-500">Loading Whisper Studio…</div>}>
              <WhisperStudio
                initialFolder={selectedFolder}
                whisperExists={binaryStatus.whisperExists}
                onRefreshLibrary={handleRefreshLibrary}
                onOpenSettings={() => handleOpenSettings('ai')}
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
        <Suspense fallback={<div className="fixed inset-0 z-40 flex items-center justify-center bg-[#07060A] text-sm text-zinc-400">Loading title…</div>}>
        <AnimeDetailView
          source={detailSource}
          initialDownloadEpisode={initialDownloadEpisode}
          settings={settings}
          onSelectGenre={handleSelectGenre}
          p2pState={p2pState}
          isFollowing={followedAnime.some((item) => item.anilistId === (detailSource.kind === 'catalog' ? detailSource.item.anilistId : detailSource.folder.anilistId))}
          followEntry={activeDetailFollowEntry}
          onToggleFollow={toggleFollowAnime}
          onToggleFollowAutoDownload={updateFollowAutoDownload}
          enqueueEpisodeDownloads={enqueueEpisodeDownloads}
          queuedEpisodeNumbers={activeDetailQueuedEpisodes}
          manualPickRequestEpisode={activeDetailManualPickEpisode}
          onClearManualPickRequest={clearManualPickRequest}
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
          onClose={handleCloseDetails}
          onPlayEpisode={handlePlayEpisode}
          onOpenRelated={handleOpenRelated}
          onLibraryChanged={handleRefreshLibrary}
          onUserEntryChange={handleUserEntryChange}
          onUserEntryRemove={handleUserEntryRemove}
          onOpenWhisper={handleOpenWhisperFolder}
          onOpenDownloads={() => handleSelectTab('downloads')}
          onOpenSettings={handleOpenSettings}
        />
        </Suspense>
      )}

      {/* Fullscreen Video Player Modal or Safe Recovery Screen (BUG-01) */}
      {activePlayerEpisode &&
        (currentPlayingFolder ? (
          <Suspense fallback={<div className="fixed inset-0 z-50 flex items-center justify-center bg-void text-sm text-zinc-400"><span className="loader-pulse inline-flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-rose-500" />Loading player…</span></div>}>
          <VideoPlayer
            episode={activePlayerEpisode}
            seasonEpisodes={currentPlayingFolder.episodes}
            folderPath={currentPlayingFolder.folderPath}
            folder={currentPlayingFolder}
            animeTitle={currentPlayingFolder.canonicalTitle || cleanSeriesTitle(currentPlayingFolder.folderName) || currentPlayingFolder.folderName}
            initialTime={playerInitialTime}
            settings={settings}
            onUpdateSettings={handleSaveSettings}
            history={history}
            onClose={handleClosePlayer}
            onEpisodeChange={handlePlayerEpisodeChange}
            onEpisodeCompleted={handleEpisodeCompleted}
          />
          </Suspense>
        ) : (
          <div className="fixed inset-0 z-50 bg-void flex flex-col items-center justify-center p-6 text-center">
            <div className="glass-panel border border-white/10 rounded-2xl p-8 max-w-md shadow-2xl flex flex-col items-center">
              <AlertCircle className="w-12 h-12 text-rose-500 mb-4 animate-pulse" />
              <h2 className="text-xl font-bold text-zinc-100 mb-2">Playback Initialization Error</h2>
              <p className="text-sm text-zinc-400 mb-6">
                Unable to locate library metadata for this episode.
              </p>
              <button
                onClick={handleClosePlayer}
                className="btn-primary px-6 py-2.5 text-white font-medium rounded-xl transition-colors"
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
        initialTab={settingsInitialTab}
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
