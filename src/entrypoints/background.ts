import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';

interface ProxyMsg {
  type: 'proxy-fetch';
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

async function handleProxy(msg: ProxyMsg) {
  const ctrl = new AbortController();
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
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: '', error: String(e) };
  } finally {
    clearTimeout(timer);
  }
}

async function toggleActiveTab(): Promise<void> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id != null) {
    browser.tabs.sendMessage(tab.id, { type: 'toggle' }).catch(() => {});
  }
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((msg: ProxyMsg, _sender, sendResponse) => {
    if (msg?.type === 'proxy-fetch') {
      handleProxy(msg).then(sendResponse);
      return true;
    }
  });

  browser.commands.onCommand.addListener((cmd) => {
    if (cmd === 'toggle-translate') void toggleActiveTab();
  });

  void browser.contextMenus.removeAll().then(() => {
    browser.contextMenus.create({ id: 'ilt-toggle', title: 'Translate / restore page', contexts: ['page'] });
  });
  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'ilt-toggle' && tab?.id != null) {
      browser.tabs.sendMessage(tab.id, { type: 'toggle' }).catch(() => {});
    }
  });
});