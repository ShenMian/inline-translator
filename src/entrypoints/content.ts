import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import { Engine } from '../core/engine';
import { langFamily, pageLang } from '../lib/lang';
import { loadSettings } from '../lib/settings';
import { createFloatingButton } from '../ui/floating';

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
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
    }

    const settings = await loadSettings();
    const engine = new Engine(settings);
    ctx.onInvalidated(() => engine.destroy());

    let floating: { host: HTMLElement; sync: () => void } | null = null;
    const syncFloating = (show: boolean) => {
      if (window.top !== window) return;
      if (show && !floating) {
        floating = createFloatingButton(() => engine.toggle(), () => engine.active);
        engine.onState = () => floating?.sync();
      } else if (!show && floating) {
        floating.host.remove();
        floating = null;
        engine.onState = undefined;
      }
    };
    syncFloating(settings.floating);

    browser.runtime.onMessage.addListener((msg: { type?: string }, _sender, sendResponse) => {
      switch (msg?.type) {
        case 'toggle':
          engine.toggle();
          sendResponse({ active: engine.active });
          break;
        case 'get-state':
          sendResponse({ active: engine.active, host: location.hostname });
          break;
        case 'settings-changed':
          void loadSettings().then((s) => {
            engine.updateSettings(s);
            syncFloating(s.floating);
            sendResponse({ active: engine.active });
          });
          return true;
      }
    });

    const host = location.hostname;
    const auto = settings.autoSites[host] ?? settings.auto;
    if (auto) {
      const pl = pageLang();
      // In auto mode skip whole pages already in the target language; manual toggle is unrestricted
      if (!pl || pl !== langFamily(settings.targetLang)) engine.start();
    }
  },
});