import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import { Engine, routeKey } from '../core/engine';
import { hydrateCache } from '../lib/cache';
import { langFamily, pageLang } from '../lib/lang';
import { loadSettings } from '../lib/settings';
import { createFloatingButton } from '../ui/floating';

/** Cross-origin iframes we must never touch: anti-bot challenges, payment card fields, and ad slots. */
const BLOCKED_FRAME_RE =
  /(?:^|\.)(?:challenges\.cloudflare\.com|hcaptcha\.com|recaptcha\.net|js\.stripe\.com|hooks\.stripe\.com|doubleclick\.net|googlesyndication\.com)$|\/cdn-cgi\/challenge-platform\/|\/recaptcha\//i;

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  matchAboutBlank: true,
  runAt: 'document_idle',
  async main(ctx) {
    if (!/^(text\/html|application\/xhtml\+xml)$/.test(document.contentType)) return;
    if (document.designMode === 'on') return;
    if (window !== window.top) {
      try {
        // Same-origin iframes are handled by the top-level engine walk to avoid double translation
        if (window.parent.document) return;
      } catch {
        /* cross-origin iframe: initialize independently (all_frames injection) */
      }
      if (BLOCKED_FRAME_RE.test(location.hostname + location.pathname)) return;
      if (window.innerWidth <= 4 || window.innerHeight <= 4) return;
    }

    let settings = await loadSettings();
    await hydrateCache();
    const engine = new Engine(settings);

    let floating: { host: HTMLElement; sync: () => void } | null = null;
    const syncFloating = (show: boolean) => {
      if (window.top !== window) return;
      if (show && !floating) {
        floating = createFloatingButton(() => engine.toggle(), () => engine.retryFailed(), () => engine.status());
        engine.onStatus = () => floating?.sync();
      } else if (!show && floating) {
        floating.host.remove();
        floating = null;
        engine.onStatus = undefined;
      }
    };
    syncFloating(settings.floating);

    const tryAutoStart = () => {
      if (engine.active) return;
      const host = location.hostname;
      const auto = settings.autoSites[host] ?? settings.auto;
      if (!auto) return;
      const pl = pageLang();
      // In auto mode skip whole pages already in the target language; manual toggle is unrestricted
      if (!pl || pl !== langFamily(settings.targetLang)) engine.start();
    };

    let lastRoute = routeKey(location.href);
    const onSpaNav = () => {
      const cur = routeKey(location.href);
      if (cur === lastRoute) return;
      lastRoute = cur;
      tryAutoStart();
    };
    window.addEventListener('popstate', onSpaNav);
    const nav = (window as { navigation?: EventTarget }).navigation;
    nav?.addEventListener('navigatesuccess', onSpaNav);

    ctx.onInvalidated(() => {
      window.removeEventListener('popstate', onSpaNav);
      nav?.removeEventListener('navigatesuccess', onSpaNav);
      floating?.host.remove();
      engine.destroy();
    });

    browser.runtime.onMessage.addListener((msg: { type?: string }, _sender, sendResponse) => {
      switch (msg?.type) {
        case 'toggle':
          engine.toggle();
          sendResponse({ active: engine.active });
          break;
        case 'retry':
          engine.retryFailed();
          sendResponse(engine.status());
          break;
        case 'get-state':
          sendResponse({ ...engine.status(), host: location.hostname });
          break;
        case 'settings-changed':
          void loadSettings().then((s) => {
            settings = s;
            engine.updateSettings(s);
            syncFloating(s.floating);
            sendResponse({ active: engine.active });
          });
          return true;
      }
    });

    tryAutoStart();
  },
});