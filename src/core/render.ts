import type { StyleId } from '../lib/settings';
import type { Paragraph } from './types';
import { INLINE_LEVEL_DISPLAYS } from './walk';

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

// Theme colors/geometry ported from Immersive Translate's inject.css defaults. Text-level
// themes decorate the inline .ilt-i inner span so they fragment per line on block paragraphs
// (Immersive's wrapper/inner split); box-level themes dress the .ilt-t wrapper, shrink-wrapped
// via inline-block. mask/opacity reveal on hover.
const STYLE_CSS: Record<StyleId, string> = {
  none: '',
  underline: `.ilt-i{border-bottom:1px solid #72ece9;}`,
  dashed: `.ilt-i{background:linear-gradient(to right,#59c1bd 0%,#59c1bd 50%,transparent 50%,transparent 100%) repeat-x left bottom;background-size:8px 2px;padding-bottom:2px;}`,
  dotted: `.ilt-i{background-image:linear-gradient(to right,#94a3b8 30%,rgba(255,255,255,0) 0%);background-position:bottom;background-size:5px 1px;background-repeat:repeat-x;padding-bottom:3px;}`,
  wavy: `.ilt-i{text-decoration:underline;text-decoration-color:#72ece9;text-decoration-style:wavy;}`,
  highlight: `.ilt-i{background:#ffff00;box-decoration-break:clone;-webkit-box-decoration-break:clone;}`,
  blockquote: `.ilt-t.ilt-block{display:inline-block;border-left:4px solid #cc3355;padding:4px 0 4px 12px;margin-top:4px;margin-bottom:4px;}`,
  solidBorder: `.ilt-t.ilt-block{display:inline-block;border:1px solid #94a3b8;padding:6px;margin-top:2px;}.ilt-t.ilt-inline{border:1px solid #94a3b8;padding:2px;}`,
  paper: `.ilt-t.ilt-block{display:inline-block;margin:8px 0;box-shadow:rgba(0,0,0,.24) 0 3px 8px;padding:16px 32px;}`,
  background: `.ilt-t.ilt-block{display:inline-block;margin:8px 0;background:rgba(219,175,175,.12);border-radius:4px;padding:12px;}.ilt-t.ilt-inline .ilt-i{background:rgba(219,175,175,.12);padding-left:6px;padding-right:6px;box-decoration-break:clone;-webkit-box-decoration-break:clone;}`,
  dividingLine: `.ilt-t.ilt-block::before{content:"";display:block;max-width:80px;width:10%;border-top:1px dashed #94a3b8;padding-top:8px;}.ilt-t.ilt-inline::before{content:"";border-left:1px dashed #94a3b8;height:16px;max-height:16px;padding-left:8px;}`,
  mask: `.ilt-i{display:inline-block;filter:blur(5px);transition:filter .3s ease;border-radius:10px;}.ilt-i:hover{filter:none;}`,
  opacity: `.ilt-i{display:inline-block;filter:opacity(.1);transition:filter .3s ease;border-radius:10px;}.ilt-i:hover{filter:none;}`,
  weakening: `.ilt-t{opacity:.618;}`,
  grey: `.ilt-i{color:#2f4f4f;}`,
  italic: `.ilt-i{font-style:italic;}`,
  bold: `.ilt-i{font-weight:bold;}`,
};

/** Base + theme CSS, shared by page injection and the popup's live preview. */
export function styleCss(style: StyleId): string {
  return BASE_CSS + STYLE_CSS[style];
}

export function injectStyles(root: Document | ShadowRoot, ruleCss: string, style: StyleId): () => void {
  const css = styleCss(style) + ruleCss;
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
/** Prose containers keep block translations even when laid out as flex/grid items. */
const PROSE_TAGS = new Set(['P', 'ARTICLE', 'SECTION', 'BLOCKQUOTE', 'TD', 'TH', 'DD', 'DT', 'LI', 'FIGCAPTION']);

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
  if (
    /^H[1-6]$/.test(r.tagName) ||
    r.getAttribute('role') === 'heading' ||
    r.tagName === 'A' ||
    inChrome(r)
  ) {
    return true;
  }
  const cs = getComputedStyle(r);
  if (FLEX_DISPLAYS.has(cs.display) || INLINE_LEVEL_DISPLAYS.has(cs.display)) return true;
  // Prose containers get their own line; otherwise a paragraph whose own nodes are all
  // inline-level (crumbs, metadata values, badge chips) is label-like: the translation
  // flows inline inside the container instead of stacking a new line. Block siblings
  // outside the run (e.g. a label H3) do not make the run prose.
  if (PROSE_TAGS.has(r.tagName)) return false;
  return p.nodes.every(
    (n) => n.nodeType === Node.TEXT_NODE || INLINE_LEVEL_DISPLAYS.has(getComputedStyle(n as Element).display),
  );
}

export function renderTranslation(p: Paragraph, nodes: Node[], lang: string): void {
  removeWrapper(p);
  const parent = p.anchor.parentNode;
  if (!parent) return;
  const doc = parent.ownerDocument ?? document;
  const w = doc.createElement('span');
  w.className = `${WRAPPER_CLASS} notranslate`;
  w.setAttribute('translate', 'no');
  w.setAttribute('lang', lang);
  (w as unknown as Record<string, unknown>)[MARK] = true;
  // Inline inner span: text-level themes fragment per line even on block paragraphs
  const inner = doc.createElement('span');
  inner.className = 'ilt-i';
  inner.append(...nodes);
  w.append(inner);
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