import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Navbar } from './components/Navbar';
import { HeroContinueWatching } from './components/Library/HeroContinueWatching';
import { FolderBrowser } from './components/Library/FolderBrowser';
import { VideoPlayer } from './components/Player/VideoPlayer';
import { WhisperStudio } from './components/WhisperStudio/WhisperStudio';
import { SettingsModal } from './components/SettingsModal';
import { AnimeFolder, Episode, AppSettings, PlaybackProgress } from './types';

export const App: React.FC = () => {
  // Navigation & View state
  const [currentTab, setCurrentTab] = useState<'library' | 'whisper'>('library');
  const [activePlayerEpisode, setActivePlayerEpisode] = useState<Episode | null>(null);
  const [playerInitialTime, setPlayerInitialTime] = useState<number>(0);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [isWhisperActive, setIsWhisperActive] = useState<boolean>(false);

  // Library & Data state
  const [settings, setSettings] = useState<AppSettings>({
    ffmpegPath: 'C:\\Users\\gogoh\\AppData\\Roaming\\Subtitle Edit\\SpeechToText\\Purfview-Faster-Whisper-XXL\\ffmpeg.exe',
    whisperPath: 'C:\\Users\\gogoh\\AppData\\Roaming\\Subtitle Edit\\SpeechToText\\Purfview-Faster-Whisper-XXL\\faster-whisper-xxl.exe',
    defaultLibraryRoot: 'D:\\films',
    autoPlayNext: true,
    subtitlesFontSize: 28,
    subtitlesOutline: true,
  });

  const [folders, setFolders] = useState<AnimeFolder[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<AnimeFolder | null>(null);
  const [history, setHistory] = useState<Record<string, PlaybackProgress>>({});
  const [loading, setLoading] = useState<boolean>(true);

  // 1. Load Settings and History on Startup
  const loadInitialData = useCallback(async () => {
    if (!window.electronAPI) {
      setLoading(false);
      return;
    }

    try {
      const appSettings = await window.electronAPI.getSettings();
      setSettings(appSettings);

      const watchHistory = await window.electronAPI.getAllPlaybackProgress();
      setHistory(watchHistory);

      // Scan Library Root
      const scannedFolders = await window.electronAPI.scanLibrary(appSettings.defaultLibraryRoot);
      setFolders(scannedFolders);

      if (scannedFolders.length > 0) {
        setSelectedFolder(scannedFolders[0]);
      }
    } catch (e) {
      console.error('Failed to load initial library data:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadInitialData();

    if (!window.electronAPI) return;

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

  // Refresh Library
  const handleRefreshLibrary = useCallback(async () => {
    setLoading(true);
    try {
      const watchHistory = await window.electronAPI.getAllPlaybackProgress();
      setHistory(watchHistory);

      const scanned = await window.electronAPI.scanLibrary(settings.defaultLibraryRoot);
      setFolders(scanned);

      if (scanned.length > 0) {
        // Keep current selected folder if still exists, or default to first
        const exists = scanned.find((f) => f.folderPath === selectedFolder?.folderPath);
        setSelectedFolder(exists || scanned[0]);
      }
    } catch (err) {
      console.error('Error refreshing library:', err);
    } finally {
      setLoading(false);
    }
  }, [settings.defaultLibraryRoot, selectedFolder]);

  // Find most recently watched episode across all anime folders
  const mostRecentWatched = useMemo(() => {
    const list = Object.values(history).filter(
      (h) => h.currentTime > 5 && !h.completed
    );
    if (list.length === 0) return null;

    list.sort((a, b) => b.lastWatchedAt - a.lastWatchedAt);
    const top = list[0];

    // Find the corresponding Episode object
    for (const folder of folders) {
      const found = folder.episodes.find((e) => e.filePath === top.filePath);
      if (found) {
        return {
          progress: top,
          episode: found,
          seasonName: folder.folderName,
        };
      }
    }

    return null;
  }, [history, folders]);

  // Change Root Directory
  const handleChangeRoot = async () => {
    const newRoot = await window.electronAPI.browseFolder(settings.defaultLibraryRoot);
    if (newRoot) {
      const updated = await window.electronAPI.updateSettings({ defaultLibraryRoot: newRoot });
      setSettings(updated);
      setLoading(true);
      const scanned = await window.electronAPI.scanLibrary(newRoot);
      setFolders(scanned);
      setSelectedFolder(scanned.length > 0 ? scanned[0] : null);
      setLoading(false);
    }
  };

  // Play Episode
  const handlePlayEpisode = (episode: Episode, startAt = 0) => {
    const saved = history[episode.filePath];
    const initial = startAt > 0 ? startAt : (saved?.currentTime && !saved.completed ? saved.currentTime : 0);
    setPlayerInitialTime(initial);
    setActivePlayerEpisode(episode);
  };

  // Close Player & Refresh Progress
  const handleClosePlayer = async () => {
    setActivePlayerEpisode(null);
    const watchHistory = await window.electronAPI.getAllPlaybackProgress();
    setHistory(watchHistory);
  };

  // Switch episode inside Player
  const handlePlayerEpisodeChange = (newEpisode: Episode) => {
    setActivePlayerEpisode(newEpisode);
    setPlayerInitialTime(0);
  };

  // Open Whisper Studio with preselected folder
  const handleOpenWhisperForFolder = (folder: AnimeFolder) => {
    setSelectedFolder(folder);
    setCurrentTab('whisper');
  };

  // Save Settings
  const handleSaveSettings = async (newSettings: Partial<AppSettings>) => {
    const updated = await window.electronAPI.updateSettings(newSettings);
    setSettings(updated);
    if (newSettings.defaultLibraryRoot && newSettings.defaultLibraryRoot !== settings.defaultLibraryRoot) {
      handleRefreshLibrary();
    }
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-[#0f0f12] text-zinc-100 overflow-hidden font-sans">
      {/* Top Navbar */}
      <Navbar
        currentTab={currentTab}
        onSelectTab={setCurrentTab}
        onOpenSettings={() => setSettingsOpen(true)}
        isWhisperActive={isWhisperActive}
      />

      {/* Main Content Area */}
      <main className="flex-1 overflow-y-auto">
        {currentTab === 'library' && (
          <div className="max-w-7xl mx-auto px-6 py-6">
            {/* Continue Watching Hero Section */}
            {mostRecentWatched && (
              <HeroContinueWatching
                lastWatched={mostRecentWatched.progress}
                episode={mostRecentWatched.episode}
                seasonName={mostRecentWatched.seasonName}
                onResume={(ep, time) => handlePlayEpisode(ep, time)}
              />
            )}

            {/* Folder Browser & Episode Grid */}
            <FolderBrowser
              libraryRoot={settings.defaultLibraryRoot}
              folders={folders}
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
        )}

        {currentTab === 'whisper' && (
          <WhisperStudio
            initialFolder={selectedFolder}
            onRefreshLibrary={handleRefreshLibrary}
          />
        )}
      </main>

      {/* Fullscreen Video Player Modal */}
      {activePlayerEpisode && selectedFolder && (
        <VideoPlayer
          episode={activePlayerEpisode}
          seasonEpisodes={selectedFolder.episodes}
          folderPath={selectedFolder.folderPath}
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
