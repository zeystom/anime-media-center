import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Settings as SettingsIcon,
  RotateCcw,
  Plus,
  Trash2,
  Folder,
  FolderOpen,
  RefreshCw,
  ExternalLink,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  HelpCircle,
  Cpu,
  Database,
  Download,
  Upload,
  Save,
  Share2,
  Gauge,
  Rss,
  Languages,
  Sparkles,
  Subtitles,
  Volume2,
} from 'lucide-react';
import { AppSettings, type DefaultSubtitleType, type DefaultTopSubMode } from '../types';
import type { P2pState, RssProvider, UpdaterState, UpdateInfoPayload, FolderDiskSpace } from '../types';
import type { SettingsTabId } from '../types/notifications';
import { showGlobalToast } from './Toast';
import { GlassSelect } from './common/GlassSelect';
import { DiskSpaceRing } from './common/DiskSpaceRing';
import { enableDeveloperMode, useDeveloperMode } from '../utils/devMode';
import { P2pConsentModal } from './P2P/P2pConsentModal';
import { UpdatePromptModal } from './UpdatePromptModal';
import { extractDriveLabelFromPath, formatDiskSize, formatFileSize, getDiskHealthStyle, getFolderDisplayName } from '../utils/format';
import { getTorrentLanguageLabel, TORRENT_LANGUAGES, type TorrentLanguageCode } from '../lib/releaseParser/releaseClassification';

interface BackupStatusInfo {
  exists: boolean;
  path: string;
  lastSyncedAt?: number;
  sizeBytes?: number;
}

/** Compact relative timestamp for the backup 'Last synced' line. */
function formatRelativeTime(ts?: number): string | null {
  if (!ts || ts <= 0) return null;
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Small toggle switch matching the app's existing switch style (EpisodeDrawer). */
const ToggleSwitch: React.FC<{
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  label: string;
}> = ({ checked, onChange, disabled, label }) => (
  <button
    type="button"
    onClick={onChange}
    disabled={disabled}
    aria-label={label}
    title={label}
    className={`w-11 h-6 rounded-full p-0.5 transition-colors duration-200 shrink-0 disabled:opacity-50 ${
      checked ? 'bg-rose-500 shadow-[0_0_12px_rgba(255,30,109,0.35)]' : 'bg-zinc-700'
    }`}
  >
    <div
      className={`w-5 h-5 rounded-full bg-white shadow-md transition-transform duration-200 ${
        checked ? 'translate-x-5' : 'translate-x-0'
      }`}
    />
  </button>
);

export type { SettingsTabId };

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  onSave: (newSettings: Partial<AppSettings>) => void;
  initialTab?: SettingsTabId;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  onSave,
  initialTab,
}) => {
  const [ffmpegPath, setFfmpegPath] = useState(settings.ffmpegPath);
  const [whisperPath, setWhisperPath] = useState(settings.whisperPath);
  const [whisperModel, setWhisperModel] = useState<string>(settings.whisperModel || 'large-v3-turbo');
  const [customModelPath, setCustomModelPath] = useState<string>(settings.customModelPath || '');
  const [libraryFolders, setLibraryFolders] = useState<string[]>(
    Array.isArray(settings.libraryFolders) && settings.libraryFolders.length > 0
      ? settings.libraryFolders
      : settings.defaultLibraryRoot
      ? [settings.defaultLibraryRoot]
      : []
  );
  const [folderDiskSpaces, setFolderDiskSpaces] = useState<Record<string, FolderDiskSpace>>({});

  useEffect(() => {
    if (!isOpen || libraryFolders.length === 0 || !window.electronAPI?.getFoldersDiskSpace) {
      setFolderDiskSpaces({});
      return;
    }
    let cancelled = false;
    window.electronAPI
      .getFoldersDiskSpace(libraryFolders)
      .then((entries) => {
        if (cancelled || !Array.isArray(entries)) return;
        const map: Record<string, FolderDiskSpace> = {};
        for (const entry of entries) {
          map[entry.folderPath] = entry;
          map[entry.folderPath.toLowerCase()] = entry;
        }
        setFolderDiskSpaces(map);
      })
      .catch(() => {
        // Ignore transient disk stats errors in Settings
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, libraryFolders]);
  const [releaseSelectionMode, setReleaseSelectionMode] = useState<'automatic' | 'manual'>(
    settings.releaseSelectionMode ?? 'automatic'
  );
  const [preferredAudioLanguages, setPreferredAudioLanguages] = useState<TorrentLanguageCode[]>(
    (settings.preferredTorrentAudioLanguages ?? ['en']) as TorrentLanguageCode[]
  );
  const [preferredSubtitleLanguages, setPreferredSubtitleLanguages] = useState<TorrentLanguageCode[]>(
    (settings.preferredTorrentSubtitleLanguages ?? ['en']) as TorrentLanguageCode[]
  );
  const [defaultAudioLanguage, setDefaultAudioLanguage] = useState<string>(
    settings.defaultAudioLanguage ?? 'auto'
  );
  const [defaultSubtitleLanguage, setDefaultSubtitleLanguage] = useState<string>(
    settings.defaultSubtitleLanguage ?? 'auto'
  );
  const [defaultSubtitleType, setDefaultSubtitleType] = useState<DefaultSubtitleType>(
    settings.defaultSubtitleType ?? 'auto'
  );
  const [defaultTopSubMode, setDefaultTopSubMode] = useState<DefaultTopSubMode>(
    settings.defaultTopSubMode ?? 'auto'
  );
  const wasOpenRef = useRef(false);
  const preferredAudioRef = useRef<TorrentLanguageCode[]>(preferredAudioLanguages);
  const preferredSubtitleRef = useRef<TorrentLanguageCode[]>(preferredSubtitleLanguages);
  const [animeTitleLanguage, setAnimeTitleLanguage] = useState<'english' | 'romaji' | 'native'>(
    settings.animeTitleLanguage ?? 'english'
  );
  const [navbarBlur, setNavbarBlur] = useState<boolean>(settings.navbarBlur ?? true);

  const [binaryStatus, setBinaryStatus] = useState<{
    ffmpegExists: boolean;
    whisperExists: boolean;
    modelExists?: boolean;
    isDefaultModelInstalled?: boolean;
    modelName?: string;
    installedModels?: string[];
    detectedCustomModels?: string[];
    customModelDetectedName?: string | null;
    isDownloadingModel?: boolean;
    downloadingModelName?: string | null;
  }>({
    ffmpegExists: false,
    whisperExists: false,
    modelExists: false,
    isDefaultModelInstalled: false,
    modelName: 'large-v3-turbo',
    installedModels: [],
    detectedCustomModels: [],
    isDownloadingModel: false,
    downloadingModelName: null,
  });

  const [downloadingModel, setDownloadingModel] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<{ percent: number | null; text: string }>({
    percent: null,
    text: '',
  });

  const [isDownloadingEngine, setIsDownloadingEngine] = useState(false);
  const [engineDownloadProgress, setEngineDownloadProgress] = useState<import('../types').WhisperEngineDownloadProgress | null>(null);

  const [isDetecting, setIsDetecting] = useState(false);
  const [showSetupGuide, setShowSetupGuide] = useState(false);
  const [activeTab, setActiveTab] = useState<SettingsTabId>(initialTab ?? 'general');
  const [confirmDeleteIndex, setConfirmDeleteIndex] = useState<number | null>(null);

  const [confirmDeleteEngine, setConfirmDeleteEngine] = useState<boolean>(false);
  const [isDeletingEngine, setIsDeletingEngine] = useState<boolean>(false);
  const [confirmDeleteModel, setConfirmDeleteModel] = useState<string | null>(null);
  const [isDeletingModel, setIsDeletingModel] = useState<string | null>(null);

  // Data & Backup section state
  const [backupStatus, setBackupStatus] = useState<BackupStatusInfo | null>(null);
  const [restoreAvailable, setRestoreAvailable] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [dataBusy, setDataBusy] = useState<'backup' | 'restore' | 'export' | 'import' | null>(null);

  // P2P & Downloads section state (driven by p2pState, NOT parent settings which may lag)
  const [p2pState, setP2pState] = useState<P2pState | null>(null);
  const [p2pBusy, setP2pBusy] = useState(false);
  const [showP2pConsent, setShowP2pConsent] = useState(false);

  // Limits draft (kept as strings while typing; committed via setP2pLimits on blur)
  const [limitMaxConcurrent, setLimitMaxConcurrent] = useState('2');
  const [limitSeedMinutes, setLimitSeedMinutes] = useState('0');

  // Indexers (BYOC) draft
  const [providersDraft, setProvidersDraft] = useState<RssProvider[]>([]);
  const [providersBusy, setProvidersBusy] = useState(false);
  const providerImportRef = useRef<HTMLInputElement>(null);

  // Optional online subtitle provider API keys
  const [subsourceApiKey, setSubsourceApiKey] = useState(settings.subsourceApiKey || '');
  const [subdlApiKey, setSubdlApiKey] = useState(settings.subdlApiKey || '');
  const [opensubtitlesApiKey, setOpensubtitlesApiKey] = useState(settings.opensubtitlesApiKey || '');

  // Application update state
  const [appVersion, setAppVersion] = useState<string>('1.0.11');
  const [checkForUpdatesOnStartup, setCheckForUpdatesOnStartup] = useState<boolean>(
    settings.checkForUpdatesOnStartup ?? true
  );
  const [autoUpdate, setAutoUpdate] = useState<boolean>(
    settings.autoUpdate ?? true
  );
  const [updaterState, setUpdaterState] = useState<UpdaterState>({
    status: 'idle',
    currentVersion: '1.0.11',
    updateInfo: null,
    downloadProgress: null,
    error: null,
  });
  const [updaterDisplayPercent, setUpdaterDisplayPercent] = useState<number>(0);
  const [manualUpdateModalOpen, setManualUpdateModalOpen] = useState<boolean>(false);
  const [manualUpdateInfo, setManualUpdateInfo] = useState<UpdateInfoPayload | null>(null);

  const updaterProgressPhaseRef = useRef<string | null>(null);
  useEffect(() => {
    const phase = updaterState.downloadProgress?.phase ?? null;
    if (phase !== updaterProgressPhaseRef.current) {
      // New phase (delta -> full restart): start the displayed percent over instead of
      // keeping the monotonic max from the previous phase.
      updaterProgressPhaseRef.current = phase;
      setUpdaterDisplayPercent(
        updaterState.downloadProgress && typeof updaterState.downloadProgress.percent === 'number'
          ? Math.round(updaterState.downloadProgress.percent)
          : 0
      );
    } else if (updaterState.downloadProgress && typeof updaterState.downloadProgress.percent === 'number') {
      setUpdaterDisplayPercent((prev) => Math.max(prev, Math.round(updaterState.downloadProgress!.percent)));
    } else if (updaterState.status === 'downloaded') {
      setUpdaterDisplayPercent(100);
    }
  }, [updaterState.downloadProgress, updaterState.status]);

  useEffect(() => {
    if (!isOpen) {
      wasOpenRef.current = false;
      return;
    }
    if (initialTab) {
      setActiveTab(initialTab);
    }
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;
    if (!initialTab) {
      setActiveTab('general');
    }

    const initialAudio = (settings.preferredTorrentAudioLanguages ?? ['en']) as TorrentLanguageCode[];
    const initialSubs = (settings.preferredTorrentSubtitleLanguages ?? ['en']) as TorrentLanguageCode[];

    setFfmpegPath(settings.ffmpegPath);
    setWhisperPath(settings.whisperPath);
    setWhisperModel(settings.whisperModel || 'large-v3-turbo');
    setCustomModelPath(settings.customModelPath || '');
    setCheckForUpdatesOnStartup(settings.checkForUpdatesOnStartup ?? true);
    setAutoUpdate(settings.autoUpdate ?? true);
    setAnimeTitleLanguage(settings.animeTitleLanguage ?? 'english');
    setNavbarBlur(settings.navbarBlur ?? true);
    setConfirmDeleteIndex(null);
    setConfirmDeleteEngine(false);
    setConfirmDeleteModel(null);
    setConfirmRestore(false);
    setLibraryFolders(
      Array.isArray(settings.libraryFolders) && settings.libraryFolders.length > 0
        ? settings.libraryFolders
        : settings.defaultLibraryRoot
        ? [settings.defaultLibraryRoot]
        : []
    );
    setReleaseSelectionMode(settings.releaseSelectionMode ?? 'automatic');
    preferredAudioRef.current = initialAudio;
    preferredSubtitleRef.current = initialSubs;
    setPreferredAudioLanguages(initialAudio);
    setPreferredSubtitleLanguages(initialSubs);
    setDefaultAudioLanguage(settings.defaultAudioLanguage ?? 'auto');
    setDefaultSubtitleLanguage(settings.defaultSubtitleLanguage ?? 'auto');
    setDefaultSubtitleType(settings.defaultSubtitleType ?? 'auto');
    setDefaultTopSubMode(settings.defaultTopSubMode ?? 'auto');
    setSubsourceApiKey(settings.subsourceApiKey || '');
    setSubdlApiKey(settings.subdlApiKey || '');
    setOpensubtitlesApiKey(settings.opensubtitlesApiKey || '');
  }, [isOpen, settings, initialTab]);

  // Live status check when user edits paths or model
  useEffect(() => {
    if (isOpen) {
      window.electronAPI
        .checkBinaries({ ffmpegPath, whisperPath, modelName: whisperModel, customModelPath })
        .then((status) => {
          setBinaryStatus(status);
          if (status.isDownloadingModel && status.downloadingModelName) {
            setDownloadingModel(status.downloadingModelName);
          }
          if (status.isDownloadingEngine && status.engineDownloadProgress) {
            setIsDownloadingEngine(true);
            setEngineDownloadProgress(status.engineDownloadProgress);
          }
        })
        .catch(() => {});
    }
  }, [isOpen, ffmpegPath, whisperPath, whisperModel, customModelPath]);

  // Listen for Whisper model download progress and status
  useEffect(() => {
    if (!isOpen) return;
    const api = window.electronAPI;
    if (!api?.onModelDownloadProgress) return;
    const unsub = api.onModelDownloadProgress((data) => {
      setDownloadProgress({
        percent: data.percent,
        text: data.text,
      });
    });
    return unsub;
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const api = window.electronAPI;
    if (!api?.onWhisperModelDownloadStatus) return;
    const unsub = api.onWhisperModelDownloadStatus((data) => {
      if (data.isDownloading && data.modelName) {
        setDownloadingModel(data.modelName);
      } else {
        setDownloadingModel(null);
      }
    });
    return unsub;
  }, [isOpen]);

  // Listen for Whisper engine download progress and status
  useEffect(() => {
    if (!isOpen) return;
    const api = window.electronAPI;
    if (!api?.onWhisperEngineDownloadProgress) return;
    const unsub = api.onWhisperEngineDownloadProgress((data) => {
      setEngineDownloadProgress(data);
      setIsDownloadingEngine(data.isDownloading);
      if (data.phase === 'completed' && data.whisperPath) {
        setWhisperPath(data.whisperPath);
        onSave({ whisperPath: data.whisperPath });
        showGlobalToast('Faster-Whisper-XXL engine installed and configured!', 'success');
      } else if (data.phase === 'error' && data.error) {
        showGlobalToast(data.error, 'error');
      }
    });
    return unsub;
  }, [isOpen, onSave]);

  // Data & Backup: load backup status + restore availability when opened
  useEffect(() => {
    if (!isOpen) return;
    const api = window.electronAPI;
    if (!api?.getBackupStatus) return;
    api
      .getBackupStatus()
      .then((status) => setBackupStatus(status))
      .catch(() => {});
    if (typeof api.detectBackupRestore === 'function') {
      api
        .detectBackupRestore()
        .then((detection) => setRestoreAvailable(Boolean(detection?.available)))
        .catch(() => {});
    }
  }, [isOpen]);

  // P2P: load engine state when the modal opens
  useEffect(() => {
    if (!isOpen) return;
    const api = window.electronAPI;
    if (!api?.getP2pState) return;
    let cancelled = false;
    api
      .getP2pState()
      .then((state) => {
        if (cancelled) return;
        setP2pState(state);
        setLimitMaxConcurrent(String(state.limits.maxConcurrent));
        setLimitSeedMinutes(String(state.limits.seedMinutes));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  // P2P: load indexer draft when modal opens (and when engine is enabled)
  useEffect(() => {
    if (!isOpen) return;
    const api = window.electronAPI;
    if (!api?.getP2pProviders) return;
    let cancelled = false;
    api
      .getP2pProviders()
      .then((providers) => {
        if (!cancelled) setProvidersDraft(Array.isArray(providers) ? providers : []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  // Updater: fetch current version, state and listen to updater events
  useEffect(() => {
    if (!isOpen) return;
    const api = window.electronAPI;
    if (!api) return;

    if (typeof api.getAppVersion === 'function') {
      api.getAppVersion().then((v) => { if (v) setAppVersion(v); }).catch(() => {});
    }
    if (typeof api.getUpdaterState === 'function') {
      api.getUpdaterState().then((s) => { if (s) setUpdaterState(s); }).catch(() => {});
    }
    if (typeof api.onUpdaterStateChanged === 'function') {
      const unsub = api.onUpdaterStateChanged((s) => {
        setUpdaterState(s);
      });
      return unsub;
    }
  }, [isOpen]);

  const handleToggleCheckOnStartup = () => {
    const next = !checkForUpdatesOnStartup;
    setCheckForUpdatesOnStartup(next);
    onSave({ checkForUpdatesOnStartup: next });
  };

  const handleToggleNavbarBlur = () => {
    const next = !navbarBlur;
    setNavbarBlur(next);
    onSave({ navbarBlur: next });
  };

  // Hidden developer-mode unlock: 5 taps on the footer version label (within a
  // 2s window each). Session-only — see src/utils/devMode.ts. Deliberately
  // invisible: the label keeps no hover/cursor/tooltip affordances.
  const developerMode = useDeveloperMode();
  const versionTapsRef = useRef({ count: 0, lastAt: 0 });
  const handleVersionTap = () => {
    const now = Date.now();
    const taps = versionTapsRef.current;
    taps.count = now - taps.lastAt < 2000 ? taps.count + 1 : 1;
    taps.lastAt = now;
    if (taps.count < 5) return;
    taps.count = 0;
    if (enableDeveloperMode()) {
      showGlobalToast('You are now a developer', 'success');
    } else if (developerMode) {
      showGlobalToast('Developer mode is already active', 'info');
    }
  };

  const handleToggleAutoUpdate = () => {
    const next = !autoUpdate;
    setAutoUpdate(next);
    onSave({ autoUpdate: next });
  };

  const handleCheckForUpdates = async () => {
    if (window.electronAPI?.checkForUpdates) {
      try {
        const state = await window.electronAPI.checkForUpdates();
        if (state) {
          setUpdaterState(state);
          if (state.status === 'available' && state.updateInfo) {
            setManualUpdateInfo(state.updateInfo);
            setManualUpdateModalOpen(true);
          } else if (state.status === 'not-available') {
            showGlobalToast(`You are running the latest version (${appVersion})`, 'info');
          }
        }
      } catch (err: any) {
        showGlobalToast(err?.message || 'Failed to check for updates', 'error');
      }
    }
  };

  const handleOpenWhatsNew = async (versionToView?: string) => {
    const targetVer = versionToView || updaterState.updateInfo?.version || appVersion;
    let notes = updaterState.updateInfo?.releaseNotes;
    if (!notes && window.electronAPI?.getReleaseNotes) {
      try {
        notes = await window.electronAPI.getReleaseNotes(targetVer);
      } catch {}
    }
    setManualUpdateInfo({
      version: targetVer,
      releaseDate: updaterState.updateInfo?.releaseDate,
      releaseNotes: notes || null,
      downloadUrl: updaterState.updateInfo?.downloadUrl,
    });
    setManualUpdateModalOpen(true);
  };

  const handleDownloadUpdate = async () => {
    if (window.electronAPI?.downloadUpdate) {
      setUpdaterDisplayPercent(0);
      try {
        const res = await window.electronAPI.downloadUpdate();
        if (!res.success && res.error) {
          showGlobalToast(res.error, 'error');
        }
      } catch (err: any) {
        showGlobalToast(err?.message || 'Failed to download update', 'error');
      }
    }
  };

  const handleInstallUpdate = () => {
    if (window.electronAPI?.installUpdate) {
      window.electronAPI.installUpdate();
    }
  };

  // Save any pending uncommitted path or model changes before closing
  const handleClose = () => {
    if (
      ffmpegPath !== settings.ffmpegPath ||
      whisperPath !== settings.whisperPath ||
      whisperModel !== settings.whisperModel ||
      customModelPath !== settings.customModelPath
    ) {
      onSave({
        ...(ffmpegPath !== settings.ffmpegPath ? { ffmpegPath } : {}),
        ...(whisperPath !== settings.whisperPath ? { whisperPath } : {}),
        ...(whisperModel !== settings.whisperModel ? { whisperModel } : {}),
        ...(customModelPath !== settings.customModelPath ? { customModelPath } : {}),
      });
    }
    onClose();
  };

  // Handle Escape key to close (the P2P consent modal handles its own Escape).
  // Yields to an open GlassSelect menu so one Escape press closes only the menu.
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (document.querySelector('[data-select-menu-open="true"]')) return;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (showP2pConsent || manualUpdateModalOpen) return;
        handleClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, ffmpegPath, whisperPath, whisperModel, customModelPath, settings, onClose, showP2pConsent, manualUpdateModalOpen]);

  if (!isOpen) return null;

  const handleAddFolder = async () => {
    const dir = await window.electronAPI.browseFolder();
    if (dir) {
      if (!libraryFolders.some((f) => f.toLowerCase() === dir.toLowerCase())) {
        const updated = [...libraryFolders, dir];
        setLibraryFolders(updated);
        onSave({
          libraryFolders: updated,
          defaultLibraryRoot: updated[0] || '',
        });
      }
    }
  };

  const handleRemoveFolder = (indexToRemove: number) => {
    const updated = libraryFolders.filter((_, idx) => idx !== indexToRemove);
    setLibraryFolders(updated);
    onSave({
      libraryFolders: updated,
      defaultLibraryRoot: updated[0] || '',
    });
  };

  const handleDownloadModel = async (targetModel: string = 'large-v3-turbo') => {
    if (!window.electronAPI?.downloadWhisperModel) return;
    if (!binaryStatus.whisperExists) {
      showGlobalToast('Faster-Whisper executable is required to download models', 'error');
      return;
    }
    setDownloadingModel(targetModel);
    setDownloadProgress({ percent: 0, text: 'Connecting to Hugging Face...' });
    try {
      const res = await window.electronAPI.downloadWhisperModel(targetModel);
      if (res?.cancelled || res?.error?.toLowerCase().includes('cancelled')) {
        // User cancelled the download, skip error toast
        return;
      }
      if (res.success) {
        showGlobalToast(`Model ${targetModel} downloaded successfully and ready!`, 'success');
        setWhisperModel(targetModel);
        setCustomModelPath('');
        await onSave({ whisperModel: targetModel, customModelPath: '' });
        const status = await window.electronAPI.checkBinaries({
          ffmpegPath,
          whisperPath,
          modelName: targetModel,
          customModelPath: '',
        });
        setBinaryStatus(status);
      } else {
        showGlobalToast(res.error || `Failed to download ${targetModel}`, 'error');
      }
    } catch (err: any) {
      if (!err?.message?.toLowerCase().includes('cancelled')) {
        showGlobalToast(err?.message || `Failed to download ${targetModel}`, 'error');
      }
    } finally {
      setDownloadingModel(null);
      setDownloadProgress({ percent: null, text: '' });
    }
  };

  const handleCancelDownloadModel = async () => {
    if (window.electronAPI?.cancelWhisperModelDownload) {
      await window.electronAPI.cancelWhisperModelDownload();
      setDownloadingModel(null);
      setDownloadProgress({ percent: null, text: '' });
      showGlobalToast('Model download cancelled', 'info');
    }
  };

  const handleDownloadWhisperEngine = async () => {
    if (!window.electronAPI?.downloadWhisperEngine) return;
    setIsDownloadingEngine(true);
    try {
      const res = await window.electronAPI.downloadWhisperEngine();
      if (!res.success && res.error) {
        showGlobalToast(res.error, 'error');
      }
    } catch (err: any) {
      showGlobalToast(err?.message || 'Failed to start engine download', 'error');
    }
  };

  const handleCancelWhisperEngineDownload = async () => {
    if (!window.electronAPI?.cancelWhisperEngineDownload) return;
    try {
      await window.electronAPI.cancelWhisperEngineDownload();
      setIsDownloadingEngine(false);
      setEngineDownloadProgress(null);
      showGlobalToast('Engine download cancelled', 'info');
    } catch (err: any) {
      console.error(err);
    }
  };

  const handleDeleteWhisperEngine = async () => {
    if (!window.electronAPI?.deleteWhisperEngine) return;
    setIsDeletingEngine(true);
    try {
      const res = await window.electronAPI.deleteWhisperEngine();
      if (res?.success) {
        setWhisperPath('');
        await onSave({ whisperPath: '' });
        showGlobalToast('Faster-Whisper engine deleted.', 'info');
        const status = await window.electronAPI.checkBinaries({
          ffmpegPath,
          whisperPath: '',
          modelName: whisperModel,
          customModelPath,
        });
        setBinaryStatus(status);
      } else {
        showGlobalToast(`Failed to delete engine: ${res?.error || 'Unknown error'}`, 'error');
      }
    } catch (err: any) {
      showGlobalToast(`Error deleting engine: ${err?.message || err}`, 'error');
    } finally {
      setIsDeletingEngine(false);
      setConfirmDeleteEngine(false);
    }
  };

  const handleDeleteModel = async (modelId: string) => {
    if (!window.electronAPI?.deleteWhisperModel) return;
    setIsDeletingModel(modelId);
    try {
      const res = await window.electronAPI.deleteWhisperModel(modelId);
      if (res?.success) {
        showGlobalToast(`Model "${modelId}" deleted successfully.`, 'info');
        const status = await window.electronAPI.checkBinaries({
          ffmpegPath,
          whisperPath,
          modelName: whisperModel,
          customModelPath,
        });
        setBinaryStatus(status);
      } else {
        showGlobalToast(`Failed to delete model: ${res?.error || 'Unknown error'}`, 'error');
      }
    } catch (err: any) {
      showGlobalToast(`Error deleting model: ${err?.message || err}`, 'error');
    } finally {
      setIsDeletingModel(null);
      setConfirmDeleteModel(null);
    }
  };

  const handleBrowseCustomModel = async () => {
    const folder = await window.electronAPI.browseFolder(customModelPath || undefined);
    if (folder) {
      const detectedName = folder.replace(/^.*[\\/]/, '').replace(/^faster-whisper-/, '');
      setCustomModelPath(folder);
      setWhisperModel(detectedName);
      onSave({ customModelPath: folder, whisperModel: detectedName });
      showGlobalToast(`Custom model selected: ${detectedName}`, 'success');
    }
  };

  const handleResetToDefaultModel = () => {
    setCustomModelPath('');
    setWhisperModel('large-v3-turbo');
    onSave({ customModelPath: '', whisperModel: 'large-v3-turbo' });
    showGlobalToast('Reset to default model (large-v3-turbo)', 'info');
  };

  const handleBrowseWhisper = async () => {
    const file = await window.electronAPI.browseFile({
      title: 'Select Faster-Whisper-XXL Executable (faster-whisper-xxl.exe)',
      defaultPath: whisperPath || undefined,
      extensions: ['exe'],
    });
    if (file) {
      setWhisperPath(file);
      onSave({ whisperPath: file });
    }
  };

  const handleWhisperChange = (val: string) => {
    setWhisperPath(val);
  };

  const handleWhisperBlur = () => {
    if (whisperPath !== settings.whisperPath) {
      onSave({ whisperPath });
    }
  };

  const handleWhisperKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      (e.target as HTMLInputElement).blur();
    }
  };

  const handleAutoDetect = async () => {
    setIsDetecting(true);
    try {
      const detected = await window.electronAPI.autoDetectBinaries();
      if (detected.ffmpegPath) setFfmpegPath(detected.ffmpegPath);
      if (detected.whisperPath) setWhisperPath(detected.whisperPath);

      onSave({
        ...(detected.ffmpegPath ? { ffmpegPath: detected.ffmpegPath } : {}),
        ...(detected.whisperPath ? { whisperPath: detected.whisperPath } : {}),
      });

      const status = await window.electronAPI.checkBinaries({
        ffmpegPath: detected.ffmpegPath,
        whisperPath: detected.whisperPath,
        modelName: whisperModel,
        customModelPath,
      });
      setBinaryStatus(status);
    } catch {
    } finally {
      setIsDetecting(false);
    }
  };

  const handleResetDefaults = async () => {
    setIsDetecting(true);
    try {
      const detected = await window.electronAPI.autoDetectBinaries();
      const updatedFfmpeg = detected.ffmpegPath || '';
      const updatedWhisper = detected.whisperPath || '';
      setFfmpegPath(updatedFfmpeg);
      setWhisperPath(updatedWhisper);
      onSave({
        ffmpegPath: updatedFfmpeg,
        whisperPath: updatedWhisper,
      });
    } finally {
      setIsDetecting(false);
    }
  };

  const refreshBackupStatus = () => {
    const api = window.electronAPI;
    if (!api?.getBackupStatus) return;
    api
      .getBackupStatus()
      .then((status) => setBackupStatus(status))
      .catch(() => {});
  };

  const handleBackupNow = async () => {
    const api = window.electronAPI;
    if (!api?.backupNow || dataBusy) return;
    setDataBusy('backup');
    try {
      const res = await api.backupNow();
      if (res?.success) {
        showGlobalToast('Backup saved successfully', 'success');
        refreshBackupStatus();
      } else {
        showGlobalToast(res?.error || 'Backup failed', 'error');
      }
    } catch {
      showGlobalToast('Backup failed', 'error');
    } finally {
      setDataBusy(null);
    }
  };

  const handleRestoreConfirmed = async () => {
    const api = window.electronAPI;
    if (!api?.restoreFromBackup || dataBusy) return;
    setDataBusy('restore');
    try {
      const res = await api.restoreFromBackup();
      if (res?.success) {
        const restored = res.restored;
        showGlobalToast(
          restored
            ? `Restored ${restored.history} history entries, ${restored.seasonRules} season rules, ${restored.userLibrary} library items`
            : 'Restore completed',
          'success'
        );
        setConfirmRestore(false);
      } else {
        showGlobalToast(res?.error || 'Restore failed', 'error');
      }
    } catch {
      showGlobalToast('Restore failed', 'error');
    } finally {
      setDataBusy(null);
    }
  };

  const handleExportWatchlist = async (format: 'json' | 'mal-xml') => {
    const api = window.electronAPI;
    if (!api?.browseSaveFile || !api?.exportWatchlist || dataBusy) return;
    setDataBusy('export');
    try {
      const isJson = format === 'json';
      const filePath = await api.browseSaveFile({
        title: 'Export Watchlist',
        defaultPath: isJson ? 'animacenter-watchlist.json' : 'animacenter-watchlist.xml',
        extensions: [isJson ? 'json' : 'xml'],
      });
      if (!filePath) return;
      const res = await api.exportWatchlist(format, filePath);
      if (res?.success) {
        showGlobalToast(`Exported ${res.count ?? 0} titles`, 'success');
      } else {
        showGlobalToast(res?.error || 'Export failed', 'error');
      }
    } catch {
      showGlobalToast('Export failed', 'error');
    } finally {
      setDataBusy(null);
    }
  };

  const handleImportWatchlist = async () => {
    const api = window.electronAPI;
    if (!api?.browseFile || !api?.importWatchlist || dataBusy) return;
    setDataBusy('import');
    try {
      const filePath = await api.browseFile({
        title: 'Import Watchlist',
        extensions: ['json', 'xml'],
      });
      if (!filePath) return;
      const res = await api.importWatchlist(filePath);
      if (res?.success) {
        showGlobalToast(`Imported ${res.imported ?? 0}, skipped ${res.skipped ?? 0}`, 'success');
      } else {
        showGlobalToast(res?.error || 'Import failed', 'error');
      }
    } catch {
      showGlobalToast('Import failed', 'error');
    } finally {
      setDataBusy(null);
    }
  };

  // ---- P2P & Downloads handlers ----

  const refreshP2pState = async () => {
    const api = window.electronAPI;
    if (!api?.getP2pState) return;
    try {
      const state = await api.getP2pState();
      setP2pState(state);
      setLimitMaxConcurrent(String(state.limits.maxConcurrent));
      setLimitSeedMinutes(String(state.limits.seedMinutes));
      // Also refresh providers if engine is enabled
      if (state.enabled && api.getP2pProviders) {
        const providers = await api.getP2pProviders();
        setProvidersDraft(Array.isArray(providers) ? providers : []);
      }
    } catch {
      // keep last known state
    }
  };

  // Master engine toggle: OFF -> open the consent modal; ON -> disable
  const handleToggleP2pEngine = async () => {
    const api = window.electronAPI;
    if (!api?.enableP2p || !api?.disableP2p || p2pBusy) return;
    if (p2pState?.enabled) {
      setP2pBusy(true);
      try {
        const res = await api.disableP2p();
        if (res?.success) {
          showGlobalToast('P2P engine disabled — no torrents are downloaded or shared', 'success');
        } else {
          showGlobalToast('Failed to disable the P2P engine', 'error');
        }
      } catch {
        showGlobalToast('Failed to disable the P2P engine', 'error');
      } finally {
        setP2pBusy(false);
        refreshP2pState();
      }
    } else {
      setShowP2pConsent(true);
    }
  };

  // Consent accepted -> record consent, then enable the engine
  const handleP2pConsentAccept = async () => {
    const api = window.electronAPI;
    if (!api?.acceptP2pConsent || !api?.enableP2p || p2pBusy) return;
    setP2pBusy(true);
    try {
      await api.acceptP2pConsent();
      const res = await api.enableP2p();
      if (res?.success) {
        showGlobalToast('P2P engine enabled — add your own indexers below', 'success');
        setShowP2pConsent(false);
      } else {
        showGlobalToast(res?.error || 'Failed to enable the P2P engine', 'error');
      }
    } catch {
      showGlobalToast('Failed to enable the P2P engine', 'error');
    } finally {
      setP2pBusy(false);
      refreshP2pState();
    }
  };

  const parseClampedInt = (raw: string, min: number, max: number, fallback: number): number => {
    const parsed = Math.round(Number(raw));
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  };

  const commitLimits = async (patch: {
    maxConcurrent?: number;
    seedMinutes?: number;
  }) => {
    const api = window.electronAPI;
    if (!api?.setP2pLimits) return;
    const current =
      p2pState?.limits ?? { maxConcurrent: 2, seedMinutes: 0 };
    const limits = {
      maxConcurrent: patch.maxConcurrent ?? current.maxConcurrent,
      seedMinutes: patch.seedMinutes ?? current.seedMinutes,
    };
    try {
      await api.setP2pLimits(limits);
      setP2pState((prev) => (prev ? { ...prev, limits } : prev));
    } catch {
      showGlobalToast('Failed to apply P2P limits', 'error');
    }
  };

  const handleMaxConcurrentBlur = () => {
    const value = parseClampedInt(limitMaxConcurrent, 1, 6, p2pState?.limits.maxConcurrent ?? 2);
    setLimitMaxConcurrent(String(value));
    if (p2pState && value !== p2pState.limits.maxConcurrent) {
      commitLimits({ maxConcurrent: value });
    }
  };

  const handleSeedMinutesChange = (value: string) => {
    setLimitSeedMinutes(value);
    const num = Math.round(Number(value));
    const seedMinutes = Number.isFinite(num) && num >= 0 ? num : 0;
    if (p2pState && seedMinutes !== p2pState.limits.seedMinutes) {
      commitLimits({ seedMinutes });
    }
  };

  const makeProviderId = () =>
    `provider-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const handleAddProvider = () => {
    setProvidersDraft((prev) => [
      ...prev,
      { id: makeProviderId(), name: '', urlTemplate: '', type: 'rss', enabled: true },
    ]);
  };

  const handleRemoveProvider = (index: number) => {
    setProvidersDraft((prev) => prev.filter((_, i) => i !== index));
  };

  const handleProviderField = (index: number, patch: Partial<RssProvider>) => {
    setProvidersDraft((prev) => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  };

  // Mirrors the main-process validation: http(s) URL containing a {query} slot
  const validateProviders = (providers: RssProvider[]): string | null => {
    for (const provider of providers) {
      if (!provider.name.trim()) return 'Every provider needs a name.';
      const url = provider.urlTemplate.trim();
      if (!/^https?:\/\//i.test(url)) {
        return `${provider.name}: the URL must start with http:// or https://`;
      }
      if (!url.includes('{query}')) {
        return `${provider.name}: the URL must contain the {query} placeholder`;
      }
    }
    return null;
  };

  const handleSaveProviders = async () => {
    const api = window.electronAPI;
    if (!api?.saveP2pProviders || providersBusy) return;
    const validationError = validateProviders(providersDraft);
    if (validationError) {
      showGlobalToast(validationError, 'error');
      return;
    }
    const providersToSave = providersDraft.map((p) => ({
      ...p,
      name: p.name.trim(),
      urlTemplate: p.urlTemplate.trim(),
    }));
    setProvidersBusy(true);
    try {
      const res = await api.saveP2pProviders(providersToSave);
      if (res?.success) {
        showGlobalToast(
          `Saved ${providersToSave.length} provider${providersToSave.length === 1 ? '' : 's'}`,
          'success'
        );
        // Update parent settings to keep UI in sync
        onSave({ rssProviders: providersToSave });
        // Refresh providers from backend to update UI state
        api.getP2pProviders().then((providers) => {
          if (!providersBusy) setProvidersDraft(Array.isArray(providers) ? providers : []);
        }).catch(() => {});
      } else {
        showGlobalToast(res?.error || 'Failed to save providers', 'error');
      }
    } catch {
      showGlobalToast('Failed to save providers', 'error');
    } finally {
      setProvidersBusy(false);
    }
  };

  const handleImportProvidersFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // allow re-selecting the same file later
    if (!file) return;
    try {
      const text = await file.text();
      const parsed: unknown = JSON.parse(text);
      const list = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && Array.isArray((parsed as { providers?: unknown }).providers)
        ? ((parsed as { providers: unknown[] }).providers)
        : null;
      if (!list) {
        showGlobalToast('Invalid config: expected an array or { "providers": [...] }', 'error');
        return;
      }
      const imported: RssProvider[] = [];
      let skipped = 0;
      for (const raw of list) {
        if (!raw || typeof raw !== 'object') {
          skipped += 1;
          continue;
        }
        const rec = raw as Record<string, unknown>;
        const name = typeof rec.name === 'string' ? rec.name.trim() : '';
        const urlTemplate = typeof rec.urlTemplate === 'string' ? rec.urlTemplate.trim() : '';
        if (!name || !urlTemplate) {
          skipped += 1;
          continue;
        }
        imported.push({
          id: typeof rec.id === 'string' && rec.id ? rec.id : makeProviderId(),
          name,
          urlTemplate,
          type: rec.type === 'torznab' ? 'torznab' : 'rss',
          enabled: rec.enabled !== false,
        });
      }
      if (imported.length === 0) {
        showGlobalToast('No valid providers found in the config file', 'error');
        return;
      }
      setProvidersDraft(imported);
      showGlobalToast(
        `Imported ${imported.length} provider${imported.length === 1 ? '' : 's'}${
          skipped > 0 ? `, skipped ${skipped} invalid` : ''
        } — remember to Save providers`,
        'success'
      );
    } catch {
      showGlobalToast('Failed to read the config file — is it valid JSON?', 'error');
    }
  };

  const handleExportProviders = () => {
    try {
      const payload = JSON.stringify({ providers: providersDraft }, null, 2);
      const blob = new Blob([payload], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'animecenter-providers.json';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      showGlobalToast(
        `Exported ${providersDraft.length} provider${providersDraft.length === 1 ? '' : 's'}`,
        'success'
      );
    } catch {
      showGlobalToast('Export failed', 'error');
    }
  };

  const commitTorrentLanguages = (kind: 'audio' | 'subtitles', next: TorrentLanguageCode[]) => {
    if (kind === 'audio') {
      preferredAudioRef.current = next;
      setPreferredAudioLanguages(next);
      onSave({ preferredTorrentAudioLanguages: next });
    } else {
      preferredSubtitleRef.current = next;
      setPreferredSubtitleLanguages(next);
      onSave({ preferredTorrentSubtitleLanguages: next });
    }
  };

  const handleSetPrimaryTorrentLanguage = (kind: 'audio' | 'subtitles', value: string) => {
    const current = kind === 'audio' ? preferredAudioRef.current : preferredSubtitleRef.current;
    if (value === 'any') {
      commitTorrentLanguages(kind, []);
      return;
    }
    const primary = value as TorrentLanguageCode;
    const fallbacks = current.slice(1).filter((code) => code !== primary);
    commitTorrentLanguages(kind, [primary, ...fallbacks]);
  };

  const handleAddFallbackTorrentLanguage = (kind: 'audio' | 'subtitles', value: string) => {
    const code = value as TorrentLanguageCode;
    const current = kind === 'audio' ? preferredAudioRef.current : preferredSubtitleRef.current;
    if (!current.includes(code)) {
      commitTorrentLanguages(kind, [...current, code]);
    }
  };

  const handleRemoveTorrentLanguage = (kind: 'audio' | 'subtitles', code: TorrentLanguageCode) => {
    const current = kind === 'audio' ? preferredAudioRef.current : preferredSubtitleRef.current;
    commitTorrentLanguages(
      kind,
      current.filter((item) => item !== code)
    );
  };

  const navTabs: Array<{
    id: SettingsTabId;
    label: string;
    icon: React.ReactNode;
    dot?: string;
  }> = [
    { id: 'general', label: 'Library & UI', icon: <Folder className="w-4 h-4" /> },
    {
      id: 'subtitles',
      label: 'Subtitles & Audio',
      icon: <Subtitles className="w-4 h-4" />,
    },
    {
      id: 'ai',
      label: 'AI',
      icon: <Sparkles className="w-4 h-4" />,
      dot: binaryStatus.whisperExists ? 'bg-emerald-400' : 'bg-amber-400',
    },
    {
      id: 'downloads',
      label: 'Downloads & P2P',
      icon: <Share2 className="w-4 h-4" />,
      dot: p2pState?.enabled ? 'bg-emerald-400' : undefined,
    },
    { id: 'backup', label: 'Backup & Data', icon: <Database className="w-4 h-4" /> },
    {
      id: 'updates',
      label: 'Updates',
      icon: <RefreshCw className="w-4 h-4" />,
      dot:
        updaterState.status === 'available' ||
        updaterState.status === 'downloading' ||
        updaterState.status === 'downloaded'
          ? 'bg-rose-400 animate-pulse'
          : undefined,
    },
  ];

  return createPortal((
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 modal-dimmer animate-in fade-in duration-150"
      onClick={handleClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        data-modal="true"
        className="modal-glass w-full max-w-4xl h-[min(86vh,680px)] flex flex-col rounded-2xl text-zinc-100 animate-in zoom-in-95 duration-150 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.08] shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-rose-500/15 border border-rose-500/25 flex items-center justify-center text-rose-300">
              <SettingsIcon className="w-4 h-4" />
            </div>
            <h3 className="text-sm font-bold text-white tracking-tight">Settings</h3>
          </div>

          <button
            type="button"
            onClick={handleClose}
            aria-label="Close settings"
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-white/[0.08] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Two-Pane Body: Sidebar + Active Category Content */}
        <div className="flex-1 min-h-0 flex flex-col md:flex-row overflow-hidden">
          <aside className="w-full md:w-52 shrink-0 border-b md:border-b-0 md:border-r border-white/[0.08] bg-black/25 p-2.5 flex md:flex-col gap-1 overflow-x-auto md:overflow-y-auto scrollbar-none">
            {navTabs.map((tab) => {
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center justify-between gap-2.5 px-3 py-2.5 rounded-xl text-xs font-semibold whitespace-nowrap transition-all border ${
                    active
                      ? 'bg-rose-500/15 text-rose-100 border-rose-500/30 shadow-sm'
                      : 'border-transparent text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.04]'
                  }`}
                >
                  <span className="flex items-center gap-2.5">
                    <span className={active ? 'text-rose-400' : 'text-zinc-500'}>{tab.icon}</span>
                    <span>{tab.label}</span>
                  </span>
                  {tab.dot && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${tab.dot}`} />}
                </button>
              );
            })}
          </aside>

          <div className="flex-1 min-h-0 overflow-y-auto p-6">
            {activeTab === 'general' && (
              <div className="space-y-6 animate-in fade-in duration-150">
                {/* Media Folders */}
                <section className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <h4 className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">
                      Anime Media Folders ({libraryFolders.length})
                    </h4>
                    <button
                      type="button"
                      onClick={handleAddFolder}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.07] hover:bg-white/[0.12] text-zinc-100 border border-white/10 text-xs font-medium transition-colors shrink-0"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Add Folder</span>
                    </button>
                  </div>

                  <div className="space-y-1.5 max-h-48 overflow-y-auto pr-0.5">
                    {libraryFolders.length === 0 ? (
                      <div className="p-4 rounded-xl border border-dashed border-white/10 bg-white/[0.02] text-center">
                        <p className="text-xs text-zinc-500">No media folders configured.</p>
                      </div>
                    ) : (
                      libraryFolders.map((folder, index) =>
                        confirmDeleteIndex === index ? (
                          <div
                            key={`${folder}-${index}-confirm`}
                            className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl bg-red-950/40 border border-red-500/40 animate-in fade-in duration-150"
                          >
                            <div className="flex items-center gap-2 text-xs text-red-200 min-w-0 flex-1">
                              <AlertTriangle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                              <span className="truncate">
                                Remove <span className="font-mono font-semibold text-white">{folder}</span>?
                              </span>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteIndex(null)}
                                className="px-2.5 py-1 rounded-lg text-[11px] font-medium text-zinc-300 hover:text-white bg-zinc-800 hover:bg-zinc-700 transition-colors"
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  handleRemoveFolder(index);
                                  setConfirmDeleteIndex(null);
                                }}
                                className="px-2.5 py-1 rounded-lg text-[11px] font-bold text-white bg-red-600 hover:bg-red-500 transition-colors"
                              >
                                Confirm Remove
                              </button>
                            </div>
                          </div>
                        ) : (() => {
                          const diskInfo = folderDiskSpaces[folder] ?? folderDiskSpaces[folder.toLowerCase()];
                          const driveLabel = diskInfo?.driveLabel || extractDriveLabelFromPath(folder);
                          const freeBytes = diskInfo?.freeBytes ?? null;
                          const totalBytes = diskInfo?.totalBytes ?? null;
                          const { textClass: healthTextClass } = getDiskHealthStyle(freeBytes);

                          return (
                            <div
                              key={`${folder}-${index}`}
                              className="flex items-center gap-3.5 px-3.5 py-2.5 rounded-xl bg-white/[0.03] border border-white/[0.08] hover:border-white/15 transition-colors"
                            >
                              <DiskSpaceRing
                                driveLabel={driveLabel}
                                freeBytes={freeBytes}
                                totalBytes={totalBytes}
                                size={36}
                              />

                              <div className="min-w-0 flex-1">
                                <p className="text-[13px] font-medium text-zinc-100 truncate leading-tight">
                                  {getFolderDisplayName(folder)}
                                </p>
                                <p className="mt-0.5 font-mono text-[11px] text-zinc-500 truncate select-all" title={folder}>
                                  {folder}
                                </p>
                              </div>

                              <div className="shrink-0 flex items-center gap-3">
                                <div className="text-right tabular-nums leading-tight">
                                  <p className={`text-xs font-medium ${healthTextClass}`}>
                                    {freeBytes != null ? `${formatDiskSize(freeBytes)} free` : '—'}
                                  </p>
                                  {totalBytes != null && totalBytes > 0 && (
                                    <p className="mt-0.5 text-[10px] text-zinc-500">
                                      of {formatDiskSize(totalBytes)}
                                    </p>
                                  )}
                                </div>
                                <div className="h-6 w-px bg-white/[0.06]" />
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteIndex(index)}
                                  className="p-1.5 rounded-lg text-zinc-500 hover:text-rose-400 hover:bg-rose-500/10 transition-colors shrink-0"
                                  title="Remove folder from library"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>
                          );
                        })()
                      )
                    )}
                  </div>
                </section>

                {/* Display & Interface */}
                <section className="space-y-3 pt-4 border-t border-white/[0.08]">
                  <h4 className="text-[11px] font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
                    <Languages className="w-3.5 h-3.5 text-zinc-500" />
                    <span>Display</span>
                  </h4>

                  <div className="space-y-2">
                    <p className="text-xs font-medium text-zinc-300">Anime Title Language</p>
                    <div className="grid grid-cols-3 gap-2.5">
                      {[
                        { value: 'english' as const, label: 'English', desc: 'Demon Slayer' },
                        { value: 'romaji' as const, label: 'Romaji', desc: 'Kimetsu no Yaiba' },
                        { value: 'native' as const, label: '日本語', desc: '鬼滅の刃' },
                      ].map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => {
                            setAnimeTitleLanguage(option.value);
                            onSave({ animeTitleLanguage: option.value });
                          }}
                          className={`flex flex-col items-start p-3 rounded-xl border text-left transition-all ${
                            animeTitleLanguage === option.value
                              ? 'border-rose-400/50 bg-rose-500/10 text-white'
                              : 'border-white/[0.08] bg-white/[0.025] text-zinc-400 hover:border-white/15 hover:text-zinc-200'
                          }`}
                        >
                          <span className={`text-xs font-bold ${animeTitleLanguage === option.value ? 'text-rose-200' : 'text-zinc-200'}`}>
                            {option.label}
                          </span>
                          <span className="mt-0.5 text-[11px] text-zinc-500">{option.desc}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center justify-between px-3.5 py-3 rounded-xl bg-white/[0.03] border border-white/[0.08]">
                    <div className="pr-4">
                      <p className="text-xs font-semibold text-zinc-200">Navbar blur</p>
                      <p className="text-[11px] text-zinc-500">Frosted glass behind top bar while scrolling</p>
                    </div>
                    <ToggleSwitch
                      checked={navbarBlur}
                      onChange={handleToggleNavbarBlur}
                      label="Navbar blur"
                    />
                  </div>
                </section>
              </div>
            )}

            {activeTab === 'subtitles' && (
              <div className="space-y-6 animate-in fade-in duration-150">
                {/* Playback Defaults */}
                <section className="space-y-3">
                  <h4 className="text-[11px] font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
                    <Volume2 className="w-3.5 h-3.5 text-rose-400" />
                    <span>Playback</span>
                  </h4>

                  <div className="rounded-xl bg-white/[0.03] border border-white/[0.08] p-4 space-y-3.5">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <label className="text-[11px] font-semibold text-zinc-300">Audio</label>
                        <GlassSelect
                          value={defaultAudioLanguage}
                          onChange={(value) => {
                            setDefaultAudioLanguage(value);
                            onSave({ defaultAudioLanguage: value });
                          }}
                          options={[
                            {
                              value: 'auto',
                              label: `Auto (${getTorrentLanguageLabel(preferredAudioLanguages[0] || 'en')})`,
                            },
                            { value: 'original', label: 'Japanese (Original)' },
                            ...TORRENT_LANGUAGES.map((lang) => ({
                              value: lang.code,
                              label: lang.label,
                            })),
                          ]}
                          ariaLabel="Default audio language"
                          className="w-full px-3 py-2 rounded-lg"
                        />
                      </div>

                      <div className="space-y-1.5">
                        <label className="text-[11px] font-semibold text-zinc-300">Subtitles</label>
                        <GlassSelect
                          value={defaultSubtitleType === 'off' ? 'off' : defaultSubtitleLanguage}
                          onChange={(value) => {
                            if (value === 'off') {
                              setDefaultSubtitleLanguage('off');
                              setDefaultSubtitleType('off');
                              onSave({ defaultSubtitleLanguage: 'off', defaultSubtitleType: 'off' });
                            } else if (defaultSubtitleType === 'off') {
                              setDefaultSubtitleLanguage(value);
                              setDefaultSubtitleType('auto');
                              onSave({ defaultSubtitleLanguage: value, defaultSubtitleType: 'auto' });
                            } else {
                              setDefaultSubtitleLanguage(value);
                              onSave({ defaultSubtitleLanguage: value });
                            }
                          }}
                          options={[
                            {
                              value: 'auto',
                              label: `Auto (${getTorrentLanguageLabel(preferredSubtitleLanguages[0] || 'en')})`,
                            },
                            { value: 'off', label: 'Off' },
                            ...TORRENT_LANGUAGES.map((lang) => ({
                              value: lang.code,
                              label: lang.label,
                            })),
                          ]}
                          ariaLabel="Default subtitle language"
                          className="w-full px-3 py-2 rounded-lg"
                        />
                      </div>
                    </div>

                    <div className="pt-3 border-t border-white/[0.06] space-y-2.5">
                      <div className="flex items-center justify-between gap-4">
                        <span className="text-xs font-medium text-zinc-300">Subtitle style</span>
                        <div
                          className={`inline-flex rounded-lg bg-black/30 p-0.5 border border-white/[0.08] transition-opacity ${
                            defaultSubtitleLanguage === 'off' || defaultSubtitleType === 'off'
                              ? 'opacity-50'
                              : ''
                          }`}
                        >
                          {([
                            { value: 'auto', label: 'Auto', title: 'Dubtitles on dubs, Full Dialogue on Japanese' },
                            { value: 'dubtitles', label: 'Dubtitles', title: 'Prefer Dubtitles, SDH & Whisper' },
                            { value: 'dialogue', label: 'Dialogue', title: 'Prefer Full ASS / Dialogue subtitles' },
                          ] as const).map((option) => {
                            const active =
                              defaultSubtitleLanguage !== 'off' && defaultSubtitleType === option.value;
                            return (
                              <button
                                key={option.value}
                                type="button"
                                title={option.title}
                                onClick={() => {
                                  setDefaultSubtitleType(option.value);
                                  if (defaultSubtitleLanguage === 'off') {
                                    setDefaultSubtitleLanguage('auto');
                                    onSave({ defaultSubtitleType: option.value, defaultSubtitleLanguage: 'auto' });
                                  } else {
                                    onSave({ defaultSubtitleType: option.value });
                                  }
                                }}
                                className={`px-3 py-1 rounded-md text-[11px] font-semibold transition-all ${
                                  active
                                    ? 'bg-rose-500/20 text-rose-100 border border-rose-400/40 shadow-sm'
                                    : 'border border-transparent text-zinc-400 hover:text-zinc-200'
                                }`}
                              >
                                {option.label}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      <div className="flex items-center justify-between gap-4">
                        <span className="text-xs font-medium text-zinc-300">Signs &amp; songs</span>
                        <div className="inline-flex rounded-lg bg-black/30 p-0.5 border border-white/[0.08]">
                          {([
                            { value: 'auto', label: 'Auto', title: 'Show top signs when main subtitles are not full ASS' },
                            { value: 'always', label: 'Always', title: 'Always enable matching signs track' },
                            { value: 'off', label: 'Off', title: 'Never auto-enable or auto-extract signs' },
                          ] as const).map((option) => {
                            const active = defaultTopSubMode === option.value;
                            return (
                              <button
                                key={option.value}
                                type="button"
                                title={option.title}
                                onClick={() => {
                                  setDefaultTopSubMode(option.value);
                                  onSave({ defaultTopSubMode: option.value });
                                }}
                                className={`px-3 py-1 rounded-md text-[11px] font-semibold transition-all ${
                                  active
                                    ? 'bg-rose-500/20 text-rose-100 border border-rose-400/40 shadow-sm'
                                    : 'border border-transparent text-zinc-400 hover:text-zinc-200'
                                }`}
                              >
                                {option.label}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  </div>
                </section>

                {/* Online Subtitle Search */}
                <section className="space-y-3 pt-4 border-t border-white/[0.08]">
                  <h4 className="text-[11px] font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
                    <Subtitles className="w-3.5 h-3.5 text-zinc-500" />
                    <span>Online Subtitle Search</span>
                  </h4>

                  <div className="rounded-xl bg-white/[0.03] border border-white/[0.08] p-3.5 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <p className="text-xs font-semibold text-zinc-200">TsukiHime</p>
                        <p className="text-[11px] text-zinc-500">Built-in anime ASS &amp; font database</p>
                      </div>
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/25">
                        <CheckCircle2 className="w-3 h-3" />
                        <span>Active</span>
                      </span>
                    </div>

                    <div className="pt-2.5 border-t border-white/[0.06] space-y-2">
                      <p className="text-[11px] font-medium text-zinc-400">Fallback API Keys (optional)</p>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        {[
                          { label: 'SubSource', value: subsourceApiKey, setter: setSubsourceApiKey, keyName: 'subsourceApiKey' as const, placeholder: 'X-API-Key' },
                          { label: 'SubDL', value: subdlApiKey, setter: setSubdlApiKey, keyName: 'subdlApiKey' as const, placeholder: 'API key' },
                          { label: 'OpenSubtitles', value: opensubtitlesApiKey, setter: setOpensubtitlesApiKey, keyName: 'opensubtitlesApiKey' as const, placeholder: 'Api-Key' },
                        ].map((field) => (
                          <div key={field.keyName} className="space-y-1">
                            <label className="text-[10px] font-medium text-zinc-500">{field.label}</label>
                            <input
                              type="password"
                              value={field.value}
                              onChange={(e) => field.setter(e.target.value)}
                              onBlur={() => onSave({ [field.keyName]: field.value.trim() })}
                              placeholder={field.placeholder}
                              className="w-full px-2.5 py-1.5 rounded-lg bg-black/30 border border-white/10 text-xs font-mono text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-rose-400/50"
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </section>
              </div>
            )}

            {activeTab === 'ai' && (
              <div className="space-y-6 animate-in fade-in duration-150">
                {/* Faster-Whisper Engine */}
                <section className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <h4 className="text-[11px] font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
                        <Cpu className="w-3.5 h-3.5 text-zinc-500" />
                        <span>Faster-Whisper Engine</span>
                      </h4>
                      {binaryStatus.whisperExists ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/25">
                          <CheckCircle2 className="w-3 h-3" />
                          <span>Ready</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/25">
                          <AlertCircle className="w-3 h-3" />
                          <span>Not Configured</span>
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => setShowSetupGuide(!showSetupGuide)}
                        className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium text-zinc-400 hover:text-white hover:bg-white/[0.06] transition-colors"
                      >
                        <HelpCircle className="w-3.5 h-3.5" />
                        <span>{showSetupGuide ? 'Hide Guide' : 'Setup Guide'}</span>
                      </button>
                      <button
                        type="button"
                        onClick={handleAutoDetect}
                        disabled={isDetecting}
                        className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-white/[0.07] hover:bg-white/[0.12] text-zinc-200 border border-white/10 text-xs font-medium transition-colors disabled:opacity-50"
                        title="Scan PATH and Subtitle Edit installations"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${isDetecting ? 'animate-spin' : 'text-zinc-400'}`} />
                        <span>Auto-Detect</span>
                      </button>
                    </div>
                  </div>

                  {showSetupGuide && (
                    <div className="p-3.5 rounded-xl bg-white/[0.03] border border-white/10 grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-[11px] animate-in fade-in duration-150">
                      <div className="p-2.5 rounded-lg bg-black/30 border border-white/[0.06] space-y-1">
                        <p className="font-semibold text-zinc-200">1. In-App or Subtitle Edit</p>
                        <p className="text-zinc-400 text-[10px] leading-relaxed">
                          Use <strong>Download Engine</strong> below, or reuse Subtitle Edit&apos;s Faster-Whisper XXL install.
                        </p>
                        <button
                          type="button"
                          onClick={() => window.electronAPI.openExternalUrl('https://www.nikse.dk/subtitleedit')}
                          className="inline-flex items-center gap-1 text-[11px] text-rose-300 hover:text-rose-200 underline"
                        >
                          <span>Subtitle Edit</span>
                          <ExternalLink className="w-3 h-3" />
                        </button>
                      </div>
                      <div className="p-2.5 rounded-lg bg-black/30 border border-white/[0.06] space-y-1">
                        <p className="font-semibold text-zinc-200">2. Standalone Archive</p>
                        <p className="text-zinc-400 text-[10px] leading-relaxed">
                          Extract Purfview&apos;s Windows archive anywhere and point to <code className="text-zinc-300">faster-whisper-xxl.exe</code>.
                        </p>
                        <button
                          type="button"
                          onClick={() =>
                            window.electronAPI.openExternalUrl('https://github.com/Purfview/whisper-standalone-win/releases')
                          }
                          className="inline-flex items-center gap-1 text-[11px] text-rose-300 hover:text-rose-200 underline"
                        >
                          <span>GitHub Releases</span>
                          <ExternalLink className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Engine Status / Installer Card */}
                  {isDownloadingEngine ? (
                    <div className="space-y-2 p-3.5 rounded-xl bg-rose-950/25 border border-rose-500/30 text-xs text-zinc-200">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-white truncate">
                          {engineDownloadProgress?.phase === 'extracting'
                            ? 'Extracting Faster-Whisper-XXL...'
                            : `Downloading Faster-Whisper-XXL (${engineDownloadProgress?.percent ?? 0}%)`}
                        </span>
                        <button
                          type="button"
                          onClick={handleCancelWhisperEngineDownload}
                          className="px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-white/10 text-[11px] font-medium shrink-0"
                        >
                          Cancel
                        </button>
                      </div>
                      <div className="w-full h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                        {engineDownloadProgress?.phase === 'extracting' ? (
                          <div className="h-full w-full bg-rose-500 animate-pulse" />
                        ) : (
                          <div
                            className="h-full bg-gradient-to-r from-rose-600 to-rose-400 transition-[width] duration-150 ease-out"
                            style={{ width: `${Math.max(2, Math.min(100, engineDownloadProgress?.percent ?? 0))}%` }}
                          />
                        )}
                      </div>
                      <div className="flex items-center justify-between text-[11px] text-zinc-400 font-mono">
                        <span>
                          {engineDownloadProgress?.phase === 'extracting'
                            ? 'Unpacking archive...'
                            : `${formatFileSize(engineDownloadProgress?.transferred ?? 0)} / ${formatFileSize(engineDownloadProgress?.total ?? 0)}`}
                        </span>
                        {engineDownloadProgress?.phase !== 'extracting' && (
                          <span>{formatFileSize(engineDownloadProgress?.bytesPerSecond ?? 0)}/s</span>
                        )}
                      </div>
                    </div>
                  ) : binaryStatus.whisperExists ? (
                    <div className="p-3.5 rounded-xl bg-white/[0.03] border border-white/[0.08] space-y-2.5">
                      {confirmDeleteEngine ? (
                        <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-red-950/40 border border-red-500/40 animate-in fade-in duration-150">
                          <div className="flex items-center gap-2 text-xs text-red-200 min-w-0">
                            <AlertTriangle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                            <span className="truncate">Delete Faster-Whisper-XXL from storage?</span>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              type="button"
                              disabled={isDeletingEngine}
                              onClick={() => setConfirmDeleteEngine(false)}
                              className="px-2.5 py-1 rounded-lg text-[11px] font-medium text-zinc-300 bg-zinc-800 hover:bg-zinc-700"
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              disabled={isDeletingEngine}
                              onClick={handleDeleteWhisperEngine}
                              className="px-2.5 py-1 rounded-lg text-[11px] font-bold text-white bg-red-600 hover:bg-red-500 disabled:opacity-50"
                            >
                              {isDeletingEngine ? 'Deleting...' : 'Confirm Delete'}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center justify-between gap-3">
                          <p className="text-xs font-semibold text-zinc-200">Faster-Whisper-XXL</p>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteEngine(true)}
                            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-300 border border-red-500/20 text-xs font-medium transition-colors shrink-0"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            <span>Delete Engine</span>
                          </button>
                        </div>
                      )}

                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          placeholder="Path to faster-whisper-xxl.exe"
                          value={whisperPath}
                          onChange={(e) => handleWhisperChange(e.target.value)}
                          onBlur={handleWhisperBlur}
                          onKeyDown={handleWhisperKeyDown}
                          className="flex-1 px-3 py-2 rounded-lg bg-black/30 border border-white/10 text-xs font-mono text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-rose-400/50"
                        />
                        <button
                          type="button"
                          onClick={handleBrowseWhisper}
                          className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/[0.07] hover:bg-white/[0.12] text-zinc-200 border border-white/10 text-xs font-medium shrink-0 transition-colors"
                        >
                          <FolderOpen className="w-3.5 h-3.5 text-zinc-400" />
                          <span>Browse</span>
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="p-3.5 rounded-xl bg-rose-950/20 border border-rose-500/25 space-y-2.5">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-white">One-Click Engine Setup</p>
                          <p className="text-[11px] text-zinc-400">Install Faster-Whisper-XXL standalone automatically.</p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            type="button"
                            onClick={handleDownloadWhisperEngine}
                            className="btn-primary flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-white text-xs font-semibold"
                          >
                            <Download className="w-3.5 h-3.5" />
                            <span>Download Engine</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => window.electronAPI.openExternalUrl('https://github.com/Purfview/whisper-standalone-win/releases')}
                            title="Open GitHub Releases"
                            className="p-1.5 rounded-lg bg-white/[0.07] hover:bg-white/[0.12] text-zinc-300 border border-white/10"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          placeholder="Path to faster-whisper-xxl.exe"
                          value={whisperPath}
                          onChange={(e) => handleWhisperChange(e.target.value)}
                          onBlur={handleWhisperBlur}
                          onKeyDown={handleWhisperKeyDown}
                          className="flex-1 px-3 py-2 rounded-lg bg-black/30 border border-white/10 text-xs font-mono text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-rose-400/50"
                        />
                        <button
                          type="button"
                          onClick={handleBrowseWhisper}
                          className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/[0.07] hover:bg-white/[0.12] text-zinc-200 border border-white/10 text-xs font-medium shrink-0 transition-colors"
                        >
                          <FolderOpen className="w-3.5 h-3.5 text-zinc-400" />
                          <span>Browse</span>
                        </button>
                      </div>
                    </div>
                  )}
                </section>

                {/* AI Subtitle Models */}
                <section className="space-y-3 pt-4 border-t border-white/[0.08]">
                  <h4 className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">
                    AI Subtitle Models
                  </h4>

                  <div className="space-y-2">
                    {[
                      { id: 'large-v3-turbo', name: 'large-v3-turbo', spec: 'Recommended · ~1.5 GB · 4–6 GB+ VRAM' },
                      { id: 'medium', name: 'medium', spec: 'Balanced · ~1.5 GB · 4 GB VRAM' },
                      { id: 'small', name: 'small', spec: 'Fast / CPU · ~480 MB · 2 GB VRAM' },
                    ].map((model) => {
                      const isInstalled =
                        model.id === 'large-v3-turbo'
                          ? binaryStatus.isDefaultModelInstalled ||
                            Boolean(binaryStatus.installedModels?.some((m) => m.toLowerCase().includes('large-v3-turbo')))
                          : Boolean(binaryStatus.installedModels?.some((m) => m.toLowerCase().includes(model.id.toLowerCase())));
                      const isThisDownloading = downloadingModel === model.id;
                      const isConfirmingDelete = confirmDeleteModel === model.id;
                      const isThisDeleting = isDeletingModel === model.id;

                      return (
                        <div
                          key={model.id}
                          className="px-3.5 py-2.5 rounded-xl border bg-white/[0.03] border-white/[0.08]"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-mono font-bold text-white">{model.name}</span>
                                {isInstalled && (
                                  <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/25">
                                    Installed
                                  </span>
                                )}
                              </div>
                              <p className="text-[11px] text-zinc-500 truncate">{model.spec}</p>
                            </div>

                            <div className="shrink-0">
                              {isThisDownloading ? (
                                <div className="flex items-center gap-2">
                                  <span className="text-xs font-mono text-rose-300 font-semibold">
                                    {downloadProgress.percent !== null ? `${downloadProgress.percent}%` : '...'}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={handleCancelDownloadModel}
                                    className="px-2.5 py-1 rounded-lg text-xs bg-red-500/15 hover:bg-red-500/25 text-red-300 border border-red-500/25"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              ) : isConfirmingDelete ? (
                                <div className="flex items-center gap-1.5">
                                  <button
                                    type="button"
                                    disabled={isThisDeleting}
                                    onClick={() => setConfirmDeleteModel(null)}
                                    className="px-2.5 py-1 rounded-lg text-[11px] bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
                                  >
                                    Cancel
                                  </button>
                                  <button
                                    type="button"
                                    disabled={isThisDeleting}
                                    onClick={() => handleDeleteModel(model.id)}
                                    className="px-2.5 py-1 rounded-lg text-[11px] font-bold text-white bg-red-600 hover:bg-red-500 disabled:opacity-50"
                                  >
                                    {isThisDeleting ? 'Deleting...' : 'Confirm'}
                                  </button>
                                </div>
                              ) : isInstalled ? (
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteModel(model.id)}
                                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-300 border border-red-500/20 text-xs font-medium"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                  <span>Delete</span>
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  disabled={!binaryStatus.whisperExists || Boolean(downloadingModel)}
                                  onClick={() => handleDownloadModel(model.id)}
                                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.08] hover:bg-white/[0.14] disabled:opacity-40 text-zinc-100 border border-white/10 font-medium text-xs transition-colors"
                                >
                                  <Download className="w-3.5 h-3.5" />
                                  <span>Download</span>
                                </button>
                              )}
                            </div>
                          </div>

                          {isThisDownloading && (
                            <div className="mt-2 space-y-1">
                              <div className="w-full bg-zinc-800 rounded-full h-1.5 overflow-hidden">
                                <div
                                  className="bg-rose-500 h-full transition-[width] duration-150 ease-out"
                                  style={{ width: `${downloadProgress.percent || 5}%` }}
                                />
                              </div>
                              {downloadProgress.text && (
                                <p className="text-[10px] font-mono text-zinc-400 truncate">{downloadProgress.text}</p>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {(() => {
                    const presets = ['large-v3-turbo', 'medium', 'small'];
                    const otherDetected = (binaryStatus.installedModels || []).filter(
                      (m) => !presets.includes(m.toLowerCase())
                    );
                    if (otherDetected.length === 0) return null;
                    return (
                      <div className="space-y-1.5 pt-1">
                        <p className="text-[11px] font-medium text-zinc-400">
                          Other Cached Models ({otherDetected.length})
                        </p>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          {otherDetected.map((m) => {
                            const isConfirmingDelete = confirmDeleteModel === m;
                            const isThisDeleting = isDeletingModel === m;
                            return (
                              <div
                                key={m}
                                className="px-3 py-2 rounded-xl border flex items-center justify-between bg-white/[0.03] border-white/[0.08]"
                              >
                                <span className="text-xs font-mono font-bold text-white truncate pr-2">{m}</span>
                                {isConfirmingDelete ? (
                                  <div className="flex items-center gap-1.5 shrink-0">
                                    <button
                                      type="button"
                                      disabled={isThisDeleting}
                                      onClick={() => setConfirmDeleteModel(null)}
                                      className="px-2 py-1 rounded text-[11px] bg-zinc-800 text-zinc-300"
                                    >
                                      Cancel
                                    </button>
                                    <button
                                      type="button"
                                      disabled={isThisDeleting}
                                      onClick={() => handleDeleteModel(m)}
                                      className="px-2 py-1 rounded text-[11px] font-bold bg-red-600 text-white"
                                    >
                                      {isThisDeleting ? '...' : 'Confirm'}
                                    </button>
                                  </div>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => setConfirmDeleteModel(m)}
                                    className="px-2.5 py-1 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-300 border border-red-500/20 text-[11px] font-medium shrink-0"
                                  >
                                    Delete
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })()}

                  <div className="flex items-center gap-2 pt-1">
                    <input
                      type="text"
                      readOnly
                      placeholder="Custom model folder (optional)"
                      value={customModelPath}
                      className="flex-1 px-3 py-2 rounded-lg bg-black/30 border border-white/10 text-xs font-mono text-zinc-200 placeholder-zinc-600 truncate focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={handleBrowseCustomModel}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/[0.07] hover:bg-white/[0.12] text-zinc-200 border border-white/10 text-xs font-medium shrink-0"
                    >
                      <FolderOpen className="w-3.5 h-3.5 text-zinc-400" />
                      <span>Custom Model</span>
                    </button>
                    {customModelPath && (
                      <button
                        type="button"
                        onClick={handleResetToDefaultModel}
                        className="px-2.5 py-2 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-300 text-xs font-medium border border-red-500/20 shrink-0"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </section>
              </div>
            )}

            {activeTab === 'downloads' && (
              <div className="space-y-6 animate-in fade-in duration-150">
                {/* BitTorrent Engine */}
                <section className="space-y-2.5">
                  <h4 className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">
                    BitTorrent Engine
                  </h4>
                  <div className="flex items-center justify-between gap-3 rounded-xl bg-white/[0.03] border border-white/[0.08] px-3.5 py-3">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 text-xs font-semibold text-zinc-200">
                        <span>P2P / BitTorrent</span>
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${
                            p2pState === null ? 'bg-amber-400' : p2pState.enabled ? 'bg-emerald-400' : 'bg-zinc-600'
                          }`}
                        />
                      </p>
                      <p className="text-[11px] text-zinc-500">
                        {p2pState === null
                          ? 'Checking status…'
                          : p2pState.enabled
                          ? 'Enabled via user-configured indexers'
                          : 'Disabled'}
                      </p>
                    </div>
                    <ToggleSwitch
                      checked={Boolean(p2pState?.enabled)}
                      onChange={handleToggleP2pEngine}
                      disabled={p2pBusy || p2pState === null || !window.electronAPI?.enableP2p}
                      label={p2pState?.enabled ? 'Disable P2P engine' : 'Enable P2P engine'}
                    />
                  </div>
                </section>

                {/* Release Selection & Languages */}
                <section className="space-y-3 pt-4 border-t border-white/[0.08]">
                  <div className="flex items-center justify-between gap-3">
                    <h4 className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">
                      Release Selection
                    </h4>
                    <div className="inline-flex rounded-lg bg-black/30 p-0.5 border border-white/[0.08]">
                      {([
                        ['automatic', 'Automatic'],
                        ['manual', 'Manual'],
                      ] as const).map(([mode, label]) => (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => {
                            setReleaseSelectionMode(mode);
                            onSave({ releaseSelectionMode: mode });
                          }}
                          className={`px-3 py-1 rounded-md text-[11px] font-semibold transition-all ${
                            releaseSelectionMode === mode
                              ? 'bg-rose-500/20 text-rose-100 border border-rose-400/40 shadow-sm'
                              : 'border border-transparent text-zinc-400 hover:text-zinc-200'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-xl bg-white/[0.03] border border-white/[0.08] p-4 grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                    {([
                      ['audio', 'Audio', preferredAudioLanguages],
                      ['subtitles', 'Subtitles', preferredSubtitleLanguages],
                    ] as const).map(([kind, label, selected]) => {
                      const primary = selected[0] ?? 'any';
                      const fallbacks = selected.slice(1);
                      const remaining = TORRENT_LANGUAGES.filter((l) => !selected.includes(l.code));

                      return (
                        <div key={kind} className="space-y-2">
                          <label className="text-[11px] font-semibold text-zinc-300">{label}</label>
                          <GlassSelect
                            value={primary}
                            onChange={(value) => handleSetPrimaryTorrentLanguage(kind, value)}
                            options={[
                              { value: 'any', label: 'Any language' },
                              ...TORRENT_LANGUAGES.map((lang) => ({
                                value: lang.code,
                                label: lang.label,
                              })),
                            ]}
                            ariaLabel={`Preferred ${label.toLowerCase()} language`}
                            className="w-full px-3 py-2 rounded-lg"
                          />

                          {selected.length > 0 && (
                            <div className="flex flex-wrap items-center gap-1.5">
                              {fallbacks.map((code, idx) => (
                                <button
                                  key={code}
                                  type="button"
                                  onClick={() => handleRemoveTorrentLanguage(kind, code)}
                                  title={`Fallback #${idx + 2} — click to remove`}
                                  className="inline-flex items-center gap-1 rounded-md border border-rose-400/30 bg-rose-500/10 px-2 py-0.5 text-[10px] font-medium text-rose-200 hover:bg-rose-500/20 transition-colors"
                                >
                                  <span className="text-rose-400/80 font-mono">#{idx + 2}</span>
                                  <span>{getTorrentLanguageLabel(code)}</span>
                                  <X className="w-2.5 h-2.5 opacity-75" />
                                </button>
                              ))}

                              {remaining.length > 0 && (
                                <div className="w-fit">
                                  <GlassSelect
                                    value="Fallback"
                                    onChange={(value) => handleAddFallbackTorrentLanguage(kind, value)}
                                    options={remaining.map((lang) => ({
                                      value: lang.code,
                                      label: lang.label,
                                    }))}
                                    leadingIcon={<Plus className="w-3 h-3" />}
                                    ariaLabel={`Add fallback ${label.toLowerCase()} language`}
                                    className="h-6 px-2 py-0 rounded-md text-[10px] font-medium text-zinc-400 border-white/[0.08] bg-black/25 hover:text-zinc-200"
                                    menuClassName="min-w-[8.5rem]"
                                  />
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>

                {p2pState?.enabled ? (
                  <>
                    {/* Speed & Limits */}
                    <section className="space-y-2.5 pt-4 border-t border-white/[0.08]">
                      <h4 className="text-[11px] font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
                        <Gauge className="w-3.5 h-3.5 text-zinc-500" />
                        <span>Limits</span>
                      </h4>
                      <div className="grid grid-cols-2 gap-3 rounded-xl bg-white/[0.03] border border-white/[0.08] p-3.5">
                        <div className="space-y-1">
                          <label className="text-[11px] font-medium text-zinc-400">Max simultaneous (1–6)</label>
                          <input
                            type="number"
                            min={1}
                            max={6}
                            value={limitMaxConcurrent}
                            onChange={(e) => setLimitMaxConcurrent(e.target.value)}
                            onBlur={handleMaxConcurrentBlur}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                            }}
                            className="w-full px-3 py-2 rounded-lg bg-black/30 border border-white/10 text-xs text-zinc-200 focus:outline-none focus:border-rose-400/50"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-[11px] font-medium text-zinc-400">Seed after complete</label>
                          <GlassSelect
                            value={String(limitSeedMinutes)}
                            onChange={(value) => handleSeedMinutesChange(value)}
                            options={[
                              { value: '0', label: 'Stop immediately' },
                              { value: '15', label: '15 minutes' },
                              { value: '60', label: '1 hour' },
                              { value: '480', label: '8 hours' },
                            ]}
                            ariaLabel="Seed after complete"
                            className="w-full px-3 py-2 rounded-lg"
                          />
                        </div>
                      </div>
                    </section>

                    {/* Indexers (BYOC) */}
                    <section className="space-y-2.5 pt-4 border-t border-white/[0.08]">
                      <div className="flex items-center justify-between">
                        <h4 className="text-[11px] font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
                          <Rss className="w-3.5 h-3.5 text-zinc-500" />
                          <span>Indexers ({providersDraft.length})</span>
                        </h4>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => providerImportRef.current?.click()}
                            disabled={providersBusy}
                            className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/[0.06] hover:bg-white/[0.11] text-zinc-200 border border-white/10 text-[11px] font-medium disabled:opacity-50"
                          >
                            <Upload className="w-3 h-3" />
                            <span>Import</span>
                          </button>
                          <button
                            type="button"
                            onClick={handleExportProviders}
                            className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/[0.06] hover:bg-white/[0.11] text-zinc-200 border border-white/10 text-[11px] font-medium"
                          >
                            <Download className="w-3 h-3" />
                            <span>Export</span>
                          </button>
                        </div>
                      </div>

                      {providersDraft.length === 0 ? (
                        <div className="p-3.5 rounded-xl border border-dashed border-white/10 bg-white/[0.02] text-center">
                          <p className="text-xs text-zinc-500">No RSS/Torznab indexers added.</p>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {providersDraft.map((provider, index) => (
                            <div
                              key={provider.id || `provider-row-${index}`}
                              className="space-y-1.5 rounded-xl bg-white/[0.03] border border-white/[0.08] p-2.5"
                            >
                              <div className="flex items-center gap-2">
                                <input
                                  type="text"
                                  value={provider.name}
                                  onChange={(e) => handleProviderField(index, { name: e.target.value })}
                                  placeholder="Indexer name"
                                  className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-black/30 border border-white/10 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-rose-400/50"
                                />
                                <GlassSelect
                                  value={provider.type}
                                  onChange={(value) =>
                                    handleProviderField(index, { type: value as RssProvider['type'] })
                                  }
                                  options={[
                                    { value: 'rss', label: 'RSS' },
                                    { value: 'torznab', label: 'Torznab' },
                                  ]}
                                  ariaLabel="Feed type"
                                  title="Feed type"
                                  className="px-2 py-1.5 rounded-lg shrink-0 w-28"
                                />
                                <input
                                  type="checkbox"
                                  checked={provider.enabled}
                                  onChange={(e) => handleProviderField(index, { enabled: e.target.checked })}
                                  className="w-4 h-4 rounded cursor-pointer accent-rose-500 shrink-0"
                                  title="Enabled"
                                  aria-label={`${provider.name || 'Provider'} enabled`}
                                />
                                <button
                                  type="button"
                                  onClick={() => handleRemoveProvider(index)}
                                  className="p-1 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-500/10 shrink-0"
                                  title="Remove provider"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                              <input
                                type="text"
                                value={provider.urlTemplate}
                                onChange={(e) => handleProviderField(index, { urlTemplate: e.target.value })}
                                placeholder="https://your-indexer.example/rss?q={query}"
                                className="w-full px-2.5 py-1.5 rounded-lg bg-black/30 border border-white/10 text-[11px] font-mono text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-rose-400/50 select-all"
                              />
                            </div>
                          ))}
                        </div>
                      )}

                      <div className="flex items-center justify-between gap-2 pt-1">
                        <button
                          type="button"
                          onClick={handleAddProvider}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.07] hover:bg-white/[0.12] text-zinc-100 border border-white/10 text-xs font-medium"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          <span>Add provider</span>
                        </button>
                        <button
                          type="button"
                          onClick={handleSaveProviders}
                          disabled={providersBusy}
                          className="btn-primary flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-white text-xs font-semibold disabled:opacity-50"
                        >
                          <Save className="w-3.5 h-3.5" />
                          <span>{providersBusy ? 'Saving…' : 'Save providers'}</span>
                        </button>
                      </div>

                      <input
                        ref={providerImportRef}
                        type="file"
                        accept=".json,application/json"
                        className="hidden"
                        onChange={handleImportProvidersFile}
                      />
                    </section>
                  </>
                ) : (
                  <p className="text-xs text-zinc-500">
                    Enable the P2P engine above to configure download limits and RSS/Torznab indexers.
                  </p>
                )}
              </div>
            )}

            {activeTab === 'backup' && (
              <div className="space-y-6 animate-in fade-in duration-150">
                {/* Documents Backup */}
                <section className="space-y-2.5">
                  <h4 className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">
                    Documents Backup
                  </h4>

                  <div className="space-y-3 rounded-xl bg-white/[0.03] border border-white/[0.08] p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-zinc-200">
                          {backupStatus?.exists
                            ? `Synced ${formatRelativeTime(backupStatus.lastSyncedAt) ?? 'recently'}${
                                backupStatus.sizeBytes ? ` · ${formatFileSize(backupStatus.sizeBytes)}` : ''
                              }`
                            : 'No backup created yet'}
                        </p>
                        {backupStatus?.path && (
                          <p className="mt-1 truncate font-mono text-[11px] text-zinc-500 select-all" title={backupStatus.path}>
                            {backupStatus.path}
                          </p>
                        )}
                      </div>
                      {backupStatus?.exists && <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />}
                    </div>

                    {confirmRestore ? (
                      <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-xl bg-red-950/40 border border-red-500/40 animate-in fade-in duration-150">
                        <div className="flex items-center gap-2 text-xs text-red-200 min-w-0 flex-1">
                          <AlertTriangle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                          <span className="truncate">Replace current history, rules, and list?</span>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            type="button"
                            onClick={() => setConfirmRestore(false)}
                            disabled={dataBusy === 'restore'}
                            className="px-2.5 py-1 rounded-lg text-[11px] bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={handleRestoreConfirmed}
                            disabled={dataBusy === 'restore'}
                            className="px-2.5 py-1 rounded-lg text-[11px] font-bold bg-red-600 hover:bg-red-500 text-white disabled:opacity-60"
                          >
                            {dataBusy === 'restore' ? 'Restoring…' : 'Confirm Restore'}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={handleBackupNow}
                          disabled={dataBusy !== null || !window.electronAPI?.backupNow}
                          className="btn-primary flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-white text-xs font-semibold disabled:opacity-50"
                        >
                          <Save className="w-3.5 h-3.5" />
                          <span>{dataBusy === 'backup' ? 'Backing up…' : 'Backup now'}</span>
                        </button>
                        {restoreAvailable && (
                          <button
                            type="button"
                            onClick={() => setConfirmRestore(true)}
                            disabled={dataBusy !== null || !window.electronAPI?.restoreFromBackup}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.07] hover:bg-white/[0.12] text-zinc-200 border border-white/10 text-xs font-medium disabled:opacity-50"
                          >
                            <RotateCcw className="w-3.5 h-3.5 text-zinc-400" />
                            <span>Restore from backup</span>
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </section>

                {/* Watchlist Export / Import */}
                <section className="space-y-2.5 pt-4 border-t border-white/[0.08]">
                  <h4 className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">
                    Watchlist Snapshot
                  </h4>
                  <div className="flex flex-wrap items-center gap-2 rounded-xl bg-white/[0.03] border border-white/[0.08] p-4">
                    <button
                      type="button"
                      onClick={() => handleExportWatchlist('json')}
                      disabled={dataBusy !== null || !window.electronAPI?.exportWatchlist}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.07] hover:bg-white/[0.12] text-zinc-200 border border-white/10 text-xs font-medium disabled:opacity-50"
                    >
                      <Download className="w-3.5 h-3.5 text-zinc-400" />
                      <span>Export JSON</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleExportWatchlist('mal-xml')}
                      disabled={dataBusy !== null || !window.electronAPI?.exportWatchlist}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.07] hover:bg-white/[0.12] text-zinc-200 border border-white/10 text-xs font-medium disabled:opacity-50"
                    >
                      <Download className="w-3.5 h-3.5 text-zinc-400" />
                      <span>Export MAL XML</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleImportWatchlist}
                      disabled={dataBusy !== null || !window.electronAPI?.importWatchlist}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.07] hover:bg-white/[0.12] text-zinc-200 border border-white/10 text-xs font-medium disabled:opacity-50"
                    >
                      <Upload className="w-3.5 h-3.5 text-zinc-400" />
                      <span>{dataBusy === 'import' ? 'Importing…' : 'Import Watchlist'}</span>
                    </button>
                  </div>
                </section>
              </div>
            )}

            {activeTab === 'updates' && (
              <div className="space-y-6 animate-in fade-in duration-150">
                {/* Version & Download Status */}
                <section className="space-y-2.5">
                  <h4 className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">
                    Application Version
                  </h4>

                  <div className="space-y-3 p-4 rounded-xl bg-white/[0.03] border border-white/[0.08]">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-bold text-white font-mono">v{appVersion}</p>
                        <p className="text-xs text-zinc-400">
                          {updaterState.status === 'not-available' && 'Up to date'}
                          {updaterState.status === 'checking' && 'Checking for updates…'}
                          {updaterState.status === 'available' && `v${updaterState.updateInfo?.version || ''} available`}
                          {updaterState.status === 'downloading' && `Downloading v${updaterState.updateInfo?.version || ''}…`}
                          {updaterState.status === 'downloaded' && `v${updaterState.updateInfo?.version || ''} ready to install`}
                          {updaterState.status === 'idle' && 'Check for updates or view release notes'}
                          {updaterState.status === 'error' && 'Update check failed'}
                        </p>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {updaterState.status === 'available' ? (
                          <>
                            <button
                              type="button"
                              onClick={() => handleOpenWhatsNew()}
                              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.07] hover:bg-white/[0.12] text-rose-200 border border-white/10 text-xs font-medium"
                            >
                              <Sparkles className="w-3.5 h-3.5 text-rose-400" />
                              <span>What&apos;s New</span>
                            </button>
                            <button
                              type="button"
                              onClick={handleDownloadUpdate}
                              className="btn-primary flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-white text-xs font-semibold"
                            >
                              <Download className="w-3.5 h-3.5" />
                              <span>Update Now</span>
                            </button>
                          </>
                        ) : updaterState.status === 'downloaded' ? (
                          <button
                            type="button"
                            onClick={handleInstallUpdate}
                            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold"
                          >
                            <RefreshCw className="w-3.5 h-3.5" />
                            <span>Restart &amp; Install</span>
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => handleOpenWhatsNew(appVersion)}
                              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.07] hover:bg-white/[0.12] text-zinc-200 border border-white/10 text-xs font-medium"
                            >
                              <Sparkles className="w-3.5 h-3.5 text-rose-400" />
                              <span>What&apos;s New</span>
                            </button>
                            <button
                              type="button"
                              onClick={handleCheckForUpdates}
                              disabled={updaterState.status === 'checking' || updaterState.status === 'downloading'}
                              className="btn-primary flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg disabled:opacity-50 text-white text-xs font-semibold"
                            >
                              <RefreshCw className={`w-3.5 h-3.5 ${updaterState.status === 'checking' ? 'animate-spin' : ''}`} />
                              <span>{updaterState.status === 'checking' ? 'Checking...' : 'Check for Updates'}</span>
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    {updaterState.status === 'downloading' && (
                      <div className="space-y-1.5 pt-2.5 border-t border-white/[0.06]">
                        <div className="flex items-center justify-between text-xs text-zinc-300">
                          <span>Downloading v{updaterState.updateInfo?.version || ''}…</span>
                          <span className="font-mono">{updaterDisplayPercent}%</span>
                        </div>
                        <div className="w-full h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                          <div
                            className="h-full bg-gradient-to-r from-rose-600 to-rose-400 transition-[width] duration-150 ease-out"
                            style={{ width: `${Math.max(2, Math.min(100, updaterDisplayPercent))}%` }}
                          />
                        </div>
                        {updaterState.downloadProgress && (
                          <div className="flex items-center justify-between text-[11px] text-zinc-500 font-mono">
                            <span>
                              {formatFileSize(updaterState.downloadProgress.transferred)} / {formatFileSize(updaterState.downloadProgress.total)}
                              {updaterState.downloadProgress.phase === 'delta' && <span className="text-emerald-400"> (delta)</span>}
                            </span>
                            <span>{formatFileSize(updaterState.downloadProgress.bytesPerSecond)}/s</span>
                          </div>
                        )}
                      </div>
                    )}

                    {updaterState.status === 'error' && updaterState.error && (
                      <div className="flex items-center justify-between p-2.5 rounded-lg bg-red-950/40 border border-red-500/30 text-xs text-red-200">
                        <div className="flex items-center gap-2 min-w-0 pr-2">
                          <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                          <span className="truncate">{updaterState.error}</span>
                        </div>
                        <button
                          type="button"
                          onClick={handleCheckForUpdates}
                          className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-[11px] font-medium text-zinc-200 shrink-0"
                        >
                          Retry
                        </button>
                      </div>
                    )}
                  </div>
                </section>

                {/* Update Preferences */}
                <section className="space-y-2 pt-4 border-t border-white/[0.08]">
                  <h4 className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">
                    Preferences
                  </h4>

                  <div className="flex items-center justify-between px-3.5 py-3 rounded-xl bg-white/[0.03] border border-white/[0.08]">
                    <span className="text-xs font-medium text-zinc-200">Check for updates on startup</span>
                    <ToggleSwitch
                      checked={checkForUpdatesOnStartup}
                      onChange={handleToggleCheckOnStartup}
                      label="Check for updates on startup"
                    />
                  </div>

                  <div className="flex items-center justify-between px-3.5 py-3 rounded-xl bg-white/[0.03] border border-white/[0.08]">
                    <span className="text-xs font-medium text-zinc-200">Auto-updates</span>
                    <ToggleSwitch
                      checked={autoUpdate}
                      onChange={handleToggleAutoUpdate}
                      label="Auto-updates"
                    />
                  </div>
                </section>
              </div>
            )}
          </div>
        </div>

        {/* Persistent Footer */}
        <div className="px-6 py-3.5 border-t border-white/[0.08] flex items-center justify-between shrink-0 bg-black/30">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleResetDefaults}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-white/[0.06] text-xs font-medium transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Reset tool paths</span>
            </button>
            <span
              className="text-[11px] text-zinc-500 font-mono select-none"
              onClick={handleVersionTap}
            >
              v{appVersion}
            </span>
          </div>

          <button
            type="button"
            onClick={handleClose}
            className="px-5 py-2 rounded-xl bg-white/[0.08] hover:bg-white/[0.14] text-zinc-100 font-medium text-xs border border-white/10 transition-colors"
          >
            Done
          </button>
        </div>

        {showP2pConsent && (
          <P2pConsentModal
            onAccept={handleP2pConsentAccept}
            onCancel={() => setShowP2pConsent(false)}
          />
        )}

        {manualUpdateModalOpen && manualUpdateInfo && (
          <UpdatePromptModal
            isOpen={manualUpdateModalOpen}
            onClose={() => setManualUpdateModalOpen(false)}
            updateInfo={manualUpdateInfo}
            appVersion={appVersion}
            hideDontShowAgain={true}
            onUpdateSettings={onSave}
          />
        )}
      </div>
    </div>
  ), document.body);
};
