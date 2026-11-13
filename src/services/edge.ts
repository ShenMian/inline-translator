import { proxyFetch } from '../lib/messaging';
import { richToPlain } from '../core/serialize';
import { retryableStatus, ServiceError, type TranslateService } from './types';

/** Edge internal unauthenticated endpoint; body is a plain string array, natively batched. */
const ENDPOINT = 'https://edge.microsoft.com/translate/translatetext';

const LANG_MAP: Record<string, string> = {
  'zh-CN': 'zh-Hans',
  'zh-TW': 'zh-Hant',
  'zh-HK': 'zh-Hant',
};

export const edge: TranslateService = {
  id: 'edge',
  async translate(texts, to) {
    const target = LANG_MAP[to] ?? to;
    const url = `${ENDPOINT}?from=&to=${encodeURIComponent(target)}&isEnterpriseClient=false`;
    const res = await proxyFetch({
      url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(texts.map(richToPlain)),
    });
    if (!res.ok) {
      throw new ServiceError(`Edge ${res.status}: ${(res.body || res.error || '').slice(0, 200)}`, retryableStatus(res.status));
    }
    const data = JSON.parse(res.body) as { translations?: { text?: string }[] }[];
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new ServiceError('Edge: unexpected response shape');
    }
    return data.map((d) => d.translations?.[0]?.text ?? '');
  },
};