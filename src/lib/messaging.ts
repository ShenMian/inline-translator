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
  /** Any of our contexts asks the background for a tab-wide translate/restore. */
  | { type: 'toggle-tab'; tabId?: number }
  /** Background polls every frame before deciding the tab-wide target state. */
  | { type: 'collect-state'; token: string }
  /** A frame answers a collect-state poll. */
  | { type: 'state-report'; token: string; active: boolean }
  /** Background applies the absolute target state so frames can never end up in opposite phase. */
  | { type: 'set-active'; active: boolean }
  | { type: 'retry' }
  | { type: 'get-state' }
  | { type: 'settings-changed' };

/** Content scripts cannot read the commands API, so the background answers with the real binding. */
export interface ShortcutInfo {
  shortcut: string;
}

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