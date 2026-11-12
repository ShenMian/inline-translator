/** In-process LRU translation cache (per tab). */
const MAX = 3000;
const map = new Map<string, string>();

export function cacheKey(service: string, to: string, text: string): string {
  return `${service}|${to}|${text}`;
}

export function cacheGet(key: string): string | undefined {
  const v = map.get(key);
  if (v !== undefined) {
    map.delete(key);
    map.set(key, v);
  }
  return v;
}

export function cacheSet(key: string, val: string): void {
  if (map.size >= MAX) {
    const first = map.keys().next().value;
    if (first !== undefined) map.delete(first);
  }
  map.set(key, val);
}