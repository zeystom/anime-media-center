import React from 'react';
import { Volume2, Subtitles, Check, Plus, Minus, RotateCcw, X, Sparkles, Type } from 'lucide-react';
import { AudioTrack, SubtitleTrack } from '../../types';

interface TrackControlsProps {
  isOpen: boolean;
  onClose: () => void;
  audioTracks: AudioTrack[];
  subtitleTracks: SubtitleTrack[];
  selectedAudioIndex: number;
  onSelectAudio: (index: number) => void;
  selectedMainSubId: string | null;
  onSelectMainSub: (trackId: string | null) => void;
  selectedTopSubId: string | null;
  onSelectTopSub: (trackId: string | null) => void;
  topSubEnabled: boolean;
  onToggleTopSub: () => void;
  syncOffset: number;
  onUpdateSyncOffset: (delta: number) => void;
  onResetSyncOffset: () => void;
  fontSize: number;
  onUpdateFontSize: (size: number) => void;
}

export const TrackControls: React.FC<TrackControlsProps> = ({
  isOpen,
  onClose,
  audioTracks,
  subtitleTracks,
  selectedAudioIndex,
  onSelectAudio,
  selectedMainSubId,
  onSelectMainSub,
  selectedTopSubId,
  onSelectTopSub,
  topSubEnabled,
  onToggleTopSub,
  syncOffset,
  onUpdateSyncOffset,
  onResetSyncOffset,
  fontSize,
  onUpdateFontSize,
}) => {
  if (!isOpen) return null;

  // Filter 2nd Subtitle / Signs (Top):
  // Strictly English AND (Signs / Forced / Songs) AND NOT the main subtitle track!
  const topSignsTracks = subtitleTracks.filter((track) => {
    const isEng = track.language === 'eng' || track.language === 'en';
    const isSignOrForced = track.isSigns || track.isForced || /sign|song|forced/i.test(track.title);
    return isEng && isSignOrForced && track.id !== selectedMainSubId;
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 animate-in fade-in duration-150">
      <div
        className="relative w-full max-w-4xl glass-dropdown rounded-2xl border border-zinc-700/80 p-6 text-zinc-100 shadow-2xl animate-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-zinc-800">
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 rounded-lg bg-red-600/20 text-red-400 flex items-center justify-center border border-red-500/30">
              <Subtitles className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white tracking-tight">Audio & Subtitle Manager</h3>
              <p className="text-xs text-zinc-400">Settings automatically persist for this entire anime season</p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 3-Column Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 py-5">
          {/* Column 1: Audio Track */}
          <div className="space-y-3">
            <div className="flex items-center space-x-2 text-xs font-bold uppercase tracking-wider text-zinc-400">
              <Volume2 className="w-4 h-4 text-indigo-400" />
              <span>Audio Track</span>
            </div>

            <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
              {audioTracks.map((track) => {
                const isSelected = selectedAudioIndex === track.audioIndex;
                const isEng = track.language === 'eng' || track.language === 'en';

                return (
                  <button
                    key={track.audioIndex}
                    onClick={() => onSelectAudio(track.audioIndex)}
                    className={`w-full flex items-center justify-between p-2.5 rounded-xl text-left text-xs transition-all border ${
                      isSelected
                        ? 'bg-red-600/20 border-red-500/60 text-white font-semibold shadow-sm'
                        : 'bg-zinc-900/60 border-zinc-800/80 text-zinc-300 hover:bg-zinc-800/60'
                    }`}
                  >
                    <div className="truncate mr-2">
                      <div className="truncate font-medium flex items-center space-x-1.5">
                        <span>{track.title}</span>
                        {isEng && (
                          <span className="text-[10px] px-1 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 font-semibold">
                            ENG
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-zinc-500 capitalize">
                        {track.languageName} • {track.codec.toUpperCase()}
                      </div>
                    </div>
                    {isSelected && <Check className="w-4 h-4 text-red-500 shrink-0" />}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Column 2: Main Subtitle (Bottom) */}
          <div className="space-y-3">
            <div className="flex items-center justify-between text-xs font-bold uppercase tracking-wider text-zinc-400">
              <div className="flex items-center space-x-2">
                <Subtitles className="w-4 h-4 text-emerald-400" />
                <span>Main Subtitle (Bottom)</span>
              </div>
            </div>

            <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
              {/* OFF Option */}
              <button
                onClick={() => onSelectMainSub(null)}
                className={`w-full flex items-center justify-between p-2.5 rounded-xl text-left text-xs transition-all border ${
                  selectedMainSubId === null
                    ? 'bg-red-600/20 border-red-500/60 text-white font-semibold shadow-sm'
                    : 'bg-zinc-900/60 border-zinc-800/80 text-zinc-400 hover:bg-zinc-800/60'
                }`}
              >
                <span>OFF (No Subtitles)</span>
                {selectedMainSubId === null && <Check className="w-4 h-4 text-red-500 shrink-0" />}
              </button>

              {subtitleTracks.map((track) => {
                const isSelected = selectedMainSubId === track.id;
                const isExternal = track.type === 'external';

                return (
                  <button
                    key={track.id}
                    onClick={() => onSelectMainSub(track.id)}
                    className={`w-full flex items-center justify-between p-2.5 rounded-xl text-left text-xs transition-all border ${
                      isSelected
                        ? 'bg-red-600/20 border-red-500/60 text-white font-semibold shadow-sm'
                        : 'bg-zinc-900/60 border-zinc-800/80 text-zinc-300 hover:bg-zinc-800/60'
                    }`}
                  >
                    <div className="truncate mr-2">
                      <div className="truncate font-medium flex items-center space-x-1.5">
                        <span>{track.title}</span>
                        {isExternal && (
                          <span className="text-[10px] px-1 py-0.2 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-bold">
                            WHISPER
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-zinc-500">
                        {track.languageName} {track.isDubtitle ? '• Dialogue/Dub' : ''}
                      </div>
                    </div>
                    {isSelected && <Check className="w-4 h-4 text-red-500 shrink-0" />}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Column 3: 2nd Subtitle / Signs (Top) */}
          <div className="space-y-3">
            <div className="flex items-center justify-between text-xs font-bold uppercase tracking-wider text-zinc-400">
              <div className="flex items-center space-x-2">
                <Sparkles className="w-4 h-4 text-yellow-400" />
                <span>2nd Sub / Signs (Top)</span>
              </div>
              <button
                onClick={onToggleTopSub}
                className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase border transition-colors ${
                  topSubEnabled
                    ? 'bg-yellow-500/20 text-yellow-300 border-yellow-500/40'
                    : 'bg-zinc-800 text-zinc-500 border-zinc-700'
                }`}
              >
                {topSubEnabled ? 'Active' : 'Muted'}
              </button>
            </div>

            <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
              {/* OFF Option */}
              <button
                onClick={() => onSelectTopSub(null)}
                className={`w-full flex items-center justify-between p-2.5 rounded-xl text-left text-xs transition-all border ${
                  selectedTopSubId === null
                    ? 'bg-yellow-500/20 border-yellow-500/60 text-yellow-200 font-semibold shadow-sm'
                    : 'bg-zinc-900/60 border-zinc-800/80 text-zinc-400 hover:bg-zinc-800/60'
                }`}
              >
                <span>OFF (No Top Signs)</span>
                {selectedTopSubId === null && <Check className="w-4 h-4 text-yellow-400 shrink-0" />}
              </button>

              {topSignsTracks.length > 0 ? (
                topSignsTracks.map((track) => {
                  const isSelected = selectedTopSubId === track.id;
                  return (
                    <button
                      key={track.id}
                      onClick={() => onSelectTopSub(track.id)}
                      className={`w-full flex items-center justify-between p-2.5 rounded-xl text-left text-xs transition-all border ${
                        isSelected
                          ? 'bg-yellow-500/20 border-yellow-500/60 text-yellow-200 font-semibold shadow-sm'
                          : 'bg-zinc-900/60 border-zinc-800/80 text-zinc-300 hover:bg-zinc-800/60'
                      }`}
                    >
                      <div className="truncate mr-2">
                        <div className="truncate font-medium">{track.title}</div>
                        <div className="text-[10px] text-yellow-500/80">English Signs / Forced Only</div>
                      </div>
                      {isSelected && <Check className="w-4 h-4 text-yellow-400 shrink-0" />}
                    </button>
                  );
                })
              ) : (
                <div className="p-3 text-center rounded-xl bg-zinc-900/40 border border-dashed border-zinc-800 text-zinc-500 text-xs">
                  No English Signs/Forced tracks found in this file. (Foreign tracks are strictly ignored).
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer: Subtitle Sync Offset & Font Size Controls */}
        <div className="pt-4 border-t border-zinc-800/80 flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-4">
            {/* Sync Offset */}
            <div className="flex items-center space-x-2">
              <span className="text-xs font-semibold text-zinc-300">Sync Offset:</span>
              <div className="flex items-center space-x-1.5 bg-zinc-900 p-1 rounded-lg border border-zinc-800">
                <button
                  onClick={() => onUpdateSyncOffset(-0.5)}
                  className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-white transition-colors"
                  aria-label="Delay Subtitles (-0.5s) [HotKey: []"
                >
                  <Minus className="w-3.5 h-3.5" />
                </button>

                <span className="text-xs font-mono font-bold px-1.5 text-zinc-200">
                  {syncOffset > 0 ? `+${syncOffset.toFixed(1)}s` : `${syncOffset.toFixed(1)}s`}
                </span>

                <button
                  onClick={() => onUpdateSyncOffset(0.5)}
                  className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-white transition-colors"
                  aria-label="Speed Up Subtitles (+0.5s) [HotKey: ]]"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>

                {syncOffset !== 0 && (
                  <button
                    onClick={onResetSyncOffset}
                    className="p-1 ml-0.5 rounded hover:bg-zinc-800 text-zinc-400 hover:text-red-400 transition-colors"
                    aria-label="Reset Sync Offset to 0s"
                  >
                    <RotateCcw className="w-3 h-3" />
                  </button>
                )}
              </div>
            </div>

            {/* Font Size Changer */}
            <div className="flex items-center space-x-2 pl-3 border-l border-zinc-800">
              <span className="text-xs font-semibold text-zinc-300 flex items-center space-x-1">
                <Type className="w-3.5 h-3.5 text-indigo-400" />
                <span>Font Size:</span>
              </span>
              <div className="flex items-center space-x-1 bg-zinc-900 p-1 rounded-lg border border-zinc-800">
                <button
                  onClick={() => onUpdateFontSize(fontSize - 2)}
                  disabled={fontSize <= 14}
                  className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-white disabled:opacity-30 transition-colors"
                  aria-label="Decrease Subtitle Font Size"
                >
                  <Minus className="w-3.5 h-3.5" />
                </button>

                <span className="text-xs font-mono font-bold px-2 text-zinc-200 min-w-[32px] text-center">
                  {fontSize}px
                </span>

                <button
                  onClick={() => onUpdateFontSize(fontSize + 2)}
                  disabled={fontSize >= 60}
                  className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-white disabled:opacity-30 transition-colors"
                  aria-label="Increase Subtitle Font Size"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>

          <button
            onClick={onClose}
            className="px-5 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold shadow-md shadow-red-600/30 transition-colors"
          >
            Apply & Close
          </button>
        </div>
      </div>
    </div>
  );
};
