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
}

export type ContentMessage =
  | { type: 'toggle' }
  | { type: 'get-state' }
  | { type: 'settings-changed' };

export async function proxyFetch(req: ProxyRequest): Promise<ProxyResponse> {
  try {
    return (await browser.runtime.sendMessage({ type: 'proxy-fetch', ...req })) as ProxyResponse;
  } catch (e) {
    return { ok: false, status: 0, body: '', error: String(e) };
  }
}