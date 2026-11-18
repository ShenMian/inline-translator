import { proxyFetch } from '../lib/messaging';
import { splitLong } from './codec';
import { parseRetryAfter, retryableStatus, ServiceError, sleep, type TranslateService } from './types';

const BATCH_ENDPOINT = 'https://translate.googleapis.com/translate_a/t';
const SINGLE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
const CONCURRENCY = 6;
const MAX_Q = 4000;
const MAX_BATCH_CHARS = 4500;

async function one(text: string, to: string, signal?: AbortSignal): Promise<string> {
  const chunks = splitLong(text);
  const out: string[] = [];
  for (const chunk of chunks) {
    const params = new URLSearchParams({
      client: 'gtx',
      dt: 't',
      dj: '1',
      ie: 'UTF-8',
      sl: 'auto',
      tl: to,
      q: chunk,
    });
    let lastErr = '';
    let lastStatus = 0;
    let lastRetryAfter: string | null | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await proxyFetch({ url: `${SINGLE_ENDPOINT}?${params}`, method: 'GET' }, signal);
      if (res.ok) {
        const data = JSON.parse(res.body) as { sentences?: { trans?: string }[] };
        const joined = (data.sentences ?? []).map((s) => s.trans ?? '').join('');
        // Throttling can return 200 with an empty body; treat as retryable failure
        if (!joined.trim() && chunk.trim()) {
          lastErr = 'Google: empty response';
          if (attempt === 0) {
            await sleep(800);
            continue;
          }
          break;
        }
        out.push(joined);
        lastErr = '';
        break;
      }
      lastErr = `Google ${res.status}: ${(res.body || res.error || '').slice(0, 200)}`;
      lastStatus = res.status;
      lastRetryAfter = res.retryAfter;
      if ((res.status === 429 || res.status >= 500) && attempt === 0) {
        await sleep(800);
        continue;
      }
      break;
    }
    // Status 0 stands for the empty-200 case, which is throttling and worth retrying
    if (lastErr) throw new ServiceError(lastErr, retryableStatus(lastStatus), parseRetryAfter(lastRetryAfter));
  }
  // CJK/Thai run sentences together without spaces; joining with ' ' would inject stray spaces
  const sep = /^(zh|ja|ko|th)/i.test(to) ? '' : ' ';
  return out.join(sep);
}

/** Batch multiple normal-sized paragraphs in a single POST to translate_a/t (default NMT mode
 *  preserves <tN>...</tN>, {{N}}, and newlines while keeping full sentence-level translation quality). */
async function batchPost(texts: string[], to: string, signal?: AbortSignal): Promise<string[] | null> {
  const params = new URLSearchParams({
    client: 'gtx',
    dt: 't',
    sl: 'auto',
    tl: to,
  });
  const form = new URLSearchParams();
  for (const t of texts) form.append('q', t);
  const body = form.toString();

  let lastErr = '';
  let lastStatus = 0;
  let lastRetryAfter: string | null | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await proxyFetch(
      {
        url: `${BATCH_ENDPOINT}?${params}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
        body,
      },
      signal,
    );
    if (res.ok) {
      try {
        const data = JSON.parse(res.body) as unknown;
        if (!Array.isArray(data) || data.length !== texts.length) return null;
        const parsed = data.map((d) =>
          (Array.isArray(d) ? String(d[0] ?? '') : typeof d === 'string' ? d : '').replace(
            /<\s*(\/?)\s*t(\d+)\s*>/gi,
            '<$1t$2>',
          ),
        );
        if (parsed.some((v, idx) => !v.trim() && texts[idx]!.trim())) {
          lastErr = 'Google: empty response';
          if (attempt === 0) {
            await sleep(800);
            continue;
          }
          return null;
        }
        return parsed;
      } catch {
        return null;
      }
    }
    lastErr = `Google ${res.status}: ${(res.body || res.error || '').slice(0, 200)}`;
    lastStatus = res.status;
    lastRetryAfter = res.retryAfter;
    if ((res.status === 429 || res.status >= 500) && attempt === 0) {
      await sleep(800);
      continue;
    }
    break;
  }
  if (lastErr) throw new ServiceError(lastErr, retryableStatus(lastStatus), parseRetryAfter(lastRetryAfter));
  return null;
}

export const google: TranslateService = {
  id: 'google',
  async translate(texts, to, signal) {
    const out = new Array<string>(texts.length).fill('');
    let firstError: ServiceError | null = null;
    let failures = 0;

    const recordError = (e: unknown, count: number) => {
      if (signal?.aborted) return;
      failures += count;
      if (!firstError) firstError = e instanceof ServiceError ? e : new ServiceError(String(e), true);
    };

    const shortGroups: number[][] = [];
    const longIndices: number[] = [];
    let curGroup: number[] = [];
    let curChars = 0;

    for (let idx = 0; idx < texts.length; idx++) {
      const t = texts[idx]!;
      if (t.length > MAX_Q) {
        longIndices.push(idx);
        continue;
      }
      if (curGroup.length > 0 && curChars + t.length > MAX_BATCH_CHARS) {
        shortGroups.push(curGroup);
        curGroup = [];
        curChars = 0;
      }
      curGroup.push(idx);
      curChars += t.length;
    }
    if (curGroup.length) shortGroups.push(curGroup);

    const fallbackIndices: number[] = [...longIndices];

    for (const grp of shortGroups) {
      if (signal?.aborted) return out;
      try {
        const res = await batchPost(
          grp.map((idx) => texts[idx]!),
          to,
          signal,
        );
        if (res) {
          grp.forEach((idx, j) => {
            out[idx] = res[j]!;
          });
        } else {
          fallbackIndices.push(...grp);
        }
      } catch (e) {
        recordError(e, grp.length);
      }
    }

    if (fallbackIndices.length) {
      let cursor = 0;
      const workers = Array.from({ length: Math.min(CONCURRENCY, fallbackIndices.length) }, async () => {
        while (cursor < fallbackIndices.length) {
          const idx = fallbackIndices[cursor++]!;
          try {
            out[idx] = await one(texts[idx]!, to, signal);
          } catch (e) {
            recordError(e, 1);
            out[idx] = '';
          }
        }
      });
      await Promise.all(workers);
    }

    if (failures === texts.length && firstError) throw firstError;
    return out;
  },
};
