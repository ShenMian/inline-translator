import { proxyFetch } from '../lib/messaging';
import type { Settings } from '../lib/settings';
import { parseRetryAfter, retryableStatus, ServiceError, ShapeError, type TranslateService } from './types';

const LANG_NAMES: Record<string, string> = {
  'zh-CN': 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  fr: 'French',
  de: 'German',
  es: 'Spanish',
  ru: 'Russian',
  pt: 'Portuguese',
  it: 'Italian',
  ar: 'Arabic',
  hi: 'Hindi',
  th: 'Thai',
  vi: 'Vietnamese',
  id: 'Indonesian',
};

function parseArray(content: string, expected: number): string[] {
  let s = content.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1]!.trim();
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  const arr = JSON.parse(s);
  if (!Array.isArray(arr) || arr.length !== expected) {
    throw new ShapeError('OpenAI: response array length mismatch');
  }
  return arr.map((x) => String(x));
}

/** Keep bisection in check: batches are ≤8 units, so three levels isolate a bad item without a request storm. */
const MAX_SPLIT_DEPTH = 3;

export function createOpenAI(cfg: Settings['openai']): TranslateService {
  async function ask(texts: string[], langName: string, signal?: AbortSignal): Promise<string> {
    const system =
      `You are a professional web-page translator. Translate every string in the user's JSON array into ${langName}. ` +
      'Strict rules: preserve all placeholders exactly as-is and in place — <tN>...</tN> are inline markup wrappers, {{N}} are atomic tokens; ' +
      'translate only natural language; keep URLs, code, numbers and product names unchanged; ' +
      'return ONLY a JSON array of translated strings in the same order, no explanations.';
    const res = await proxyFetch(
      {
        url: `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model: cfg.model,
          temperature: 0,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: JSON.stringify(texts) },
          ],
        }),
      },
      signal,
    );
    if (!res.ok) {
      throw new ServiceError(
        `OpenAI ${res.status}: ${(res.body || res.error || '').slice(0, 300)}`,
        retryableStatus(res.status),
        parseRetryAfter(res.retryAfter),
      );
    }
    const data = JSON.parse(res.body) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new ServiceError('OpenAI: empty response');
    return content;
  }

  /**
   * A malformed or truncated array currently fails the whole batch and retries it unchanged.
   * Splitting on shape errors narrows the blast radius: one awkward unit (or a truncated tail)
   * no longer costs its siblings their translations. Halves settle independently, and a failed
   * half becomes an empty slot the engine retries on its own.
   */
  async function run(texts: string[], langName: string, signal: AbortSignal | undefined, depth: number): Promise<string[]> {
    const content = await ask(texts, langName, signal);
    try {
      return parseArray(content, texts.length);
    } catch (e) {
      if (texts.length <= 1 || depth >= MAX_SPLIT_DEPTH || signal?.aborted) throw e;
      const mid = Math.ceil(texts.length / 2);
      const [left, right] = await Promise.allSettled([
        run(texts.slice(0, mid), langName, signal, depth + 1),
        run(texts.slice(mid), langName, signal, depth + 1),
      ]);
      if (left.status === 'rejected' && right.status === 'rejected') throw left.reason;
      const out = new Array<string>(texts.length).fill('');
      if (left.status === 'fulfilled') left.value.forEach((v, i) => (out[i] = v));
      if (right.status === 'fulfilled') right.value.forEach((v, i) => (out[mid + i] = v));
      return out;
    }
  }

  return {
    id: 'openai',
    async translate(texts, to, signal) {
      if (!cfg.apiKey) throw new ServiceError('OpenAI: API key not configured');
      return run(texts, LANG_NAMES[to] ?? to, signal, 0);
    },
  };
}
