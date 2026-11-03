import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { Info, CheckCircle2, AlertTriangle, AlertCircle, X } from 'lucide-react';

export type ToastType = 'info' | 'success' | 'warning' | 'error';

export interface ToastItem {
  id: string;
  message: string;
  type: ToastType;
  duration?: number;
}

interface ToastContextValue {
  showToast: (message: string, type?: ToastType, duration?: number) => void;
  toast: {
    info: (message: string, duration?: number) => void;
    success: (message: string, duration?: number) => void;
    warning: (message: string, duration?: number) => void;
    error: (message: string, duration?: number) => void;
  };
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

// Global event listener for non-hook dispatching
type ToastListener = (toast: ToastItem) => void;
const listeners = new Set<ToastListener>();

export function showGlobalToast(message: string, type: ToastType = 'info', duration: number = 3500) {
  const item: ToastItem = {
    id: `toast-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    message,
    type,
    duration,
  };
  listeners.forEach((listener) => listener(item));
}

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timerMapRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const removeToast = useCallback((id: string) => {
    const timer = timerMapRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timerMapRef.current.delete(id);
    }
    setToasts((prev) => {
      if (!prev.some((t) => t.id === id)) return prev;
      return prev.filter((t) => t.id !== id);
    });
  }, []);

  const showToast = useCallback(
    (message: string, type: ToastType = 'info', duration: number = 3500) => {
      showGlobalToast(message, type, duration);
    },
    []
  );

  useEffect(() => {
    const timerMap = timerMapRef.current;
    const handleNewToast: ToastListener = (item) => {
      setToasts((prev) => {
        if (prev.length >= 5) {
          const evicted = prev.slice(0, prev.length - 4);
          for (const ev of evicted) {
            const evTimer = timerMap.get(ev.id);
            if (evTimer) {
              clearTimeout(evTimer);
              timerMap.delete(ev.id);
            }
          }
        }
        return [...prev.slice(-4), item];
      });

      if (item.duration && item.duration > 0 && Number.isFinite(item.duration)) {
        const timerId = setTimeout(() => {
          timerMap.delete(item.id);
          removeToast(item.id);
        }, item.duration);
        timerMap.set(item.id, timerId);
      }
    };

    listeners.add(handleNewToast);
    return () => {
      listeners.delete(handleNewToast);
      for (const timer of timerMap.values()) {
        clearTimeout(timer);
      }
      timerMap.clear();
    };
  }, [removeToast]);

  const toastMethods = {
    info: useCallback((msg: string, d?: number) => showToast(msg, 'info', d), [showToast]),
    success: useCallback((msg: string, d?: number) => showToast(msg, 'success', d), [showToast]),
    warning: useCallback((msg: string, d?: number) => showToast(msg, 'warning', d), [showToast]),
    error: useCallback((msg: string, d?: number) => showToast(msg, 'error', d), [showToast]),
  };

  return (
    <ToastContext.Provider value={{ showToast, toast: toastMethods }}>
      {children}
      {/* Floating Toast Notification Container */}
      <div className="fixed bottom-6 inset-x-0 flex flex-col items-center pointer-events-none z-[9999] space-y-2.5 px-4">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-center space-x-3 px-4 py-3 rounded-xl shadow-2xl backdrop-blur-md border text-sm max-w-lg transition-all duration-300 animate-in fade-in slide-in-from-bottom-2 ${
              t.type === 'error'
                ? 'bg-zinc-900/95 border-rose-500/40 text-rose-100 shadow-rose-950/30'
                : t.type === 'warning'
                ? 'bg-zinc-900/95 border-amber-500/40 text-amber-100 shadow-amber-950/30'
                : t.type === 'success'
                ? 'bg-zinc-900/95 border-emerald-500/40 text-emerald-100 shadow-emerald-950/30'
                : 'bg-zinc-900/95 border-zinc-700/60 text-zinc-100 shadow-black/40'
            }`}
          >
            <div className="shrink-0">
              {t.type === 'error' && <AlertCircle className="w-5 h-5 text-rose-400" />}
              {t.type === 'warning' && <AlertTriangle className="w-5 h-5 text-amber-400" />}
              {t.type === 'success' && <CheckCircle2 className="w-5 h-5 text-emerald-400" />}
              {t.type === 'info' && <Info className="w-5 h-5 text-blue-400" />}
            </div>
            <div className="flex-1 font-medium leading-snug">{t.message}</div>
            <button
              onClick={() => removeToast(t.id)}
              className="shrink-0 p-1 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-white/5 transition-colors"
              title="Dismiss notification"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    // Graceful fallback for usage outside ToastProvider
    return {
      showToast: showGlobalToast,
      toast: {
        info: (msg: string, d?: number) => showGlobalToast(msg, 'info', d),
        success: (msg: string, d?: number) => showGlobalToast(msg, 'success', d),
        warning: (msg: string, d?: number) => showGlobalToast(msg, 'warning', d),
        error: (msg: string, d?: number) => showGlobalToast(msg, 'error', d),
      },
    };
  }
  return context;
}
