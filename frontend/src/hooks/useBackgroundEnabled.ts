import { useSyncExternalStore } from 'react';

/**
 * User preference for the animated TrianglesBackground. Persisted in
 * localStorage and shared by every consumer (the canvas, FrostedPanel, the
 * TopBar toggle) plus other browser tabs — without a React context/provider,
 * so a component can read it in isolation (and in tests) without wiring.
 *
 * Defaults to ON; only an explicit "false" disables it, so first-time visitors
 * get the effect and a missing/unreadable localStorage degrades to enabled.
 */

const STORAGE_KEY = 'triangles-bg-enabled';
const listeners = new Set<() => void>();

function getSnapshot(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'false';
  } catch {
    return true; // localStorage blocked (private mode, etc.) → keep the default.
  }
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  // `storage` only fires in *other* tabs, which keeps windows in sync; the
  // originating tab is notified synchronously by setBackgroundEnabled below.
  window.addEventListener('storage', callback);
  return () => {
    listeners.delete(callback);
    window.removeEventListener('storage', callback);
  };
}

export function setBackgroundEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(enabled));
  } catch {
    // Persistence is best-effort; still notify in-memory listeners so the
    // toggle works for the current session even if storage is unavailable.
  }
  for (const l of listeners) l();
}

export function useBackgroundEnabled(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => true);
}
