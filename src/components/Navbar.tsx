import React, { useEffect, useRef, useState } from 'react';
import { House, Compass, Film, CalendarDays, HardDrive, Sparkles, Settings as SettingsIcon, ShieldCheck, ShieldAlert, Search, Bell, CheckCheck, Trash2, Download, Radio, History, AlertTriangle, Minus, Square, Copy, X } from 'lucide-react';
import { useCatalogSearch, type RailItem } from '../hooks/useCatalog';
import type { AppNotification } from '../types/notifications';

export type AppTab = 'home' | 'discover' | 'library' | 'schedule' | 'downloads' | 'whisper';

// Titles opened through the navbar search, newest first (persisted locally).
const RECENT_SEARCHES_KEY = 'anime-center.recent-searches.v1';
const RECENT_SEARCHES_LIMIT = 3;

function loadRecentSearches(): RailItem[] {
  try {
    const raw = localStorage.getItem(RECENT_SEARCHES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => item && typeof item.anilistId === 'number' && typeof item.title === 'string');
  } catch {
    return [];
  }
}

interface NavbarProps {
  currentTab: AppTab;
  /** Artwork softly visible beneath the translucent title bar. */
  backdropImage?: string | null;
  backdropMode?: 'ambient' | 'anime';
  /** 1 while the source hero is in view, fading to 0 as it scrolls away. */
  backdropProgress?: number;
  onSelectTab: (tab: AppTab) => void;
  onOpenSettings: () => void;
  onSelectSearchItem: (item: RailItem) => void;
  isWhisperActive: boolean;
  /** True while a P2P download is running: Downloads tab gets a beam, status pill hides. */
  downloadsActive: boolean;
  /** P2P status pill rendered before the Settings button (Phase 5). */
  p2pIndicator: {
    enabled: boolean;
    /** Status text shown in the pill. */
    status: string;
    /** Icon name shown in the pill. */
    icon: string;
    /** Color class for the pill background. */
    bgColor: string;
    /** Color class for the pill text. */
    textColor: string;
  };
  notifications: AppNotification[];
  onNotificationRead: (id: string) => void;
  onDismissNotification: (id: string) => void;
  onMarkAllNotificationsRead: () => void;
  onClearNotifications: () => void;
  onNotificationAction: (item: AppNotification) => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  currentTab,
  backdropImage,
  backdropMode,
  backdropProgress = 1,
  onSelectTab,
  onOpenSettings,
  onSelectSearchItem,
  isWhisperActive,
  downloadsActive,
  p2pIndicator,
  notifications,
  onNotificationRead,
  onDismissNotification,
  onMarkAllNotificationsRead,
  onClearNotifications,
  onNotificationAction,
}) => {
  const [query, setQuery] = useState('');
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [windowMaximized, setWindowMaximized] = useState(false);
  const [recentSearches, setRecentSearches] = useState<RailItem[]>(() => loadRecentSearches());
  const searchBoxRef = useRef<HTMLDivElement>(null);
  const notificationsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let mounted = true;
    window.electronAPI?.isWindowMaximized().then((value) => {
      if (mounted) setWindowMaximized(value);
    }).catch(() => {});
    const unsubscribe = window.electronAPI?.onWindowMaximizedChange((value) => setWindowMaximized(value));
    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, []);
  // Hover prefetch for search/recent rows: a resting cursor (200 ms) warms
  // the episodes pipeline before the click; moving through the list cancels.
  const warmTimersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const armWarm = (anilistId: number) => {
    if (warmTimersRef.current.has(anilistId)) return;
    const timer = setTimeout(() => {
      warmTimersRef.current.delete(anilistId);
      window.electronAPI?.warmRemoteEpisodes?.(anilistId);
    }, 200);
    warmTimersRef.current.set(anilistId, timer);
  };
  const cancelWarm = (anilistId: number) => {
    const timer = warmTimersRef.current.get(anilistId);
    if (timer) {
      clearTimeout(timer);
      warmTimersRef.current.delete(anilistId);
    }
  };
  const { results, loading } = useCatalogSearch(query);
  const unreadCount = notifications.filter((item) => !item.read).length;
  const notificationTone = (item: AppNotification) => item.tone || (
    item.kind === 'airing' ? (item.finalEpisode ? 'purple' : 'green')
      : item.kind === 'follow' ? 'green'
      : item.kind === 'whisper' ? 'purple'
        : item.state === 'error' ? 'red'
          : item.state === 'completed' ? 'green' : 'cyan'
  );
  const toneClasses: Record<string, { icon: string; card: string }> = {
    green: { icon: 'bg-emerald-400/10 text-emerald-300', card: 'border-emerald-400/15' },
    purple: { icon: 'bg-violet-400/10 text-violet-300', card: 'border-violet-400/20' },
    blue: { icon: 'bg-sky-400/10 text-sky-300', card: 'border-sky-400/15' },
    red: { icon: 'bg-red-400/10 text-red-300', card: 'border-red-400/15' },
    amber: { icon: 'bg-amber-400/10 text-amber-300', card: 'border-amber-400/15' },
    cyan: { icon: 'bg-cyan-400/10 text-cyan-300', card: 'border-cyan-400/15' },
  };

  const recordRecentSearch = (item: RailItem) => {
    setRecentSearches((prev) => {
      const next = [item, ...prev.filter((entry) => entry.anilistId !== item.anilistId)].slice(0, RECENT_SEARCHES_LIMIT);
      try { localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  };

  // Click anywhere outside a panel (or Escape) closes it. Both panels are
  // mutually exclusive: opening one dismisses the other.
  useEffect(() => {
    if (!searchOpen && !notificationsOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (searchOpen && searchBoxRef.current && !searchBoxRef.current.contains(target)) setSearchOpen(false);
      if (notificationsOpen && notificationsRef.current && !notificationsRef.current.contains(target)) setNotificationsOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSearchOpen(false);
        setNotificationsOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [searchOpen, notificationsOpen]);

  return (
    <header
      className={`isolate relative z-50 flex h-[72px] shrink-0 select-none items-center justify-between gap-6 border-b border-white/[0.08] pl-8 [-webkit-app-region:drag] [&>*]:[-webkit-app-region:no-drag] ${backdropImage ? 'bg-[#101116]/45 backdrop-blur-xl' : 'bg-[#101116]/95 backdrop-blur-2xl'}`}
    >
      {backdropImage && (
        <div aria-hidden className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
          <img
            src={backdropImage}
            alt=""
            loading="eager"
            decoding="async"
            className={`absolute inset-0 h-full w-full scale-125 object-cover ${backdropMode === 'anime' ? 'blur-[7px] saturate-125' : 'blur-[14px] saturate-150'}`}
            style={{
              opacity: (backdropMode === 'anime' ? 0.4 : 0.25) * Math.max(0, Math.min(1, backdropProgress)),
              transform: `scale(1.25) translateY(${(Math.max(0, Math.min(1, backdropProgress)) - 1) * 72}px)`,
              transition: 'opacity 120ms linear, transform 120ms linear',
            }}
          />
          <div
            className="absolute inset-0"
            style={{
              backgroundColor: `rgba(16,17,22,${backdropMode === 'anime' ? 0.45 + (1 - backdropProgress) * 0.45 : 0.7 + (1 - backdropProgress) * 0.25})`,
              transition: 'background-color 120ms linear',
            }}
          />
          <div className="absolute inset-0 bg-gradient-to-b from-[#101116]/20 via-transparent to-[#101116]/35" />
        </div>
      )}
      {/* Brand Logo & Name */}
      <div className="relative z-10 flex cursor-pointer items-center space-x-3" onClick={() => onSelectTab('home')}>
        <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-rose-300/20 bg-gradient-to-br from-rose-500/35 via-violet-700/25 to-cyan-300/20 shadow-lg shadow-rose-950/40">
            <img src="./kaiko-mark.svg" alt="" draggable={false} className="h-full w-full object-cover" />
        </div>
        <div className="flex items-center space-x-2">
          <span className="font-bold tracking-tight text-xl text-zinc-100">
            Kai<span className="text-rose-400">ko</span>
          </span>
        </div>
      </div>

      <div ref={searchBoxRef} className="relative z-10 hidden min-w-[220px] max-w-[440px] flex-1 xl:block 2xl:mx-3">
        <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onFocus={() => { setSearchOpen(true); setNotificationsOpen(false); }}
          placeholder="Search anime or episodes..."
          className="w-full rounded-full border border-white/[0.08] bg-[#0b0c10]/75 py-2.5 pl-11 pr-4 text-xs text-zinc-200 shadow-inner outline-none transition placeholder:text-zinc-500 focus:border-rose-400/40 focus:ring-2 focus:ring-rose-500/15"
        />
        {searchOpen && !query.trim() && recentSearches.length > 0 && <div className="absolute left-0 right-0 top-full z-50 mt-2 overflow-hidden rounded-2xl border border-white/10 bg-[#141620]/[0.98] p-1.5 shadow-2xl backdrop-blur-xl">
          <p className="flex items-center gap-1.5 px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-wider text-zinc-500"><History className="h-3 w-3" /> Recent</p>
          {recentSearches.map((item) => <button key={item.anilistId} onClick={() => { recordRecentSearch(item); onSelectSearchItem(item); setQuery(''); setSearchOpen(false) }} onMouseEnter={() => armWarm(item.anilistId)} onMouseLeave={() => cancelWarm(item.anilistId)} className="flex w-full items-center gap-3 rounded-xl p-2 text-left transition hover:bg-white/[0.07]">
            <span className="h-12 w-9 shrink-0 overflow-hidden rounded-md bg-zinc-900">{item.posterUrl && <img src={item.posterUrl} alt="" className="h-full w-full object-cover" />}</span>
            <span className="min-w-0"><span className="block truncate text-xs font-semibold text-zinc-100">{item.title}</span><span className="mt-1 block text-[10px] text-zinc-500">{item.seasonYear ?? 'Anime'}{item.format ? ` · ${item.format}` : ''}</span></span>
          </button>)}
        </div>}
        {searchOpen && query.trim() && <div className="absolute left-0 right-0 top-full z-50 mt-2 overflow-hidden rounded-2xl border border-white/10 bg-[#141620]/[0.98] p-1.5 shadow-2xl backdrop-blur-xl">
          {loading ? <p className="px-3 py-4 text-xs text-zinc-500">Searching…</p> : results.length === 0 ? <p className="px-3 py-4 text-xs text-zinc-500">No matching anime</p> : results.slice(0, 7).map((item) => <button key={item.anilistId} onClick={() => { recordRecentSearch(item); onSelectSearchItem(item); setQuery(''); setSearchOpen(false) }} onMouseEnter={() => armWarm(item.anilistId)} onMouseLeave={() => cancelWarm(item.anilistId)} className="flex w-full items-center gap-3 rounded-xl p-2 text-left transition hover:bg-white/[0.07]">
            <span className="h-12 w-9 shrink-0 overflow-hidden rounded-md bg-zinc-900">{item.posterUrl && <img src={item.posterUrl} alt="" className="h-full w-full object-cover" />}</span>
            <span className="min-w-0"><span className="block truncate text-xs font-semibold text-zinc-100">{item.title}</span><span className="mt-1 block text-[10px] text-zinc-500">{item.seasonYear ?? 'Anime'}{item.format ? ` · ${item.format}` : ''}</span></span>
          </button>)}
        </div>}
      </div>

      {/* Main Navigation Tabs */}
      <nav className="relative z-10 flex items-center gap-1 rounded-full border border-white/[0.08] bg-black/25 p-1.5 shadow-inner shadow-black/30">
        <button
          onClick={() => onSelectTab('home')}
          className={`flex items-center space-x-2 px-4 py-1.5 rounded-md rounded-l-full text-sm font-medium transition-all ${
            currentTab === 'home'
              ? 'bg-rose-500 text-white shadow-[0_0_22px_rgba(244,63,94,0.32)]'
              : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-100'
          }`}
        >
          <House className="w-4 h-4" />
          <span>Home</span>
        </button>

        <button
          onClick={() => onSelectTab('discover')}
          className={`flex items-center space-x-2 rounded-md px-4 py-1.5 text-sm font-medium transition-all ${
            currentTab === 'discover'
              ? 'bg-rose-500 text-white shadow-[0_0_22px_rgba(244,63,94,0.32)]'
              : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-100'
          }`}
        >
          <Compass className="h-4 w-4" />
          <span>Discover</span>
        </button>

        <button
          onClick={() => onSelectTab('library')}
          className={`flex items-center space-x-2 px-4 py-1.5 rounded-md text-sm font-medium transition-all ${
            currentTab === 'library'
              ? 'bg-rose-500 text-white shadow-[0_0_22px_rgba(244,63,94,0.32)]'
              : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-100'
          }`}
        >
          <Film className="w-4 h-4" />
          <span>Library</span>
        </button>

        <button
          onClick={() => onSelectTab('schedule')}
          className={`flex items-center space-x-2 px-4 py-1.5 rounded-md text-sm font-medium transition-all ${
            currentTab === 'schedule'
              ? 'bg-rose-500 text-white shadow-[0_0_22px_rgba(244,63,94,0.32)]'
              : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-100'
          }`}
        >
          <CalendarDays className="w-4 h-4" />
          <span>Schedule</span>
        </button>

        <button
          onClick={() => onSelectTab('downloads')}
          className={`relative flex items-center space-x-2 px-4 py-1.5 rounded-md text-sm font-medium transition-all ${
            currentTab === 'downloads'
              ? 'bg-rose-500 text-white shadow-[0_0_22px_rgba(244,63,94,0.32)]'
              : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-100'
          } ${downloadsActive ? 'shadow-[0_0_18px_rgba(34,211,238,0.35)]' : ''}`}
        >
          {downloadsActive && (
            <span aria-hidden className="download-beam-mask">
              <span className="download-beam-arc" />
            </span>
          )}
          <HardDrive className="w-4 h-4" />
          <span>Downloads</span>
        </button>

        <button
          onClick={() => onSelectTab('whisper')}
          className={`relative flex items-center space-x-2 px-4 py-1.5 rounded-md rounded-r-full text-sm font-medium transition-all ${
            currentTab === 'whisper'
              ? 'border border-violet-500/20 bg-violet-500/[0.08] text-violet-200'
              : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-100'
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
      <div className="relative z-10 flex items-center space-x-3">
        {p2pIndicator?.enabled && !downloadsActive && p2pIndicator.status !== 'Idle' && (
          <div
            title={p2pIndicator.status}
            className={`hidden sm:flex items-center space-x-1.5 px-2.5 py-1 rounded-full border text-xs font-medium transition-colors ${p2pIndicator.bgColor} ${p2pIndicator.textColor}`}
          >
            {p2pIndicator.icon === 'ShieldCheck' ? (
              <ShieldCheck className="w-3.5 h-3.5" />
            ) : p2pIndicator.icon === 'ShieldAlert' ? (
              <ShieldAlert className="w-3.5 h-3.5" />
            ) : p2pIndicator.icon === 'HardDrive' ? (
              <HardDrive className="w-3.5 h-3.5" />
            ) : null}
            <span>{p2pIndicator.status}</span>
          </div>
        )}

        <div ref={notificationsRef} className="relative">
          <button
            type="button"
            onClick={() => { setNotificationsOpen((open) => !open); setSearchOpen(false); }}
            title={unreadCount ? `${unreadCount} unread notifications` : 'Notifications'}
            aria-label="Notifications"
            className="relative rounded-lg p-2 text-zinc-400 transition hover:bg-zinc-800/80 hover:text-white"
          >
            <Bell className="h-5 w-5" />
            {unreadCount > 0 && <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-rose-400 ring-2 ring-[#101116]" />}
          </button>
          {notificationsOpen && (
            <div className="absolute right-0 top-full z-[80] mt-3 w-[min(92vw,390px)] overflow-hidden rounded-2xl border border-white/10 bg-[#141620] shadow-2xl shadow-black/60">
              <div className="flex items-center justify-between border-b border-white/[0.08] px-4 py-3">
                <div>
                  <p className="text-sm font-bold text-white">Notifications</p>
                  <p className="mt-0.5 text-[10px] text-zinc-500">{unreadCount ? `${unreadCount} unread` : 'You’re all caught up'}</p>
                </div>
                <div className="flex items-center gap-1">
                  <button type="button" onClick={onMarkAllNotificationsRead} title="Mark all as read" className="rounded-lg p-2 text-zinc-500 transition hover:bg-white/[0.06] hover:text-zinc-200"><CheckCheck className="h-4 w-4" /></button>
                  <button type="button" onClick={onClearNotifications} title="Clear notifications" className="rounded-lg p-2 text-zinc-500 transition hover:bg-white/[0.06] hover:text-rose-300"><Trash2 className="h-4 w-4" /></button>
                </div>
              </div>
              <div className="max-h-[min(65vh,520px)] overflow-y-auto p-2">
                {notifications.length === 0 ? (
                  <p className="px-4 py-10 text-center text-xs text-zinc-500">Download and airing updates will appear here.</p>
                ) : notifications.map((item) => (
                  <div key={item.id} className={`mb-1 flex gap-3 rounded-xl border p-3 ${toneClasses[notificationTone(item)]?.card || 'border-white/[0.06]'} ${item.read ? 'bg-transparent' : 'bg-white/[0.04]'}`}>
                    <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${toneClasses[notificationTone(item)]?.icon || 'bg-zinc-400/10 text-zinc-300'}`}>
                      {item.kind === 'airing' ? (
                        <Radio className="h-4 w-4" />
                      ) : item.kind === 'follow' ? (
                        <Bell className="h-4 w-4" />
                      ) : item.kind === 'whisper' ? (
                        <Sparkles className="h-4 w-4" />
                      ) : item.state === 'error' ? (
                        <AlertTriangle className="h-4 w-4" />
                      ) : (
                        <Download className="h-4 w-4" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold text-zinc-100">{item.title}</p>
                      <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">{item.message}</p>
                      {item.kind === 'download' && item.state === 'downloading' && item.progress != null && (
                        <div className="mt-1.5 flex items-center gap-2">
                          <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/10">
                            <div className="h-full rounded-full bg-gradient-to-r from-rose-500 to-cyan-300 transition-all" style={{ width: `${Math.max(3, Math.min(100, item.progress))}%` }} />
                          </div>
                          <span className="font-mono text-[10px] text-zinc-400">{Math.round(item.progress)}%</span>
                        </div>
                      )}
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <span className="text-[10px] text-zinc-600">{new Date(item.createdAt).toLocaleString()}</span>
                        {item.kind === 'airing' && item.anilistId && item.episode ? (
                          <button type="button" onClick={() => { onNotificationRead(item.id); onNotificationAction(item); setNotificationsOpen(false); }} className={`rounded-lg px-2.5 py-1 text-[10px] font-bold transition ${item.finalEpisode ? 'bg-violet-400/10 text-violet-200 hover:bg-violet-400/20' : 'bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/20'}`}>Find EP {item.episode}</button>
                        ) : item.kind === 'download' ? (
                          <button type="button" onClick={() => { onNotificationRead(item.id); onNotificationAction(item); setNotificationsOpen(false); }} className="rounded-lg bg-emerald-400/10 px-2.5 py-1 text-[10px] font-bold text-emerald-200 transition hover:bg-emerald-400/20">Downloads</button>
                        ) : item.kind === 'whisper' ? (
                          <button type="button" onClick={() => { onNotificationRead(item.id); onNotificationAction(item); setNotificationsOpen(false); }} className="rounded-lg bg-indigo-400/10 px-2.5 py-1 text-[10px] font-bold text-indigo-200 transition hover:bg-indigo-400/20">Whisper Studio</button>
                        ) : item.kind !== 'follow' && !item.read ? (
                          <button type="button" onClick={() => onNotificationRead(item.id)} className="text-[10px] font-semibold text-zinc-500 hover:text-zinc-200">Mark read</button>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-start gap-1">
                      {!item.read && <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-rose-400" />}
                      <button type="button" onClick={() => onDismissNotification(item.id)} title="Dismiss notification" aria-label={`Dismiss ${item.title}`} className="-mr-1 -mt-1 rounded-md p-1 text-zinc-600 transition hover:bg-white/[0.08] hover:text-zinc-200"><X className="h-3.5 w-3.5" /></button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <button
          onClick={onOpenSettings}
          title="App Settings"
          className="p-2 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800/80 transition-colors"
        >
          <SettingsIcon className="w-5 h-5" />
        </button>
      </div>

      <div aria-label="Window controls" className="relative z-10 flex h-10 shrink-0 self-start items-stretch overflow-hidden [-webkit-app-region:no-drag]">
        <button
          type="button"
          onClick={() => { void window.electronAPI?.minimizeWindow(); }}
          title="Minimize"
          aria-label="Minimize window"
          className="flex w-[46px] items-center justify-center text-zinc-300/75 transition-colors hover:bg-white/[0.08] hover:text-white [-webkit-app-region:no-drag]"
        >
          <Minus className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => { void window.electronAPI?.toggleMaximizeWindow().then(setWindowMaximized); }}
          title={windowMaximized ? 'Restore' : 'Maximize'}
          aria-label={windowMaximized ? 'Restore window' : 'Maximize window'}
          className="flex w-[46px] items-center justify-center text-zinc-300/75 transition-colors hover:bg-white/[0.08] hover:text-white [-webkit-app-region:no-drag]"
        >
          {windowMaximized ? <Copy className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          onClick={() => { void window.electronAPI?.closeWindow(); }}
          title="Close"
          aria-label="Close window"
          className="flex w-[46px] items-center justify-center text-zinc-300/75 transition-colors hover:bg-rose-500 hover:text-white [-webkit-app-region:no-drag]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
};
