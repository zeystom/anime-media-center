import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { AlertCircle } from 'lucide-react';
import { Navbar } from './components/Navbar';
import { HeroContinueWatching } from './components/Library/HeroContinueWatching';
import { FolderBrowser } from './components/Library/FolderBrowser';
import { VideoPlayer } from './components/Player/VideoPlayer';
import { WhisperStudio } from './components/WhisperStudio/WhisperStudio';
import { SettingsModal } from './components/SettingsModal';
import { AnimeFolder, Episode, AppSettings, PlaybackProgress } from './types';

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
  const [currentTab, setCurrentTab] = useState<'library' | 'whisper'>('library');
  const [activePlayerEpisode, setActivePlayerEpisode] = useState<Episode | null>(null);
  const [playerInitialTime, setPlayerInitialTime] = useState<number>(0);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [isWhisperActive, setIsWhisperActive] = useState<boolean>(false);

  // Library & Data state
  const [settings, setSettings] = useState<AppSettings>({
    ffmpegPath: '',
    whisperPath: '',
    defaultLibraryRoot: '',
    libraryFolders: [],
    autoPlayNext: true,
    subtitlesFontSize: 28,
    subtitlesOutline: true,
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
  const [loading, setLoading] = useState<boolean>(true);
  const [binaryStatus, setBinaryStatus] = useState<{ ffmpegExists: boolean; whisperExists: boolean }>({
    ffmpegExists: true,
    whisperExists: true,
  });

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
  }, [checkBinariesStatus]);

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

  // Find most recently watched episode across all anime folders
  const mostRecentWatched = useMemo(() => {
    const list = Object.values(history).filter(
      (h) => h.currentTime > 5 && !h.completed
    );
    if (list.length === 0) return null;

    list.sort((a, b) => b.lastWatchedAt - a.lastWatchedAt);
    const top = list[0];

    // Find the corresponding Episode object
    for (const folder of visibleFolders) {
      const found = folder.episodes.find((e) => e.filePath === top.filePath);
      if (found && !found.isDownloading) {
        return {
          progress: top,
          episode: found,
          seasonName: folder.folderName,
          folder,
        };
      }
    }

    return null;
  }, [history, visibleFolders]);

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

  // Resolve current active anime folder for player
  const currentPlayingFolder = useMemo(() => {
    if (!activePlayerEpisode) return null;
    return (
      folders.find((f) => f.episodes.some((e) => e.filePath === activePlayerEpisode.filePath)) ||
      selectedFolder
    );
  }, [activePlayerEpisode, folders, selectedFolder]);

  return (
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
          {(!binaryStatus.ffmpegExists || !binaryStatus.whisperExists) && (
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
              <button
                onClick={() => setSettingsOpen(true)}
                className="px-3 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 border border-amber-500/30 font-semibold transition-colors"
              >
                Open Settings
              </button>
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
        {/* Library Tab View */}
        <div className={`h-full overflow-y-auto ${currentTab === 'library' ? 'block' : 'hidden'}`}>
          <div className="max-w-7xl mx-auto px-6 py-6">
            {/* Continue Watching Hero Section */}
            {mostRecentWatched && (
              <HeroContinueWatching
                lastWatched={mostRecentWatched.progress}
                episode={mostRecentWatched.episode}
                seasonName={mostRecentWatched.seasonName}
                posterUrl={mostRecentWatched.folder?.posterUrl}
                bannerUrl={mostRecentWatched.folder?.bannerUrl}
                onResume={(ep, time) => handlePlayEpisode(ep, time)}
              />
            )}

            {/* Folder Browser & Episode Grid */}
            <FolderBrowser
              libraryRoot={
                settings.libraryFolders && settings.libraryFolders.length > 1
                  ? `${settings.libraryFolders.length} folders (${settings.libraryFolders.map((f) => f.split('\\').pop() || f).join(', ')})`
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
            />
          </div>
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

      {/* Fullscreen Video Player Modal */}
      {activePlayerEpisode && currentPlayingFolder && (
        <VideoPlayer
          episode={activePlayerEpisode}
          seasonEpisodes={currentPlayingFolder.episodes}
          folderPath={currentPlayingFolder.folderPath}
          initialTime={playerInitialTime}
          settings={settings}
          history={history}
          onClose={handleClosePlayer}
          onEpisodeChange={handlePlayerEpisodeChange}
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
  );
};
