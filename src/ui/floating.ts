import { storage } from 'wxt/utils/storage';
import type { EngineStatus } from '../core/engine';

const SVG_NS = 'http://www.w3.org/2000/svg';
const DEFAULT_BOTTOM = 20;
const MIN_BOTTOM = 12;
const BTN_SIZE = 42;
const DRAG_THRESHOLD = 5;

const floatingBottomItem = storage.defineItem<number>('local:floatingBottom', {
  fallback: DEFAULT_BOTTOM,
});

const FLOATING_CSS = `
  :host{all:initial;}
  .wrap{display:flex;flex-direction:column;align-items:center;gap:8px;user-select:none;}
  button{border:1px solid rgba(0,0,0,.08);background:#fff;color:#333;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 10px rgba(0,0,0,.18);transition:background .15s,color .15s,transform .1s;padding:0;font:inherit;touch-action:none;}
  .main{position:relative;width:42px;height:42px;border-radius:50%;}
  .main:hover{transform:scale(1.06);}
  .main.dragging{cursor:grabbing;transform:none;}
  .main.active{background:#2563eb;color:#fff;border-color:transparent;}
  .main.error{background:#dc2626;color:#fff;border-color:transparent;}
  .main svg{width:22px;height:22px;pointer-events:none;}
  .main.busy::after{content:'';position:absolute;inset:-5px;border-radius:50%;border:2px solid transparent;border-top-color:#2563eb;animation:ilt-spin .8s linear infinite;pointer-events:none;}
  .main.active.busy::after{border-top-color:#fff;}
  @keyframes ilt-spin{to{transform:rotate(360deg);}}
  .retry{display:none;height:28px;border-radius:14px;padding:0 10px;gap:5px;background:#dc2626;color:#fff;border-color:transparent;font-size:12px;font-weight:600;}
  .retry.show{display:flex;}
  .retry:hover{filter:brightness(1.08);}
  .retry svg{width:14px;height:14px;}
  @media (prefers-color-scheme: dark){button{background:#1f2937;color:#e5e7eb;border-color:rgba(255,255,255,.1);}.retry{background:#dc2626;color:#fff;}}
`;

function buildSvg(strokeWidth: string, paths: string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', strokeWidth);
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

function clampBottom(val: number): number {
  const max = Math.max(MIN_BOTTOM, window.innerHeight - BTN_SIZE - MIN_BOTTOM);
  return Math.min(max, Math.max(MIN_BOTTOM, Math.round(val)));
}

/** Floating toggle at right edge (vertically draggable): Shadow DOM isolates styles from the host page.
 *  Built via DOM APIs (no innerHTML) so strict Trusted-Types CSP pages never throw. */
export function createFloatingButton(
  onToggle: () => void,
  onRetry: () => void,
  getStatus: () => EngineStatus,
): { host: HTMLElement; sync: () => void; destroy: () => void } {
  const host = document.createElement('div');
  host.setAttribute('data-ilt-ui', '');
  host.setAttribute('translate', 'no');
  let currentBottom = DEFAULT_BOTTOM;
  const applyBottom = (val: number) => {
    currentBottom = clampBottom(val);
    host.style.bottom = `${currentBottom}px`;
  };
  host.style.cssText = `position:fixed;right:20px;bottom:${DEFAULT_BOTTOM}px;z-index:2147483647;`;
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = FLOATING_CSS;

  const wrap = document.createElement('div');
  wrap.className = 'wrap';

  const retry = document.createElement('button');
  retry.className = 'retry';
  retry.title = 'Retry failed translations';
  retry.setAttribute('aria-label', 'Retry failed translations');
  const count = document.createElement('span');
  count.className = 'count';
  retry.append(buildSvg('2', ['M21 12a9 9 0 1 1-2.64-6.36', 'M21 3v6h-6']), count);

  const main = document.createElement('button');
  main.className = 'main';
  main.title = 'Inline Translator: translate / restore (Alt+A · drag vertically)';
  main.setAttribute('aria-label', 'Translate this page');
  // 文: dot + bar on top, crossing 撇/捺 below; a vertical through the bar reads as 丈
  main.append(
    buildSvg('1.8', [
      'M4 5.5h7.5M7.75 3v2.5',
      'M10 5.5c-.2 2.2-1.6 4.6-6.5 8.5',
      'M4.5 8c1.7 2.7 4.3 5 7 6.5',
      'M12.5 20l4-9 4 9M13.8 17h5.4',
    ]),
  );

  wrap.append(retry, main);
  shadow.append(style, wrap);

  let dragPointerId: number | null = null;
  let startY = 0;
  let startBottom = DEFAULT_BOTTOM;
  let moved = false;
  let suppressClick = false;

  main.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragPointerId = e.pointerId;
    startY = e.clientY;
    startBottom = currentBottom;
    moved = false;
    try {
      main.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events without active pointer */
    }
  });

  main.addEventListener('pointermove', (e) => {
    if (dragPointerId !== e.pointerId) return;
    const dy = startY - e.clientY;
    if (!moved && Math.abs(dy) > DRAG_THRESHOLD) {
      moved = true;
      main.classList.add('dragging');
    }
    if (moved) applyBottom(startBottom + dy);
  });

  const endDrag = (e: PointerEvent) => {
    if (dragPointerId !== e.pointerId) return;
    dragPointerId = null;
    main.classList.remove('dragging');
    try {
      if (main.hasPointerCapture(e.pointerId)) main.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (moved) {
      moved = false;
      suppressClick = true;
      void floatingBottomItem.setValue(currentBottom).catch(() => {});
      setTimeout(() => {
        suppressClick = false;
      }, 250);
    }
  };
  main.addEventListener('pointerup', endDrag);
  main.addEventListener('pointercancel', endDrag);

  const onResize = () => applyBottom(currentBottom);
  window.addEventListener('resize', onResize);

  void floatingBottomItem
    .getValue()
    .then((v) => {
      if (typeof v === 'number' && Number.isFinite(v)) applyBottom(v);
    })
    .catch(() => {});
  const unwatch = floatingBottomItem.watch((v) => {
    if (typeof v === 'number' && Number.isFinite(v) && dragPointerId === null) applyBottom(v);
  });

  const sync = () => {
    const s = getStatus();
    main.classList.toggle('active', s.active);
    main.classList.toggle('busy', s.active && s.busy);
    retry.classList.toggle('show', s.active && s.failed > 0 && s.errorRetryable);
    count.textContent = String(s.failed);
    retry.title = s.error ? `Retry ${s.failed} failed — ${s.error}` : `Retry ${s.failed} failed translations`;
    // Config-type failure (e.g. bad API key): flag the main button instead of offering a futile retry
    const configErr = s.active && s.failed > 0 && !s.errorRetryable;
    main.classList.toggle('error', configErr);
    main.title = configErr
      ? `Translation failed — check service settings${s.error ? `: ${s.error}` : ''}`
      : 'Inline Translator: translate / restore (Alt+A · drag vertically)';
  };
  main.addEventListener('click', (e) => {
    if (suppressClick) {
      suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    onToggle();
    sync();
  });
  retry.addEventListener('click', () => {
    onRetry();
    sync();
  });
  document.body.appendChild(host);
  sync();
  return {
    host,
    sync,
    destroy: () => {
      window.removeEventListener('resize', onResize);
      unwatch();
      host.remove();
    },
  };
}
