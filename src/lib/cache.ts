import { storage } from 'wxt/utils/storage';

/**
 * In-process LRU translation cache (per tab), persisted to chrome.storage.local so translations
 * survive reloads and navigation. The Map stays the synchronous hot path used by the engine;
 * disk is a bounded mirror written back in debounced batches.
 *
 * Persistence merges with what is already on disk instead of overwriting it: several tabs share
 * one storage key, and a full-snapshot write from one tab would otherwise erase every entry only
 * the others had. Entries also carry a write time so stale translations expire.
 */
const MAX = 3000;
/** Stay well under the 10MB storage.local quota; char count is a conservative byte proxy. */
const MAX_BYTES = 4 * 1024 * 1024;
const PERSIST_DELAY = 800;
/** Translation quality drifts with engine updates; a week keeps the cache useful without going stale. */
const TTL = 7 * 24 * 60 * 60 * 1000;

interface Entry {
  /** Translated rich text. */
  v: string;
  /** Write time (ms since epoch), used for TTL expiry. */
  t: number;
}

const map = new Map<string, Entry>();
let bytes = 0;

const cacheItem = storage.defineItem<Record<string, Entry | string>>('local:cache', { fallback: {} });

export function cacheKey(service: string, to: string, text: string): string {
  return `${service}|${to}|${text}`;
}

function cost(key: string, val: string): number {
  return key.length + val.length;
}

/** Insert/update an entry, then evict oldest until under both the count and byte budgets. */
function put(key: string, val: string, t = Date.now()): void {
  const prev = map.get(key);
  if (prev !== undefined) {
    bytes -= cost(key, prev.v);
    map.delete(key);
  }
  map.set(key, { v: val, t });
  bytes += cost(key, val);
  while (map.size > MAX || bytes > MAX_BYTES) {
    const first = map.keys().next().value;
    if (first === undefined) break;
    bytes -= cost(first, map.get(first)!.v);
    map.delete(first);
  }
}

export function cacheGet(key: string): string | undefined {
  const e = map.get(key);
  if (e === undefined) return undefined;
  if (Date.now() - e.t > TTL) {
    bytes -= cost(key, e.v);
    map.delete(key);
    return undefined;
  }
  map.delete(key);
  map.set(key, e); // refresh LRU recency
  return e.v;
}

export function cacheSet(key: string, val: string): void {
  put(key, val);
  schedulePersist();
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let writing: Promise<void> = Promise.resolve();

function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persist();
  }, PERSIST_DELAY);
}

/** Merge this tab's entries into the on-disk cache (others' entries survive), drop expired ones,
 *  and keep the result within the same budgets as the in-memory LRU. */
function persist(): Promise<void> {
  const snapshot = Object.fromEntries(map);
  writing = writing.then(async () => {
    const stored = (await cacheItem.getValue().catch(() => ({}))) ?? {};
    const now = Date.now();
    const merged: Record<string, Entry> = {};
    for (const [k, raw] of Object.entries(stored)) {
      // Legacy shape was a plain string → treat as freshly written
      const e = typeof raw === 'string' ? { v: raw, t: now } : raw;
      if (e && typeof e.v === 'string' && now - e.t <= TTL) merged[k] = e;
    }
    for (const [k, e] of Object.entries(snapshot)) merged[k] = e;
    let count = Object.keys(merged).length;
    let size = 0;
    for (const [k, e] of Object.entries(merged)) size += cost(k, e.v);
    // Object key order is oldest→newest within each source, so trimming from the front drops the
    // least recently used entries first.
    for (const k of Object.keys(merged)) {
      if (count <= MAX && size <= MAX_BYTES) break;
      size -= cost(k, merged[k]!.v);
      count--;
      delete merged[k];
    }
    await cacheItem.setValue(merged);
  }).catch(() => {});
  return writing;
}

/** Warm the in-memory cache from disk once at startup, before the engine translates. */
export async function hydrateCache(): Promise<void> {
  try {
    const saved = await cacheItem.getValue();
    for (const [k, raw] of Object.entries(saved ?? {})) {
      if (typeof raw === 'string') put(k, raw);
      else if (raw && typeof raw.v === 'string') put(k, raw.v, raw.t);
    }
  } catch {
    /* storage unavailable → degrade to a pure in-memory cache */
  }
  if (typeof window !== 'undefined') {
    // Best-effort flush of the last batch before the page goes away
    window.addEventListener('pagehide', () => {
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      void persist();
    });
  }
}
