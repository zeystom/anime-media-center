import React from 'react';
import { House, Film, CalendarDays, HardDrive, Sparkles, Settings as SettingsIcon, Terminal, Clapperboard, ShieldCheck, ShieldAlert } from 'lucide-react';

export type AppTab = 'home' | 'library' | 'schedule' | 'downloads' | 'whisper';

/** VPN/P2P status pill shown in the navbar while the P2P engine is enabled. */
export interface P2pIndicatorState {
  enabled: boolean;
  /** true = VPN tunnel detected, false = no VPN detected, null = unknown/checking. */
  vpnActive: boolean | null;
}

interface NavbarProps {
  currentTab: AppTab;
  onSelectTab: (tab: AppTab) => void;
  onOpenSettings: () => void;
  isWhisperActive: boolean;
  /** Optional P2P status pill rendered before the Settings button (Phase 5). */
  p2pIndicator?: P2pIndicatorState;
}

export const Navbar: React.FC<NavbarProps> = ({
  currentTab,
  onSelectTab,
  onOpenSettings,
  isWhisperActive,
  p2pIndicator,
}) => {
  return (
    <header className="h-14 border-b border-zinc-800/80 bg-[#121216] px-6 flex items-center justify-between z-30 select-none">
      {/* Brand Logo & Name */}
      <div className="flex items-center space-x-3 cursor-pointer" onClick={() => onSelectTab('home')}>
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
          onClick={() => onSelectTab('home')}
          className={`flex items-center space-x-2 px-4 py-1.5 rounded-md text-sm font-medium transition-all ${
            currentTab === 'home'
              ? 'bg-zinc-800 text-white shadow-sm'
              : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
          }`}
        >
          <House className="w-4 h-4" />
          <span>Home</span>
        </button>

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
          onClick={() => onSelectTab('schedule')}
          className={`flex items-center space-x-2 px-4 py-1.5 rounded-md text-sm font-medium transition-all ${
            currentTab === 'schedule'
              ? 'bg-zinc-800 text-white shadow-sm'
              : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
          }`}
        >
          <CalendarDays className="w-4 h-4" />
          <span>Schedule</span>
        </button>

        <button
          onClick={() => onSelectTab('downloads')}
          className={`flex items-center space-x-2 px-4 py-1.5 rounded-md text-sm font-medium transition-all ${
            currentTab === 'downloads'
              ? 'bg-zinc-800 text-white shadow-sm'
              : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
          }`}
        >
          <HardDrive className="w-4 h-4" />
          <span>Downloads</span>
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

        {p2pIndicator?.enabled && (
          <div
            title={
              p2pIndicator.vpnActive === true
                ? 'P2P is enabled — VPN tunnel detected. Torrent traffic goes through the VPN.'
                : p2pIndicator.vpnActive === false
                ? 'P2P is enabled but no VPN tunnel was detected. Your real IP may be visible to peers and your ISP.'
                : 'P2P is enabled — VPN status is being checked.'
            }
            className={`hidden sm:flex items-center space-x-1.5 px-2.5 py-1 rounded-full border text-xs font-medium transition-colors ${
              p2pIndicator.vpnActive === true
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                : p2pIndicator.vpnActive === false
                ? 'bg-red-500/10 border-red-500/30 text-red-300'
                : 'bg-amber-500/10 border-amber-500/30 text-amber-300'
            }`}
          >
            {p2pIndicator.vpnActive === true ? (
              <ShieldCheck className="w-3.5 h-3.5" />
            ) : (
              <ShieldAlert className="w-3.5 h-3.5" />
            )}
            <span>
              {p2pIndicator.vpnActive === true
                ? 'VPN'
                : p2pIndicator.vpnActive === false
                ? 'No VPN'
                : 'P2P'}
            </span>
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
