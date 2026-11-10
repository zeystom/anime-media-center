import React, { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Sparkles, Download, RefreshCw, X, ArrowUpCircle } from 'lucide-react';
import { UpdateInfoPayload, UpdateProgressPayload, UpdaterState } from '../types';
import { showGlobalToast } from './Toast';
import { formatFileSize } from '../utils/format';
import { formatReleaseNotesHtml } from '../utils/releaseNotes';

interface UpdatePromptModalProps {
  isOpen: boolean;
  onClose: () => void;
  updateInfo: UpdateInfoPayload;
  appVersion: string;
  onUpdateSettings?: (settings: Partial<import('../types').AppSettings>) => void | Promise<void>;
  hideDontShowAgain?: boolean;
}

export const UpdatePromptModal: React.FC<UpdatePromptModalProps> = ({
  isOpen,
  onClose,
  updateInfo,
  appVersion,
  onUpdateSettings,
  hideDontShowAgain = false,
}) => {
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [isDownloaded, setIsDownloaded] = useState(false);
  const [progress, setProgress] = useState<UpdateProgressPayload | null>(null);
  const [displayPercent, setDisplayPercent] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [asyncReleaseNotes, setAsyncReleaseNotes] = useState<string | null>(updateInfo.releaseNotes || null);

  useEffect(() => {
    if (updateInfo.releaseNotes) {
      setAsyncReleaseNotes(updateInfo.releaseNotes);
      return;
    }
    if (updateInfo.version && window.electronAPI?.getReleaseNotes) {
      window.electronAPI
        .getReleaseNotes(updateInfo.version)
        .then((notes) => {
          if (notes) setAsyncReleaseNotes(notes);
        })
        .catch(() => {});
    }
  }, [updateInfo.version, updateInfo.releaseNotes]);

  const formattedReleaseNotes = useMemo(() => {
    const raw = asyncReleaseNotes || updateInfo.releaseNotes;
    return raw ? formatReleaseNotesHtml(raw) : '';
  }, [asyncReleaseNotes, updateInfo.releaseNotes]);

  const handleReleaseNotesClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as HTMLElement).closest('a');
    if (anchor && anchor.href) {
      e.preventDefault();
      e.stopPropagation();
      if (window.electronAPI?.openExternalUrl) {
        window.electronAPI.openExternalUrl(anchor.href);
      }
    }
  };

  useEffect(() => {
    if (progress?.percent !== undefined && progress.percent !== null) {
      setDisplayPercent((prev) => Math.max(prev, Math.round(progress.percent)));
    }
  }, [progress]);

  useEffect(() => {
    if (!isOpen) return;
    const api = window.electronAPI;
    if (!api) return;

    if (typeof api.getUpdaterState === 'function') {
      api.getUpdaterState().then((state) => {
        if (!state) return;
        if (state.status === 'downloading') {
          setIsDownloading(true);
          if (state.downloadProgress) {
            setProgress(state.downloadProgress);
            if (typeof state.downloadProgress.percent === 'number') {
              setDisplayPercent(Math.round(state.downloadProgress.percent));
            }
          }
        } else if (state.status === 'downloaded') {
          setIsDownloading(false);
          setIsDownloaded(true);
        } else if (state.status === 'error') {
          setIsDownloading(false);
          setError(state.error || 'Failed to download update');
        }
      }).catch(() => {});
    }

    if (typeof api.onUpdaterStateChanged === 'function') {
      const unsub = api.onUpdaterStateChanged((state: UpdaterState) => {
        if (state.status === 'downloading') {
          setIsDownloading(true);
          if (state.downloadProgress) {
            setProgress(state.downloadProgress);
            if (typeof state.downloadProgress.percent === 'number') {
              setDisplayPercent((prev) => Math.max(prev, Math.round(state.downloadProgress!.percent)));
            }
          }
        } else if (state.status === 'downloaded') {
          setIsDownloading(false);
          setIsDownloaded(true);
        } else if (state.status === 'error') {
          setIsDownloading(false);
          setError(state.error || 'Failed to download update');
        }
      });

      return () => {
        unsub();
      };
    }
  }, [isOpen]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        e.stopPropagation();
        handleDismiss();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, dontShowAgain]);

  if (!isOpen) return null;

  const handleDismiss = async () => {
    if (!hideDontShowAgain && dontShowAgain) {
      try {
        const updaterPayload = {
          checkForUpdatesOnStartup: false,
          autoUpdate: false,
        };
        if (onUpdateSettings) {
          await onUpdateSettings(updaterPayload);
        } else if (window.electronAPI?.updateSettings) {
          await window.electronAPI.updateSettings(updaterPayload);
        }
        showGlobalToast('Auto-updates disabled', 'info');
      } catch (err) {
        console.error('[Updater] Failed to update settings on dismiss:', err);
      }
    }
    onClose();
  };

  const handleStartUpdate = async () => {
    if (dontShowAgain) {
      try {
        const updaterPayload = {
          checkForUpdatesOnStartup: false,
          autoUpdate: false,
        };
        if (onUpdateSettings) {
          await onUpdateSettings(updaterPayload);
        } else if (window.electronAPI?.updateSettings) {
          await window.electronAPI.updateSettings(updaterPayload);
        }
      } catch (err) {
        console.error('[Updater] Failed to save settings:', err);
      }
    }

    setDisplayPercent(0);
    setIsDownloading(true);
    setError(null);
    try {
      const res = await window.electronAPI.downloadUpdate();
      if (!res.success && res.error) {
        setError(res.error);
        setIsDownloading(false);
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to start download');
      setIsDownloading(false);
    }
  };

  const handleInstallNow = () => {
    window.electronAPI.installUpdate();
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/80 animate-in fade-in duration-150"
      onClick={handleDismiss}
    >
      <div
        role="dialog"
        aria-modal="true"
        data-modal="true"
        aria-labelledby="update-prompt-title"
        className="w-full max-w-lg flex flex-col bg-[#141418] border border-white/10 rounded-2xl text-zinc-100 shadow-2xl animate-in zoom-in-95 duration-150 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 shrink-0">
          <div className="flex items-center space-x-3">
            <div className="w-9 h-9 rounded-xl bg-purple-500/20 border border-purple-500/30 flex items-center justify-center text-purple-400">
              <Sparkles className="w-5 h-5 text-purple-400" />
            </div>
            <div>
              <h3 id="update-prompt-title" className="text-sm font-bold text-white tracking-tight">
                Update Available
              </h3>
              <p className="text-xs text-zinc-400">
                Kaiko v{updateInfo.version} (current: v{appVersion})
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={handleDismiss}
            aria-label="Close update dialog"
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6 space-y-4">
          {isDownloaded ? (
            <div className="p-4 rounded-xl bg-green-950/30 border border-green-500/30 space-y-2">
              <div className="flex items-center space-x-2 text-green-300 font-medium text-xs">
                <RefreshCw className="w-4 h-4 text-green-400 shrink-0" />
                <span>Update downloaded successfully!</span>
              </div>
              <p className="text-xs text-zinc-300">
                Restart the application to apply version <span className="font-semibold text-white">v{updateInfo.version}</span>.
              </p>
            </div>
          ) : isDownloading ? (
            <div className="space-y-3 p-4 rounded-xl bg-zinc-900/50 border border-white/5">
              <div className="flex items-center justify-between text-xs text-zinc-200">
                <span className="flex items-center space-x-2">
                  <Download className="w-4 h-4 text-purple-400 animate-pulse" />
                  <span>Downloading update v{updateInfo.version}...</span>
                </span>
                <span className="font-mono font-semibold text-purple-300">
                  {displayPercent}%
                </span>
              </div>

              <div className="w-full h-2 rounded-full bg-zinc-800 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-purple-500 to-indigo-500 transition-[width] duration-150 ease-out"
                  style={{ width: `${Math.max(2, Math.min(100, displayPercent))}%` }}
                />
              </div>

              {progress && (
                <div className="flex items-center justify-between text-[11px] text-zinc-400 font-mono">
                  <span>
                    {formatFileSize(progress.transferred)} / {formatFileSize(progress.total)}
                  </span>
                  <span>{formatFileSize(progress.bytesPerSecond)}/s</span>
                </div>
              )}
            </div>
          ) : (
            <>
              <p className="text-xs text-zinc-300 leading-relaxed">
                A new version of Kaiko is available (<span className="font-semibold text-white">v{updateInfo.version}</span>).
                You can update now directly without re-downloading through Git.
              </p>

              <div className="space-y-1.5">
                <span className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">
                  What's New in v{updateInfo.version}:
                </span>
                {formattedReleaseNotes ? (
                  <div
                    className="release-notes-content p-3.5 rounded-xl bg-zinc-900/60 border border-white/5 max-h-56 overflow-y-auto text-xs text-zinc-300 font-sans"
                    dangerouslySetInnerHTML={{ __html: formattedReleaseNotes }}
                    onClick={handleReleaseNotesClick}
                  />
                ) : (
                  <div className="p-3.5 rounded-xl bg-zinc-900/40 border border-white/5 text-xs text-zinc-400 font-sans animate-pulse">
                    Loading release notes...
                  </div>
                )}
              </div>

              {error && (
                <div className="p-3 rounded-xl bg-red-950/40 border border-red-500/40 text-xs text-red-200">
                  {error}
                </div>
              )}

              {/* Checkbox: "Don't show again and disable auto-updates" */}
              {!hideDontShowAgain && (
                <label className="flex items-center space-x-2.5 pt-2 cursor-pointer select-none group">
                  <input
                    type="checkbox"
                    checked={dontShowAgain}
                    onChange={(e) => setDontShowAgain(e.target.checked)}
                    className="w-4 h-4 rounded border-zinc-700 bg-zinc-800 text-purple-600 focus:ring-0 focus:ring-offset-0 cursor-pointer"
                  />
                  <span className="text-xs text-zinc-300 group-hover:text-white transition-colors">
                    Don't show again and disable auto-updates
                  </span>
                </label>
              )}
            </>
          )}
        </div>

        {/* Footer Actions */}
        <div className="px-6 py-4 border-t border-white/10 flex items-center justify-end space-x-3 shrink-0 bg-[#141418]">
          {isDownloaded ? (
            <>
              <button
                type="button"
                onClick={handleDismiss}
                className="px-4 py-2 rounded-xl text-xs font-medium text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
              >
                Later
              </button>
              <button
                type="button"
                onClick={handleInstallNow}
                className="flex items-center space-x-2 px-5 py-2 rounded-xl bg-green-600 hover:bg-green-500 text-white font-medium text-xs shadow-lg shadow-green-600/20 transition-all"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Restart &amp; Install</span>
              </button>
            </>
          ) : isDownloading ? (
            <button
              type="button"
              onClick={handleDismiss}
              className="px-4 py-2 rounded-xl text-xs font-medium text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
            >
              Minimize (downloading in background)
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={handleDismiss}
                className="px-4 py-2 rounded-xl text-xs font-medium text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
              >
                Later
              </button>
              <button
                type="button"
                onClick={handleStartUpdate}
                className="flex items-center space-x-2 px-5 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-medium text-xs shadow-lg shadow-purple-600/20 transition-all"
              >
                <ArrowUpCircle className="w-3.5 h-3.5" />
                <span>Update Now</span>
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};
