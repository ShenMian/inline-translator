import { cacheGet, cacheKey, cacheSet } from '../lib/cache';
import { isSameLang } from '../lib/lang';
import { joinSelectors, matchRules, type EffectiveRule } from '../lib/rules';
import type { Settings } from '../lib/settings';
import { BUILTIN_RULES } from '../rules/builtin';
import { getService, ServiceError, type TranslateService } from '../services';
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

/** Live engine state for the floating button / popup: busy drives the spinner, failed the retry affordance. */
export interface EngineStatus {
  active: boolean;
  busy: boolean;
  failed: number;
  error: string;
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
  private base: Omit<WalkContext, 'styles' | 'blockDesc' | 'shell'>;
  private watcher: Watcher;
  private io: IntersectionObserver | null = null;
  private ioTargets = new Map<Element, Paragraph[]>();
  private nodePara = new WeakMap<Node, Paragraph>();
  private wrappers = new Set<Paragraph>();
  private subRoots = new Set<Node>();
  private frameListeners = new WeakSet<HTMLIFrameElement>();
  private styleDisposers: (() => void)[] = [];

  private queue: Paragraph[] = [];
  private queueChars = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private firstQueuedAt = 0;
  private inflight = 0;

  private attempts = new WeakMap<Paragraph, number>();
  private failed = new Set<Paragraph>();
  private retryTimers = new Set<ReturnType<typeof setTimeout>>();
  private retryScheduled = 0;
  private lastError = '';

  private dirty = new Set<Element>();
  private dirtyTimer: ReturnType<typeof setTimeout> | null = null;
  private lastUrl = location.href;
  private destroyed = false;

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
    return { ...this.base, styles: new WeakMap(), blockDesc: new WeakMap(), shell: new WeakMap() };
  }

  toggle(): void {
    if (this.active) this.stop();
    else this.start();
  }

  start(): void {
    if (this.active || this.destroyed || !document.body) return;
    this.active = true;
    this.styleDisposers.push(injectStyles(document, this.rule.css, this.settings.style));
    this.io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const ps = this.ioTargets.get(e.target);
          this.io?.unobserve(e.target);
          this.ioTargets.delete(e.target);
          ps?.forEach((p) => this.enqueue(p));
        }
      },
      { rootMargin: '0px 0px 200% 0px', threshold: 0 },
    );
    this.scanRoot(document.body);
    this.watcher.observe(document.body);
    this.watcher.observeDocument();
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
    this.ioTargets.clear();
    this.watcher.disconnect();
    this.subRoots.clear();
    this.styleDisposers.forEach((d) => d());
    this.styleDisposers = [];
    this.queue = [];
    this.queueChars = 0;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    for (const t of this.retryTimers) clearTimeout(t);
    this.retryTimers.clear();
    this.retryScheduled = 0;
    this.failed.clear();
    this.attempts = new WeakMap();
    this.lastError = '';
    this.dirty.clear();
    if (this.dirtyTimer) clearTimeout(this.dirtyTimer);
    this.dirtyTimer = null;
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
    };
  }

  /** Re-enqueue paragraphs that exhausted their automatic retries (manual recovery). */
  retryFailed(): void {
    if (!this.active) return;
    const list = Array.from(this.failed);
    this.failed.clear();
    this.lastError = '';
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
    const needRetranslate =
      this.active && (s.targetLang !== this.settings.targetLang || s.service !== this.settings.service || s.style !== this.settings.style);
    this.settings = s;
    this.service = getService(s);
    this.rule = matchRules(location.href, [...BUILTIN_RULES, ...s.customRules]);
    this.base = {
      rule: this.rule,
      ignoreSel: joinSelectors(this.rule.ignore),
      blockSel: joinSelectors(this.rule.block),
      inlineSel: joinSelectors(this.rule.inline),
      keepSel: joinSelectors(this.rule.keep),
    };
    if (needRetranslate) {
      this.stop();
      this.start();
    }
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
    const target = p.anchor.nodeType === Node.ELEMENT_NODE ? (p.anchor as Element) : (p.anchor.parentElement ?? p.root);
    if (target.nodeType !== Node.ELEMENT_NODE) {
      this.enqueue(p);
      return;
    }
    let list = this.ioTargets.get(target);
    if (!list) {
      list = [];
      this.ioTargets.set(target, list);
      this.io?.observe(target);
    }
    list.push(p);
    void ctx;
  }

  /** Pierce open shadow roots and same-origin iframes; cross-origin iframes get their own all_frames injection. */
  private discoverSubRoots(root: Root): void {
    const scope = root instanceof Element ? root : null;
    const els = scope ? scope.querySelectorAll('*') : (root as ShadowRoot).querySelectorAll('*');
    for (const el of Array.from(els)) {
      // Shadow/iframe piercing must honor ignore regions too, or chrome web components leak translations
      if (this.base.ignoreSel && el.closest(this.base.ignoreSel)) continue;
      const sr = el.shadowRoot;
      if (sr && !this.subRoots.has(sr)) {
        this.subRoots.add(sr);
        this.styleDisposers.push(injectStyles(sr, this.rule.css, this.settings.style));
        this.scanRoot(sr);
        this.watcher.observe(sr);
      }
      if (el.tagName === 'IFRAME') {
        const frame = el as HTMLIFrameElement;
        const tryRegister = () => {
          if (!this.active) return;
          try {
            const doc = frame.contentDocument;
            if (doc?.body && !this.subRoots.has(doc.body)) {
              this.subRoots.add(doc.body);
              this.styleDisposers.push(injectStyles(doc, this.rule.css, this.settings.style));
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
      this.applyResult(p, cached);
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
    if (this.inflight >= MAX_INFLIGHT) {
      this.flushTimer = setTimeout(() => this.flush(), 400);
      return;
    }
    const batch = this.queue;
    this.queue = [];
    this.queueChars = 0;
    this.firstQueuedAt = 0;
    this.inflight++;
    const to = this.settings.targetLang;
    const serviceId = this.service.id;
    this.service
      .translate(batch.map((p) => p.rich), to)
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
          this.applyResult(p, tr);
        });
      })
      .catch((e) => {
        const retryable = e instanceof ServiceError ? e.retryable : true;
        this.lastError = e instanceof Error ? e.message : String(e);
        console.warn('[ilt] translate failed:', e);
        for (const p of batch) this.handleItemFailure(p, retryable);
      })
      .finally(() => {
        this.inflight--;
        this.emitStatus();
      });
  }

  /** Bounded exponential-backoff retry for a failed unit; mark it failed once attempts run out. */
  private handleItemFailure(p: Paragraph, retryable: boolean): void {
    if (!this.active || this.nodePara.get(p.anchor) !== p) return;
    const n = (this.attempts.get(p) ?? 0) + 1;
    this.attempts.set(p, n);
    if (retryable && n < MAX_ATTEMPTS) {
      this.retryScheduled++;
      const t = setTimeout(() => {
        this.retryTimers.delete(t);
        this.retryScheduled--;
        if (this.active && this.nodePara.get(p.anchor) === p) this.enqueue(p);
        this.emitStatus();
      }, RETRY_BASE_DELAY * 2 ** (n - 1));
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
    renderTranslation(p, nodes, this.settings.targetLang);
    this.wrappers.add(p);
    this.failed.delete(p);
    this.attempts.delete(p);
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
    if (location.href !== this.lastUrl) {
      this.lastUrl = location.href;
      this.updateSettings(this.settings); // re-match rules for the current URL
      this.scanRoot(document.body);
      this.cleanup();
      return;
    }
    // Drop containers nested in others, then walk up to block boundaries
    const list = Array.from(containers).filter((c) => c.isConnected);
    const roots = new Set<Element>();
    const ctx = this.freshCtx();
    for (let c of list) {
      if (list.some((other) => other !== c && other.contains(c))) continue;
      while (c.parentElement && c !== document.body && !isBlock(c, ctx)) c = c.parentElement;
      roots.add(c);
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