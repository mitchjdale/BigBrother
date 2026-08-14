import { useEffect, useState } from "react";

/**
 * Like useState, but the value is persisted to localStorage under `key` so it
 * survives a full page refresh. Falls back to `initialValue` when nothing is
 * stored or storage is unavailable.
 */
export function usePersistentState<T>(key: string, initialValue: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = window.localStorage.getItem(key);
      return stored != null ? (JSON.parse(stored) as T) : initialValue;
    } catch {
      return initialValue;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable / quota exceeded — ignore */
    }
  }, [key, value]);

  return [value, setValue] as const;
}

/**
 * Read a cached value written by writeCache. Returns null when there's no
 * (valid) cached entry so callers can decide whether to show a loading state.
 */
export function readCache<T>(key: string): T | null {
  try {
    const stored = window.localStorage.getItem(key);
    return stored != null ? (JSON.parse(stored) as T) : null;
  } catch {
    return null;
  }
}

/** Persist a value for later stale-while-revalidate reads via readCache. */
export function writeCache<T>(key: string, value: T): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable / quota exceeded — ignore */
  }
}
