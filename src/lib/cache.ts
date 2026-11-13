import { storage } from 'wxt/utils/storage';

/**
 * In-process LRU translation cache (per tab), persisted to chrome.storage.local so translations
 * survive reloads and navigation. The Map stays the synchronous hot path used by the engine;
 * disk is a bounded mirror written back in debounced batches.
 */
const MAX = 3000;
/** Stay well under the 10MB storage.local quota; char count is a conservative byte proxy. */
const MAX_BYTES = 4 * 1024 * 1024;
const PERSIST_DELAY = 800;

const map = new Map<string, string>();
let bytes = 0;

const cacheItem = storage.defineItem<Record<string, string>>('local:cache', { fallback: {} });

export function cacheKey(service: string, to: string, text: string): string {
  return `${service}|${to}|${text}`;
}

function cost(key: string, val: string): number {
  return key.length + val.length;
}

/** Insert/update an entry, then evict oldest until under both the count and byte budgets. */
function put(key: string, val: string): void {
  const prev = map.get(key);
  if (prev !== undefined) {
    bytes -= cost(key, prev);
    map.delete(key);
  }
  map.set(key, val);
  bytes += cost(key, val);
  while (map.size > MAX || bytes > MAX_BYTES) {
    const first = map.keys().next().value;
    if (first === undefined) break;
    bytes -= cost(first, map.get(first)!);
    map.delete(first);
  }
}

export function cacheGet(key: string): string | undefined {
  const v = map.get(key);
  if (v !== undefined) {
    map.delete(key);
    map.set(key, v); // refresh LRU recency
  }
  return v;
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

/** Snapshot the LRU (oldest→newest) to storage; chained so overlapping flushes never race. */
function persist(): Promise<void> {
  const snapshot = Object.fromEntries(map);
  writing = writing.then(() => cacheItem.setValue(snapshot)).catch(() => {});
  return writing;
}

/** Warm the in-memory cache from disk once at startup, before the engine translates. */
export async function hydrateCache(): Promise<void> {
  try {
    const saved = await cacheItem.getValue();
    for (const [k, v] of Object.entries(saved)) put(k, v);
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