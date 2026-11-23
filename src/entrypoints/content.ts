import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import { Engine, routeKey } from '../core/engine';
import { getShadow, tagOf } from '../core/filter';
import { hydrateCache } from '../lib/cache';
import { langFamily, pageLang } from '../lib/lang';
import type { ContentMessage } from '../lib/messaging';
import { loadSettings } from '../lib/settings';
import { createFloatingButton } from '../ui/floating';

/** Cross-origin iframes we must never touch: anti-bot challenges, payment card fields, and ad slots. */
const BLOCKED_FRAME_RE =
  /(?:^|\.)(?:challenges\.cloudflare\.com|hcaptcha\.com|recaptcha\.net|js\.stripe\.com|hooks\.stripe\.com|doubleclick\.net|googlesyndication\.com)$|\/cdn-cgi\/challenge-platform\/|\/recaptcha\//i;

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Node).nodeType !== 'number' || (target as Node).nodeType !== Node.ELEMENT_NODE) {
    return false;
  }
  const el = target as Element;
  return EDITABLE_TAGS.has(tagOf(el)) || (el as HTMLElement).isContentEditable || !!el.closest('[contenteditable="true"]');
}

function deepElementFromPoint(x: number, y: number): Element | null {
  let el: Element | null = document.elementFromPoint(x, y);
  while (el) {
    const sr = getShadow(el);
    if (!sr) break;
    const inner = sr.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  return el;
}

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

    let shortcut = '';
    let floating: { host: HTMLElement; sync: () => void; destroy: () => void } | null = null;
    const syncFloating = (show: boolean) => {
      if (window.top !== window) return;
      if (show && !floating) {
        floating = createFloatingButton(
          () => void browser.runtime.sendMessage({ type: 'toggle-tab' }).catch(() => {}),
          () => engine.retryFailed(),
          () => engine.status(),
          () => shortcut,
        );
        engine.onStatus = () => floating?.sync();
      } else if (!show && floating) {
        floating.destroy();
        floating = null;
        engine.onStatus = undefined;
      }
    };
    syncFloating(settings.floating);
    // Show the accelerator that is really bound; a conflicting extension may leave the command unassigned
    void browser.runtime
      .sendMessage({ type: 'get-shortcut' })
      .then((info: { shortcut?: string } | undefined) => {
        shortcut = info?.shortcut ?? '';
        floating?.sync();
      })
      .catch(() => {});

    // Alt-hover spot translation: tap bare Alt over any paragraph to translate/restore just that block
    let pointerX = -1;
    let pointerY = -1;
    let hasPointer = false;
    let altArmed = false;
    let altDownAt = 0;

    const onPointerMove = (e: PointerEvent) => {
      pointerX = e.clientX;
      pointerY = e.clientY;
      hasPointer = true;
    };
    const disarmAlt = () => {
      altArmed = false;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Alt' && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.repeat) {
        if (!isEditableTarget(e.target)) {
          altArmed = true;
          altDownAt = Date.now();
        }
      } else {
        altArmed = false;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== 'Alt' || !altArmed) return;
      altArmed = false;
      if (!hasPointer || Date.now() - altDownAt > 600 || !document.hasFocus()) return;
      const hit = deepElementFromPoint(pointerX, pointerY);
      if (hit) {
        e.preventDefault();
        void engine.toggleElement(hit);
      }
    };

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerdown', disarmAlt, { passive: true });
    window.addEventListener('wheel', disarmAlt, { passive: true });
    window.addEventListener('blur', disarmAlt);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);

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
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerdown', disarmAlt);
      window.removeEventListener('wheel', disarmAlt);
      window.removeEventListener('blur', disarmAlt);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('popstate', onSpaNav);
      nav?.removeEventListener('navigatesuccess', onSpaNav);
      floating?.destroy();
      engine.destroy();
    });

    browser.runtime.onMessage.addListener((msg: ContentMessage, _sender, sendResponse) => {
      switch (msg?.type) {
        case 'collect-state':
          void browser.runtime.sendMessage({ type: 'state-report', token: msg.token, active: engine.active }).catch(() => {});
          sendResponse({ active: engine.active });
          break;
        case 'set-active':
          engine.setActive(msg.active);
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
