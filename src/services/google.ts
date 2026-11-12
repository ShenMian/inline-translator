import { proxyFetch } from '../lib/messaging';
import { ServiceError, sleep, type TranslateService } from './types';

const ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
const CONCURRENCY = 6;
const MAX_Q = 4000;

/** Split over-long text by sentences to keep GET URLs within limits. */
function splitLong(text: string): string[] {
  if (text.length <= MAX_Q) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > MAX_Q) {
    const window = rest.slice(0, MAX_Q);
    const cut = Math.max(
      window.lastIndexOf('. '),
      window.lastIndexOf('! '),
      window.lastIndexOf('? '),
      window.lastIndexOf('。'),
      window.lastIndexOf('！'),
      window.lastIndexOf('？'),
      window.lastIndexOf('\n'),
    );
    const at = cut > MAX_Q / 2 ? cut + 1 : MAX_Q;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  if (rest) parts.push(rest);
  return parts;
}

async function one(text: string, to: string): Promise<string> {
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
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await proxyFetch({ url: `${ENDPOINT}?${params}`, method: 'GET' });
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
      if ((res.status === 429 || res.status >= 500) && attempt === 0) {
        await sleep(800);
        continue;
      }
      break;
    }
    if (lastErr) throw new ServiceError(lastErr, true);
  }
  return out.join(' ');
}

export const google: TranslateService = {
  id: 'google',
  async translate(texts, to) {
    const out = new Array<string>(texts.length);
    let i = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, texts.length) }, async () => {
      while (i < texts.length) {
        const idx = i++;
        out[idx] = await one(texts[idx]!, to);
      }
    });
    await Promise.all(workers);
    return out;
  },
};