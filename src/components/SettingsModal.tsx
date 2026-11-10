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
} from 'lucide-react';
import { AppSettings } from '../types';
import type { P2pState, RssProvider, UpdaterState } from '../types';
import { showGlobalToast } from './Toast';
import { P2pConsentModal } from './P2P/P2pConsentModal';
import { formatFileSize } from '../utils/format';
import { TORRENT_LANGUAGES, type TorrentLanguageCode } from '../lib/releaseParser/releaseClassification';

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
      checked ? 'bg-red-600' : 'bg-zinc-700'
    }`}
  >
    <div
      className={`w-5 h-5 rounded-full bg-white shadow-md transition-transform duration-200 ${
        checked ? 'translate-x-5' : 'translate-x-0'
      }`}
    />
  </button>
);

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  onSave: (newSettings: Partial<AppSettings>) => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  settings,
  onSave,
}) => {
  const [ffmpegPath, setFfmpegPath] = useState(settings.ffmpegPath);
  const [whisperPath, setWhisperPath] = useState(settings.whisperPath);
  const [whisperModel, setWhisperModel] = useState<string>(settings.whisperModel || 'large-v3-turbo');
  const [customModelPath, setCustomModelPath] = useState<string>(settings.customModelPath || '');
  const [showCustomModelSection, setShowCustomModelSection] = useState(Boolean(settings.customModelPath));
  const [libraryFolders, setLibraryFolders] = useState<string[]>(
    Array.isArray(settings.libraryFolders) && settings.libraryFolders.length > 0
      ? settings.libraryFolders
      : settings.defaultLibraryRoot
      ? [settings.defaultLibraryRoot]
      : []
  );
  const [releaseSelectionMode, setReleaseSelectionMode] = useState<'automatic' | 'manual'>(
    settings.releaseSelectionMode ?? 'automatic'
  );
  const [preferredAudioLanguages, setPreferredAudioLanguages] = useState<TorrentLanguageCode[]>(
    (settings.preferredTorrentAudioLanguages ?? ['en']) as TorrentLanguageCode[]
  );
  const [preferredSubtitleLanguages, setPreferredSubtitleLanguages] = useState<TorrentLanguageCode[]>(
    (settings.preferredTorrentSubtitleLanguages ?? ['en']) as TorrentLanguageCode[]
  );
  const [animeTitleLanguage, setAnimeTitleLanguage] = useState<'english' | 'romaji' | 'native'>(
    settings.animeTitleLanguage ?? 'english'
  );

  const [binaryStatus, setBinaryStatus] = useState<{
    ffmpegExists: boolean;
    whisperExists: boolean;
    modelExists?: boolean;
    isDefaultModelInstalled?: boolean;
    modelName?: string;
    detectedCustomModels?: string[];
    customModelDetectedName?: string | null;
  }>({
    ffmpegExists: false,
    whisperExists: false,
    modelExists: false,
    isDefaultModelInstalled: false,
    modelName: 'large-v3-turbo',
    detectedCustomModels: [],
  });

  const [downloadingModel, setDownloadingModel] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<{ percent: number | null; text: string }>({
    percent: null,
    text: '',
  });

  const [isDetecting, setIsDetecting] = useState(false);
  const [showSetupGuide, setShowSetupGuide] = useState(false);
  const [confirmDeleteIndex, setConfirmDeleteIndex] = useState<number | null>(null);

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

  // Application update state
  const [appVersion, setAppVersion] = useState<string>('1.0.7');
  const [checkForUpdatesOnStartup, setCheckForUpdatesOnStartup] = useState<boolean>(
    settings.checkForUpdatesOnStartup ?? true
  );
  const [autoUpdate, setAutoUpdate] = useState<boolean>(
    settings.autoUpdate ?? true
  );
  const [updaterState, setUpdaterState] = useState<UpdaterState>({
    status: 'idle',
    currentVersion: '1.0.7',
    updateInfo: null,
    downloadProgress: null,
    error: null,
  });
  const [updaterDisplayPercent, setUpdaterDisplayPercent] = useState<number>(0);

  useEffect(() => {
    if (updaterState.downloadProgress && typeof updaterState.downloadProgress.percent === 'number') {
      setUpdaterDisplayPercent((prev) => Math.max(prev, Math.round(updaterState.downloadProgress!.percent)));
    }
  }, [updaterState.downloadProgress]);

  useEffect(() => {
    if (isOpen) {
      setFfmpegPath(settings.ffmpegPath);
      setWhisperPath(settings.whisperPath);
      setWhisperModel(settings.whisperModel || 'large-v3-turbo');
      setCustomModelPath(settings.customModelPath || '');
      setShowCustomModelSection(Boolean(settings.customModelPath));
      setCheckForUpdatesOnStartup(settings.checkForUpdatesOnStartup ?? true);
      setAutoUpdate(settings.autoUpdate ?? true);
      setLibraryFolders(
        Array.isArray(settings.libraryFolders) && settings.libraryFolders.length > 0
          ? settings.libraryFolders
          : settings.defaultLibraryRoot
          ? [settings.defaultLibraryRoot]
          : []
      );
      setReleaseSelectionMode(settings.releaseSelectionMode ?? 'automatic');
      setPreferredAudioLanguages((settings.preferredTorrentAudioLanguages ?? ['en']) as TorrentLanguageCode[]);
      setPreferredSubtitleLanguages((settings.preferredTorrentSubtitleLanguages ?? ['en']) as TorrentLanguageCode[]);

      // Check existence of external binaries and models
      window.electronAPI
        .checkBinaries({
          ffmpegPath: settings.ffmpegPath,
          whisperPath: settings.whisperPath,
          modelName: settings.whisperModel || 'large-v3-turbo',
          customModelPath: settings.customModelPath,
        })
        .then((status) => {
          setBinaryStatus(status);
        })
        .catch(() => {});
    }
  }, [isOpen, settings]);

  // Live status check when user edits paths or model
  useEffect(() => {
    if (isOpen) {
      window.electronAPI
        .checkBinaries({ ffmpegPath, whisperPath, modelName: whisperModel, customModelPath })
        .then((status) => {
          setBinaryStatus(status);
        })
        .catch(() => {});
    }
  }, [isOpen, ffmpegPath, whisperPath, whisperModel, customModelPath]);

  // Listen for Whisper model download progress
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
          if (state.status === 'not-available') {
            showGlobalToast(`You are running the latest version (${appVersion})`, 'info');
          }
        }
      } catch (err: any) {
        showGlobalToast(err?.message || 'Failed to check for updates', 'error');
      }
    }
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

  // Handle Escape key to close (the P2P consent modal handles its own Escape)
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (showP2pConsent) return;
        handleClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, ffmpegPath, whisperPath, settings, onClose, showP2pConsent]);

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

  const handleDownloadModel = async () => {
    if (!window.electronAPI?.downloadWhisperModel) return;
    if (!binaryStatus.whisperExists) {
      showGlobalToast('Faster-Whisper executable is required to download models', 'error');
      return;
    }
    setDownloadingModel('large-v3-turbo');
    setDownloadProgress({ percent: 0, text: 'Connecting to Hugging Face...' });
    try {
      const res = await window.electronAPI.downloadWhisperModel('large-v3-turbo');
      if (res.success) {
        showGlobalToast('Model large-v3-turbo downloaded successfully and ready!', 'success');
        const status = await window.electronAPI.checkBinaries({
          ffmpegPath,
          whisperPath,
          modelName: 'large-v3-turbo',
          customModelPath,
        });
        setBinaryStatus(status);
      } else {
        showGlobalToast(res.error || 'Failed to download model', 'error');
      }
    } catch (err: any) {
      showGlobalToast(err?.message || 'Failed to download model', 'error');
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

  const handleSelectDetectedModel = (modelName: string) => {
    setWhisperModel(modelName);
    onSave({ whisperModel: modelName });
    showGlobalToast(`Active model set to ${modelName}`, 'success');
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

  return createPortal((
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 animate-in fade-in duration-150"
      onClick={handleClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        data-modal="true"
        className="w-full max-w-xl max-h-[90vh] flex flex-col bg-[#141418] border border-white/10 rounded-2xl text-zinc-100 shadow-2xl animate-in zoom-in-95 duration-150 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 shrink-0">
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 rounded-lg bg-zinc-800/80 border border-white/10 flex items-center justify-center text-zinc-400">
              <SettingsIcon className="w-4 h-4 text-zinc-400" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white tracking-tight">Settings</h3>
              <p className="text-xs text-zinc-400">Configure media folders and external binary paths</p>
            </div>
          </div>

          <div className="flex items-center space-x-3">
            <span
              title={`Kaiko version ${appVersion}`}
              className="text-xs font-mono font-medium px-2.5 py-1 rounded-lg bg-zinc-800/90 text-zinc-400 border border-white/10 select-none"
            >
              v{appVersion}
            </span>
            <button
              type="button"
              onClick={handleClose}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Form Body (Scrollable) */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* Section: Anime Media Folders */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <label className="text-xs font-semibold text-zinc-200 uppercase tracking-wider flex items-center space-x-2">
                  <Folder className="w-3.5 h-3.5 text-zinc-400" />
                  <span>Anime Media Folders ({libraryFolders.length})</span>
                </label>
                <p className="text-[11px] text-zinc-400">
                  Add directories across different drives (e.g. D:\films, E:\Anime). Incomplete downloads stay hidden and appear here when ready.
                </p>
              </div>

              <button
                type="button"
                onClick={handleAddFolder}
                className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-100 border border-white/10 text-xs font-medium transition-all shadow-sm shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Folder</span>
              </button>
            </div>

            {/* Folder List with Removal Confirmation */}
            <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
              {libraryFolders.length === 0 ? (
                <div className="p-3.5 rounded-xl border border-dashed border-zinc-800 bg-zinc-900/40 text-center">
                  <p className="text-xs text-zinc-500">No media folders added. Click "+ Add Folder" to choose a directory.</p>
                </div>
              ) : (
                libraryFolders.map((folder, index) =>
                  confirmDeleteIndex === index ? (
                    <div
                      key={`${folder}-${index}-confirm`}
                      className="flex items-center justify-between gap-3 px-3 py-2 rounded-xl bg-red-950/40 border border-red-500/40 animate-in fade-in duration-150"
                    >
                      <div className="flex items-center space-x-2 text-xs text-red-200 min-w-0 flex-1">
                        <AlertTriangle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                        <span className="truncate">
                          Remove <span className="font-mono font-semibold text-white">{folder}</span>?
                        </span>
                      </div>
                      <div className="flex items-center space-x-2 shrink-0">
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
                          className="px-2.5 py-1 rounded-lg text-[11px] font-bold text-white bg-red-600 hover:bg-red-500 transition-colors shadow-sm"
                        >
                          Confirm Remove
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div
                      key={`${folder}-${index}`}
                      className="flex items-center justify-between gap-3 px-3 py-2 rounded-xl bg-zinc-900/90 border border-white/10 hover:border-zinc-700/80 transition-colors group"
                    >
                      <div className="flex items-center space-x-2.5 min-w-0 flex-1">
                        <Folder className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                        <span className="font-mono text-xs text-zinc-200 truncate select-all" title={folder}>
                          {folder}
                        </span>
                      </div>

                      <button
                        type="button"
                        onClick={() => setConfirmDeleteIndex(index)}
                        className="p-1 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-colors shrink-0"
                        title="Remove folder from library"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )
                )
              )}
            </div>

          </div>

          {/* Section: Anime Title Language */}
          <div className="space-y-3 pt-3 border-t border-white/10">
            <div>
              <label className="text-xs font-semibold text-zinc-200 uppercase tracking-wider flex items-center space-x-2">
                <Languages className="w-3.5 h-3.5 text-zinc-400" />
                <span>Anime Title Language</span>
              </label>
              <p className="text-[11px] text-zinc-400">
                Choose whether titles across Discovery, Home, and details appear in English, Romanized Japanese, or Original Japanese.
              </p>
            </div>

            <div className="grid grid-cols-3 gap-2.5">
              {[
                { value: 'english' as const, label: 'English', desc: 'Localized (e.g. Demon Slayer)' },
                { value: 'romaji' as const, label: 'Romaji', desc: 'Romanized (e.g. Kimetsu no Yaiba)' },
                { value: 'native' as const, label: '日本語', desc: 'Native script (e.g. 鬼滅の刃)' },
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
                      ? 'border-rose-400/50 bg-rose-500/10 text-white shadow-sm'
                      : 'border-white/10 bg-zinc-900/60 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
                  }`}
                >
                  <span className={`text-xs font-bold ${animeTitleLanguage === option.value ? 'text-rose-200' : 'text-zinc-200'}`}>{option.label}</span>
                  <span className="mt-1 text-[10px] text-zinc-500 leading-tight">{option.desc}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Section: Faster-Whisper AI Subtitles Engine */}
          <div className="space-y-3 pt-3 border-t border-white/10">
            <div className="flex items-center justify-between">
              <div>
                <label className="text-xs font-semibold text-zinc-200 uppercase tracking-wider flex items-center space-x-2">
                  <Cpu className="w-3.5 h-3.5 text-zinc-400" />
                  <span>Faster-Whisper AI Subtitles Engine</span>
                </label>
                <p className="text-[11px] text-zinc-400">
                  Faster-Whisper powers high-speed AI speech-to-text subtitle generation in Whisper Studio.
                </p>
              </div>

              <div className="flex items-center space-x-2 shrink-0">
                <button
                  type="button"
                  onClick={() => setShowSetupGuide(!showSetupGuide)}
                  className="flex items-center space-x-1 px-2.5 py-1 rounded-lg text-[11px] font-medium text-zinc-400 hover:text-white hover:bg-zinc-800/80 transition-colors"
                >
                  <HelpCircle className="w-3.5 h-3.5 text-zinc-400" />
                  <span>{showSetupGuide ? 'Hide Guide' : 'Setup Guide'}</span>
                </button>

                <button
                  type="button"
                  onClick={handleAutoDetect}
                  disabled={isDetecting}
                  className="flex items-center space-x-1.5 px-3 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 hover:text-white border border-white/10 text-xs font-medium transition-all disabled:opacity-50"
                  title="Scan PATH and Subtitle Edit installations"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isDetecting ? 'animate-spin text-zinc-300' : 'text-zinc-400'}`} />
                  <span>Auto-Detect</span>
                </button>
              </div>
            </div>

            {/* Setup & Installation Guide Card (Expandable) */}
            {showSetupGuide && (
              <div className="p-3.5 rounded-xl bg-zinc-900/90 border border-white/10 space-y-2.5 animate-in fade-in duration-150">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-zinc-200">How to set up Faster-Whisper</span>
                  <button
                    type="button"
                    onClick={() => setShowSetupGuide(false)}
                    className="text-zinc-500 hover:text-zinc-300 text-xs"
                  >
                    Close
                  </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 text-[11px]">
                  <div className="p-2.5 rounded-lg bg-zinc-950/70 border border-white/5 space-y-1.5">
                    <div className="font-semibold text-zinc-200 flex items-center justify-between">
                      <span>1. Subtitle Edit (Easiest)</span>
                    </div>
                    <p className="text-zinc-400 text-[10px] leading-relaxed">
                      In Subtitle Edit, open <em>Video &rarr; Audio to text</em> and pick <strong>Faster-Whisper XXL</strong>. It auto-downloads everything to AppData.
                    </p>
                    <button
                      type="button"
                      onClick={() => window.electronAPI.openExternalUrl('https://www.nikse.dk/subtitleedit')}
                      className="inline-flex items-center space-x-1 text-[11px] text-zinc-300 hover:text-white underline pt-0.5"
                    >
                      <span>Subtitle Edit Website</span>
                      <ExternalLink className="w-3 h-3" />
                    </button>
                  </div>

                  <div className="p-2.5 rounded-lg bg-zinc-950/70 border border-white/5 space-y-1.5">
                    <div className="font-semibold text-zinc-200 flex items-center justify-between">
                      <span>2. Standalone Release</span>
                    </div>
                    <p className="text-zinc-400 text-[10px] leading-relaxed">
                      Download the standalone Windows archive from the Faster-Whisper-XXL release, extract anywhere, and click <strong>Browse</strong>.
                    </p>
                    <button
                      type="button"
                      onClick={() =>
                        window.electronAPI.openExternalUrl('https://github.com/Purfview/whisper-standalone-win/releases')
                      }
                      className="inline-flex items-center space-x-1 text-[11px] text-zinc-300 hover:text-white underline pt-0.5"
                    >
                      <span>Purfview GitHub Releases</span>
                      <ExternalLink className="w-3 h-3" />
                    </button>
                  </div>
                </div>

                <div className="text-[10px] text-zinc-400 pt-0.5">
                  <span className="text-zinc-300 font-medium">Model notice:</span> The default <code>large-v3-turbo</code> model can be downloaded below in 1-click or will download automatically on first transcription.
                </div>
              </div>
            )}

            {/* Faster-Whisper Binary Path & Setup */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-300 flex items-center justify-between">
                <span>Faster-Whisper-XXL Executable (faster-whisper-xxl.exe)</span>
                <span className="text-[10px] text-zinc-500 font-normal">Required for Whisper Studio</span>
              </label>
              <div className="flex items-center space-x-2">
                <div className="relative flex-1">
                  <input
                    type="text"
                    placeholder="Auto-detected or specify path to faster-whisper-xxl.exe"
                    value={whisperPath}
                    onChange={(e) => handleWhisperChange(e.target.value)}
                    onBlur={handleWhisperBlur}
                    onKeyDown={handleWhisperKeyDown}
                    className="w-full pl-3 pr-24 py-2 rounded-lg bg-zinc-900 border border-white/10 text-xs font-mono text-zinc-200 focus:outline-none focus:border-zinc-500"
                  />
                  <div className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center space-x-1 pointer-events-none select-none">
                    {binaryStatus.whisperExists ? (
                      <>
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                        <span className="text-[11px] font-medium text-emerald-400">Ready</span>
                      </>
                    ) : (
                      <>
                        <AlertCircle className="w-3.5 h-3.5 text-amber-400" />
                        <span className="text-[11px] font-medium text-amber-400">Not found</span>
                      </>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleBrowseWhisper}
                  className="flex items-center space-x-1.5 px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-white/10 text-xs font-medium transition-colors shrink-0"
                >
                  <FolderOpen className="w-3.5 h-3.5 text-zinc-400" />
                  <span>Browse</span>
                </button>
              </div>

              {/* If Whisper engine is not found, show direct download link button */}
              {!binaryStatus.whisperExists && (
                <div className="flex items-center justify-between p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-300">
                  <div className="flex items-center space-x-2">
                    <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
                    <span>Faster-Whisper-XXL engine is not configured yet.</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => window.electronAPI.openExternalUrl('https://github.com/Purfview/whisper-standalone-win/releases')}
                    className="inline-flex items-center space-x-1.5 px-3 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 border border-amber-500/40 text-[11px] font-semibold transition-colors shrink-0"
                  >
                    <span>Download Engine</span>
                    <ExternalLink className="w-3 h-3 text-amber-300" />
                  </button>
                </div>
              )}
            </div>

            {/* AI Subtitle Model Section */}
            <div className="space-y-3 pt-3 border-t border-white/10">
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-xs font-semibold text-zinc-200 uppercase tracking-wider flex items-center space-x-2">
                    <Sparkles className="w-3.5 h-3.5 text-zinc-400" />
                    <span>AI Subtitle Model</span>
                  </label>
                  <p className="text-[11px] text-zinc-400">
                    Choose which AI model Whisper Studio uses for transcription, or download the default model.
                  </p>
                </div>
                <div className="flex items-center space-x-1.5">
                  <span className="text-[10px] text-zinc-500">Active Model:</span>
                  <span className="text-xs font-mono font-semibold text-indigo-300 bg-indigo-500/15 border border-indigo-500/30 px-2 py-0.5 rounded-md">
                    {customModelPath ? (binaryStatus.customModelDetectedName || customModelPath.replace(/^.*[\\/]/, '')) : whisperModel}
                  </span>
                </div>
              </div>

              {/* Selectable Model Options */}
              <div className="space-y-2">
                {/* 1. Default Model (large-v3-turbo) */}
                <div
                  onClick={() => {
                    if (customModelPath) {
                      setCustomModelPath('');
                      setWhisperModel('large-v3-turbo');
                      onSave({ customModelPath: '', whisperModel: 'large-v3-turbo' });
                      showGlobalToast('Active model set to large-v3-turbo', 'success');
                    } else if (whisperModel !== 'large-v3-turbo') {
                      setWhisperModel('large-v3-turbo');
                      onSave({ whisperModel: 'large-v3-turbo' });
                      showGlobalToast('Active model set to large-v3-turbo', 'success');
                    }
                  }}
                  className={`p-3.5 rounded-xl border transition-all cursor-pointer ${
                    !customModelPath && whisperModel === 'large-v3-turbo'
                      ? 'bg-indigo-600/10 border-indigo-500/50 shadow-md ring-1 ring-indigo-500/30'
                      : 'bg-zinc-900/60 border-white/5 hover:border-zinc-700 hover:bg-zinc-900/90'
                  }`}
                >
                  <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                    <div className="flex items-start space-x-3">
                      {/* Radio indicator */}
                      <div className="mt-0.5 shrink-0">
                        {!customModelPath && whisperModel === 'large-v3-turbo' ? (
                          <div className="w-4 h-4 rounded-full border-2 border-indigo-400 bg-indigo-500 flex items-center justify-center">
                            <div className="w-1.5 h-1.5 rounded-full bg-white" />
                          </div>
                        ) : (
                          <div className="w-4 h-4 rounded-full border border-zinc-600 bg-zinc-800" />
                        )}
                      </div>

                      <div className="space-y-1">
                        <div className="flex items-center space-x-2 flex-wrap gap-y-1">
                          <span className="text-xs font-mono font-bold text-white">large-v3-turbo</span>
                          <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                            Default • Recommended
                          </span>
                          {!customModelPath && whisperModel === 'large-v3-turbo' && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                              Active
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-zinc-400">
                          State-of-the-art accuracy with up to 8x faster inference speed (~1.5 GB).
                        </p>
                      </div>
                    </div>

                    <div className="shrink-0 flex items-center space-x-2 self-end sm:self-center" onClick={(e) => e.stopPropagation()}>
                      {downloadingModel === 'large-v3-turbo' ? (
                        <div className="flex items-center space-x-2">
                          <span className="text-xs font-mono text-indigo-300 font-semibold animate-pulse">
                            {downloadProgress.percent !== null ? `${downloadProgress.percent}%` : 'Downloading...'}
                          </span>
                          <button
                            type="button"
                            onClick={handleCancelDownloadModel}
                            className="px-2.5 py-1 rounded-lg text-xs bg-red-500/20 hover:bg-red-500/30 text-red-300 border border-red-500/30 transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : binaryStatus.isDefaultModelInstalled || binaryStatus.modelExists ? (
                        <span className="inline-flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-semibold">
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                          <span>Installed</span>
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={!binaryStatus.whisperExists || Boolean(downloadingModel)}
                          onClick={handleDownloadModel}
                          className="inline-flex items-center space-x-1.5 px-3.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium text-xs shadow transition-colors"
                        >
                          <Download className="w-3.5 h-3.5" />
                          <span>Download large-v3-turbo</span>
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Progress bar during download */}
                  {downloadingModel === 'large-v3-turbo' && (
                    <div className="mt-3 pt-2.5 border-t border-white/5 space-y-1.5 animate-in fade-in">
                      <div className="w-full bg-zinc-800 rounded-full h-1.5 overflow-hidden">
                        <div
                          className="bg-indigo-500 h-full transition-[width] duration-150 ease-out"
                          style={{ width: `${downloadProgress.percent || 5}%` }}
                        />
                      </div>
                      {downloadProgress.text && (
                        <p className="text-[10px] font-mono text-zinc-400 truncate">
                          {downloadProgress.text}
                        </p>
                      )}
                    </div>
                  )}
                </div>

                {/* 2. Other Models Detected in _models (e.g. medium, tiny, small, base) */}
                {binaryStatus.detectedCustomModels && binaryStatus.detectedCustomModels.length > 0 && (
                  <div className="space-y-1.5 pt-1">
                    <span className="text-[11px] text-zinc-400 font-medium block">
                      Other Models Installed Locally in _models:
                    </span>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {binaryStatus.detectedCustomModels.map((m) => {
                        const isSelected = !customModelPath && whisperModel === m;
                        return (
                          <div
                            key={m}
                            onClick={() => {
                              setCustomModelPath('');
                              setWhisperModel(m);
                              onSave({ customModelPath: '', whisperModel: m });
                              showGlobalToast(`Active model set to ${m}`, 'success');
                            }}
                            className={`p-3 rounded-xl border transition-all cursor-pointer flex items-center justify-between ${
                              isSelected
                                ? 'bg-indigo-600/10 border-indigo-500/50 shadow-sm ring-1 ring-indigo-500/30'
                                : 'bg-zinc-900/60 border-white/5 hover:border-zinc-700 hover:bg-zinc-900/90'
                            }`}
                          >
                            <div className="flex items-center space-x-2.5 truncate">
                              <div className="shrink-0">
                                {isSelected ? (
                                  <div className="w-4 h-4 rounded-full border-2 border-indigo-400 bg-indigo-500 flex items-center justify-center">
                                    <div className="w-1.5 h-1.5 rounded-full bg-white" />
                                  </div>
                                ) : (
                                  <div className="w-4 h-4 rounded-full border border-zinc-600 bg-zinc-800" />
                                )}
                              </div>
                              <div className="truncate">
                                <span className="text-xs font-mono font-semibold text-zinc-200 block truncate">{m}</span>
                                <span className="text-[10px] text-zinc-500">Local model</span>
                              </div>
                            </div>

                            <div className="shrink-0 ml-2">
                              {isSelected ? (
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                                  Active
                                </span>
                              ) : (
                                <span className="text-[10px] text-zinc-400 hover:text-white font-medium">
                                  Select
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* 3. Custom Model on Disk (Optional) */}
                {customModelPath && (
                  <div
                    onClick={() => {
                      onSave({ customModelPath, whisperModel });
                      showGlobalToast(`Active model set to custom (${binaryStatus.customModelDetectedName || 'model'})`, 'success');
                    }}
                    className="p-3 rounded-xl border bg-purple-600/10 border-purple-500/50 shadow-md ring-1 ring-purple-500/30 space-y-1.5 cursor-pointer"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-2.5 truncate">
                        <div className="w-4 h-4 rounded-full border-2 border-purple-400 bg-purple-500 flex items-center justify-center shrink-0">
                          <div className="w-1.5 h-1.5 rounded-full bg-white" />
                        </div>
                        <div className="truncate">
                          <span className="text-xs font-mono font-bold text-white block truncate">
                            Custom: {binaryStatus.customModelDetectedName || customModelPath.replace(/^.*[\\/]/, '')}
                          </span>
                          <span className="text-[10px] font-mono text-zinc-400 block truncate" title={customModelPath}>
                            {customModelPath}
                          </span>
                        </div>
                      </div>

                      <div className="shrink-0 flex items-center space-x-2 ml-2" onClick={(e) => e.stopPropagation()}>
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-purple-500/20 text-purple-300 border border-purple-500/30">
                          Active
                        </span>
                        <button
                          type="button"
                          onClick={handleResetToDefaultModel}
                          className="text-[11px] text-red-400 hover:text-red-300 underline font-medium transition-colors"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Custom Model Folder Picker Section */}
              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => setShowCustomModelSection(!showCustomModelSection)}
                  className="text-[11px] text-zinc-400 hover:text-zinc-200 underline font-medium transition-colors flex items-center space-x-1"
                >
                  <span>{showCustomModelSection ? 'Hide Custom Model Browser' : '+ Use Custom Model from Folder...'}</span>
                </button>

                {showCustomModelSection && (
                  <div className="mt-2 p-3 rounded-xl bg-zinc-900/60 border border-white/5 space-y-2.5 animate-in fade-in duration-150">
                    <p className="text-[11px] text-zinc-400 leading-relaxed">
                      Select any folder containing a Faster-Whisper model on disk. Kaiko will auto-detect its name and set it as your active model.
                    </p>

                    <div className="flex items-center space-x-2">
                      <input
                        type="text"
                        readOnly
                        placeholder="Select custom model directory..."
                        value={customModelPath}
                        className="flex-1 px-3 py-1.5 rounded-lg bg-zinc-950 border border-white/10 text-xs font-mono text-zinc-200 truncate focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={handleBrowseCustomModel}
                        className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-white/10 text-xs font-medium transition-colors shrink-0"
                      >
                        <FolderOpen className="w-3.5 h-3.5 text-zinc-400" />
                        <span>Browse Folder</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Section: Application Updates */}
          <div className="space-y-3 pt-3 border-t border-white/10">
            <div>
              <label className="text-xs font-semibold text-zinc-200 uppercase tracking-wider flex items-center space-x-2">
                <RefreshCw className="w-3.5 h-3.5 text-zinc-400" />
                <span>Application Updates</span>
              </label>
              <p className="text-[11px] text-zinc-400">
                Manage update checking and installation from GitHub Releases without re-downloading or pulling through Git.
              </p>
            </div>

            <div className="space-y-2">
              {/* Toggle 1: Search updates on start */}
              <div className="flex items-center justify-between p-3 rounded-xl bg-zinc-900/60 border border-white/5">
                <div className="space-y-0.5 pr-3">
                  <span className="text-xs font-medium text-zinc-200">
                    Check for updates on startup
                  </span>
                  <p className="text-[11px] text-zinc-400">
                    Automatically check for new releases when launching the application
                  </p>
                </div>
                <ToggleSwitch
                  checked={checkForUpdatesOnStartup}
                  onChange={handleToggleCheckOnStartup}
                  label="Check for updates on startup"
                />
              </div>

              {/* Toggle 2: Auto-updates */}
              <div className="flex items-center justify-between p-3 rounded-xl bg-zinc-900/60 border border-white/5">
                <div className="space-y-0.5 pr-3">
                  <span className="text-xs font-medium text-zinc-200">
                    Auto-updates
                  </span>
                  <p className="text-[11px] text-zinc-400">
                    Automatically download available updates in the background
                  </p>
                </div>
                <ToggleSwitch
                  checked={autoUpdate}
                  onChange={handleToggleAutoUpdate}
                  label="Auto-updates"
                />
              </div>

              {/* Check for updates button & Status */}
              <div className="flex flex-col space-y-2.5 p-3.5 rounded-xl bg-zinc-900/60 border border-white/5">
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5 min-w-0 pr-3">
                    <span className="text-xs font-medium text-zinc-200">
                      Application Version
                    </span>
                    <p className="text-[11px] text-zinc-400 font-mono">
                      Current: <span className="text-zinc-200 font-semibold">v{appVersion}</span>
                      {updaterState.status === 'not-available' && ' — you are running the latest version'}
                      {updaterState.status === 'checking' && ' — checking for updates...'}
                      {updaterState.status === 'available' && ` — new version v${updaterState.updateInfo?.version || ''} available!`}
                      {updaterState.status === 'downloaded' && ` — v${updaterState.updateInfo?.version || ''} ready to install!`}
                    </p>
                  </div>

                  <div className="flex items-center space-x-2 shrink-0">
                    {updaterState.status === 'available' ? (
                      <button
                        type="button"
                        onClick={handleDownloadUpdate}
                        className="flex items-center space-x-1.5 px-3.5 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-xs font-medium transition-all shadow-sm"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>Update Now</span>
                      </button>
                    ) : updaterState.status === 'downloaded' ? (
                      <button
                        type="button"
                        onClick={handleInstallUpdate}
                        className="flex items-center space-x-1.5 px-3.5 py-1.5 rounded-lg bg-green-600 hover:bg-green-500 text-white text-xs font-medium transition-all shadow-sm"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        <span>Restart &amp; Install</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={handleCheckForUpdates}
                        disabled={updaterState.status === 'checking' || updaterState.status === 'downloading'}
                        className="flex items-center space-x-1.5 px-3.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-100 border border-white/10 text-xs font-medium transition-all shadow-sm"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${updaterState.status === 'checking' ? 'animate-spin text-purple-400' : ''}`} />
                        <span>{updaterState.status === 'checking' ? 'Checking...' : 'Check for Updates'}</span>
                      </button>
                    )}
                  </div>
                </div>

                {/* Downloading Progress Bar */}
                {updaterState.status === 'downloading' && (
                  <div className="space-y-1.5 pt-2 border-t border-white/5">
                    <div className="flex items-center justify-between text-xs text-zinc-300">
                      <span>Downloading update v{updaterState.updateInfo?.version || ''}...</span>
                      <span className="font-mono">{updaterDisplayPercent}%</span>
                    </div>
                    <div className="w-full h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-purple-500 to-indigo-500 transition-[width] duration-150 ease-out"
                        style={{ width: `${Math.max(2, Math.min(100, updaterDisplayPercent))}%` }}
                      />
                    </div>
                    {updaterState.downloadProgress && (
                      <div className="flex items-center justify-between text-[11px] text-zinc-500 font-mono">
                        <span>{formatFileSize(updaterState.downloadProgress.transferred)} / {formatFileSize(updaterState.downloadProgress.total)}</span>
                        <span>{formatFileSize(updaterState.downloadProgress.bytesPerSecond)}/s</span>
                      </div>
                    )}
                  </div>
                )}

                {/* Error message */}
                {updaterState.status === 'error' && updaterState.error && (
                  <div className="flex items-center justify-between p-2.5 rounded-lg bg-red-950/40 border border-red-500/30 text-xs text-red-200">
                    <div className="flex items-center space-x-2 min-w-0 pr-2">
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
            </div>
          </div>

          {/* Section: Data & Backup */}
          <div className="space-y-3 pt-3 border-t border-white/10">
            <div>
              <label className="text-xs font-semibold text-zinc-200 uppercase tracking-wider flex items-center space-x-2">
                <Database className="w-3.5 h-3.5 text-zinc-400" />
                <span>Data &amp; Backup</span>
              </label>
              <p className="text-[11px] text-zinc-400">
                Back up watch history, season rules and your list to Documents, and move your watchlist in or out.
              </p>
            </div>

            {/* Documents backup card */}
            <div className="space-y-2.5 rounded-xl bg-zinc-900/90 border border-white/10 p-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-zinc-200">Documents Backup</p>
                  {backupStatus?.path ? (
                    <p
                      className="mt-0.5 truncate font-mono text-[10px] text-zinc-500 select-all"
                      title={backupStatus.path}
                    >
                      {backupStatus.path}
                    </p>
                  ) : (
                    <p className="mt-0.5 text-[10px] text-zinc-500">No backup location reported yet</p>
                  )}
                  <p className="mt-0.5 text-[10px] text-zinc-500">
                    {backupStatus?.exists
                      ? `Last synced ${formatRelativeTime(backupStatus.lastSyncedAt) ?? 'unknown'}${
                          backupStatus.sizeBytes ? ` · ${formatFileSize(backupStatus.sizeBytes)}` : ''
                        }`
                      : 'No backup created yet'}
                  </p>
                </div>
                {backupStatus?.exists && (
                  <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-emerald-400 mt-0.5" />
                )}
              </div>

              {confirmRestore ? (
                <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-xl bg-red-950/40 border border-red-500/40 animate-in fade-in duration-150">
                  <div className="flex items-center space-x-2 text-xs text-red-200 min-w-0 flex-1">
                    <AlertTriangle className="w-3.5 h-3.5 text-red-400 shrink-0" />
                    <span className="truncate">
                      Restore backup over current data? Watch history, season rules and your list will be replaced.
                    </span>
                  </div>
                  <div className="flex items-center space-x-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => setConfirmRestore(false)}
                      disabled={dataBusy === 'restore'}
                      className="px-2.5 py-1 rounded-lg text-[11px] font-medium text-zinc-300 hover:text-white bg-zinc-800 hover:bg-zinc-700 transition-colors disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleRestoreConfirmed}
                      disabled={dataBusy === 'restore'}
                      className="px-2.5 py-1 rounded-lg text-[11px] font-bold text-white bg-red-600 hover:bg-red-500 transition-colors shadow-sm disabled:opacity-60"
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
                    className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-zinc-100 hover:bg-white text-zinc-900 text-xs font-bold transition-colors shadow-sm disabled:opacity-50"
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>{dataBusy === 'backup' ? 'Backing up…' : 'Backup now'}</span>
                  </button>
                  {restoreAvailable && (
                    <button
                      type="button"
                      onClick={() => setConfirmRestore(true)}
                      disabled={dataBusy !== null || !window.electronAPI?.restoreFromBackup}
                      className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-white/10 text-xs font-medium transition-colors disabled:opacity-50"
                    >
                      <RotateCcw className="w-3.5 h-3.5 text-zinc-400" />
                      <span>Restore from backup</span>
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Watchlist import / export card */}
            <div className="space-y-2.5 rounded-xl bg-zinc-900/90 border border-white/10 p-3.5">
              <p className="text-xs font-semibold text-zinc-200">Watchlist</p>
              <p className="text-[10px] text-zinc-500">
                Export your tracked titles as a full JSON snapshot or MAL-compatible XML, or import an existing list.
              </p>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleExportWatchlist('json')}
                  disabled={dataBusy !== null || !window.electronAPI?.exportWatchlist}
                  className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-white/10 text-xs font-medium transition-colors disabled:opacity-50"
                  title="Export the full watchlist (scores, progress, status) as JSON"
                >
                  <Download className="w-3.5 h-3.5 text-zinc-400" />
                  <span>JSON (full)</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleExportWatchlist('mal-xml')}
                  disabled={dataBusy !== null || !window.electronAPI?.exportWatchlist}
                  className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-white/10 text-xs font-medium transition-colors disabled:opacity-50"
                  title="Export as MyAnimeList-compatible XML"
                >
                  <Download className="w-3.5 h-3.5 text-zinc-400" />
                  <span>MAL XML</span>
                </button>
                <button
                  type="button"
                  onClick={handleImportWatchlist}
                  disabled={dataBusy !== null || !window.electronAPI?.importWatchlist}
                  className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-white/10 text-xs font-medium transition-colors disabled:opacity-50"
                  title="Import a previously exported JSON or MAL XML watchlist"
                >
                  <Upload className="w-3.5 h-3.5 text-zinc-400" />
                  <span>{dataBusy === 'import' ? 'Importing…' : 'Import Watchlist'}</span>
                </button>
              </div>
            </div>
          </div>

          {/* Section: P2P & Downloads */}
          <div className="space-y-3 pt-3 border-t border-white/10">
            <div>
              <label className="text-xs font-semibold text-zinc-200 uppercase tracking-wider flex items-center space-x-2">
                <Share2 className="w-3.5 h-3.5 text-zinc-400" />
                <span>P2P &amp; Downloads</span>
              </label>
              <p className="text-[11px] text-zinc-400">
                BitTorrent engine with speed limits and your own RSS/Torznab indexers.
              </p>
            </div>

            {/* Master engine toggle card */}
            <div className="flex items-center justify-between gap-3 rounded-xl bg-zinc-900/90 border border-white/10 p-3.5">
              <div className="min-w-0">
                <p className="flex items-center space-x-2 text-xs font-semibold text-zinc-200">
                  <span>P2P / BitTorrent engine</span>
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                      p2pState === null ? 'bg-amber-400' : p2pState.enabled ? 'bg-emerald-400' : 'bg-zinc-600'
                    }`}
                  />
                </p>
                <p className="mt-0.5 text-[10px] text-zinc-500">
                  {p2pState === null
                    ? 'Checking engine state…'
                    : p2pState.enabled
                    ? 'On — torrents are downloaded and seeded via your own indexers.'
                    : 'Off — no torrents are downloaded or shared.'}
                </p>
              </div>
              <ToggleSwitch
                checked={Boolean(p2pState?.enabled)}
                onChange={handleToggleP2pEngine}
                disabled={p2pBusy || p2pState === null || !window.electronAPI?.enableP2p}
                label={p2pState?.enabled ? 'Disable P2P engine' : 'Enable P2P engine'}
              />
            </div>

            <div className="space-y-2 rounded-xl bg-zinc-900/90 border border-white/10 p-3.5">
              <div>
                <p className="text-xs font-semibold text-zinc-200">Release selection</p>
                <p className="mt-0.5 text-[10px] text-zinc-500">
                  Automatic picks the highest-ranked match by language, title accuracy, video quality and seeders.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {([
                  ['automatic', 'Automatic'],
                  ['manual', 'Choose manually'],
                ] as const).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => {
                      setReleaseSelectionMode(mode);
                      onSave({ releaseSelectionMode: mode });
                    }}
                    className={`rounded-lg border px-3 py-2 text-xs font-semibold transition-colors ${
                      releaseSelectionMode === mode
                        ? 'border-red-500/50 bg-red-500/15 text-red-200'
                        : 'border-white/10 bg-zinc-950/50 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                    }`}
                  >
                    {label}{mode === 'automatic' ? ' (default)' : ''}
                  </button>
                ))}
              </div>
              <p className="pt-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Automatic search languages</p>
              {([
                ['Audio', preferredAudioLanguages, setPreferredAudioLanguages, 'preferredTorrentAudioLanguages'],
                ['Subtitles', preferredSubtitleLanguages, setPreferredSubtitleLanguages, 'preferredTorrentSubtitleLanguages'],
              ] as const).map(([label, selected, setSelected, settingKey]) => (
                <div key={label} className="space-y-1.5">
                  <p className="text-[10px] text-zinc-400">{label}</p>
                  <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-5">
                    {TORRENT_LANGUAGES.map((language) => {
                      const checked = selected.includes(language.code);
                      return <label key={language.code} className={`flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1.5 text-[10px] transition ${checked ? 'border-rose-400/30 bg-rose-500/10 text-rose-100' : 'border-white/5 bg-zinc-950/40 text-zinc-400 hover:text-zinc-200'}`}>
                        <input type="checkbox" checked={checked} onChange={() => {
                          const next = checked ? selected.filter((code) => code !== language.code) : [...selected, language.code];
                          setSelected(next);
                          onSave({ [settingKey]: next });
                        }} className="accent-rose-500" />
                        {language.label}
                      </label>;
                    })}
                  </div>
                </div>
              ))}
              <p className="text-[10px] text-zinc-500">Manual search shows all releases; use its audio and subtitle filters to narrow results.</p>
            </div>

            {p2pState?.enabled ? (
              <>
                {/* Speed & Limits card */}
                <div className="space-y-2.5 rounded-xl bg-zinc-900/90 border border-white/10 p-3.5">
                  <p className="flex items-center space-x-2 text-xs font-semibold text-zinc-200">
                    <Gauge className="w-3.5 h-3.5 text-zinc-400" />
                    <span>Speed &amp; Limits</span>
                  </p>
                  <div className="grid grid-cols-2 gap-2.5">
                    <div className="space-y-1">
                      <label className="text-[10px] font-medium text-zinc-400">Max simultaneous downloads</label>
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
                        className="w-full px-3 py-2 rounded-lg bg-zinc-950/70 border border-white/10 text-xs text-zinc-200 focus:outline-none focus:border-zinc-500"
                      />
                      <p className="text-[10px] text-zinc-500">Between 1 and 6 torrents at once.</p>
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] font-medium text-zinc-400">Seed after complete</label>
                      <select
                        value={limitSeedMinutes}
                        onChange={(e) => handleSeedMinutesChange(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg bg-zinc-950/70 border border-white/10 text-xs text-zinc-200 focus:outline-none focus:border-zinc-500 cursor-pointer"
                      >
                        <option value="0">Stop immediately</option>
                        <option value="15">15 minutes</option>
                        <option value="60">1 hour</option>
                        <option value="480">8 hours</option>
                      </select>
                      <p className="text-[10px] text-zinc-500">How long to keep seeding once done.</p>
                    </div>
                  </div>
                  <p className="text-[10px] text-zinc-500">Changes apply live to the torrent engine.</p>
                </div>
                <div className="space-y-2.5 rounded-xl bg-zinc-900/90 border border-white/10 p-3.5">
                  <div className="flex items-center justify-between">
                    <p className="flex items-center space-x-2 text-xs font-semibold text-zinc-200">
                      <Rss className="w-3.5 h-3.5 text-zinc-400" />
                      <span>Indexers (BYOC)</span>
                    </p>
                    <span className="text-[10px] text-zinc-500">{providersDraft.length} configured</span>
                  </div>

                  {providersDraft.length === 0 ? (
                    <div className="p-3 rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 text-center">
                      <p className="text-[11px] text-zinc-500">No indexers configured yet. Add one below or import a config file.</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {providersDraft.map((provider, index) => (
                        <div
                          key={provider.id || `provider-row-${index}`}
                          className="space-y-1.5 rounded-xl bg-zinc-950/70 border border-white/10 p-2.5"
                        >
                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              value={provider.name}
                              onChange={(e) => handleProviderField(index, { name: e.target.value })}
                              placeholder="Indexer name"
                              className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-white/10 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
                            />
                            <select
                              value={provider.type}
                              onChange={(e) =>
                                handleProviderField(index, { type: e.target.value as RssProvider['type'] })
                              }
                              className="px-2 py-1.5 rounded-lg bg-zinc-900 border border-white/10 text-xs text-zinc-200 focus:outline-none focus:border-zinc-500 cursor-pointer shrink-0"
                              title="Feed type"
                            >
                              <option value="rss">RSS</option>
                              <option value="torznab">Torznab</option>
                            </select>
                            <input
                              type="checkbox"
                              checked={provider.enabled}
                              onChange={(e) => handleProviderField(index, { enabled: e.target.checked })}
                              className="w-4 h-4 rounded border-zinc-700 bg-zinc-900 text-red-600 focus:ring-0 focus:ring-offset-0 cursor-pointer accent-red-600 shrink-0"
                              title="Enabled"
                              aria-label={`${provider.name || 'Provider'} enabled`}
                            />
                            <button
                              type="button"
                              onClick={() => handleRemoveProvider(index)}
                              className="p-1 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-colors shrink-0"
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
                            className="w-full px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-white/10 text-[11px] font-mono text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 select-all"
                          />
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={handleAddProvider}
                      className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-100 border border-white/10 text-xs font-medium transition-all shadow-sm"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Add provider</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => providerImportRef.current?.click()}
                      disabled={providersBusy}
                      className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-white/10 text-xs font-medium transition-colors disabled:opacity-50"
                      title="Import providers from a JSON config file"
                    >
                      <Upload className="w-3.5 h-3.5 text-zinc-400" />
                      <span>Import config</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleExportProviders}
                      className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-white/10 text-xs font-medium transition-colors"
                      title="Export providers to animecenter-providers.json"
                    >
                      <Download className="w-3.5 h-3.5 text-zinc-400" />
                      <span>Export config</span>
                    </button>
                    <div className="flex-1" />
                    <button
                      type="button"
                      onClick={handleSaveProviders}
                      disabled={providersBusy}
                      className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-zinc-100 hover:bg-white text-zinc-900 text-xs font-bold transition-colors shadow-sm disabled:opacity-50"
                    >
                      <Save className="w-3.5 h-3.5" />
                      <span>{providersBusy ? 'Saving…' : 'Save providers'}</span>
                    </button>
                  </div>

                  <p className="text-[10px] text-zinc-500">No indexers are bundled. You bring your own RSS/Torznab sources.</p>
                </div>

                {/* Hidden input backing the Import config button */}
                <input
                  ref={providerImportRef}
                  type="file"
                  accept=".json,application/json"
                  className="hidden"
                  onChange={handleImportProvidersFile}
                />
              </>
            ) : (
              <p className="text-[10px] text-zinc-500 px-1">
                The engine is off. Enable it above to configure speed limits and indexers.
                No indexers are bundled — you bring your own RSS/Torznab sources.
              </p>
            )}
          </div>
        </div>

        {/* Footer Actions */}
        <div className="px-6 py-4 border-t border-white/10 flex items-center justify-between shrink-0 bg-[#141418]">
          <div className="flex items-center space-x-3">
            <button
              type="button"
              onClick={handleResetDefaults}
              className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800/80 text-xs font-medium transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Reset tool paths</span>
            </button>
            <span className="text-[11px] text-zinc-500 font-mono select-none">
              v{appVersion}
            </span>
          </div>

          <button
            type="button"
            onClick={handleClose}
            className="px-5 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-100 font-medium text-xs border border-white/10 transition-colors shadow-sm"
          >
            Done
          </button>
        </div>

        {/* P2P consent overlay (renders above this modal; handles its own Escape/backdrop) */}
        {showP2pConsent && (
          <P2pConsentModal
            onAccept={handleP2pConsentAccept}
            onCancel={() => setShowP2pConsent(false)}
          />
        )}
      </div>
    </div>
  ), document.body);
};
