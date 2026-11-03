import React, { useState, useEffect } from 'react';
import {
  Volume2,
  Subtitles,
  Check,
  Plus,
  Minus,
  RotateCcw,
  X,
  Sparkles,
  Type,
  Palette,
  SlidersHorizontal,
  Layers,
} from 'lucide-react';
import { AudioTrack, SubtitleTrack } from '../../types';
import { getSubtitleTextShadow } from './SubtitleOverlay';

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
  textColor?: string;
  onUpdateTextColor?: (color: string) => void;
  fontFamily?: 'sans' | 'trebuchet' | 'rounded' | 'serif' | 'mono';
  onUpdateFontFamily?: (font: 'sans' | 'trebuchet' | 'rounded' | 'serif' | 'mono') => void;
  bgStyle?: 'none' | 'translucent' | 'semi' | 'solid';
  onUpdateBgStyle?: (bg: 'none' | 'translucent' | 'semi' | 'solid') => void;
  outlineWidth?: 'thin' | 'medium' | 'thick' | 'heavy' | 'none';
  onUpdateOutlineWidth?: (width: 'thin' | 'medium' | 'thick' | 'heavy' | 'none') => void;
  outlineColor?: string;
  onUpdateOutlineColor?: (color: string) => void;
  onResetSubtitleStyle?: () => void;
}

const FONT_FAMILIES: Record<string, string> = {
  sans: 'Inter, system-ui, -apple-system, sans-serif',
  trebuchet: '"Trebuchet MS", "Lucida Grande", "Segoe UI", sans-serif',
  rounded: '"Comfortaa", "Nunito", "Segoe UI Rounded", "Arial Rounded MT Bold", sans-serif',
  serif: 'Georgia, "Times New Roman", Cambria, serif',
  mono: 'ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, monospace',
};

const COLOR_OPTIONS = [
  { id: '#ffffff', label: 'White', color: '#ffffff' },
  { id: '#fef08a', label: 'Anime Yellow', color: '#fef08a' },
  { id: '#a5f3fc', label: 'Cyan', color: '#a5f3fc' },
  { id: '#fcd34d', label: 'Warm Amber', color: '#fcd34d' },
  { id: '#86efac', label: 'Mint', color: '#86efac' },
];

const OUTLINE_COLOR_OPTIONS = [
  { id: '#000000', label: 'Black (Default)', color: '#000000' },
  { id: '#27272a', label: 'Charcoal', color: '#27272a' },
  { id: '#0f172a', label: 'Midnight', color: '#0f172a' },
  { id: '#3f0d12', label: 'Deep Wine', color: '#3f0d12' },
  { id: '#26130b', label: 'Chocolate', color: '#26130b' },
];

const OUTLINE_WIDTH_STEPS: Array<{
  id: 'none' | 'thin' | 'medium' | 'thick' | 'heavy';
  label: string;
  px: number;
  desc: string;
}> = [
  { id: 'none', label: 'None', px: 0, desc: 'Off' },
  { id: 'thin', label: 'Thin', px: 1, desc: 'Subtle' },
  { id: 'medium', label: 'Medium', px: 2, desc: 'Balanced' },
  { id: 'thick', label: 'Standard', px: 3, desc: 'Fansub Standard' },
  { id: 'heavy', label: 'Heavy', px: 4, desc: 'Max Contrast' },
];

const FONT_OPTIONS: Array<{ id: 'sans' | 'trebuchet' | 'rounded' | 'serif' | 'mono'; label: string; sample: string }> = [
  { id: 'sans', label: 'Clean Sans (Default)', sample: 'Inter' },
  { id: 'trebuchet', label: 'Cinematic Sans', sample: 'Trebuchet MS' },
  { id: 'rounded', label: 'Soft Rounded', sample: 'Comfortaa' },
  { id: 'serif', label: 'Editorial Serif', sample: 'Georgia' },
  { id: 'mono', label: 'Monospace', sample: 'Consolas' },
];

const BG_OPTIONS: Array<{ id: 'none' | 'translucent' | 'semi' | 'solid'; label: string; desc: string }> = [
  { id: 'none', label: 'None (Default)', desc: 'Pure Outline' },
  { id: 'translucent', label: 'Soft Pill', desc: 'Light Black Glass' },
  { id: 'semi', label: 'Semi-Opaque', desc: 'Deep Contrast Box' },
  { id: 'solid', label: 'Solid Black', desc: 'Maximum Readability' },
];

function getSubTrackDisplay(track: SubtitleTrack, index: number, allTracks: SubtitleTrack[]) {
  let badge = 'SRT';
  if (track.type === 'external') {
    badge = 'SRT';
  } else if (track.codec) {
    badge = track.codec.toUpperCase().replace('SUBRIP', 'SRT');
  }

  let title = '';
  if (track.type === 'external') {
    title = 'External .srt (Whisper)';
  } else {
    const lang = track.languageName || 'English';
    const rawTitle = (track.title || '').trim();
    const isRawCodecOnly = /^(ass|ssa|subrip|srt)(\s*\((default|forced|hearing impaired)\))?$/i.test(rawTitle);

    if (track.isDubtitle || /sdh|dubtitle|hearing impaired/i.test(rawTitle)) {
      title = `${lang} — Dubtitle / SDH`;
    } else if (track.isSigns || track.isForced || /sign|song|forced/i.test(rawTitle)) {
      title = `${lang} — Signs / Forced`;
    } else if (!isRawCodecOnly && rawTitle && !/^stream\s*#?\d+/i.test(rawTitle)) {
      const cleaned = rawTitle
        .replace(/\b(ass|ssa|subrip|srt)\b/gi, '')
        .replace(/\((default)\)/gi, '')
        .trim();
      title = cleaned || `${lang} — Full Dialogue`;
    } else {
      title = `${lang} — Full Dialogue`;
    }
  }

  const duplicates = allTracks.filter((t) => {
    if (t.id === track.id) return false;
    if (t.type === 'external' && track.type === 'external') return true;
    if (t.type === 'external' || track.type === 'external') return false;
    const tLang = t.languageName || 'English';
    const tRaw = (t.title || '').trim();
    const tIsRaw = /^(ass|ssa|subrip|srt)(\s*\((default|forced|hearing impaired)\))?$/i.test(tRaw);
    let tTitle = '';
    if (t.isDubtitle || /sdh|dubtitle|hearing impaired/i.test(tRaw)) {
      tTitle = `${tLang} — Dubtitle / SDH`;
    } else if (t.isSigns || t.isForced || /sign|song|forced/i.test(tRaw)) {
      tTitle = `${tLang} — Signs / Forced`;
    } else if (!tIsRaw && tRaw && !/^stream\s*#?\d+/i.test(tRaw)) {
      tTitle = tRaw.replace(/\b(ass|ssa|subrip|srt)\b/gi, '').replace(/\((default)\)/gi, '').trim() || `${tLang} — Full Dialogue`;
    } else {
      tTitle = `${tLang} — Full Dialogue`;
    }
    return tTitle.toLowerCase() === title.toLowerCase();
  });

  if (duplicates.length > 0 && track.type !== 'external') {
    const trackNum = track.index !== null && track.index !== undefined ? track.index : index + 1;
    title = `${title} (Track #${trackNum})`;
  }

  return { title, badge };
}

function getAudioTrackDisplay(track: AudioTrack, allTracks: AudioTrack[]) {
  const lang = track.languageName || 'Audio';
  const codec = (track.codec || 'AUDIO').toUpperCase();
  let title = track.title || `${lang} Audio`;

  if (/^([a-zA-Z]+)\s*\([a-zA-Z0-9_-]+\)$/i.test(title)) {
    title = lang;
  }

  const duplicates = allTracks.filter(
    (t) => t.audioIndex !== track.audioIndex && (t.title || t.languageName) === (track.title || track.languageName)
  );
  if (duplicates.length > 0) {
    title = `${title} (Track #${track.audioIndex + 1})`;
  }

  return { title, badge: codec };
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
  textColor = '#ffffff',
  onUpdateTextColor,
  fontFamily = 'sans',
  onUpdateFontFamily,
  bgStyle = 'none',
  onUpdateBgStyle,
  outlineWidth = 'thick',
  onUpdateOutlineWidth,
  outlineColor = '#000000',
  onUpdateOutlineColor,
  onResetSubtitleStyle,
}) => {
  const [activeTab, setActiveTab] = useState<'tracks' | 'styling'>('tracks');
  const [previewBackdrop, setPreviewBackdrop] = useState<'spectrum' | 'dark' | 'bright'>('spectrum');

  const currOutlineIndex = Math.max(
    0,
    OUTLINE_WIDTH_STEPS.findIndex((s) => s.id === (outlineWidth || 'thick'))
  );
  const currOutlineStep = OUTLINE_WIDTH_STEPS[currOutlineIndex] || OUTLINE_WIDTH_STEPS[3];

  // Reset tab back to 'tracks' every time the dialog is closed or reopened
  const handleClose = () => {
    setActiveTab('tracks');
    onClose();
  };

  useEffect(() => {
    if (isOpen) {
      setActiveTab('tracks');
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        handleClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  if (!isOpen) return null;

  // Filter 2nd Subtitle / Signs (Top):
  const topSignsTracks = subtitleTracks.filter((track) => {
    const isEng = track.language === 'eng' || track.language === 'en';
    const isSignOrForced = track.isSigns || track.isForced || /sign|song|forced/i.test(track.title);
    return isEng && isSignOrForced && track.id !== selectedMainSubId;
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 animate-in fade-in duration-150"
      onClick={handleClose}
    >
      <div
        className="relative w-full max-w-4xl glass-dropdown rounded-2xl border border-zinc-700/80 p-6 text-zinc-100 shadow-2xl animate-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-zinc-800">
          <div className="flex items-center space-x-3">
            {activeTab === 'styling' ? (
              <div className="w-8 h-8 rounded-lg bg-amber-500/20 text-amber-400 flex items-center justify-center border border-amber-500/30">
                <Sparkles className="w-4 h-4" />
              </div>
            ) : (
              <div className="w-8 h-8 rounded-lg bg-red-600/20 text-red-400 flex items-center justify-center border border-red-500/30">
                <Subtitles className="w-4 h-4" />
              </div>
            )}
            <div>
              <h3 className="text-base font-bold text-white tracking-tight">
                {activeTab === 'styling' ? 'Advanced Subtitle Styling' : 'Audio & Subtitle Manager'}
              </h3>
              <p className="text-xs text-zinc-400">
                {activeTab === 'styling'
                  ? 'Custom styling applied live to external, dialogue, and signs subtitles'
                  : 'Settings automatically persist for this entire anime season'}
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <button
              onClick={handleClose}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* TAB 1: Tracks & Channels Selection */}
        {activeTab === 'tracks' && (
          <>
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
                    const { title, badge } = getAudioTrackDisplay(track, audioTracks);

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
                            <span>{title}</span>
                            {isEng && (
                              <span className="text-[10px] px-1 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 font-semibold">
                                ENG
                              </span>
                            )}
                          </div>
                          <div className="text-[10px] text-zinc-500 capitalize">
                            {track.languageName}
                          </div>
                        </div>
                        <div className="flex items-center space-x-2 shrink-0">
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-medium bg-zinc-800 text-zinc-400 border border-zinc-700/50">
                            {badge}
                          </span>
                          {isSelected && <Check className="w-4 h-4 text-red-500 shrink-0" />}
                        </div>
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

                  {subtitleTracks.map((track, idx) => {
                    const isSelected = selectedMainSubId === track.id;
                    const { title, badge } = getSubTrackDisplay(track, idx, subtitleTracks);

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
                            <span>{title}</span>
                          </div>
                          <div className="text-[10px] text-zinc-500">
                            {track.languageName}
                          </div>
                        </div>
                        <div className="flex items-center space-x-2 shrink-0">
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-medium bg-zinc-800 text-zinc-400 border border-zinc-700/50">
                            {badge}
                          </span>
                          {isSelected && <Check className="w-4 h-4 text-red-500 shrink-0" />}
                        </div>
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
                    topSignsTracks.map((track, idx) => {
                      const isSelected = selectedTopSubId === track.id;
                      const { title, badge } = getSubTrackDisplay(track, idx, topSignsTracks);
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
                            <div className="truncate font-medium">{title}</div>
                            <div className="text-[10px] text-yellow-500/80">English Signs / Forced Only</div>
                          </div>
                          <div className="flex items-center space-x-2 shrink-0">
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-medium bg-zinc-800 text-zinc-400 border border-zinc-700/50">
                              {badge}
                            </span>
                            {isSelected && <Check className="w-4 h-4 text-yellow-400 shrink-0" />}
                          </div>
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

            {/* Subtitles Settings Footer Section */}
            <div className="pt-4 border-t border-zinc-800/80 flex flex-wrap items-center justify-between gap-4">
              <div className="flex flex-wrap items-center gap-3 sm:gap-4">
                {/* Section Title */}
                <div className="flex items-center space-x-1.5 text-xs font-bold uppercase tracking-wider text-zinc-400">
                  <Subtitles className="w-4 h-4 text-emerald-400" />
                  <span>Subtitles Settings:</span>
                </div>

                {/* Sync Offset */}
                <div className="flex items-center space-x-2 pl-3 border-l border-zinc-800">
                  <span className="text-xs font-semibold text-zinc-300">Sync:</span>
                  <div className="flex items-center space-x-1.5 bg-zinc-900 p-1 rounded-lg border border-zinc-800">
                    <button
                      onClick={() => onUpdateSyncOffset(-0.5)}
                      className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-white transition-colors"
                      aria-label="Delay Subtitles (-0.5s) [HotKey: []"
                    >
                      <Minus className="w-3.5 h-3.5" />
                    </button>

                    <span className="text-xs font-mono font-bold px-1.5 text-zinc-200">
                      {syncOffset > 0 ? `+${syncOffset.toFixed(1)}s (earlier)` : syncOffset < 0 ? `${syncOffset.toFixed(1)}s (later)` : '0.0s'}
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

                {/* Font Size Stepper */}
                <div className="flex items-center space-x-2 pl-3 border-l border-zinc-800">
                  <span className="text-xs font-semibold text-zinc-300 flex items-center space-x-1">
                    <Type className="w-3.5 h-3.5 text-zinc-400" />
                    <span>Size:</span>
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
                      disabled={fontSize >= 64}
                      className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-white disabled:opacity-30 transition-colors"
                      aria-label="Increase Subtitle Font Size"
                    >
                      <Plus className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Single Advanced Button */}
                <button
                  onClick={() => setActiveTab('styling')}
                  className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-zinc-800/80 hover:bg-zinc-700/80 text-zinc-200 hover:text-white border border-white/10 text-xs font-semibold transition-all shadow-sm"
                >
                  <SlidersHorizontal className="w-3.5 h-3.5 text-amber-400" />
                  <span>Advanced</span>
                </button>
              </div>

              <div className="flex items-center space-x-3 ml-auto">
                <span className="text-xs text-zinc-500 font-medium hidden sm:inline">
                  Changes apply immediately
                </span>
                <button
                  onClick={handleClose}
                  className="px-5 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold transition-all shadow-md shadow-red-600/20 active:scale-95 cursor-pointer"
                  aria-label="Done (Close audio and subtitle manager)"
                >
                  Done
                </button>
              </div>
            </div>
          </>
        )}

        {/* TAB 2: Modern Subtitle Customization with Live Preview */}
        {activeTab === 'styling' && (
          <div className="py-4 space-y-5 animate-in fade-in duration-150">
            {/* Live Subtitle Preview Box with Dedicated Header Bar & Rainbow Spectrum Test */}
            <div className="w-full rounded-2xl bg-gradient-to-b from-[#181822] via-[#0d0d12] to-black border border-zinc-700/60 overflow-hidden shadow-2xl flex flex-col">
              {/* Separate Header Bar (Never overlaps subtitle dialogue) */}
              <div className="px-4 py-2 bg-zinc-900/90 border-b border-zinc-800/80 flex items-center justify-between text-xs font-mono">
                <div className="flex items-center space-x-2 text-zinc-300 font-semibold">
                  <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                  <span>Live Preview</span>
                </div>

                {/* Contrast Test Mode Switcher */}
                <div className="flex items-center bg-black/60 p-0.5 rounded-lg border border-zinc-800 text-[10px] font-mono">
                  <button
                    onClick={() => setPreviewBackdrop('spectrum')}
                    className={`px-2 py-0.5 rounded transition-all font-semibold ${
                      previewBackdrop === 'spectrum'
                        ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-sm'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    Spectrum
                  </button>
                  <button
                    onClick={() => setPreviewBackdrop('dark')}
                    className={`px-2 py-0.5 rounded transition-all ${
                      previewBackdrop === 'dark'
                        ? 'bg-zinc-800 text-white font-semibold'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    Dark
                  </button>
                  <button
                    onClick={() => setPreviewBackdrop('bright')}
                    className={`px-2 py-0.5 rounded transition-all ${
                      previewBackdrop === 'bright'
                        ? 'bg-zinc-200 text-zinc-900 font-bold'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    Bright
                  </button>
                </div>

                <div className="text-[11px] text-zinc-500 font-mono hidden sm:block">
                  {fontSize}px • {currOutlineStep.px}px outline • {textColor}
                </div>
              </div>

              {/* Centered Dialogue Canvas with Vertical Rainbow Gamma Bands */}
              <div className="h-36 flex items-center justify-center p-4 relative overflow-hidden bg-zinc-950">
                {previewBackdrop === 'spectrum' && (
                  <>
                    {/* Vertical Rainbow / Contrast Test Bars */}
                    <div className="absolute inset-x-3 inset-y-2 rounded-xl overflow-hidden flex shadow-inner border border-white/10 opacity-90">
                      <div className="flex-1 bg-[#09090b]" title="Dark / Black" />
                      <div className="flex-1 bg-[#1e1b4b]" title="Midnight Indigo" />
                      <div className="flex-1 bg-[#1d4ed8]" title="Deep Blue" />
                      <div className="flex-1 bg-[#0284c7]" title="Sky Cyan" />
                      <div className="flex-1 bg-[#10b981]" title="Emerald Green" />
                      <div className="flex-1 bg-[#eab308]" title="Sunlight Yellow" />
                      <div className="flex-1 bg-[#f8fafc]" title="Pure White" />
                      <div className="flex-1 bg-[#ef4444]" title="Crimson Red" />
                      <div className="flex-1 bg-[#9333ea]" title="Violet" />
                      <div className="flex-1 bg-[#18181b]" title="Charcoal" />
                    </div>
                    {/* Subtle Top & Bottom Vignette */}
                    <div className="absolute inset-x-3 inset-y-2 rounded-xl pointer-events-none bg-gradient-to-t from-black/40 via-transparent to-black/20" />
                  </>
                )}

                {previewBackdrop === 'dark' && (
                  <div className="absolute inset-x-3 inset-y-2 rounded-xl bg-black/90 border border-zinc-800 shadow-inner" />
                )}

                {previewBackdrop === 'bright' && (
                  <div className="absolute inset-x-3 inset-y-2 rounded-xl bg-gradient-to-b from-sky-200 via-amber-100 to-white border border-white/20 shadow-inner" />
                )}

                {/* Subtitle Dialogue (Rendered on top at z-10) */}
                <div
                  className={`relative z-10 max-w-2xl text-center transition-all duration-150 leading-relaxed ${
                    bgStyle === 'translucent'
                      ? 'bg-black/60 backdrop-blur-[2px] rounded-xl px-4 py-1.5 shadow-lg'
                      : bgStyle === 'semi'
                      ? 'bg-black/80 rounded-xl px-4 py-1.5 shadow-xl'
                      : bgStyle === 'solid'
                      ? 'bg-black/95 rounded-xl px-4 py-1.5 shadow-2xl'
                      : 'px-3 py-1'
                  }`}
                  style={{
                    fontSize: `${Math.min(fontSize, 38)}px`,
                    color: textColor,
                    fontFamily: FONT_FAMILIES[fontFamily] || FONT_FAMILIES.sans,
                    textShadow: getSubtitleTextShadow(outlineWidth, outlineColor),
                  }}
                >
                  I have no interest in ordinary humans.
                </div>
              </div>
            </div>

            {/* Customization Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {/* Left Column: Font Size, Text Color & Outline Styling */}
              <div className="space-y-4">
                {/* Font Size & Presets */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs font-bold text-zinc-300">
                    <span className="flex items-center space-x-1.5">
                      <Type className="w-4 h-4 text-amber-400" />
                      <span>Font Size</span>
                    </span>
                    <span className="font-mono text-zinc-400">{fontSize}px</span>
                  </div>

                  <div className="flex items-center space-x-2">
                    <div className="flex items-center bg-zinc-900 p-1 rounded-xl border border-zinc-800">
                      <button
                        onClick={() => onUpdateFontSize(fontSize - 2)}
                        disabled={fontSize <= 14}
                        className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-white disabled:opacity-30 transition-colors"
                      >
                        <Minus className="w-3.5 h-3.5" />
                      </button>
                      <span className="text-xs font-mono font-bold px-3 text-zinc-100 min-w-[38px] text-center">
                        {fontSize}px
                      </span>
                      <button
                        onClick={() => onUpdateFontSize(fontSize + 2)}
                        disabled={fontSize >= 64}
                        className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-white disabled:opacity-30 transition-colors"
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    {/* Quick Presets */}
                    <div className="flex items-center space-x-1 text-xs">
                      {[
                        { size: 28, label: 'Small' },
                        { size: 38, label: 'Standard' },
                        { size: 46, label: 'Large' },
                        { size: 54, label: 'Cinema' },
                      ].map((preset) => (
                        <button
                          key={preset.size}
                          onClick={() => onUpdateFontSize(preset.size)}
                          className={`px-2 py-1 rounded-lg border text-[11px] font-medium transition-all ${
                            fontSize === preset.size
                              ? 'bg-amber-500/20 text-amber-300 border-amber-500/50 font-bold'
                              : 'bg-zinc-900/60 text-zinc-400 border-zinc-800 hover:bg-zinc-800/80 hover:text-zinc-200'
                          }`}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Subtitle Text Color */}
                <div className="space-y-2">
                  <div className="flex items-center space-x-1.5 text-xs font-bold text-zinc-300">
                    <Palette className="w-4 h-4 text-emerald-400" />
                    <span>Subtitle Text Color</span>
                  </div>
                  <div className="grid grid-cols-5 gap-2">
                    {COLOR_OPTIONS.map((c) => {
                      const isSelected = (textColor || '#ffffff').toLowerCase() === c.id.toLowerCase();
                      return (
                        <button
                          key={c.id}
                          onClick={() => onUpdateTextColor?.(c.id)}
                          className={`flex flex-col items-center justify-center p-2 rounded-xl border text-center transition-all ${
                            isSelected
                              ? 'bg-white/10 border-white text-white font-bold shadow-sm'
                              : 'bg-zinc-900/70 border-zinc-800 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                          }`}
                        >
                          <span
                            className="w-4 h-4 rounded-full border border-black/40 shadow-sm mb-1"
                            style={{ backgroundColor: c.color }}
                          />
                          <span className="text-[10px] truncate max-w-[60px]">{c.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Outline Thickness Slider with Visual Standard Dot Marker */}
                <div className="space-y-2 p-3 rounded-xl bg-zinc-900/60 border border-zinc-800">
                  <div className="flex items-center justify-between text-xs font-bold text-zinc-300">
                    <div className="flex items-center space-x-1.5">
                      <Layers className="w-4 h-4 text-amber-400" />
                      <span>Outline Thickness</span>
                    </div>
                    <div className="flex items-center space-x-2 font-mono text-[11px]">
                      <span className={currOutlineStep.id === 'thick' ? 'text-amber-400 font-semibold' : 'text-zinc-300 font-medium'}>
                        {currOutlineStep.px}px • {currOutlineStep.label}
                      </span>
                      {currOutlineStep.id !== 'thick' && (
                        <button
                          type="button"
                          onClick={() => onUpdateOutlineWidth?.('thick')}
                          className="text-[10px] text-zinc-500 hover:text-amber-400 underline transition-colors"
                          title="Reset to Standard (3px)"
                        >
                          Reset
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Slider Bar Track */}
                  <div className="relative pt-2 pb-1.5 px-1">
                    {/* Visual Track */}
                    <div className="relative h-2 w-full rounded-full bg-zinc-800 border border-zinc-700/60">
                      {/* Filled Progress Bar */}
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-amber-500 to-amber-400 transition-all duration-75"
                        style={{ width: `${(currOutlineIndex / (OUTLINE_WIDTH_STEPS.length - 1)) * 100}%` }}
                      />

                      {/* Tick Marks Along Track */}
                      {OUTLINE_WIDTH_STEPS.map((step, idx) => {
                        const pct = (idx / (OUTLINE_WIDTH_STEPS.length - 1)) * 100;
                        const isStandard = step.id === 'thick';
                        const isPassed = idx <= currOutlineIndex;

                        return (
                          <div
                            key={step.id}
                            className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none"
                            style={{ left: `${pct}%` }}
                          >
                            {isStandard ? (
                              // Prominent Visual Dot for Standard Size (3px)
                              <div className="relative flex items-center justify-center">
                                {/* Subtle Glowing Halo around standard point */}
                                <div className="w-4 h-4 rounded-full bg-amber-400/25 absolute animate-pulse" />
                                {/* Solid Visual Dot Indicator */}
                                <div
                                  className={`w-2.5 h-2.5 rounded-full border border-black shadow-md transition-colors ${
                                    isPassed ? 'bg-white' : 'bg-amber-400'
                                  }`}
                                  title="Standard default size (3px)"
                                />
                              </div>
                            ) : (
                              // Subtle Dot for other steps
                              <div
                                className={`w-1.5 h-1.5 rounded-full transition-colors ${
                                  isPassed ? 'bg-zinc-950/70' : 'bg-zinc-600'
                                }`}
                              />
                            )}
                          </div>
                        );
                      })}

                      {/* Slider Thumb */}
                      <div
                        className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-white shadow-md border-2 border-amber-500 pointer-events-none transition-transform duration-75 hover:scale-110"
                        style={{ left: `${(currOutlineIndex / (OUTLINE_WIDTH_STEPS.length - 1)) * 100}%` }}
                      />
                    </div>

                    {/* Native Accessible Range Slider Overlay */}
                    <input
                      type="range"
                      min={0}
                      max={OUTLINE_WIDTH_STEPS.length - 1}
                      step={1}
                      value={currOutlineIndex}
                      onChange={(e) => {
                        const val = parseInt(e.target.value, 10);
                        const selected = OUTLINE_WIDTH_STEPS[val];
                        if (selected) {
                          onUpdateOutlineWidth?.(selected.id);
                        }
                      }}
                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-20"
                      aria-label="Outline Thickness"
                    />
                  </div>

                  {/* Labels Below the Slider with Standard Marker */}
                  <div className="flex justify-between items-center text-[10px] text-zinc-500 font-mono px-0.5 select-none">
                    {OUTLINE_WIDTH_STEPS.map((step, idx) => {
                      const isStandard = step.id === 'thick';
                      const isSelected = idx === currOutlineIndex;

                      return (
                        <button
                          key={step.id}
                          type="button"
                          onClick={() => onUpdateOutlineWidth?.(step.id)}
                          className={`transition-colors cursor-pointer hover:text-zinc-200 ${
                            isSelected
                              ? 'text-white font-bold'
                              : isStandard
                              ? 'text-amber-400 font-semibold'
                              : 'text-zinc-500'
                          }`}
                        >
                          {isStandard ? (
                            <span className="flex items-center space-x-1">
                              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block" />
                              <span>Standard (3px)</span>
                            </span>
                          ) : step.id === 'none' ? (
                            'Off'
                          ) : (
                            `${step.px}px`
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Outline Color */}
                <div className="space-y-2">
                  <div className="flex items-center space-x-1.5 text-xs font-bold text-zinc-300">
                    <Palette className="w-4 h-4 text-zinc-400" />
                    <span>Outline Shadow Color</span>
                  </div>
                  <div className="grid grid-cols-5 gap-2">
                    {OUTLINE_COLOR_OPTIONS.map((oc) => {
                      const isSelected = (outlineColor || '#000000').toLowerCase() === oc.id.toLowerCase();
                      return (
                        <button
                          key={oc.id}
                          onClick={() => onUpdateOutlineColor?.(oc.id)}
                          className={`flex flex-col items-center justify-center p-2 rounded-xl border text-center transition-all ${
                            isSelected
                              ? 'bg-white/10 border-white text-white font-bold shadow-sm'
                              : 'bg-zinc-900/70 border-zinc-800 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                          }`}
                        >
                          <span
                            className="w-4 h-4 rounded-full border border-white/20 shadow-sm mb-1"
                            style={{ backgroundColor: oc.color }}
                          />
                          <span className="text-[10px] truncate max-w-[60px]">{oc.label.split(' ')[0]}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Right Column: Font Family & Background Style */}
              <div className="space-y-4">
                {/* Font Family Selection */}
                <div className="space-y-2">
                  <div className="flex items-center space-x-1.5 text-xs font-bold text-zinc-300">
                    <Type className="w-4 h-4 text-purple-400" />
                    <span>Font Family</span>
                  </div>
                  <div className="grid grid-cols-1 gap-1.5 max-h-44 overflow-y-auto pr-1">
                    {FONT_OPTIONS.map((f) => {
                      const isSelected = (fontFamily || 'sans') === f.id;
                      return (
                        <button
                          key={f.id}
                          onClick={() => onUpdateFontFamily?.(f.id)}
                          className={`flex items-center justify-between p-2 rounded-xl border text-left text-xs transition-all ${
                            isSelected
                              ? 'bg-purple-600/20 border-purple-500/60 text-white font-semibold'
                              : 'bg-zinc-900/70 border-zinc-800 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                          }`}
                        >
                          <span style={{ fontFamily: FONT_FAMILIES[f.id] }}>{f.label}</span>
                          <span className="text-[10px] text-zinc-500 font-mono">{f.sample}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Background Backdrop Style */}
                <div className="space-y-2">
                  <div className="flex items-center space-x-1.5 text-xs font-bold text-zinc-300">
                    <Layers className="w-4 h-4 text-indigo-400" />
                    <span>Background Backdrop</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {BG_OPTIONS.map((b) => {
                      const isSelected = (bgStyle || 'none') === b.id;
                      return (
                        <button
                          key={b.id}
                          onClick={() => onUpdateBgStyle?.(b.id)}
                          className={`p-2.5 rounded-xl border text-left text-xs transition-all ${
                            isSelected
                              ? 'bg-indigo-600/20 border-indigo-500/60 text-white font-semibold'
                              : 'bg-zinc-900/70 border-zinc-800 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                          }`}
                        >
                          <div className="font-medium text-[11px] text-zinc-200">{b.label}</div>
                          <div className="text-[10px] text-zinc-500">{b.desc}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>

            {/* Styling Footer Actions */}
            <div className="pt-4 border-t border-zinc-800/80 flex items-center justify-between">
              <button
                onClick={onResetSubtitleStyle}
                className="flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-red-400 border border-zinc-800 text-xs font-medium transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reset to Defaults (38px, White, Clean)</span>
              </button>

              <div className="flex items-center space-x-2.5">
                <button
                  onClick={() => setActiveTab('tracks')}
                  className="flex items-center space-x-1.5 px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-100 hover:text-white border border-white/10 text-xs font-semibold transition-all shadow-sm active:scale-95 cursor-pointer"
                >
                  <span>← Back to Audio & Subtitles</span>
                </button>
                <button
                  onClick={handleClose}
                  className="px-5 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold transition-all shadow-md shadow-red-600/20 active:scale-95 cursor-pointer"
                  aria-label="Done (Close subtitle styling customizer)"
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};