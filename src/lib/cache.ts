import { storage } from 'wxt/utils/storage';

/**
 * In-process LRU translation cache (per tab), persisted incrementally to chrome.storage.local so
 * translations survive reloads and sync live across open tabs. The Map stays the synchronous hot
 * path used by the engine; only dirty entries written by this tab are flushed on debounce/pagehide.
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
/** Entries written in this tab since the last flush; clean tabs never write on pagehide. */
const dirty = new Map<string, Entry>();
let bytes = 0;
let listenersBound = false;

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
  const t = Date.now();
  put(key, val, t);
  dirty.set(key, { v: val, t });
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

/** Merge only this tab's dirty entries into the on-disk cache (others' entries survive), drop
 *  expired ones, and keep the result within the same budgets as the in-memory LRU. */
function persist(): Promise<void> {
  if (dirty.size === 0) return writing;
  const batch = new Map(dirty);
  dirty.clear();
  writing = writing
    .then(async () => {
      const stored = (await cacheItem.getValue().catch(() => ({}))) ?? {};
      const now = Date.now();
      const merged: Record<string, Entry> = {};
      for (const [k, raw] of Object.entries(stored)) {
        // Legacy shape was a plain string → treat as freshly written
        const e = typeof raw === 'string' ? { v: raw, t: now } : raw;
        if (e && typeof e.v === 'string' && now - e.t <= TTL) merged[k] = e;
      }
      for (const [k, e] of batch) merged[k] = e;
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
    })
    .catch(() => {});
  return writing;
}

/** Warm the in-memory cache from disk at startup and subscribe to live cross-tab updates. */
export async function hydrateCache(): Promise<void> {
  try {
    const saved = await cacheItem.getValue();
    const now = Date.now();
    for (const [k, raw] of Object.entries(saved ?? {})) {
      if (typeof raw === 'string') put(k, raw, now);
      else if (raw && typeof raw.v === 'string' && now - raw.t <= TTL) put(k, raw.v, raw.t);
    }
  } catch {
    /* storage unavailable → degrade to a pure in-memory cache */
  }
  if (listenersBound) return;
  listenersBound = true;
  try {
    cacheItem.watch((next) => {
      const entries = Object.entries(next ?? {});
      if (entries.length === 0) {
        if (persistTimer) {
          clearTimeout(persistTimer);
          persistTimer = null;
        }
        dirty.clear();
        map.clear();
        bytes = 0;
        return;
      }
      const now = Date.now();
      for (const [k, raw] of entries) {
        const e = typeof raw === 'string' ? { v: raw, t: now } : raw;
        if (!e || typeof e.v !== 'string' || now - e.t > TTL) continue;
        const cur = map.get(k);
        if (!cur || cur.t < e.t) put(k, e.v, e.t);
      }
    });
  } catch {
    /* ignore */
  }
  if (typeof window !== 'undefined') {
    // Flush any remaining dirty entries before the page goes away
    window.addEventListener('pagehide', () => {
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      void persist();
    });
  }
}
