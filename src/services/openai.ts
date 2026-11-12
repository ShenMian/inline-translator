import { proxyFetch } from '../lib/messaging';
import type { Settings } from '../lib/settings';
import { ServiceError, type TranslateService } from './types';

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
    throw new ServiceError('OpenAI: response array length mismatch');
  }
  return arr.map((x) => String(x));
}

export function createOpenAI(cfg: Settings['openai']): TranslateService {
  return {
    id: 'openai',
    async translate(texts, to) {
      if (!cfg.apiKey) throw new ServiceError('OpenAI: API key not configured');
      const langName = LANG_NAMES[to] ?? to;
      const system =
        `You are a professional web-page translator. Translate every string in the user's JSON array into ${langName}. ` +
        'Strict rules: preserve all placeholders exactly as-is and in place — <tN>...</tN> are inline markup wrappers, {{N}} are atomic tokens; ' +
        'translate only natural language; keep URLs, code, numbers and product names unchanged; ' +
        'return ONLY a JSON array of translated strings in the same order, no explanations.';
      const res = await proxyFetch({
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
      });
      if (!res.ok) {
        throw new ServiceError(`OpenAI ${res.status}: ${(res.body || res.error || '').slice(0, 300)}`, res.status === 429);
      }
      const data = JSON.parse(res.body) as { choices?: { message?: { content?: string } }[] };
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new ServiceError('OpenAI: empty response');
      return parseArray(content, texts.length);
    },
  };
}