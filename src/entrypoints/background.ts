import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import type { ContentMessage, ShortcutInfo, ToggleResponse } from '../lib/messaging';
import { getToggleShortcut, openShortcutsPage } from '../lib/shortcut';

interface ProxyMsg {
  type: 'proxy-fetch';
  id?: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

const inflight = new Map<string, AbortController>();

async function handleProxy(msg: ProxyMsg) {
  const ctrl = new AbortController();
  if (msg.id != null) inflight.set(msg.id, ctrl);
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(msg.url, {
      method: msg.method ?? 'GET',
      headers: msg.headers,
      body: msg.body,
      signal: ctrl.signal,
      redirect: 'follow',
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body, retryAfter: res.headers.get('Retry-After') };
  } catch (e) {
    return { ok: false, status: 0, body: '', error: String(e) };
  } finally {
    clearTimeout(timer);
    if (msg.id != null) inflight.delete(msg.id);
  }
}

async function toggleActiveTab(): Promise<ToggleResponse> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id == null) return { ok: false, error: 'No active tab to translate.' };
  return enqueueToggle(tab.id);
}

/**
 * Frames auto-start independently (per-frame language/iframe timing), so a raw flip sent to all
 * of them leaves two groups translating in opposite phase forever. Poll every frame first, then
 * broadcast one absolute target state.
 */
const STATE_POLL_MS = 120;
const pendingPolls = new Map<string, { anyActive: boolean }>();
const toggleChains = new Map<number, Promise<ToggleResponse>>();

async function toggleTab(tabId: number): Promise<ToggleResponse> {
  const token = crypto.randomUUID();
  const poll = { anyActive: false };
  pendingPolls.set(token, poll);
  try {
    await browser.tabs.sendMessage(tabId, { type: 'collect-state', token }).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, STATE_POLL_MS));
    try {
      await browser.tabs.sendMessage(tabId, { type: 'set-active', active: !poll.anyActive });
      return { ok: true };
    } catch {
      return { ok: false, error: 'Inline Translator is not available on this page. Try a regular web page.' };
    }
  } finally {
    pendingPolls.delete(token);
  }
}

/** Serialize per tab so rapid presses each flip exactly once. */
function enqueueToggle(tabId: number): Promise<ToggleResponse> {
  const prev = toggleChains.get(tabId) ?? Promise.resolve({ ok: true } as const);
  const next = prev.then(() => toggleTab(tabId));
  toggleChains.set(tabId, next);
  void next.finally(() => {
    if (toggleChains.get(tabId) === next) toggleChains.delete(tabId);
  });
  return next;
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener(
    (
      msg: ProxyMsg | { type: 'proxy-abort'; id: string } | { type: 'get-shortcut' } | ContentMessage,
      sender,
      sendResponse,
    ) => {
      if (msg?.type === 'proxy-fetch') {
        handleProxy(msg).then(sendResponse);
        return true;
      }
      if (msg?.type === 'proxy-abort') {
        inflight.get(msg.id)?.abort();
        inflight.delete(msg.id);
        sendResponse({});
      }
      if (msg?.type === 'get-shortcut') {
        getToggleShortcut().then((shortcut): ShortcutInfo => ({ shortcut })).then(sendResponse);
        return true;
      }
      if (msg?.type === 'state-report') {
        const poll = pendingPolls.get(msg.token);
        if (poll && msg.active) poll.anyActive = true;
        sendResponse({});
        return;
      }
      if (msg?.type === 'toggle-tab') {
        const tabId = msg.tabId ?? sender.tab?.id;
        const run = tabId != null ? enqueueToggle(tabId) : toggleActiveTab();
        run.then(
          (result) => sendResponse(result),
          (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
        );
        return true;
      }
    },
  );

  // A shortcut taken by another extension fails silently at install; point the user at the picker
  browser.runtime.onInstalled.addListener(({ reason }) => {
    if (reason !== 'install') return;
    void getToggleShortcut().then((shortcut) => {
      if (!shortcut) void openShortcutsPage();
    });
  });

  browser.commands.onCommand.addListener((cmd) => {
    if (cmd === 'toggle-translate') void toggleActiveTab();
  });

  void browser.contextMenus.removeAll().then(() => {
    browser.contextMenus.create({ id: 'ilt-toggle', title: 'Translate / restore page', contexts: ['page'] });
  });
  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'ilt-toggle' && tab?.id != null) void enqueueToggle(tab.id);
  });
});