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
} from 'lucide-react';
import { AppSettings } from '../types';
import type { P2pState, RssProvider } from '../types';
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

  const [binaryStatus, setBinaryStatus] = useState<{
    ffmpegExists: boolean;
    whisperExists: boolean;
  }>({
    ffmpegExists: false,
    whisperExists: false,
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

  useEffect(() => {
    if (isOpen) {
      setFfmpegPath(settings.ffmpegPath);
      setWhisperPath(settings.whisperPath);
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

      // Check existence of external binaries
      window.electronAPI
        .checkBinaries({ ffmpegPath: settings.ffmpegPath, whisperPath: settings.whisperPath })
        .then((status) => {
          setBinaryStatus(status);
        })
        .catch(() => {});
    }
  }, [isOpen, settings]);

  // Live status check when user edits paths
  useEffect(() => {
    if (isOpen) {
      window.electronAPI
        .checkBinaries({ ffmpegPath, whisperPath })
        .then((status) => {
          setBinaryStatus(status);
        })
        .catch(() => {});
    }
  }, [isOpen, ffmpegPath, whisperPath]);

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

  // Save any pending uncommitted path changes before closing
  const handleClose = () => {
    if (ffmpegPath !== settings.ffmpegPath || whisperPath !== settings.whisperPath) {
      onSave({
        ...(ffmpegPath !== settings.ffmpegPath ? { ffmpegPath } : {}),
        ...(whisperPath !== settings.whisperPath ? { whisperPath } : {}),
      });
    }
    onClose();
  };

  // Handle Escape key to close (the P2P consent modal handles its own Escape)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        if (showP2pConsent) return;
        handleClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
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

  const handleBrowseFfmpeg = async () => {
    const file = await window.electronAPI.browseFile({
      title: 'Select FFmpeg Executable (ffmpeg.exe)',
      defaultPath: ffmpegPath || undefined,
      extensions: ['exe'],
    });
    if (file) {
      setFfmpegPath(file);
      onSave({ ffmpegPath: file });
    }
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

  const handleFfmpegChange = (val: string) => {
    setFfmpegPath(val);
  };

  const handleFfmpegBlur = () => {
    if (ffmpegPath !== settings.ffmpegPath) {
      onSave({ ffmpegPath });
    }
  };

  const handleFfmpegKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      (e.target as HTMLInputElement).blur();
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

          <button
            type="button"
            onClick={handleClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
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

          {/* Section: External Tools & AI Engine */}
          <div className="space-y-3 pt-3 border-t border-white/10">
            <div className="flex items-center justify-between">
              <div>
                <label className="text-xs font-semibold text-zinc-200 uppercase tracking-wider flex items-center space-x-2">
                  <Cpu className="w-3.5 h-3.5 text-zinc-400" />
                  <span>External Tools & AI Engine</span>
                </label>
                <p className="text-[11px] text-zinc-400">
                  Required for video transcoding, keyframe seeking, and AI dubtitle transcription.
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
                  <span className="text-xs font-bold text-zinc-200">How to set up Faster-Whisper & FFmpeg</span>
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
                      Download the Windows .7z archive from the Faster-Whisper-XXL release, extract anywhere, and click <strong>Browse</strong>. If FFmpeg is not bundled, configure ffmpeg.exe separately.
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
                  <span className="text-zinc-300 font-medium">Model notice:</span> The <code>large-v3-turbo</code> model (~1.5 GB) downloads automatically on the first transcription.
                </div>
              </div>
            )}

            {/* FFmpeg Binary Path */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-300">FFmpeg Executable (ffmpeg.exe)</label>
              <div className="flex items-center space-x-2">
                <div className="relative flex-1">
                  <input
                    type="text"
                    placeholder="Auto-detected or specify path to ffmpeg.exe"
                    value={ffmpegPath}
                    onChange={(e) => handleFfmpegChange(e.target.value)}
                    onBlur={handleFfmpegBlur}
                    onKeyDown={handleFfmpegKeyDown}
                    className="w-full pl-3 pr-24 py-2 rounded-lg bg-zinc-900 border border-white/10 text-xs font-mono text-zinc-200 focus:outline-none focus:border-zinc-500"
                  />
                  <div className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center space-x-1 pointer-events-none select-none">
                    {binaryStatus.ffmpegExists ? (
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
                  onClick={handleBrowseFfmpeg}
                  className="flex items-center space-x-1.5 px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-white/10 text-xs font-medium transition-colors shrink-0"
                >
                  <FolderOpen className="w-3.5 h-3.5 text-zinc-400" />
                  <span>Browse</span>
                </button>
              </div>
            </div>

            {/* Faster-Whisper Binary Path */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-zinc-300">
                Faster-Whisper-XXL Executable (faster-whisper-xxl.exe)
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
          <button
            type="button"
            onClick={handleResetDefaults}
            className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800/80 text-xs font-medium transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset tool paths</span>
          </button>

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
