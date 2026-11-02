import React from 'react';
import { Film, Sparkles, Settings as SettingsIcon, Terminal, Clapperboard } from 'lucide-react';

interface NavbarProps {
  currentTab: 'library' | 'whisper';
  onSelectTab: (tab: 'library' | 'whisper') => void;
  onOpenSettings: () => void;
  isWhisperActive: boolean;
}

export const Navbar: React.FC<NavbarProps> = ({
  currentTab,
  onSelectTab,
  onOpenSettings,
  isWhisperActive,
}) => {
  return (
    <header className="h-14 border-b border-zinc-800/80 bg-[#121216] px-6 flex items-center justify-between z-30 select-none">
      {/* Brand Logo & Name */}
      <div className="flex items-center space-x-3 cursor-pointer" onClick={() => onSelectTab('library')}>
        <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-red-600 to-indigo-600 flex items-center justify-center shadow-lg shadow-red-600/20">
          <Clapperboard className="w-4 h-4 text-white" />
        </div>
        <div className="flex items-center space-x-2">
          <span className="font-bold tracking-tight text-base text-zinc-100">
            Anime<span className="text-red-500">Center</span>
          </span>
        </div>
      </div>

      {/* Main Navigation Tabs */}
      <nav className="flex items-center space-x-1 bg-zinc-900/80 p-1 rounded-lg border border-zinc-800">
        <button
          onClick={() => onSelectTab('library')}
          className={`flex items-center space-x-2 px-4 py-1.5 rounded-md text-sm font-medium transition-all ${
            currentTab === 'library'
              ? 'bg-zinc-800 text-white shadow-sm'
              : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
          }`}
        >
          <Film className="w-4 h-4" />
          <span>Library</span>
        </button>

        <button
          onClick={() => onSelectTab('whisper')}
          className={`relative flex items-center space-x-2 px-4 py-1.5 rounded-md text-sm font-medium transition-all ${
            currentTab === 'whisper'
              ? 'bg-zinc-800 text-white shadow-sm'
              : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
          }`}
        >
          <Sparkles className="w-4 h-4 text-indigo-400" />
          <span>Whisper Studio</span>
          {isWhisperActive && (
            <span className="flex h-2 w-2 relative">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500"></span>
            </span>
          )}
        </button>
      </nav>

      {/* Right Action Icons */}
      <div className="flex items-center space-x-3">
        {isWhisperActive && (
          <div
            onClick={() => onSelectTab('whisper')}
            className="hidden sm:flex items-center space-x-2 px-2.5 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/30 text-indigo-300 text-xs font-medium cursor-pointer hover:bg-indigo-500/20 transition-colors"
          >
            <Terminal className="w-3.5 h-3.5 animate-pulse" />
            <span>Transcribing in background</span>
          </div>
        )}

        <button
          onClick={onOpenSettings}
          title="App Settings"
          className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800/80 transition-colors"
        >
          <SettingsIcon className="w-5 h-5" />
        </button>
      </div>
    </header>
  );
};
