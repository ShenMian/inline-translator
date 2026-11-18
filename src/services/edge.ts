import { proxyFetch } from '../lib/messaging';
import { decodeEdgeRich, encodeEdgeRich } from './codec';
import { parseRetryAfter, retryableStatus, ServiceError, ShapeError, type TranslateService } from './types';

/** Edge internal unauthenticated endpoint; body is a string array, batched with <b i=N> tag round-trip. */
const ENDPOINT = 'https://edge.microsoft.com/translate/translatetext';

const LANG_MAP: Record<string, string> = {
  'zh-CN': 'zh-Hans',
  'zh-TW': 'zh-Hant',
  'zh-HK': 'zh-Hant',
};

const MAX_SPLIT_DEPTH = 3;

async function ask(texts: string[], target: string, signal?: AbortSignal): Promise<string[]> {
  const url = `${ENDPOINT}?from=&to=${encodeURIComponent(target)}&isEnterpriseClient=false`;
  const res = await proxyFetch(
    {
      url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(texts.map(encodeEdgeRich)),
    },
    signal,
  );
  if (!res.ok) {
    throw new ServiceError(
      `Edge ${res.status}: ${(res.body || res.error || '').slice(0, 200)}`,
      retryableStatus(res.status),
      parseRetryAfter(res.retryAfter),
    );
  }
  const data = JSON.parse(res.body) as { translations?: { text?: string }[] }[];
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new ShapeError('Edge: unexpected response shape');
  }
  return data.map((d) => decodeEdgeRich(d.translations?.[0]?.text ?? ''));
}

export const edge: TranslateService = {
  id: 'edge',
  async translate(texts, to, signal) {
    const target = LANG_MAP[to] ?? to;
    // A shape mismatch fails the whole batch; split it so one awkward unit cannot sink its siblings.
    // Halves settle independently so the healthy side's results survive a failed one.
    const run = async (list: string[], depth: number): Promise<string[]> => {
      try {
        return await ask(list, target, signal);
      } catch (e) {
        if (list.length <= 1 || depth >= MAX_SPLIT_DEPTH || !(e instanceof ShapeError) || signal?.aborted) throw e;
        const mid = Math.ceil(list.length / 2);
        const [left, right] = await Promise.allSettled([run(list.slice(0, mid), depth + 1), run(list.slice(mid), depth + 1)]);
        if (left.status === 'rejected' && right.status === 'rejected') throw left.reason;
        const out = new Array<string>(list.length).fill('');
        if (left.status === 'fulfilled') left.value.forEach((v, i) => (out[i] = v));
        if (right.status === 'fulfilled') right.value.forEach((v, i) => (out[mid + i] = v));
        return out;
      }
    };
    return run(texts, 0);
  },
};
