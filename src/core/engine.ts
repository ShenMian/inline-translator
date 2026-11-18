import { cacheGet, cacheKey, cacheSet } from '../lib/cache';
import { isSameLang } from '../lib/lang';
import { joinSelectors, matchRules, type EffectiveRule } from '../lib/rules';
import type { Settings } from '../lib/settings';
import { BUILTIN_RULES } from '../rules/builtin';
import { getService, ServiceError, type TranslateService } from '../services';
import { getShadow, isBlockedByAncestor, isInsideOurs, isOurs, styleOf, tagOf } from './filter';
import { Watcher } from './observe';
import { injectStyles, removeWrapper, renderTranslation } from './render';
import { restore } from './serialize';
import type { Paragraph, Root, WalkContext } from './types';
import { extractParagraphs, isBlock } from './walk';

const BATCH_ITEMS = 8;
const BATCH_CHARS = 3500;
const BATCH_DELAY = 300;
const BATCH_MAX_WAIT = 1200;
const MAX_INFLIGHT = 2;
const RESCAN_DEBOUNCE = 150;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY = 1200;
/** Cap DOM work per frame so a cache-warm rescan never blocks input for long. */
const RENDER_CHUNK = 80;
/** Cap display:none reveal observations so huge tables/menus stay featherweight. */
const MAX_HIDDEN_WATCH = 1500;

/** Strip in-page #anchor fragments while preserving HashRouter routes (#/path, #!/path). */
export function routeKey(url: string): string {
  const idx = url.indexOf('#');
  if (idx < 0) return url;
  const hash = url.slice(idx);
  return /^#!?\/.+/.test(hash) ? url : url.slice(0, idx);
}

/** Live engine state for the floating button / popup: busy drives the spinner, failed the retry affordance. */
export interface EngineStatus {
  active: boolean;
  busy: boolean;
  failed: number;
  error: string;
  /** False for config-type failures (e.g. 401) where retrying is futile until settings change. */
  errorRetryable: boolean;
}

/**
 * Engine orchestration: scan extraction → viewport-lazy translation → batched requests →
 * rich-text restore rendering → dynamic rescans. All state lives in WeakMap/expando, never in
 * DOM attributes, so our own mutations never trigger us.
 */
export class Engine {
  active = false;
  onStatus?: (s: EngineStatus) => void;

  private settings: Settings;
  private service: TranslateService;
  private rule: EffectiveRule;
  private base: Omit<WalkContext, 'styles' | 'blockDesc' | 'shell' | 'onHidden'>;
  private watcher: Watcher;
  private io: IntersectionObserver | null = null;
  private scrollerIos = new Map<Element, IntersectionObserver>();
  private ioTargets = new Map<Element, Paragraph[]>();
  private hiddenRo: ResizeObserver | null = null;
  private observedHidden = new Set<Element>();
  private nodePara = new WeakMap<Node, Paragraph>();
  private wrappers = new Set<Paragraph>();
  private subRoots = new Set<Node>();
  private frameListeners = new WeakSet<HTMLIFrameElement>();
  private styleRoots = new Map<Document | ShadowRoot, () => void>();

  private queue: Paragraph[] = [];
  private queueChars = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private firstQueuedAt = 0;
  private inflight = 0;
  private inflightCtrls = new Set<AbortController>();

  private attempts = new WeakMap<Paragraph, number>();
  private failed = new Set<Paragraph>();
  private retryTimers = new Set<ReturnType<typeof setTimeout>>();
  private retryScheduled = 0;
  private lastError = '';
  private lastErrorRetryable = true;

  private dirty = new Set<Element>();
  private dirtyTimer: ReturnType<typeof setTimeout> | null = null;
  private shadowTimer: ReturnType<typeof setTimeout> | null = null;
  private navCleanup: (() => void) | null = null;
  private lastRoute = routeKey(location.href);
  private destroyed = false;

  /** Pending DOM writes, coalesced into one animation frame (map dedupes repeat results). */
  private renderQueue = new Map<Paragraph, string>();
  private frameCancel: (() => void) | null = null;

  constructor(settings: Settings) {
    this.settings = settings;
    this.service = getService(settings);
    this.rule = matchRules(location.href, [...BUILTIN_RULES, ...settings.customRules]);
    this.base = {
      rule: this.rule,
      ignoreSel: joinSelectors(this.rule.ignore),
      blockSel: joinSelectors(this.rule.block),
      inlineSel: joinSelectors(this.rule.inline),
      keepSel: joinSelectors(this.rule.keep),
    };
    this.watcher = new Watcher(
      (containers) => this.scheduleRescan(containers),
      () => this.restart(),
    );
  }

  private freshCtx(): WalkContext {
    return {
      ...this.base,
      styles: new WeakMap(),
      blockDesc: new WeakMap(),
      shell: new WeakMap(),
      onHidden: (el) => this.watchHidden(el),
    };
  }

  private watchHidden(el: Element): void {
    if (!this.hiddenRo || el.ownerDocument !== document) return;
    if (this.observedHidden.has(el) || this.observedHidden.size >= MAX_HIDDEN_WATCH) return;
    this.observedHidden.add(el);
    this.hiddenRo.observe(el);
  }

  toggle(): void {
    if (this.active) this.stop();
    else this.start();
  }

  start(): void {
    if (this.active || this.destroyed || !document.body) return;
    this.active = true;
    this.lastRoute = routeKey(location.href);
    this.applyStyles(document);
    this.io = new IntersectionObserver((entries) => this.onIntersect(entries, this.io), {
      rootMargin: '100% 0px 200% 0px',
      threshold: 0,
    });
    if (typeof ResizeObserver === 'function') {
      this.hiddenRo = new ResizeObserver((entries) => {
        const revealed = new Set<Element>();
        for (const e of entries) {
          const r = e.contentRect;
          if (r.width > 0 || r.height > 0 || e.target.getClientRects().length > 0) {
            this.hiddenRo?.unobserve(e.target);
            this.observedHidden.delete(e.target as Element);
            revealed.add(e.target as Element);
          }
        }
        if (revealed.size) this.scheduleRescan(revealed);
      });
    }
    this.scanRoot(document.body);
    this.watcher.observe(document.body);
    this.watcher.observeDocument();
    this.bindNavigation();
    // Catch custom elements that attach shadow roots asynchronously shortly after document_idle
    this.shadowTimer = setTimeout(() => {
      this.shadowTimer = null;
      if (this.active && document.body) this.discoverSubRoots(document.body);
    }, 900);
    this.emitStatus();
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    for (const p of this.wrappers) removeWrapper(p);
    this.wrappers.clear();
    this.nodePara = new WeakMap();
    this.io?.disconnect();
    this.io = null;
    for (const sio of this.scrollerIos.values()) sio.disconnect();
    this.scrollerIos.clear();
    this.ioTargets.clear();
    this.hiddenRo?.disconnect();
    this.hiddenRo = null;
    this.observedHidden.clear();
    this.watcher.disconnect();
    this.navCleanup?.();
    this.navCleanup = null;
    if (this.shadowTimer) clearTimeout(this.shadowTimer);
    this.shadowTimer = null;
    this.subRoots.clear();
    this.disposeStyles();
    this.queue = [];
    this.queueChars = 0;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    for (const t of this.retryTimers) clearTimeout(t);
    this.retryTimers.clear();
    this.retryScheduled = 0;
    for (const c of this.inflightCtrls) c.abort();
    this.inflightCtrls.clear();
    this.failed.clear();
    this.attempts = new WeakMap();
    this.lastError = '';
    this.lastErrorRetryable = true;
    this.dirty.clear();
    if (this.dirtyTimer) clearTimeout(this.dirtyTimer);
    this.dirtyTimer = null;
    this.frameCancel?.();
    this.frameCancel = null;
    this.renderQueue.clear();
    this.emitStatus();
  }

  destroy(): void {
    this.destroyed = true;
    this.stop();
  }

  status(): EngineStatus {
    return {
      active: this.active,
      busy: this.queue.length > 0 || this.inflight > 0 || this.retryScheduled > 0,
      failed: this.failed.size,
      error: this.lastError,
      errorRetryable: this.lastErrorRetryable,
    };
  }

  /** Re-enqueue paragraphs that exhausted their automatic retries (manual recovery). */
  retryFailed(): void {
    if (!this.active) return;
    const list = Array.from(this.failed);
    this.failed.clear();
    this.lastError = '';
    this.lastErrorRetryable = true;
    for (const p of list) {
      this.attempts.delete(p);
      if (p.anchor.isConnected && this.nodePara.get(p.anchor) === p) this.enqueue(p);
    }
    this.emitStatus();
  }

  private emitStatus(): void {
    this.onStatus?.(this.status());
  }

  updateSettings(s: Settings): void {
    const prev = this.settings;
    // Style is pure CSS, and rule edits change how the page is scanned; neither needs new requests.
    const oaChanged =
      s.service === 'openai' &&
      (s.openai.baseUrl !== prev.openai.baseUrl ||
        s.openai.apiKey !== prev.openai.apiKey ||
        s.openai.model !== prev.openai.model);
    const retranslate = this.active && (s.targetLang !== prev.targetLang || s.service !== prev.service || oaChanged);
    const rulesChanged = this.active && JSON.stringify(s.customRules) !== JSON.stringify(prev.customRules);
    const styleChanged = this.active && s.style !== prev.style;
    const nextRule = matchRules(location.href, [...BUILTIN_RULES, ...s.customRules]);
    const siteRuleChanged = this.active && JSON.stringify(nextRule) !== JSON.stringify(this.rule);
    this.settings = s;
    this.service = getService(s);
    this.rule = nextRule;
    this.base = {
      rule: this.rule,
      ignoreSel: joinSelectors(this.rule.ignore),
      blockSel: joinSelectors(this.rule.block),
      inlineSel: joinSelectors(this.rule.inline),
      keepSel: joinSelectors(this.rule.keep),
    };
    if (!this.active) return;
    if (retranslate || rulesChanged || siteRuleChanged) {
      this.stop();
      this.start();
    } else if (styleChanged) {
      // Swap stylesheets in place; the DOM and the cache stay untouched
      for (const root of Array.from(this.styleRoots.keys())) this.applyStyles(root);
    }
  }

  private bindNavigation(): void {
    this.navCleanup?.();
    const onNav = () => {
      if (!this.active) return;
      if (routeKey(location.href) !== this.lastRoute && document.body) {
        this.scheduleRescan(new Set([document.body]));
      }
    };
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted && this.active && document.body) this.scheduleRescan(new Set([document.body]));
    };
    window.addEventListener('popstate', onNav);
    window.addEventListener('hashchange', onNav);
    window.addEventListener('pageshow', onPageShow);
    const nav = (window as { navigation?: EventTarget }).navigation;
    nav?.addEventListener('navigatesuccess', onNav);
    this.navCleanup = () => {
      window.removeEventListener('popstate', onNav);
      window.removeEventListener('hashchange', onNav);
      window.removeEventListener('pageshow', onPageShow);
      nav?.removeEventListener('navigatesuccess', onNav);
    };
  }

  private applyStyles(root: Document | ShadowRoot): void {
    this.styleRoots.get(root)?.();
    this.styleRoots.set(root, injectStyles(root, this.rule.css, this.settings.style));
  }

  private disposeStyles(): void {
    for (const dispose of this.styleRoots.values()) dispose();
    this.styleRoots.clear();
  }

  private restart(): void {
    this.stop();
    this.start();
  }

  // ---------- scan & register ----------

  private scanRoot(root: Root, immediate = false): void {
    const ctx = this.freshCtx();
    for (const p of extractParagraphs(root, ctx)) this.register(p, ctx, immediate);
    this.discoverSubRoots(root);
  }

  /** Walk past display:contents wrappers (which have 0x0 client rects and never trigger IO). */
  private resolveIoTarget(p: Paragraph, ctx: WalkContext): Element | null {
    let cur: Element | null =
      p.anchor.nodeType === Node.ELEMENT_NODE ? (p.anchor as Element) : (p.anchor.parentElement ?? p.root);
    while (cur && cur.nodeType === Node.ELEMENT_NODE) {
      if (styleOf(cur, ctx).display !== 'contents') return cur;
      if (cur.parentElement) {
        cur = cur.parentElement;
      } else {
        const root = cur.getRootNode();
        cur = root.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? (root as ShadowRoot).host : null;
      }
    }
    return null;
  }

  private onIntersect(entries: IntersectionObserverEntry[], obs: IntersectionObserver | null): void {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const ps = this.ioTargets.get(e.target);
      obs?.unobserve(e.target);
      this.ioTargets.delete(e.target);
      ps?.forEach((p) => this.enqueue(p));
    }
  }

  /** Find an enclosing inner scroll container (overflow-y: auto/scroll) so IO rootMargin expands its scrollport. */
  private findScrollRoot(el: Element, ctx: WalkContext): Element | null {
    let cur: Element | null = el.parentElement;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      const oy = styleOf(cur, ctx).overflowY;
      if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && cur.clientHeight > 0 && cur.scrollHeight > cur.clientHeight + 4) {
        return cur;
      }
      if (cur.parentElement) {
        cur = cur.parentElement;
      } else {
        const root = cur.getRootNode();
        cur = root.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? (root as ShadowRoot).host : null;
      }
    }
    return null;
  }

  private observerFor(target: Element, ctx: WalkContext): IntersectionObserver | null {
    const scroller = this.findScrollRoot(target, ctx);
    if (!scroller) return this.io;
    let sio = this.scrollerIos.get(scroller);
    if (!sio) {
      sio = new IntersectionObserver((entries) => this.onIntersect(entries, sio!), {
        root: scroller,
        rootMargin: '100% 0px 200% 0px',
        threshold: 0,
      });
      this.scrollerIos.set(scroller, sio);
    }
    return sio;
  }

  private register(p: Paragraph, ctx: WalkContext, immediate = false): void {
    if (isSameLang(p.text, this.settings.targetLang)) return;
    const existing = this.nodePara.get(p.anchor);
    if (existing) {
      if (existing.hash === p.hash && existing.wrapper?.isConnected) return;
      removeWrapper(existing);
      this.wrappers.delete(existing);
    }
    for (const n of p.nodes) this.nodePara.set(n, p);
    if (immediate) {
      this.enqueue(p);
      return;
    }
    const target = this.resolveIoTarget(p, ctx);
    if (!target || target.ownerDocument !== document) {
      this.enqueue(p);
      return;
    }
    let list = this.ioTargets.get(target);
    if (!list) {
      list = [];
      this.ioTargets.set(target, list);
      this.observerFor(target, ctx)?.observe(target);
    }
    list.push(p);
  }

  /** Pierce shadow roots and same-origin iframes; cross-origin iframes get their own all_frames injection. */
  private discoverSubRoots(root: Root): void {
    // Use nodeType rather than instanceof Element so cross-realm iframe elements match too
    const els =
      root.nodeType === Node.ELEMENT_NODE
        ? (root as Element).querySelectorAll('*')
        : (root as ShadowRoot).querySelectorAll('*');
    for (const el of Array.from(els)) {
      if (isOurs(el) || isInsideOurs(el)) continue;
      // Shadow/iframe piercing must honor ignore regions too, or chrome web components leak translations
      if (this.base.ignoreSel && el.closest(this.base.ignoreSel)) continue;
      const sr = getShadow(el);
      if (sr && !this.subRoots.has(sr)) {
        this.subRoots.add(sr);
        this.applyStyles(sr);
        this.scanRoot(sr);
        this.watcher.observe(sr);
      }
      if (tagOf(el) === 'IFRAME') {
        const frame = el as HTMLIFrameElement;
        const tryRegister = () => {
          if (!this.active) return;
          try {
            const doc = frame.contentDocument;
            if (doc?.body && !this.subRoots.has(doc.body)) {
              this.subRoots.add(doc.body);
              this.applyStyles(doc);
              // Cross-document elements make IO unreliable → enqueue directly
              this.scanRoot(doc.body, true);
              this.watcher.observe(doc.body);
            }
          } catch {
            // Cross-origin iframe inaccessible; covered by its own all_frames injection
          }
        };
        tryRegister();
        // The iframe may finish loading after the parent scan (or change src later)
        if (!this.frameListeners.has(frame)) {
          this.frameListeners.add(frame);
          frame.addEventListener('load', tryRegister);
        }
      }
    }
  }

  // ---------- batch translation ----------

  private enqueue(p: Paragraph): void {
    if (!this.active || this.nodePara.get(p.anchor) !== p) return;
    const key = cacheKey(this.service.id, this.settings.targetLang, p.rich);
    const cached = cacheGet(key);
    if (cached !== undefined) {
      this.scheduleRender(p, cached);
      return;
    }
    this.queue.push(p);
    this.queueChars += p.rich.length;
    if (this.queue.length === 1 && this.inflight === 0) this.emitStatus();
    if (!this.firstQueuedAt) this.firstQueuedAt = Date.now();
    if (this.queue.length >= BATCH_ITEMS || this.queueChars >= BATCH_CHARS || Date.now() - this.firstQueuedAt >= BATCH_MAX_WAIT) {
      this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), BATCH_DELAY);
    }
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.queue.length) {
      this.firstQueuedAt = 0;
      return;
    }
    while (this.queue.length && this.inflight < MAX_INFLIGHT) {
      let take = 0;
      let chars = 0;
      while (take < this.queue.length && take < BATCH_ITEMS) {
        const len = this.queue[take]!.rich.length;
        if (take > 0 && chars + len > BATCH_CHARS) break;
        chars += len;
        take++;
      }
      const batch = this.queue.splice(0, take);
      this.queueChars = Math.max(0, this.queueChars - chars);
      if (!this.queue.length) this.firstQueuedAt = 0;
      this.dispatchBatch(batch);
    }
  }

  private dispatchBatch(batch: Paragraph[]): void {
    this.inflight++;
    const ctrl = new AbortController();
    this.inflightCtrls.add(ctrl);
    const to = this.settings.targetLang;
    const serviceId = this.service.id;
    this.service
      .translate(batch.map((p) => p.rich), to, ctrl.signal)
      .then((results) => {
        results.forEach((tr, i) => {
          const p = batch[i];
          if (!p) return;
          // Empty result = this unit failed while its siblings may have succeeded; retry it alone
          if (!tr) {
            this.handleItemFailure(p, true);
            return;
          }
          cacheSet(cacheKey(serviceId, to, p.rich), tr);
          this.scheduleRender(p, tr);
        });
        // A short response leaves the tail unaddressed; retry those units instead of dropping them
        for (let i = results.length; i < batch.length; i++) this.handleItemFailure(batch[i]!, true);
      })
      .catch((e) => {
        // Aborts come from stop(): no user-visible failure to report
        if (ctrl.signal.aborted) return;
        const retryable = e instanceof ServiceError ? e.retryable : true;
        const retryAfterMs = e instanceof ServiceError ? e.retryAfterMs : undefined;
        this.lastError = e instanceof Error ? e.message : String(e);
        this.lastErrorRetryable = retryable;
        console.warn('[ilt] translate failed:', e);
        for (const p of batch) this.handleItemFailure(p, retryable, retryAfterMs);
      })
      .finally(() => {
        this.inflight--;
        this.inflightCtrls.delete(ctrl);
        if (this.active && this.queue.length) this.flush();
        this.emitStatus();
      });
  }

  /** Bounded exponential-backoff retry for a failed unit; mark it failed once attempts run out. */
  private handleItemFailure(p: Paragraph, retryable: boolean, retryAfterMs?: number): void {
    if (!this.active || this.nodePara.get(p.anchor) !== p) return;
    const n = (this.attempts.get(p) ?? 0) + 1;
    this.attempts.set(p, n);
    if (retryable && n < MAX_ATTEMPTS) {
      this.retryScheduled++;
      // Honor the server's Retry-After cooldown, but never retry sooner than our own backoff
      const delay = Math.max(retryAfterMs ?? 0, RETRY_BASE_DELAY * 2 ** (n - 1));
      const t = setTimeout(() => {
        this.retryTimers.delete(t);
        this.retryScheduled--;
        if (this.active && this.nodePara.get(p.anchor) === p) this.enqueue(p);
        this.emitStatus();
      }, delay);
      this.retryTimers.add(t);
    } else {
      this.failed.add(p);
    }
    this.emitStatus();
  }

  private applyResult(p: Paragraph, tr: string): void {
    if (!this.active || !p.anchor.isConnected || this.nodePara.get(p.anchor) !== p) return;
    const nodes = restore(tr, p.tokens);
    if (!nodes.length) return;
    // Skip redundant bilingual echoes when proper nouns / versions translate identically (e.g. "jQuery 4.1.0")
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
    const outText = norm(nodes.map((n) => n.textContent ?? '').join(''));
    const srcText = norm(p.nodes.map((n) => n.textContent ?? '').join(''));
    if (!outText || outText === srcText) {
      this.failed.delete(p);
      this.attempts.delete(p);
      return;
    }
    renderTranslation(p, nodes, this.settings.targetLang, this.base.blockSel, this.base.inlineSel);
    this.wrappers.add(p);
    this.failed.delete(p);
    this.attempts.delete(p);
  }

  /**
   * Coalesce DOM writes into animation frames. Inserting many translations one by one forces a
   * layout per unit and makes the page crawl; batching also lets us measure how far the content
   * moved and correct the scroll position once per frame.
   */
  private scheduleRender(p: Paragraph, tr: string): void {
    this.renderQueue.set(p, tr);
    this.scheduleRenderFlush();
  }

  private flushRenders(): void {
    if (!this.active) {
      this.renderQueue.clear();
      return;
    }
    const chunk: [Paragraph, string][] = [];
    for (const entry of this.renderQueue) {
      chunk.push(entry);
      if (chunk.length >= RENDER_CHUNK) break;
    }
    for (const [p] of chunk) this.renderQueue.delete(p);

    const anchor = this.captureScrollAnchor(chunk);
    // Read before the writes: restoring + inserting invalidates layout anyway
    const before = anchor ? anchor.top : 0;
    for (const [p, tr] of chunk) this.applyResult(p, tr);
    if (anchor && anchor.el.isConnected) {
      const delta = anchor.el.getBoundingClientRect().top - before;
      // Translations inserted above the viewport/scroller grow content and push the reader down;
      // scroll back by the same amount. A huge delta means unrelated layout churn, so leave it alone.
      if (anchor.scroller) {
        if (Math.abs(delta) > 1 && Math.abs(delta) < anchor.scroller.clientHeight * 3) {
          anchor.scroller.scrollTop += delta;
        }
      } else if (Math.abs(delta) > 1 && Math.abs(delta) < window.innerHeight * 2) {
        window.scrollBy(0, delta);
      }
    }
    if (this.renderQueue.size) this.scheduleRenderFlush();
  }

  private scheduleRenderFlush(): void {
    if (this.frameCancel) return;
    const run = () => {
      this.frameCancel = null;
      this.flushRenders();
    };
    // rAF is paused in background tabs; fall back to a timer so popup-triggered runs still render
    if (document.hidden) {
      const t = setTimeout(run, 16);
      this.frameCancel = () => clearTimeout(t);
    } else {
      const id = requestAnimationFrame(run);
      this.frameCancel = () => cancelAnimationFrame(id);
    }
  }

  private findScrolledContainer(el: Element): Element | null {
    let cur: Element | null = el.parentElement;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      if (cur.scrollTop > 0 && cur.scrollHeight > cur.clientHeight) {
        const oy = getComputedStyle(cur).overflowY;
        if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') return cur;
      }
      cur = cur.parentElement;
    }
    return null;
  }

  /** Sample a non-fixed element currently visible in the viewport (or inner scroll container) so
   *  offscreen-above insertions keep the reading line steady. */
  private captureScrollAnchor(chunk: [Paragraph, string][]): { el: Element; top: number; scroller: Element | null } | null {
    if (document.hidden) return null;
    for (const [p] of chunk) {
      const el = p.anchor.nodeType === Node.ELEMENT_NODE ? (p.anchor as Element) : p.anchor.parentElement;
      if (!el || el.ownerDocument !== document || !el.isConnected) continue;
      const sc = this.findScrolledContainer(el);
      if (sc) {
        const sr = sc.getBoundingClientRect();
        if (el.getBoundingClientRect().top < sr.bottom) {
          const x = Math.floor(sr.left + sr.width / 2);
          for (const ratio of [0.3, 0.5]) {
            const hit = document.elementFromPoint(x, Math.floor(sr.top + sr.height * ratio));
            if (hit && sc.contains(hit) && hit !== sc && !isOurs(hit) && !isInsideOurs(hit)) {
              return { el: hit, top: hit.getBoundingClientRect().top, scroller: sc };
            }
          }
        }
      }
    }
    if (window.scrollY <= 0) return null;
    const affectsViewport = chunk.some(([p]) => {
      const el = p.anchor.nodeType === Node.ELEMENT_NODE ? (p.anchor as Element) : p.anchor.parentElement;
      return !!el && el.ownerDocument === document && el.isConnected && el.getBoundingClientRect().top < window.innerHeight;
    });
    if (!affectsViewport) return null;
    const x = Math.floor(window.innerWidth / 2);
    for (const ratio of [0.25, 0.5, 0.15]) {
      const hit = document.elementFromPoint(x, Math.floor(window.innerHeight * ratio));
      if (hit && hit !== document.body && hit !== document.documentElement && !isOurs(hit) && !isInsideOurs(hit)) {
        const pos = getComputedStyle(hit).position;
        if (pos !== 'fixed' && pos !== 'sticky') {
          return { el: hit, top: hit.getBoundingClientRect().top, scroller: null };
        }
      }
    }
    return null;
  }

  // ---------- dynamic rescan ----------

  private scheduleRescan(containers: Set<Element>): void {
    for (const c of containers) this.dirty.add(c);
    if (this.dirtyTimer) return;
    this.dirtyTimer = setTimeout(() => {
      this.dirtyTimer = null;
      const task = () => {
        const set = new Set(this.dirty);
        this.dirty.clear();
        this.rescan(set);
      };
      if (typeof requestIdleCallback === 'function') requestIdleCallback(task, { timeout: 500 });
      else setTimeout(task, 0);
    }, RESCAN_DEBOUNCE);
  }

  private rescan(containers: Set<Element>): void {
    if (!this.active) return;
    const route = routeKey(location.href);
    if (route !== this.lastRoute) {
      this.lastRoute = route;
      const prevRule = JSON.stringify(this.rule);
      this.updateSettings(this.settings); // re-match rules for the current URL
      // If updateSettings didn't already restart due to a rule change, scan the new route view
      if (this.active && JSON.stringify(this.rule) === prevRule && document.body) {
        this.scanRoot(document.body);
        this.cleanup();
      }
      return;
    }
    // Drop containers nested in others or inside skip/atomic ancestors, then walk up to block boundaries
    const ctx = this.freshCtx();
    const list = Array.from(containers).filter(
      (c) => c.isConnected && !isOurs(c) && !isInsideOurs(c) && !isBlockedByAncestor(c, ctx),
    );
    const roots = new Set<Element>();
    for (let c of list) {
      if (list.some((other) => other !== c && other.contains(c))) continue;
      const body = c.ownerDocument?.body ?? document.body;
      while (c.parentElement && c !== body && !isBlock(c, ctx)) c = c.parentElement;
      if (!isBlockedByAncestor(c, ctx)) roots.add(c);
    }
    for (const r of roots) {
      const immediate = r.ownerDocument !== document;
      const ps = extractParagraphs(r, ctx);
      for (const p of ps) this.register(p, ctx, immediate);
      this.discoverSubRoots(r);
    }
    this.cleanup();
  }

  /** Remove orphan translations whose anchor is gone. */
  private cleanup(): void {
    for (const p of this.wrappers) {
      if (!p.wrapper?.isConnected || !p.anchor.isConnected) {
        removeWrapper(p);
        this.wrappers.delete(p);
      }
    }
    let pruned = false;
    for (const p of this.failed) {
      if (!p.anchor.isConnected) {
        this.failed.delete(p);
        pruned = true;
      }
    }
    if (pruned) this.emitStatus();
  }
}