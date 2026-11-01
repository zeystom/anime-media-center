import React, { useState } from 'react';
import { X, Settings as SettingsIcon, Save, RotateCcw, FolderOpen } from 'lucide-react';
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
  const [defaultLibraryRoot, setDefaultLibraryRoot] = useState(settings.defaultLibraryRoot);
  const [subtitlesFontSize, setSubtitlesFontSize] = useState(settings.subtitlesFontSize);
  const [subtitlesOutline, setSubtitlesOutline] = useState(settings.subtitlesOutline);
  const [autoPlayNext, setAutoPlayNext] = useState(settings.autoPlayNext);

  if (!isOpen) return null;

  const handleBrowseLibrary = async () => {
    const dir = await window.electronAPI.browseFolder(defaultLibraryRoot);
    if (dir) setDefaultLibraryRoot(dir);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      ffmpegPath,
      whisperPath,
      defaultLibraryRoot,
      subtitlesFontSize,
      subtitlesOutline,
      autoPlayNext,
    });
    onClose();
  };

  const handleResetDefaults = () => {
    setFfmpegPath('C:\\Users\\gogoh\\AppData\\Roaming\\Subtitle Edit\\SpeechToText\\Purfview-Faster-Whisper-XXL\\ffmpeg.exe');
    setWhisperPath('C:\\Users\\gogoh\\AppData\\Roaming\\Subtitle Edit\\SpeechToText\\Purfview-Faster-Whisper-XXL\\faster-whisper-xxl.exe');
    setDefaultLibraryRoot('D:\\films');
    setSubtitlesFontSize(28);
    setSubtitlesOutline(true);
    setAutoPlayNext(true);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-150">
      <div
        className="w-full max-w-2xl bg-[#141418] border border-zinc-700/80 rounded-2xl p-6 text-zinc-100 shadow-2xl animate-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-zinc-800">
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 rounded-lg bg-zinc-800 flex items-center justify-center text-zinc-300">
              <SettingsIcon className="w-4 h-4 text-indigo-400" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white tracking-tight">System & Player Settings</h3>
              <p className="text-xs text-zinc-400">Configure external binary paths and playback preferences</p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="py-5 space-y-4">
          {/* FFmpeg Binary Path */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-zinc-300">FFmpeg Executable Path</label>
            <input
              type="text"
              value={ffmpegPath}
              onChange={(e) => setFfmpegPath(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-700 text-xs font-mono text-zinc-200 focus:outline-none focus:border-red-500"
            />
          </div>

          {/* Whisper Binary Path */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-zinc-300">Faster-Whisper-XXL Executable Path</label>
            <input
              type="text"
              value={whisperPath}
              onChange={(e) => setWhisperPath(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-700 text-xs font-mono text-zinc-200 focus:outline-none focus:border-red-500"
            />
          </div>

          {/* Default Media Library Root */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-zinc-300">Default Anime Media Root (e.g. D:\films)</label>
            <div className="flex items-center space-x-2">
              <input
                type="text"
                value={defaultLibraryRoot}
                onChange={(e) => setDefaultLibraryRoot(e.target.value)}
                className="flex-1 px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-700 text-xs font-mono text-zinc-200 focus:outline-none focus:border-red-500"
              />
              <button
                type="button"
                onClick={handleBrowseLibrary}
                className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium border border-zinc-700 transition-colors flex items-center space-x-1"
              >
                <FolderOpen className="w-3.5 h-3.5" />
                <span>Browse</span>
              </button>
            </div>
          </div>

          {/* Subtitles Visual Customization */}
          <div className="pt-2 border-t border-zinc-800/80 space-y-3">
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

          {/* Footer Actions */}
          <div className="pt-4 border-t border-zinc-800 flex items-center justify-between">
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
                type="submit"
                className="flex items-center space-x-1.5 px-5 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold text-xs shadow-md shadow-red-600/30 transition-colors"
              >
                <Save className="w-4 h-4" />
                <span>Save Settings</span>
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
