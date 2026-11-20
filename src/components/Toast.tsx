import React, {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Download,
  Info,
  Radio,
  Sparkles,
  X,
} from 'lucide-react';
import type { NotificationKind } from '../types/notifications';

export type ToastType = 'info' | 'success' | 'warning' | 'error' | 'purple';

export interface ToastOptions {
  title?: string;
  actionLabel?: string;
  onAction?: () => void;
  posterUrl?: string | null;
  kind?: NotificationKind;
  notificationId?: string;
  onMarkRead?: () => void;
}

export interface ToastItem extends ToastOptions {
  id: string;
  message: string;
  type: ToastType;
  duration?: number;
  createdAt: number;
}

interface ToastContextValue {
  showToast: (
    message: string,
    type?: ToastType,
    duration?: number,
    options?: ToastOptions
  ) => void;
  toast: {
    info: (message: string, duration?: number, options?: ToastOptions) => void;
    success: (message: string, duration?: number, options?: ToastOptions) => void;
    warning: (message: string, duration?: number, options?: ToastOptions) => void;
    error: (message: string, duration?: number, options?: ToastOptions) => void;
  };
}

interface BellAnchor {
  anchored: boolean;
  top: number;
  right: number;
  caretRight: number;
}

const DEFAULT_DURATION_MS = 4400;
const MAX_VISIBLE_TOASTS = 4;

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

type ToastListener = (toast: ToastItem) => void;
type DrawerListener = (isOpen: boolean) => void;

const listeners = new Set<ToastListener>();
const arrivalListeners = new Set<ToastListener>();
const drawerListeners = new Set<DrawerListener>();
let notificationDrawerOpenState = false;

export function setNotificationDrawerOpen(isOpen: boolean): void {
  if (notificationDrawerOpenState === isOpen) return;
  notificationDrawerOpenState = isOpen;
  drawerListeners.forEach((listener) => listener(isOpen));
}

export function subscribeToastArrival(callback: ToastListener): () => void {
  arrivalListeners.add(callback);
  return () => {
    arrivalListeners.delete(callback);
  };
}

export function showGlobalToast(
  message: string,
  type: ToastType = 'info',
  duration: number = DEFAULT_DURATION_MS,
  options?: ToastOptions
): void {
  const item: ToastItem = {
    id: `toast-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    message,
    type,
    duration,
    createdAt: Date.now(),
    ...options,
  };
  arrivalListeners.forEach((listener) => listener(item));
  if (notificationDrawerOpenState) {
    // User already has the bell notification panel open — avoid overlapping it.
    return;
  }
  listeners.forEach((listener) => listener(item));
}

const TYPE_STYLES: Record<
  ToastType,
  {
    border: string;
    glow: string;
    iconBox: string;
    bar: string;
    pill: string;
    caretBorder: string;
  }
> = {
  error: {
    border: 'border-rose-500/40 hover:border-rose-400/60',
    glow: 'from-rose-500/15 via-rose-500/5 to-transparent',
    iconBox: 'bg-rose-500/20 text-rose-200 border-rose-500/35',
    bar: 'from-rose-500 to-pink-400',
    pill: 'bg-rose-500/20 text-rose-100 border-rose-400/35 group-hover:bg-rose-500/30',
    caretBorder: 'border-rose-500/40',
  },
  warning: {
    border: 'border-amber-500/40 hover:border-amber-400/60',
    glow: 'from-amber-500/15 via-amber-500/5 to-transparent',
    iconBox: 'bg-amber-500/20 text-amber-200 border-amber-500/35',
    bar: 'from-amber-400 to-orange-400',
    pill: 'bg-amber-500/20 text-amber-100 border-amber-400/35 group-hover:bg-amber-500/30',
    caretBorder: 'border-amber-500/40',
  },
  success: {
    border: 'border-emerald-500/40 hover:border-emerald-400/60',
    glow: 'from-emerald-500/15 via-emerald-500/5 to-transparent',
    iconBox: 'bg-emerald-500/20 text-emerald-200 border-emerald-500/35',
    bar: 'from-emerald-400 to-teal-400',
    pill: 'bg-emerald-500/20 text-emerald-100 border-emerald-400/35 group-hover:bg-emerald-500/30',
    caretBorder: 'border-emerald-500/40',
  },
  purple: {
    border: 'border-violet-500/40 hover:border-violet-400/60',
    glow: 'from-violet-500/15 via-fuchsia-500/5 to-transparent',
    iconBox: 'bg-violet-500/20 text-violet-200 border-violet-500/35',
    bar: 'from-violet-400 to-fuchsia-400',
    pill: 'bg-violet-500/20 text-violet-100 border-violet-400/35 group-hover:bg-violet-500/30',
    caretBorder: 'border-violet-500/40',
  },
  info: {
    border: 'border-sky-400/35 hover:border-rose-400/50',
    glow: 'from-sky-500/15 via-indigo-500/5 to-transparent',
    iconBox: 'bg-sky-500/20 text-sky-200 border-sky-400/35',
    bar: 'from-sky-400 to-indigo-400',
    pill: 'bg-white/10 text-zinc-100 border-white/20 group-hover:bg-rose-500/25 group-hover:border-rose-400/45 group-hover:text-rose-100',
    caretBorder: 'border-sky-400/35',
  },
};

function renderToastIcon(item: ToastItem) {
  if (item.kind === 'download') {
    if (item.type === 'error' || item.type === 'warning') {
      return <AlertTriangle className="w-4 h-4" />;
    }
    return <Download className="w-4 h-4" />;
  }
  if (item.kind === 'airing') {
    return <Radio className="w-4 h-4" />;
  }
  if (item.kind === 'whisper') {
    return <Sparkles className="w-4 h-4" />;
  }
  if (item.type === 'error') return <AlertCircle className="w-4 h-4" />;
  if (item.type === 'warning') return <AlertTriangle className="w-4 h-4" />;
  if (item.type === 'success') return <CheckCircle2 className="w-4 h-4" />;
  if (item.type === 'purple') return <Sparkles className="w-4 h-4" />;
  return <Info className="w-4 h-4" />;
}

interface ToastCardProps {
  toast: ToastItem;
  isFirst: boolean;
  anchor: BellAnchor;
  onDismiss: (id: string) => void;
}

const ToastCard = forwardRef<HTMLDivElement, ToastCardProps>(
  ({ toast, isFirst, anchor, onDismiss }, ref) => {
    const duration =
      typeof toast.duration === 'number' && toast.duration > 0 && Number.isFinite(toast.duration)
        ? toast.duration
        : 0;

    const [paused, setPaused] = useState(false);
    const [progress, setProgress] = useState(1);
    const remainingRef = useRef<number>(duration);
    const startedAtRef = useRef<number>(Date.now());
    const style = TYPE_STYLES[toast.type] || TYPE_STYLES.info;
    const isActionable = typeof toast.onAction === 'function';

    useEffect(() => {
      if (duration <= 0) return;
      if (paused) {
        const elapsed = Date.now() - startedAtRef.current;
        remainingRef.current = Math.max(0, remainingRef.current - elapsed);
        return;
      }

      startedAtRef.current = Date.now();
      const timeoutId = window.setTimeout(() => {
        onDismiss(toast.id);
      }, remainingRef.current);

      let rafId = 0;
      const tick = () => {
        const elapsed = Date.now() - startedAtRef.current;
        const left = Math.max(0, remainingRef.current - elapsed);
        setProgress(left / duration);
        if (left > 0) {
          rafId = window.requestAnimationFrame(tick);
        }
      };
      rafId = window.requestAnimationFrame(tick);

      return () => {
        window.clearTimeout(timeoutId);
        if (rafId) window.cancelAnimationFrame(rafId);
      };
    }, [duration, paused, toast.id, onDismiss]);

    const handleCardClick = () => {
      if (!toast.onAction) return;
      try {
        toast.onMarkRead?.();
        toast.onAction();
      } finally {
        onDismiss(toast.id);
      }
    };

    const originX = anchor.anchored
      ? `calc(100% - ${anchor.caretRight + 6}px)`
      : '100%';

    return (
      <motion.div
        ref={ref}
        layout="position"
        initial={{
          opacity: 0,
          y: -18,
          scale: 0.62,
          filter: 'blur(6px)',
        }}
        animate={{
          opacity: 1,
          y: 0,
          scale: 1,
          filter: 'blur(0px)',
        }}
        exit={{
          opacity: 0,
          y: -16,
          scale: 0.78,
          filter: 'blur(5px)',
          transition: { duration: 0.19, ease: [0.4, 0, 1, 1] },
        }}
        transition={{
          type: 'spring',
          stiffness: 460,
          damping: 28,
          mass: 0.78,
        }}
        style={{ transformOrigin: `${originX} 0px` }}
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        onClick={isActionable ? handleCardClick : undefined}
        role={isActionable ? 'button' : 'status'}
        tabIndex={isActionable ? 0 : undefined}
        onKeyDown={
          isActionable
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handleCardClick();
                }
              }
            : undefined
        }
        className={`group pointer-events-auto relative w-[348px] max-w-[calc(100vw-24px)] rounded-2xl border bg-[#0d0a16]/95 ring-1 ring-inset ring-white/[0.06] backdrop-blur-2xl shadow-[0_22px_52px_-12px_rgba(0,0,0,0.92)] transition-colors duration-200 ${style.border} ${
          isActionable ? 'cursor-pointer hover:bg-[#151024]/95' : ''
        }`}
      >
        {/* Top pointer caret leading directly back up to the bell button */}
        {isFirst && anchor.anchored && (
          <div
            aria-hidden="true"
            style={{
              right: `${anchor.caretRight}px`,
              clipPath: 'polygon(0 0, 100% 0, 0 100%)',
            }}
            className={`absolute -top-[6px] h-3 w-3 rotate-45 rounded-tl-[2px] border-l border-t bg-[#0d0a16] ${style.caretBorder}`}
          />
        )}

        <div className="relative overflow-hidden rounded-2xl">
          {/* Top-right radial ambient tint */}
          <div
            aria-hidden="true"
            className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${style.glow}`}
          />

          <div className="relative flex items-start gap-3 px-3.5 py-3">
            {toast.posterUrl ? (
              <div className="relative h-12 w-9 shrink-0 overflow-hidden rounded-lg border border-white/15 bg-zinc-900 shadow-md">
                <img
                  src={toast.posterUrl}
                  alt=""
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
                <div
                  className={`absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-md border backdrop-blur-md ${style.iconBox}`}
                >
                  {renderToastIcon(toast)}
                </div>
              </div>
            ) : (
              <div
                className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border ${style.iconBox}`}
              >
                {renderToastIcon(toast)}
              </div>
            )}

            <div className="min-w-0 flex-1 pr-1">
              {toast.title && (
                <p className="truncate text-[12.5px] font-bold tracking-tight text-white">
                  {toast.title}
                </p>
              )}
              <p
                className={`${
                  toast.title ? 'mt-0.5 text-[11.5px] text-zinc-200' : 'text-[12.5px] font-medium text-white'
                } leading-snug line-clamp-2`}
              >
                {toast.message}
              </p>

              {isActionable && (
                <div className="mt-2 flex items-center justify-between gap-2">
                  <span
                    className={`inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 text-[10.5px] font-bold transition-colors ${style.pill}`}
                  >
                    <span>{toast.actionLabel || 'Open'}</span>
                    <ChevronRight className="h-3 w-3 transition-transform duration-150 group-hover:translate-x-0.5" />
                  </span>
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDismiss(toast.id);
              }}
              className="-mr-1 -mt-0.5 shrink-0 rounded-lg p-1 text-zinc-400 transition-colors hover:bg-white/[0.1] hover:text-white"
              title="Dismiss notification"
              aria-label="Dismiss notification"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Smooth countdown progress line */}
          {duration > 0 && (
            <div className="h-[2px] w-full bg-white/[0.05]">
              <div
                className={`h-full origin-left bg-gradient-to-r ${style.bar} transition-opacity ${
                  paused ? 'opacity-45' : 'opacity-85'
                }`}
                style={{ transform: `scaleX(${Math.max(0, Math.min(1, progress))})` }}
              />
            </div>
          )}
        </div>
      </motion.div>
    );
  }
);
ToastCard.displayName = 'ToastCard';

function measureBellAnchor(): BellAnchor {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return { anchored: false, top: 20, right: 20, caretRight: 24 };
  }
  const bell = document.querySelector<HTMLElement>('[data-notification-bell="true"]');
  if (bell) {
    const rect = bell.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      const top = Math.round(rect.bottom + 12);
      const right = Math.max(12, Math.round(window.innerWidth - rect.right - 14));
      const bellCenterFromRight = window.innerWidth - (rect.left + rect.width / 2);
      const caretRight = Math.max(18, Math.min(280, Math.round(bellCenterFromRight - right - 6)));
      return { anchored: true, top, right, caretRight };
    }
  }
  return { anchored: false, top: 20, right: 20, caretRight: 24 };
}

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [drawerOpen, setDrawerOpen] = useState<boolean>(notificationDrawerOpenState);
  const [anchor, setAnchor] = useState<BellAnchor>(measureBellAnchor);

  const refreshAnchor = useCallback(() => {
    setAnchor(measureBellAnchor());
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => {
      if (!prev.some((t) => t.id === id)) return prev;
      return prev.filter((t) => t.id !== id);
    });
  }, []);

  const showToast = useCallback(
    (
      message: string,
      type: ToastType = 'info',
      duration: number = DEFAULT_DURATION_MS,
      options?: ToastOptions
    ) => {
      showGlobalToast(message, type, duration, options);
    },
    []
  );

  useEffect(() => {
    const handleNewToast: ToastListener = (item) => {
      setAnchor(measureBellAnchor());
      setToasts((prev) => [item, ...prev].slice(0, MAX_VISIBLE_TOASTS));
    };

    const handleDrawerChange: DrawerListener = (isOpen) => {
      setDrawerOpen(isOpen);
      if (isOpen) {
        setToasts([]);
      }
    };

    listeners.add(handleNewToast);
    drawerListeners.add(handleDrawerChange);
    return () => {
      listeners.delete(handleNewToast);
      drawerListeners.delete(handleDrawerChange);
    };
  }, []);

  useEffect(() => {
    if (toasts.length === 0) return;
    refreshAnchor();
    const handleResize = () => refreshAnchor();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [toasts.length, refreshAnchor]);

  const toastMethods = {
    info: useCallback(
      (msg: string, d?: number, opts?: ToastOptions) => showToast(msg, 'info', d, opts),
      [showToast]
    ),
    success: useCallback(
      (msg: string, d?: number, opts?: ToastOptions) => showToast(msg, 'success', d, opts),
      [showToast]
    ),
    warning: useCallback(
      (msg: string, d?: number, opts?: ToastOptions) => showToast(msg, 'warning', d, opts),
      [showToast]
    ),
    error: useCallback(
      (msg: string, d?: number, opts?: ToastOptions) => showToast(msg, 'error', d, opts),
      [showToast]
    ),
  };

  const visibleToasts = drawerOpen ? [] : toasts;

  return (
    <ToastContext.Provider value={{ showToast, toast: toastMethods }}>
      {children}
      {/* Floating Bell-Anchored Toast Notification Stack */}
      <div
        style={{ top: `${anchor.top}px`, right: `${anchor.right}px` }}
        className="fixed z-[9999] flex flex-col items-end gap-2.5 pointer-events-none"
      >
        <AnimatePresence mode="popLayout" initial={false}>
          {visibleToasts.map((t, index) => (
            <ToastCard
              key={t.id}
              toast={t}
              isFirst={index === 0}
              anchor={anchor}
              onDismiss={removeToast}
            />
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
};

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    return {
      showToast: showGlobalToast,
      toast: {
        info: (msg: string, d?: number, opts?: ToastOptions) =>
          showGlobalToast(msg, 'info', d, opts),
        success: (msg: string, d?: number, opts?: ToastOptions) =>
          showGlobalToast(msg, 'success', d, opts),
        warning: (msg: string, d?: number, opts?: ToastOptions) =>
          showGlobalToast(msg, 'warning', d, opts),
        error: (msg: string, d?: number, opts?: ToastOptions) =>
          showGlobalToast(msg, 'error', d, opts),
      },
    };
  }
  return context;
}
