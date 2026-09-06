// Tiny stale-while-revalidate cache so navigation never waits on the network.
//
// Every read-only API call the views make goes through `useQuery(key, fetcher)`. The first
// caller pays for the request; afterwards the data is returned synchronously from memory
// (and from sessionStorage after a reload) while a refresh runs in the background. Writes
// call `mutate` to patch the cached value optimistically and `invalidate` to refetch.
import { useCallback, useEffect, useRef, useState } from "react";

interface Entry {
  data: unknown;
  at: number;
}

const STORAGE_PREFIX = "rq:";
const memory = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();
const fetchers = new Map<string, () => Promise<unknown>>();
const listeners = new Map<string, Set<() => void>>();

function notify(key: string) {
  listeners.get(key)?.forEach((fn) => fn());
}

function readStorage(key: string): Entry | undefined {
  try {
    const raw = sessionStorage.getItem(STORAGE_PREFIX + key);
    if (!raw) return undefined;
    return JSON.parse(raw) as Entry;
  } catch {
    return undefined;
  }
}

function writeStorage(key: string, entry: Entry) {
  try {
    sessionStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(entry));
  } catch {
    // Quota or private mode: memory cache still works.
  }
}

export function getCached<T>(key: string): T | undefined {
  const m = memory.get(key);
  if (m) return m.data as T;
  const s = readStorage(key);
  if (s) {
    memory.set(key, s);
    return s.data as T;
  }
  return undefined;
}

export function setCached<T>(key: string, data: T): void {
  const entry = { data, at: Date.now() };
  memory.set(key, entry);
  writeStorage(key, entry);
  notify(key);
}

/** Patch a cached value in place (optimistic update). No-op when nothing is cached. */
export function mutate<T>(key: string, fn: (current: T) => T): void {
  const current = getCached<T>(key);
  if (current === undefined) return;
  setCached(key, fn(current));
}

/** Fetch `key` (deduplicated) and store the result. Errors propagate to the caller. */
export async function revalidate<T>(key: string, fetcher?: () => Promise<T>): Promise<T> {
  const fn = fetcher ?? (fetchers.get(key) as (() => Promise<T>) | undefined);
  if (!fn) throw new Error(`No fetcher registered for ${key}`);
  fetchers.set(key, fn);
  const pending = inflight.get(key) as Promise<T> | undefined;
  if (pending) return pending;
  const p = fn()
    .then((data) => {
      setCached(key, data);
      return data;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Warm the cache without rendering anything. Failures are ignored (the view will retry). */
export function prefetch<T>(key: string, fetcher: () => Promise<T>): void {
  if (getCached(key) !== undefined || inflight.has(key)) {
    fetchers.set(key, fetcher);
    return;
  }
  void revalidate(key, fetcher).catch(() => {});
}

/** Refetch every cached key that starts with one of the prefixes. Keys with no listener are dropped. */
export function invalidate(...prefixes: string[]): void {
  const keys = new Set<string>([...memory.keys(), ...fetchers.keys()]);
  for (const key of keys) {
    if (!prefixes.some((p) => key === p || key.startsWith(p + ":"))) continue;
    const watched = (listeners.get(key)?.size ?? 0) > 0;
    if (watched && fetchers.has(key)) void revalidate(key).catch(() => {});
    else {
      memory.delete(key);
      try { sessionStorage.removeItem(STORAGE_PREFIX + key); } catch { /* ignore */ }
    }
  }
}

export function clearCache(): void {
  memory.clear();
  inflight.clear();
  fetchers.clear();
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(STORAGE_PREFIX)) sessionStorage.removeItem(k);
    }
  } catch { /* ignore */ }
  for (const key of listeners.keys()) notify(key);
}

export interface QueryResult<T> {
  data: T | undefined;
  error: Error | null;
  /** True only while the very first load for this key is in flight. */
  loading: boolean;
  refresh: () => Promise<void>;
}

/**
 * Subscribe to a cached value. Returns instantly with whatever is cached, kicks off a
 * background refresh on mount, and re-renders when the value changes anywhere in the app.
 */
export function useQuery<T>(key: string | null, fetcher: () => Promise<T>, opts: { revalidateOnMount?: boolean } = {}): QueryResult<T> {
  const revalidateOnMount = opts.revalidateOnMount ?? true;
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const [, force] = useState(0);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!key) return;
    const rerender = () => force((n) => n + 1);
    let set = listeners.get(key);
    if (!set) listeners.set(key, (set = new Set()));
    set.add(rerender);
    fetchers.set(key, fetcherRef.current);
    if (revalidateOnMount || getCached(key) === undefined) {
      revalidate(key, fetcherRef.current).then(() => setError(null), (e) => setError(e instanceof Error ? e : new Error(String(e))));
    }
    return () => {
      set!.delete(rerender);
      if (set!.size === 0) listeners.delete(key);
    };
  }, [key, revalidateOnMount]);

  const refresh = useCallback(async () => {
    if (!key) return;
    try {
      await revalidate(key, fetcherRef.current);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    }
  }, [key]);

  const data = key ? getCached<T>(key) : undefined;
  return { data, error, loading: data === undefined && !error, refresh };
}
