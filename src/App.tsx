import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { AlertCircle, X } from 'lucide-react';
import { Navbar } from './components/Navbar';
import { HomeView } from './components/Home/HomeView';
import { FolderBrowser } from './components/Library/FolderBrowser';
import { AnimeDetailView, DetailSource } from './components/AnimeDetail/AnimeDetailView';
import { ScheduleView } from './components/Schedule/ScheduleView';
import { VideoPlayer } from './components/Player/VideoPlayer';
import { WhisperStudio } from './components/WhisperStudio/WhisperStudio';
import { DownloadsView } from './components/Downloads/DownloadsView';
import { CompletionPrompt, CompletionPromptData } from './components/common/CompletionPrompt';
import { SettingsModal } from './components/SettingsModal';
import { AnimeFolder, Episode, AppSettings, PlaybackProgress, UserLibraryEntry } from './types';
import { useLocalStatus } from './hooks/useLocalStatus';
import { ToastProvider, showGlobalToast } from './components/Toast';
import { getPathBasename, getPathDirname, formatFileSize } from './utils/format';

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

export const App: React.FC = () => {
  // Navigation & View state
  const [currentTab, setCurrentTab] = useState<'home' | 'library' | 'schedule' | 'downloads' | 'whisper'>('home');
  const [activePlayerEpisode, setActivePlayerEpisode] = useState<Episode | null>(null);
  const [playerInitialTime, setPlayerInitialTime] = useState<number>(0);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [isWhisperActive, setIsWhisperActive] = useState<boolean>(false);
  const [detailSource, setDetailSource] = useState<DetailSource | null>(null);

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
    subtitlesOutlineWidth: 'thick',
    subtitlesOutlineColor: '#000000',
  });

  const [folders, setFolders] = useState<AnimeFolder[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<AnimeFolder | null>(null);

  // Filter folders if user enabled 'Hide downloading / incomplete releases'
  const visibleFolders = useMemo(() => {
    if (settings.hideDownloadingAnime) {
      return folders.filter((f) => !f.isDownloading);
    }
    return folders;
  }, [folders, settings.hideDownloadingAnime]);

  useEffect(() => {
    if (settings.hideDownloadingAnime && selectedFolder?.isDownloading) {
      setSelectedFolder(visibleFolders[0] || null);
    }
  }, [settings.hideDownloadingAnime, selectedFolder, visibleFolders]);
  const [history, setHistory] = useState<Record<string, PlaybackProgress>>({});
  const [userEntries, setUserEntries] = useState<Record<number, UserLibraryEntry>>({});
  const [loading, setLoading] = useState<boolean>(true);
  const [binaryStatus, setBinaryStatus] = useState<{ ffmpegExists: boolean; whisperExists: boolean }>({
    ffmpegExists: true,
    whisperExists: true,
  });
  const [bannerDismissed, setBannerDismissed] = useState<boolean>(false);

  // Season-completion suggestion: offers to free downloaded files when a
  // season finishes playing. Dismissed folders stay muted for the session.
  const [completionPrompt, setCompletionPrompt] = useState<CompletionPromptState | null>(null);
  const dismissedFoldersRef = useRef<Set<string>>(new Set());

  const isScanningRef = useRef(false);
  const scanPendingRef = useRef(false);

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

      // Scan all configured Library Roots
      const scannedFolders = await window.electronAPI.scanLibrary();
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

    const unsubDone = window.electronAPI.onWhisperDone(() => {
      setIsWhisperActive(false);
    });

    return () => {
      unsubProgress();
      unsubDone();
    };
  }, [loadInitialData]);

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

  return (
    <ToastProvider>
      <div className="flex flex-col h-screen w-screen bg-[#0f0f12] text-zinc-100 overflow-hidden font-sans">
      {/* Top Navbar - Only rendered in Menu/Library/Whisper views */}
      {!activePlayerEpisode && (
        <>
          <Navbar
            currentTab={currentTab}
            onSelectTab={setCurrentTab}
            onOpenSettings={() => setSettingsOpen(true)}
            isWhisperActive={isWhisperActive}
          />

          {/* Missing Binary Warning Banner */}
          {(!binaryStatus.ffmpegExists || !binaryStatus.whisperExists) &&
            !bannerDismissed &&
            currentTab !== 'whisper' && (
              <div className="bg-amber-500/10 border-b border-amber-500/20 px-6 py-2.5 flex items-center justify-between text-xs text-amber-300">
                <div className="flex items-center space-x-2">
                  <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
                  <span>
                    {!binaryStatus.ffmpegExists && !binaryStatus.whisperExists
                      ? 'FFmpeg and Whisper binaries not found. Configure tool paths in Settings to enable video playback and AI subtitles.'
                      : !binaryStatus.ffmpegExists
                      ? 'FFmpeg binary not found. Video transcoding and playback will not function.'
                      : 'Faster-Whisper binary not found. AI subtitle generation will not function.'}
                  </span>
                </div>
                <div className="flex items-center space-x-2">
                  <button
                    onClick={() => setSettingsOpen(true)}
                    className="px-3 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 border border-amber-500/30 font-semibold transition-colors"
                  >
                    Open Settings
                  </button>
                  <button
                    onClick={() => setBannerDismissed(true)}
                    className="p-1 rounded-lg text-amber-400/80 hover:text-amber-200 hover:bg-amber-500/20 transition-colors"
                    title="Dismiss warning"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
        </>
      )}

      {/* Main Content Area - Persists tab states without destroying components */}
      <main
        className={`flex-1 overflow-hidden relative flex flex-col ${
          activePlayerEpisode ? 'hidden' : 'block'
        }`}
      >
        {/* Home Tab View */}
        <div className={`h-full overflow-y-auto ${currentTab === 'home' ? 'block' : 'hidden'}`}>
          <HomeView
            upNext={
              mostRecentWatched
                ? {
                    progress: mostRecentWatched.progress,
                    episode: mostRecentWatched.episode,
                    seasonName: mostRecentWatched.seasonName,
                    posterUrl: mostRecentWatched.folder?.posterUrl,
                    bannerUrl: mostRecentWatched.folder?.bannerUrl,
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
          />
        </div>

        {/* Library Tab View */}
        <div className={`h-full overflow-y-auto ${currentTab === 'library' ? 'block' : 'hidden'}`}>
          <div className="max-w-7xl mx-auto px-6 py-6">
            {/* Folder Browser & Episode Grid */}
            <FolderBrowser
              libraryRoot={
                settings.libraryFolders && settings.libraryFolders.length > 1
                  ? `${settings.libraryFolders.length} folders (${settings.libraryFolders.map((f) => getPathBasename(f)).join(', ')})`
                  : settings.defaultLibraryRoot
              }
              folders={visibleFolders}
              selectedFolder={selectedFolder}
              history={history}
              loading={loading}
              onSelectFolder={setSelectedFolder}
              onChangeRoot={handleChangeRoot}
              onRefresh={handleRefreshLibrary}
              onPlayEpisode={(ep) => handlePlayEpisode(ep)}
              onOpenWhisper={handleOpenWhisperForFolder}
              onOpenInExplorer={(p) => window.electronAPI.openFolderInExplorer(p)}
              onOpenFolderDetails={(folder) => setDetailSource({ kind: 'local', folder })}
            />
          </div>
        </div>

        {/* Schedule Tab View */}
        <div className={`h-full overflow-y-auto ${currentTab === 'schedule' ? 'block' : 'hidden'}`}>
          <ScheduleView
            onSelectItem={(item) => setDetailSource({ kind: 'catalog', item })}
            statusFor={statusFor}
          />
        </div>

        {/* Downloads Tab View (storage usage + files-only deletion) */}
        <div className={`h-full overflow-y-auto ${currentTab === 'downloads' ? 'block' : 'hidden'}`}>
          <DownloadsView onRefreshLibrary={handleRefreshLibrary} />
        </div>

        {/* Whisper Studio Tab View (Never unmounted so active jobs & terminal logs are preserved) */}
        <div className={`h-full flex-1 min-h-0 ${currentTab === 'whisper' ? 'flex flex-col' : 'hidden'}`}>
          <WhisperStudio
            initialFolder={selectedFolder}
            whisperExists={binaryStatus.whisperExists}
            onRefreshLibrary={handleRefreshLibrary}
            onOpenSettings={() => setSettingsOpen(true)}
          />
        </div>
      </main>

      {/* Anime Detail Overlay (fixed z-40; the fullscreen player at z-50 stays above it).
          Intentionally kept while detailSource is set: unmounts during playback and
          re-appears right after the player closes. */}
      {detailSource && !activePlayerEpisode && (
        <AnimeDetailView
          source={detailSource}
          folders={visibleFolders}
          history={history}
          userEntries={userEntries}
          onClose={() => setDetailSource(null)}
          onPlayEpisode={handlePlayEpisode}
          onLibraryChanged={handleRefreshLibrary}
          onOpenWhisper={(folder) => {
            setSelectedFolder(folder);
            setDetailSource(null);
            setCurrentTab('whisper');
          }}
        />
      )}

      {/* Fullscreen Video Player Modal or Safe Recovery Screen (BUG-01) */}
      {activePlayerEpisode &&
        (currentPlayingFolder ? (
          <VideoPlayer
            episode={activePlayerEpisode}
            seasonEpisodes={currentPlayingFolder.episodes}
            folderPath={currentPlayingFolder.folderPath}
            initialTime={playerInitialTime}
            settings={settings}
            onUpdateSettings={(updated) => setSettings((prev) => ({ ...prev, ...updated }))}
            history={history}
            onClose={handleClosePlayer}
            onEpisodeChange={handlePlayerEpisodeChange}
            onEpisodeCompleted={handleEpisodeCompleted}
          />
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
      <SettingsModal
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onSave={handleSaveSettings}
      />
    </div>
    </ToastProvider>
  );
};
