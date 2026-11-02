import React, { useState, useEffect } from 'react';
import {
  X,
  Settings as SettingsIcon,
  Save,
  RotateCcw,
  Plus,
  Trash2,
  Folder,
  FolderOpen,
  RefreshCw,
  ExternalLink,
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
  Cpu,
} from 'lucide-react';
import { AppSettings } from '../types';

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
  const [subtitlesFontSize, setSubtitlesFontSize] = useState(settings.subtitlesFontSize);
  const [subtitlesOutline, setSubtitlesOutline] = useState(settings.subtitlesOutline);
  const [autoPlayNext, setAutoPlayNext] = useState(settings.autoPlayNext);

  const [binaryStatus, setBinaryStatus] = useState<{
    ffmpegExists: boolean;
    whisperExists: boolean;
    modelExists: boolean;
    modelName: string;
  }>({
    ffmpegExists: false,
    whisperExists: false,
    modelExists: false,
    modelName: 'large-v3-turbo',
  });

  const [isDetecting, setIsDetecting] = useState(false);
  const [detectNotice, setDetectNotice] = useState<string | null>(null);
  const [showSetupGuide, setShowSetupGuide] = useState(false);

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
      setSubtitlesFontSize(settings.subtitlesFontSize);
      setSubtitlesOutline(settings.subtitlesOutline);
      setAutoPlayNext(settings.autoPlayNext);

      // Check existence of external binaries
      window.electronAPI
        .checkBinaries({ ffmpegPath: settings.ffmpegPath, whisperPath: settings.whisperPath })
        .then((status) => {
          setBinaryStatus(status);
          if (!status.whisperExists || !status.ffmpegExists) {
            setShowSetupGuide(true);
          }
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

  if (!isOpen) return null;

  const handleAddFolder = async () => {
    const dir = await window.electronAPI.browseFolder();
    if (dir) {
      if (!libraryFolders.some((f) => f.toLowerCase() === dir.toLowerCase())) {
        setLibraryFolders((prev) => [...prev, dir]);
      }
    }
  };

  const handleRemoveFolder = (indexToRemove: number) => {
    setLibraryFolders((prev) => prev.filter((_, idx) => idx !== indexToRemove));
  };

  const handleBrowseFfmpeg = async () => {
    const file = await window.electronAPI.browseFile({
      title: 'Select FFmpeg Executable (ffmpeg.exe)',
      defaultPath: ffmpegPath || undefined,
      extensions: ['exe'],
    });
    if (file) {
      setFfmpegPath(file);
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
    }
  };

  const handleAutoDetect = async () => {
    setIsDetecting(true);
    try {
      const detected = await window.electronAPI.autoDetectBinaries();
      if (detected.ffmpegPath) setFfmpegPath(detected.ffmpegPath);
      if (detected.whisperPath) setWhisperPath(detected.whisperPath);

      const status = await window.electronAPI.checkBinaries({
        ffmpegPath: detected.ffmpegPath,
        whisperPath: detected.whisperPath,
      });
      setBinaryStatus(status);

      if (status.ffmpegExists && status.whisperExists) {
        setDetectNotice('Auto-detection successful! Both FFmpeg and Faster-Whisper located.');
      } else if (status.ffmpegExists || status.whisperExists) {
        setDetectNotice('Partially detected. Please configure the remaining binary below.');
      } else {
        setDetectNotice('No standard installations found in PATH or Subtitle Edit. See Setup Guide below.');
      }
      setTimeout(() => setDetectNotice(null), 4000);
    } catch {
      setDetectNotice('Error during auto-detection.');
      setTimeout(() => setDetectNotice(null), 3000);
    } finally {
      setIsDetecting(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      ffmpegPath,
      whisperPath,
      libraryFolders,
      defaultLibraryRoot: libraryFolders[0] || '',
      subtitlesFontSize,
      subtitlesOutline,
      autoPlayNext,
    });
    onClose();
  };

  const handleResetDefaults = async () => {
    setIsDetecting(true);
    try {
      const detected = await window.electronAPI.autoDetectBinaries();
      setFfmpegPath(detected.ffmpegPath || '');
      setWhisperPath(detected.whisperPath || '');
      setSubtitlesFontSize(28);
      setSubtitlesOutline(true);
      setAutoPlayNext(true);
    } finally {
      setIsDetecting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 animate-in fade-in duration-150">
      <div
        className="w-full max-w-2xl max-h-[90vh] flex flex-col bg-[#141418] border border-zinc-700/80 rounded-2xl text-zinc-100 shadow-2xl animate-in zoom-in-95 duration-150 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-6 pb-4 border-b border-zinc-800 shrink-0">
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 rounded-lg bg-zinc-800 flex items-center justify-center text-zinc-300">
              <SettingsIcon className="w-4 h-4 text-indigo-400" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white tracking-tight">System & Player Settings</h3>
              <p className="text-xs text-zinc-400">Configure media folders, Whisper AI speech-to-text, and playback preferences</p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable Form Body */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* Notification banner */}
          {detectNotice && (
            <div className="p-3 rounded-xl bg-indigo-950/60 border border-indigo-500/40 text-indigo-200 text-xs flex items-center space-x-2 animate-in fade-in duration-200">
              <CheckCircle2 className="w-4 h-4 text-indigo-400 shrink-0" />
              <span>{detectNotice}</span>
            </div>
          )}

          {/* Multi-Folder Anime Library Roots */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <label className="text-xs font-bold text-zinc-200 uppercase tracking-wider flex items-center space-x-2">
                  <Folder className="w-3.5 h-3.5 text-amber-400" />
                  <span>Anime Media Folders ({libraryFolders.length})</span>
                </label>
                <p className="text-[11px] text-zinc-400">
                  Add directories across different drives (e.g. D:\films, E:\Anime). All folders will be scanned together.
                </p>
              </div>

              <button
                type="button"
                onClick={handleAddFolder}
                className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-red-600/90 hover:bg-red-500 text-white text-xs font-semibold shadow-md shadow-red-600/20 transition-all hover:scale-[1.02] active:scale-[0.98]"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Folder</span>
              </button>
            </div>

            {/* Folder List */}
            <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
              {libraryFolders.length === 0 ? (
                <div className="p-3.5 rounded-xl border border-dashed border-zinc-800 bg-zinc-900/40 text-center">
                  <p className="text-xs text-zinc-500">No media folders added. Click "+ Add Folder" to choose a directory.</p>
                </div>
              ) : (
                libraryFolders.map((folder, index) => (
                  <div
                    key={`${folder}-${index}`}
                    className="flex items-center justify-between gap-3 px-3 py-2 rounded-xl bg-zinc-900/90 border border-zinc-800/90 hover:border-zinc-700/80 transition-colors group"
                  >
                    <div className="flex items-center space-x-2.5 min-w-0 flex-1">
                      <Folder className="w-4 h-4 text-amber-400/90 shrink-0" />
                      <span className="font-mono text-xs text-zinc-200 truncate select-all" title={folder}>
                        {folder}
                      </span>
                      {index === 0 && (
                        <span className="text-[9px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700/60 shrink-0">
                          Primary
                        </span>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() => handleRemoveFolder(index)}
                      className="p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-colors shrink-0"
                      title="Remove folder from library"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* External Binaries & Whisper AI Engine */}
          <div className="space-y-3 pt-3 border-t border-zinc-800/80">
            <div className="flex items-center justify-between">
              <div>
                <label className="text-xs font-bold text-zinc-200 uppercase tracking-wider flex items-center space-x-2">
                  <Cpu className="w-3.5 h-3.5 text-indigo-400" />
                  <span>External Tools & AI Engine</span>
                </label>
                <p className="text-[11px] text-zinc-400">
                  Required for video transcoding, keyframe seeking, and AI dubtitle transcription.
                </p>
              </div>

              <div className="flex items-center space-x-2">
                <button
                  type="button"
                  onClick={() => setShowSetupGuide(!showSetupGuide)}
                  className="flex items-center space-x-1 px-2.5 py-1 rounded-lg text-[11px] font-medium text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
                >
                  <HelpCircle className="w-3.5 h-3.5 text-indigo-400" />
                  <span>{showSetupGuide ? 'Hide Guide' : 'Setup Guide'}</span>
                </button>

                <button
                  type="button"
                  onClick={handleAutoDetect}
                  disabled={isDetecting}
                  className="flex items-center space-x-1.5 px-3 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 hover:text-white text-xs font-medium border border-zinc-700/70 transition-all disabled:opacity-50"
                  title="Scan PATH and Subtitle Edit installations"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isDetecting ? 'animate-spin text-indigo-400' : ''}`} />
                  <span>Auto-Detect</span>
                </button>
              </div>
            </div>

            {/* FFmpeg Binary Path */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-zinc-300">FFmpeg Executable (ffmpeg.exe)</label>
                {binaryStatus.ffmpegExists ? (
                  <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                    Found
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20">
                    Not Found
                  </span>
                )}
              </div>
              <div className="flex items-center space-x-2">
                <input
                  type="text"
                  placeholder="Auto-detected or specify path to ffmpeg.exe"
                  value={ffmpegPath}
                  onChange={(e) => setFfmpegPath(e.target.value)}
                  className="flex-1 px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-700 text-xs font-mono text-zinc-200 focus:outline-none focus:border-red-500"
                />
                <button
                  type="button"
                  onClick={handleBrowseFfmpeg}
                  className="flex items-center space-x-1.5 px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium border border-zinc-700 transition-colors shrink-0"
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  <span>Browse</span>
                </button>
              </div>
            </div>

            {/* Whisper Binary Path */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-semibold text-zinc-300">
                  Faster-Whisper-XXL Executable (faster-whisper-xxl.exe)
                </label>
                <div className="flex items-center space-x-1.5">
                  {binaryStatus.whisperExists ? (
                    <>
                      <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                        Found
                      </span>
                      {binaryStatus.modelExists ? (
                        <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-indigo-500/15 text-indigo-300 border border-indigo-500/30">
                          large-v3-turbo Ready
                        </span>
                      ) : (
                        <span
                          className="px-2 py-0.5 rounded text-[10px] font-medium bg-zinc-800 text-zinc-400 border border-zinc-700/60"
                          title="Model will automatically download on first transcription"
                        >
                          large-v3-turbo (Auto-downloads on 1st run)
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20">
                      Not Found
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center space-x-2">
                <input
                  type="text"
                  placeholder="Auto-detected or specify path to faster-whisper-xxl.exe"
                  value={whisperPath}
                  onChange={(e) => setWhisperPath(e.target.value)}
                  className="flex-1 px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-700 text-xs font-mono text-zinc-200 focus:outline-none focus:border-red-500"
                />
                <button
                  type="button"
                  onClick={handleBrowseWhisper}
                  className="flex items-center space-x-1.5 px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium border border-zinc-700 transition-colors shrink-0"
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  <span>Browse</span>
                </button>
              </div>
            </div>

            {/* Setup & Installation Guide Card */}
            {showSetupGuide && (
              <div className="p-4 rounded-xl bg-zinc-900/90 border border-zinc-700/80 space-y-3 animate-in fade-in duration-150">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2 text-amber-400 text-xs font-semibold">
                    <AlertTriangle className="w-4 h-4 shrink-0" />
                    <span>How to install Whisper AI & FFmpeg</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowSetupGuide(false)}
                    className="text-zinc-500 hover:text-zinc-300 text-xs"
                  >
                    Dismiss
                  </button>
                </div>

                <p className="text-[11px] text-zinc-300 leading-relaxed">
                  Anime Media Center uses <strong className="text-white">Faster-Whisper-XXL</strong> and{' '}
                  <strong className="text-white">FFmpeg</strong> to batch-transcribe English dubs into voice-matched
                  subtitles. You can set them up in either of two ways:
                </p>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
                  {/* Option 1: Subtitle Edit */}
                  <div className="p-3 rounded-lg bg-zinc-950/70 border border-zinc-800 space-y-2">
                    <div className="text-xs font-bold text-white flex items-center justify-between">
                      <span>Method 1: Subtitle Edit</span>
                      <span className="text-[9px] uppercase px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-bold">
                        Easiest
                      </span>
                    </div>
                    <p className="text-[11px] text-zinc-400 leading-relaxed">
                      Download Subtitle Edit. Open <em>Video &rarr; Audio to text (Whisper)</em>, select{' '}
                      <strong>Faster-Whisper XXL</strong>. It automatically downloads the engine, models, and FFmpeg!
                    </p>
                    <button
                      type="button"
                      onClick={() => window.electronAPI.openExternalUrl('https://www.nikse.dk/subtitleedit')}
                      className="inline-flex items-center space-x-1.5 text-xs font-semibold text-indigo-400 hover:text-indigo-300 transition-colors pt-1"
                    >
                      <span>Download Subtitle Edit</span>
                      <ExternalLink className="w-3 h-3" />
                    </button>
                  </div>

                  {/* Option 2: Standalone Release */}
                  <div className="p-3 rounded-lg bg-zinc-950/70 border border-zinc-800 space-y-2">
                    <div className="text-xs font-bold text-white flex items-center justify-between">
                      <span>Method 2: Standalone Release</span>
                      <span className="text-[9px] uppercase px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-400 font-bold">
                        Portable
                      </span>
                    </div>
                    <p className="text-[11px] text-zinc-400 leading-relaxed">
                      Download <code className="text-zinc-200">Faster-Whisper-XXL_windows.7z</code> from Purfview's official
                      GitHub repository. Extract anywhere and click <strong>Browse</strong> above.
                    </p>
                    <button
                      type="button"
                      onClick={() =>
                        window.electronAPI.openExternalUrl('https://github.com/Purfview/whisper-standalone-win/releases')
                      }
                      className="inline-flex items-center space-x-1.5 text-xs font-semibold text-indigo-400 hover:text-indigo-300 transition-colors pt-1"
                    >
                      <span>Purfview GitHub Releases</span>
                      <ExternalLink className="w-3 h-3" />
                    </button>
                  </div>
                </div>

                <div className="p-2.5 rounded-lg bg-zinc-950/40 border border-zinc-800/80 text-[10px] text-zinc-400 flex items-start space-x-2">
                  <span className="text-indigo-400 font-bold shrink-0">AI Model Notice:</span>
                  <span>
                    When transcribing for the first time, Faster-Whisper automatically downloads the high-speed{' '}
                    <strong className="text-zinc-200">large-v3-turbo</strong> model directly into its local{' '}
                    <code>_models</code> folder. No manual model setup required!
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Subtitles Visual Customization */}
          <div className="pt-3 border-t border-zinc-800/80 space-y-3">
            <span className="text-xs font-bold uppercase tracking-wider text-zinc-400 block">
              Subtitle Overlay Appearance
            </span>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs text-zinc-300">
                  <span>Font Size ({subtitlesFontSize}px)</span>
                </div>
                <input
                  type="range"
                  min="20"
                  max="44"
                  step="2"
                  value={subtitlesFontSize}
                  onChange={(e) => setSubtitlesFontSize(parseInt(e.target.value, 10))}
                  className="w-full accent-red-600 cursor-pointer"
                />
              </div>

              <div className="flex items-center space-x-3 pt-4">
                <label className="flex items-center space-x-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={subtitlesOutline}
                    onChange={(e) => setSubtitlesOutline(e.target.checked)}
                    className="w-4 h-4 rounded bg-zinc-900 border-zinc-700 text-red-600 focus:ring-0 cursor-pointer"
                  />
                  <span className="text-xs font-medium text-zinc-200">
                    High-contrast text outline & drop shadow
                  </span>
                </label>
              </div>
            </div>
          </div>
        </form>

        {/* Footer Actions */}
        <div className="p-6 pt-4 border-t border-zinc-800 flex items-center justify-between shrink-0 bg-[#141418]">
          <button
            type="button"
            onClick={handleResetDefaults}
            className="flex items-center space-x-1.5 px-3 py-2 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 text-xs font-medium transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset to Defaults</span>
          </button>

          <div className="flex items-center space-x-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-zinc-400 hover:text-white text-xs font-medium transition-colors"
            >
              Cancel
            </button>

            <button
              type="button"
              onClick={handleSubmit}
              className="flex items-center space-x-1.5 px-5 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold text-xs shadow-md shadow-red-600/30 transition-colors"
            >
              <Save className="w-4 h-4" />
              <span>Save Settings</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
