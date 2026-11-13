import { useSyncExternalStore } from 'react';

/**
 * Developer mode — a session-only capability flag.
 *
 * Granted by tapping the version label in the settings footer 5 times, revoked
 * on every app restart: nothing is persisted to disk or localStorage, so a
 * regular user can never stumble into developer-only UI (diagnostics buttons,
 * etc.). Gate new developer-only features with `useDeveloperMode()`.
 */
let developerMode = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function isDeveloperMode(): boolean {
  return developerMode;
}

export function enableDeveloperMode(): boolean {
  if (developerMode) return false;
  developerMode = true;
  notify();
  return true;
}

/** React hook: re-renders consumers when developer mode flips on. */
export function useDeveloperMode(): boolean {
  return useSyncExternalStore(
    (onStoreChange) => {
      listeners.add(onStoreChange);
      return () => listeners.delete(onStoreChange);
    },
    isDeveloperMode,
  );
}
