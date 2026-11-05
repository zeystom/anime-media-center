import React, { useState, useEffect } from 'react';
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
} from 'lucide-react';
import { AppSettings } from '../types';
import { showGlobalToast } from './Toast';
import { formatFileSize } from '../utils/format';

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
  const [hideDownloadingAnime, setHideDownloadingAnime] = useState<boolean>(
    settings.hideDownloadingAnime ?? false
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
      setHideDownloadingAnime(settings.hideDownloadingAnime ?? false);

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

  // Handle Escape key to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        handleClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, ffmpegPath, whisperPath, settings, onClose]);

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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 animate-in fade-in duration-150"
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
                  Add directories across different drives (e.g. D:\films, E:\Anime). All folders will be scanned together.
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

            {/* Filter option: hide downloading torrents */}
            <label className="flex items-center space-x-2.5 pt-1.5 text-xs text-zinc-300 hover:text-zinc-100 cursor-pointer select-none transition-colors">
              <input
                type="checkbox"
                checked={hideDownloadingAnime}
                onChange={(e) => {
                  const checked = e.target.checked;
                  setHideDownloadingAnime(checked);
                  onSave({ hideDownloadingAnime: checked });
                }}
                className="w-4 h-4 rounded border-zinc-700 bg-zinc-900 text-red-600 focus:ring-0 focus:ring-offset-0 cursor-pointer accent-red-600"
              />
              <span>Hide downloading / incomplete torrent releases from library</span>
            </label>
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
      </div>
    </div>
  );
};
