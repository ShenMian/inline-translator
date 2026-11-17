import { ATOMIC_TAGS, isInsideOurs, isOurs, tagOf } from './filter';
import { WRAP_TAGS } from './serialize';

/**
 * Dynamic content watcher: filters noise from our own insertions, debounces dirty
 * containers into engine rescans; watches document/documentElement separately (without
 * subtree) to catch SPA root/body swaps without waking up on <head> churn.
 */
export class Watcher {
  private mo: MutationObserver;
  private roots = new Set<Node>();

  constructor(
    private onDirty: (containers: Set<Element>) => void,
    private onBodySwap: () => void,
  ) {
    this.mo = new MutationObserver((muts) => this.handle(muts));
  }

  observe(root: Node): void {
    if (this.roots.has(root)) return;
    this.roots.add(root);
    this.mo.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['open', 'hidden', 'aria-hidden'],
    });
  }

  observeDocument(): void {
    for (const root of [document, document.documentElement]) {
      if (!root || this.roots.has(root)) continue;
      this.roots.add(root);
      this.mo.observe(root, { childList: true });
    }
  }

  disconnect(): void {
    this.mo.disconnect();
    this.roots.clear();
  }

  private handle(muts: MutationRecord[]): void {
    const dirty = new Set<Element>();
    let bodySwap = false;
    for (const m of muts) {
      if (m.type === 'childList') {
        if (m.target === document || m.target === document.documentElement) {
          for (const n of [...Array.from(m.addedNodes), ...Array.from(m.removedNodes)]) {
            const nm = n.nodeName.toUpperCase();
            if (nm === 'BODY' || nm === 'HTML') bodySwap = true;
          }
          continue;
        }
        const targetEl = m.target.nodeType === Node.ELEMENT_NODE ? (m.target as Element) : m.target.parentElement;
        if (targetEl && (isOurs(targetEl) || isInsideOurs(targetEl))) continue;
        for (const n of m.addedNodes) {
          if (isOurs(n) || isInsideOurs(n)) continue;
          if (n.nodeType === Node.ELEMENT_NODE) {
            dirty.add(n as Element);
          } else if (n.nodeType === Node.TEXT_NODE && targetEl) {
            dirty.add(targetEl);
          }
        }
        for (const n of m.removedNodes) {
          if (isOurs(n) || isInsideOurs(n)) continue;
          if (
            targetEl &&
            (n.nodeType === Node.TEXT_NODE ||
              (n.nodeType === Node.ELEMENT_NODE &&
                (WRAP_TAGS.has(tagOf(n as Element)) || ATOMIC_TAGS.has(tagOf(n as Element)))))
          ) {
            dirty.add(targetEl);
          }
        }
      } else if (m.type === 'characterData') {
        if (!isInsideOurs(m.target) && m.target.parentElement) dirty.add(m.target.parentElement);
      } else if (m.type === 'attributes' && m.target.nodeType === Node.ELEMENT_NODE) {
        const el = m.target as Element;
        if (isOurs(el) || isInsideOurs(el)) continue;
        if (
          (m.attributeName === 'open' && el.hasAttribute('open')) ||
          (m.attributeName === 'hidden' && !(el as HTMLElement).hidden) ||
          (m.attributeName === 'aria-hidden' && el.getAttribute('aria-hidden') !== 'true')
        ) {
          dirty.add(el);
        }
      }
    }
    if (bodySwap) {
      this.onBodySwap();
      return;
    }
    if (dirty.size) this.onDirty(dirty);
  }
}