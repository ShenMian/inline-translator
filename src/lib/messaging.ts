import { browser } from 'wxt/browser';

/** content → background cross-origin fetch proxy (MV3 content scripts are bound by page CORS). */
export interface ProxyRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface ProxyResponse {
  ok: boolean;
  status: number;
  body: string;
  error?: string;
  retryAfter?: string | null;
}

export type ContentMessage =
  | { type: 'toggle' }
  | { type: 'retry' }
  | { type: 'get-state' }
  | { type: 'settings-changed' };

export async function proxyFetch(req: ProxyRequest, signal?: AbortSignal): Promise<ProxyResponse> {
  if (signal?.aborted) return { ok: false, status: 0, body: '', error: 'aborted' };
  // Unique across tabs/frames: the background controller table is global
  const id = crypto.randomUUID();
  const onAbort = () => {
    browser.runtime.sendMessage({ type: 'proxy-abort', id }).catch(() => {});
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return (await browser.runtime.sendMessage({ type: 'proxy-fetch', id, ...req })) as ProxyResponse;
  } catch (e) {
    return { ok: false, status: 0, body: '', error: String(e) };
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}