import { isInsideOurs, isOurs } from './render';

/**
 * Dynamic content watcher: filters noise from our own insertions, debounces dirty
 * containers into engine rescans; watches documentElement separately to catch SPA body swaps.
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
    this.mo.observe(root, { childList: true, subtree: true, characterData: true });
  }

  observeDocument(): void {
    this.observe(document.documentElement);
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
        if (m.target === document.documentElement) {
          for (const n of [...Array.from(m.addedNodes), ...Array.from(m.removedNodes)]) {
            if (n.nodeName === 'BODY') bodySwap = true;
          }
          continue;
        }
        let foreign = false;
        for (const n of m.addedNodes) {
          if (isOurs(n) || isInsideOurs(n)) continue;
          foreign = true;
          const container = n.nodeType === Node.ELEMENT_NODE ? (n as Element).parentElement : n.parentElement;
          if (container) dirty.add(container);
        }
        for (const n of m.removedNodes) {
          if (!isOurs(n) && !isInsideOurs(n)) foreign = true;
        }
        if (foreign) {
          const t = m.target.nodeType === Node.ELEMENT_NODE ? (m.target as Element) : m.target.parentElement;
          if (t) dirty.add(t);
        }
      } else if (m.type === 'characterData') {
        if (!isInsideOurs(m.target) && m.target.parentElement) dirty.add(m.target.parentElement);
      }
    }
    if (bodySwap) {
      this.onBodySwap();
      return;
    }
    if (dirty.size) this.onDirty(dirty);
  }
}