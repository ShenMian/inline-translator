import type { StyleId } from '../lib/settings';
import type { Paragraph } from './types';

export const WRAPPER_CLASS = 'ilt-t';
export const MARK = '__ilt__';

// Translation typography matches the original: all text properties inherit (like Immersive
// Translate's default theme); no dimming or weight resets. Decorative themes are opt-in.
const BASE_CSS = `
.ilt-t{display:inline;font:inherit;color:inherit;letter-spacing:inherit;word-spacing:inherit;text-align:inherit;text-transform:inherit;text-indent:inherit;border:0;background:none;float:none;position:static;width:auto;height:auto;margin:0;padding:0;white-space:normal;}
.ilt-t.ilt-block{display:block;margin-top:.3em;}
.ilt-t.ilt-inline{margin-left:.45em;}
.ilt-t img,.ilt-t svg{max-width:100%;vertical-align:middle;}
`;

const STYLE_CSS: Record<StyleId, string> = {
  default: '',
  underline: `.ilt-t{text-decoration:underline;text-decoration-style:dotted;text-underline-offset:3px;}`,
  quote: `.ilt-t.ilt-block{border-left:2px solid currentColor;padding-left:.6em;opacity:.8;}`,
};

export function injectStyles(root: Document | ShadowRoot, ruleCss: string, style: StyleId): () => void {
  const css = BASE_CSS + STYLE_CSS[style] + ruleCss;
  // Constructed sheets must use the target document's own realm constructor (sharing across documents is rejected)
  const doc = root.nodeType === Node.DOCUMENT_NODE ? (root as Document) : (root as ShadowRoot).ownerDocument;
  const SheetCtor = doc?.defaultView?.CSSStyleSheet;
  if (SheetCtor && 'adoptedStyleSheets' in root) {
    const sheet = new SheetCtor();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    return () => {
      root.adoptedStyleSheets = root.adoptedStyleSheets.filter((s) => s !== sheet);
    };
  }
  const el = document.createElement('style');
  el.setAttribute('data-ilt-style', '');
  el.textContent = css;
  // Cross-realm (iframe) documents cannot be tested with instanceof
  const parent = root.nodeType === Node.DOCUMENT_NODE ? ((root as Document).head ?? (root as Document).documentElement) : root;
  parent.appendChild(el);
  return () => el.remove();
}

/** When the whole paragraph is one inline element (e.g. <p><span class="x">…</span></p>), the
 *  translation as its sibling cannot inherit that element's own text styles → copy the properties
 *  that differ from its parent. Everything else inherits naturally. */
const TEXT_PROPS = [
  'font-size', 'font-family', 'font-weight', 'font-style', 'font-variant',
  'line-height', 'letter-spacing', 'word-spacing', 'color',
  'text-align', 'text-transform', 'text-indent', 'text-decoration-line',
];

function matchSourceStyle(w: HTMLElement, p: Paragraph): void {
  if (p.nodes.length !== 1 || p.anchor.nodeType !== Node.ELEMENT_NODE) return;
  const el = p.anchor as Element;
  const parent = el.parentElement;
  if (!parent) return;
  const cs = getComputedStyle(el);
  const ps = getComputedStyle(parent);
  for (const prop of TEXT_PROPS) {
    const v = cs.getPropertyValue(prop);
    if (v !== ps.getPropertyValue(prop)) w.style.setProperty(prop, v);
  }
}

/** Label-like units: translation follows inline on the same line to the right of the original,
 *  avoiding block-in-inline-flow stacking; only prose paragraphs get their own line. */
const CHROME_SEL = 'nav,header,footer,aside,[role="navigation"],[role="banner"],[role="contentinfo"]';
const FLEX_DISPLAYS = new Set([
  'flex', 'inline-flex', 'grid', 'inline-grid',
  'table-row', 'table-row-group', 'table-header-group', 'table-footer-group',
]);

/** Walk up across shadow boundaries (closest inside a shadow cannot see light-DOM ancestors). */
function inChrome(el: Element): boolean {
  let node: Element | null = el;
  while (node) {
    if (node.closest(CHROME_SEL)) return true;
    const root = node.getRootNode();
    node = root.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? (root as ShadowRoot).host : null;
  }
  return false;
}

function isInlineUnit(p: Paragraph): boolean {
  const r = p.root;
  return (
    /^H[1-6]$/.test(r.tagName) ||
    r.getAttribute('role') === 'heading' ||
    r.tagName === 'A' ||
    FLEX_DISPLAYS.has(getComputedStyle(r).display) ||
    inChrome(r)
  );
}

export function renderTranslation(p: Paragraph, nodes: Node[], lang: string): void {
  removeWrapper(p);
  const parent = p.anchor.parentNode;
  if (!parent) return;
  const w = (parent.ownerDocument ?? document).createElement('span');
  w.className = `${WRAPPER_CLASS} notranslate`;
  w.setAttribute('translate', 'no');
  w.setAttribute('lang', lang);
  (w as unknown as Record<string, unknown>)[MARK] = true;
  w.append(...nodes);
  matchSourceStyle(w, p);
  w.classList.add(isInlineUnit(p) ? 'ilt-inline' : 'ilt-block');
  parent.insertBefore(w, p.anchor.nextSibling);
  p.wrapper = w;
}

export function removeWrapper(p: Paragraph): void {
  p.wrapper?.remove();
  p.wrapper = undefined;
}

export function isOurs(node: Node): boolean {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const el = node as Element;
  return (
    (el as unknown as Record<string, unknown>)[MARK] === true ||
    el.classList.contains(WRAPPER_CLASS) ||
    el.hasAttribute('data-ilt-ui')
  );
}

export function isInsideOurs(node: Node): boolean {
  let n: Node | null = node;
  while (n) {
    if (isOurs(n)) return true;
    n = n.parentNode;
  }
  return false;
}