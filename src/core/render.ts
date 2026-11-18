import { dirForLang } from '../lib/lang';
import type { StyleId } from '../lib/settings';
import { GROUP_CLASS, isInsideOurs, isOurs, MARK, safeMatches, tagOf, winOf, WRAPPER_CLASS } from './filter';
import type { Paragraph } from './types';
import { INLINE_LEVEL_DISPLAYS } from './walk';

export { isInsideOurs, isOurs, MARK, WRAPPER_CLASS };

// Translation typography matches the original: all text properties inherit; no dimming or
// weight resets. Decorative themes are opt-in.
const BASE_CSS = `
.ilt-t{display:inline;unicode-bidi:isolate;font:inherit;color:inherit;letter-spacing:inherit;word-spacing:inherit;text-align:inherit;text-transform:inherit;text-indent:inherit;border:0;background:none;float:none;position:static;width:auto;height:auto;margin:0;padding:0;white-space:inherit;overflow-wrap:break-word;}
.ilt-g{display:inline;font:inherit;color:inherit;}
.ilt-i{unicode-bidi:isolate;}
.ilt-t.ilt-block{display:block;margin-top:.3em;}
.ilt-t.ilt-inline{margin-inline-start:.45em;}
.ilt-s{font-size:0;line-height:0;white-space:pre;}
.ilt-t img,.ilt-t svg{display:inline;max-width:100%;vertical-align:middle;}
[data-ilt-unclamp]{-webkit-line-clamp:unset!important;line-clamp:unset!important;max-height:none!important;}
`;

// Text-level themes decorate the inline .ilt-i inner span so they fragment per line on block
// paragraphs; box-level themes dress the .ilt-t wrapper, shrink-wrapped via inline-block.
// mask/opacity reveal on hover.
const STYLE_CSS: Record<StyleId, string> = {
  none: '',
  underline: `.ilt-i{border-bottom:1px solid #72ece9;}`,
  dashed: `.ilt-i{background:linear-gradient(to right,#59c1bd 0%,#59c1bd 50%,transparent 50%,transparent 100%) repeat-x left bottom;background-size:8px 2px;padding-bottom:2px;}`,
  dotted: `.ilt-i{background-image:linear-gradient(to right,#94a3b8 30%,rgba(255,255,255,0) 0%);background-position:bottom;background-size:5px 1px;background-repeat:repeat-x;padding-bottom:3px;}`,
  wavy: `.ilt-i{text-decoration:underline;text-decoration-color:#72ece9;text-decoration-style:wavy;}`,
  highlight: `.ilt-i{background:#ffff00;box-decoration-break:clone;-webkit-box-decoration-break:clone;}`,
  blockquote: `.ilt-t.ilt-block{display:block;width:fit-content;border-inline-start:4px solid #cc3355;padding-block:4px;padding-inline-start:12px;margin-top:4px;margin-bottom:4px;}`,
  solidBorder: `.ilt-t.ilt-block{display:block;width:fit-content;border:1px solid #94a3b8;padding:6px;margin-top:2px;}.ilt-t.ilt-inline{border:1px solid #94a3b8;padding:2px;}`,
  paper: `.ilt-t.ilt-block{display:block;width:fit-content;margin:8px 0;box-shadow:rgba(0,0,0,.24) 0 3px 8px;padding:16px 32px;}`,
  background: `.ilt-t.ilt-block{display:block;width:fit-content;margin:8px 0;background:rgba(219,175,175,.12);border-radius:4px;padding:12px;}.ilt-t.ilt-inline .ilt-i{background:rgba(219,175,175,.12);padding-left:6px;padding-right:6px;box-decoration-break:clone;-webkit-box-decoration-break:clone;}`,
  dividingLine: `.ilt-t.ilt-block::before{content:"";display:block;max-width:80px;width:10%;border-top:1px dashed #94a3b8;padding-top:8px;}.ilt-t.ilt-inline::before{content:"";border-inline-start:1px dashed #94a3b8;height:16px;max-height:16px;padding-inline-start:8px;}`,
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
  // Constructed sheets must use the target document's own realm constructor (sharing across documents
  // is rejected, and Firefox Xray wrappers forbid assigning content-script arrays to adoptedStyleSheets)
  const doc = root.nodeType === Node.DOCUMENT_NODE ? (root as Document) : (root as ShadowRoot).ownerDocument;
  const SheetCtor = doc?.defaultView?.CSSStyleSheet;
  if (SheetCtor && 'adoptedStyleSheets' in root) {
    try {
      const sheet = new SheetCtor();
      sheet.replaceSync(css);
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
      return () => {
        try {
          root.adoptedStyleSheets = root.adoptedStyleSheets.filter((s) => s !== sheet);
        } catch {
          /* root already torn down */
        }
      };
    } catch {
      /* fall through to <style> element */
    }
  }
  const el = (doc ?? document).createElement('style');
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
  const win = winOf(el);
  const cs = win.getComputedStyle(el);
  const ps = win.getComputedStyle(parent);
  for (const prop of TEXT_PROPS) {
    const v = cs.getPropertyValue(prop);
    if (v !== ps.getPropertyValue(prop)) w.style.setProperty(prop, v);
  }
}

/** Label-like units: translation follows inline on the same line to the right of the original,
 *  avoiding block-in-inline-flow stacking; longer headings and prose paragraphs get their own line. */
const ALWAYS_CHROME_SEL = 'nav,aside,[role="navigation"],[role="banner"],[role="contentinfo"]';
const SECTIONING_CONTENT_SEL = 'article,main,[role="main"],section';
const FLEX_DISPLAYS = new Set([
  'flex', 'inline-flex', 'grid', 'inline-grid',
  'table-row', 'table-row-group', 'table-header-group', 'table-footer-group',
]);
const INLINE_UI_SEL =
  'button,label,summary,legend,option,[role="button"],[role="tab"],[role="menuitem"],[role="option"],[role="switch"]';
/** Dedicated prose paragraphs always stack on a new line so short dialogue/CJK lines keep even rhythm. */
const PROSE_TAGS = new Set(['P', 'BLOCKQUOTE', 'DD', 'FIGCAPTION']);

const INLINE_MAX_CHARS = 24;
const INLINE_MAX_WORDS = 4;
const INLINE_MAX_CJK = 12;

/** Walk up across shadow boundaries. Per HTML5, <header>/<footer> inside <article>/<main>/<section>
 *  are sectioning headers rather than site-wide chrome banners. */
function inChrome(el: Element): boolean {
  let node: Element | null = el;
  while (node) {
    if (node.closest(ALWAYS_CHROME_SEL)) return true;
    const hf = node.closest('header,footer');
    if (hf && !hf.parentElement?.closest(SECTIONING_CONTENT_SEL)) return true;
    const root = node.getRootNode();
    node = root.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? (root as ShadowRoot).host : null;
  }
  return false;
}

function inInlineUi(el: Element): boolean {
  let node: Element | null = el;
  while (node) {
    if (node.closest(INLINE_UI_SEL)) return true;
    const root = node.getRootNode();
    node = root.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? (root as ShadowRoot).host : null;
  }
  return false;
}

function isShortInlineText(text: string): boolean {
  if (text.includes('\n') || text.length > INLINE_MAX_CHARS || /[.!?。！？]$/.test(text)) return false;
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) ?? []).length;
  if (cjk > INLINE_MAX_CJK) return false;
  return text.trim().split(/\s+/).length <= INLINE_MAX_WORDS;
}

function isInlineUnit(p: Paragraph, blockSel = '', inlineSel = ''): boolean {
  const r = p.root;
  if (blockSel && safeMatches(r, blockSel)) return false;
  if (inlineSel && safeMatches(r, inlineSel)) return true;
  if (inInlineUi(r) || inChrome(r)) return true;
  const tag = tagOf(r);
  const win = winOf(r);
  const cs = win.getComputedStyle(r);
  if (FLEX_DISPLAYS.has(cs.display) || INLINE_LEVEL_DISPLAYS.has(cs.display) || cs.whiteSpace === 'nowrap') return true;
  if (PROSE_TAGS.has(tag) || (p.preWhitespace && p.text.includes('\n'))) return false;
  if (!isShortInlineText(p.text)) return false;
  return p.nodes.every(
    (n) => n.nodeType === Node.TEXT_NODE || INLINE_LEVEL_DISPLAYS.has(win.getComputedStyle(n as Element).display),
  );
}

const UNCLAMP_STOP = new Set(['BODY', 'HTML', 'MAIN', 'ARTICLE', 'SECTION', 'NAV', 'HEADER', 'FOOTER', 'ASIDE']);

function unclampAncestors(p: Paragraph): void {
  if (inChrome(p.root)) return;
  const win = winOf(p.root);
  let cur: Element | null = p.root;
  for (let depth = 0; cur && depth < 3; depth++, cur = cur.parentElement) {
    if (UNCLAMP_STOP.has(tagOf(cur))) break;
    const cs = win.getComputedStyle(cur);
    if (cs.webkitLineClamp && cs.webkitLineClamp !== 'none' && cs.webkitLineClamp !== '0') {
      cur.setAttribute('data-ilt-unclamp', '');
      (p.unclamped ??= []).push(cur);
    }
  }
}

function needsSlotGroup(p: Paragraph, parent: Node): parent is Element {
  if (parent.nodeType !== Node.ELEMENT_NODE) return false;
  const el = parent as Element;
  if (el.classList.contains(GROUP_CLASS)) return false;
  if (!p.nodes.every((n) => n.parentNode === el)) return false;
  const cs = winOf(el).getComputedStyle(el);
  const disp = cs.display;
  const isFlex = disp === 'flex' || disp === 'inline-flex';
  const isGrid = disp === 'grid' || disp === 'inline-grid';
  if (!isFlex && !isGrid) return false;
  if (isFlex && cs.flexDirection.startsWith('column')) return true;
  if (isGrid || /space-(between|around|evenly)/.test(cs.justifyContent)) {
    const inRun = new Set(p.nodes);
    for (const c of el.childNodes) {
      if (inRun.has(c) || isOurs(c)) continue;
      if (c.nodeType === Node.ELEMENT_NODE || /\S/.test(c.nodeValue ?? '')) return true;
    }
  }
  return false;
}

export function renderTranslation(p: Paragraph, nodes: Node[], lang: string, blockSel = '', inlineSel = ''): void {
  removeWrapper(p);
  const parent = p.anchor.parentNode;
  if (!parent) return;
  const doc = parent.ownerDocument ?? document;
  // Use <font> rather than <span> so host CSS rules like `a > span` or `.btn > span` never match us
  const w = doc.createElement('font');
  w.className = `${WRAPPER_CLASS} notranslate`;
  w.setAttribute('translate', 'no');
  w.setAttribute('lang', lang);
  (w as unknown as Record<string, unknown>)[MARK] = true;
  const dir = dirForLang(lang);
  const rootCs = winOf(p.root).getComputedStyle(p.root);
  if (rootCs.whiteSpace === 'pre') w.style.whiteSpace = 'pre-wrap';
  // Inline inner element: text-level themes fragment per line even on block paragraphs,
  // and dir + unicode-bidi:isolate keep mixed LTR/RTL runs from scrambling surrounding flow.
  const inner = doc.createElement('font');
  inner.className = 'ilt-i';
  inner.setAttribute('dir', dir);
  inner.append(...nodes);
  w.append(inner);
  matchSourceStyle(w, p);
  const inline = isInlineUnit(p, blockSel, inlineSel);
  if (inline) {
    w.classList.add('ilt-inline');
    if (!/\s$/.test(p.anchor.textContent ?? '')) {
      const sep = doc.createElement('font');
      sep.className = 'ilt-s';
      sep.textContent = ' ';
      w.prepend(sep);
    }
  } else {
    w.classList.add('ilt-block');
    w.setAttribute('dir', dir);
    if (rootCs.direction !== dir) {
      const ta = w.style.textAlign || rootCs.textAlign;
      if (ta === 'left' || ta === 'right' || ta === 'start') {
        w.style.textAlign = 'start';
        if (dir === 'rtl') w.style.marginLeft = 'auto';
        else w.style.marginRight = 'auto';
      }
    }
  }
  unclampAncestors(p);
  if (inline && needsSlotGroup(p, parent)) {
    const g = doc.createElement('font');
    g.className = GROUP_CLASS;
    parent.insertBefore(g, p.nodes[0]!);
    for (const n of p.nodes) g.appendChild(n);
    g.appendChild(w);
    p.group = g;
  } else {
    parent.insertBefore(w, p.anchor.nextSibling);
  }
  p.wrapper = w;
}

export function removeWrapper(p: Paragraph): void {
  p.wrapper?.remove();
  p.wrapper = undefined;
  if (p.group) {
    const g = p.group;
    p.group = undefined;
    if (g.parentNode) {
      g.replaceWith(...Array.from(g.childNodes).filter((n) => !isOurs(n)));
    }
  }
  if (p.unclamped) {
    for (const el of p.unclamped) {
      if (!el.querySelector(`.${WRAPPER_CLASS}`)) el.removeAttribute('data-ilt-unclamp');
    }
    p.unclamped = undefined;
  }
}