import type { WalkContext } from './types';

export const WRAPPER_CLASS = 'ilt-t';
export const MARK = '__ilt__';

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

/** Never entered: invisible, lazy, decorative-vector, ruby-reading, code-block and similar regions.
 *  SVG is excluded (matching Immersive Translate & KISS) rather than cloned as an atomic token:
 *  trailing UI chevrons/icons (`<a>About Us <svg/></a>`) stay after the translation instead of
 *  getting duplicated inside `.ilt-t` (where Tailwind's `svg { display: block }` stacks them). */
const DROP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'TITLE', 'META', 'LINK', 'BASE',
  'SLOT', 'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'PRE', 'SVG', 'RP', 'RT', 'DATALIST', 'PARAM', 'TRACK',
]);

/** Kept verbatim: atomic placeholder inside a paragraph, never split for translation. */
export const ATOMIC_TAGS = new Set([
  'CODE', 'KBD', 'SAMP', 'VAR', 'TT', 'SUB', 'SUP',
  'IMG', 'MATH', 'PICTURE', 'CANVAS', 'VIDEO', 'AUDIO', 'EMBED',
  'INPUT', 'SELECT', 'TEXTAREA', 'MAP', 'AREA',
]);

/** Universal math containers rendered with nested spans/SVGs (KaTeX, MathJax v2/v3, LaTeX). */
const GLOBAL_KEEP_SEL =
  '.katex,.katex-display,mjx-container,.MathJax,.MathJax_Preview,.MathJax_Display,' +
  '.MathJax_CHTML,.MathJax_SVG,math-renderer,.mwe-math-element,.ltx_Math,.math-inline,.math-block';

/** Ligature icon fonts, div-based code editors/highlighters, and screen-reader-only helpers. */
const GLOBAL_IGNORE_SEL =
  '.material-icons,material-icon,.google-symbols,[class^="material-symbols-"],[class*=" material-symbols-"],' +
  'i.fa,i[class^="fa-"],i[class*=" fa-"],.codicon,.octicon,' +
  '.monaco-editor,.cm-editor,.CodeMirror,.ace_editor,.prism-code,.hljs,.shiki,[role="code"],table.highlight,div.highlight,' +
  '.sr-only,.visually-hidden,.visuallyhidden,.screen-reader-text';

export function winOf(el: Element): Window {
  return el.ownerDocument?.defaultView ?? window;
}

/** Uppercase tag name regardless of HTML vs SVG/MathML/XHTML namespace (where tagName is lowercase). */
export function tagOf(el: Element): string {
  return el.tagName.toUpperCase();
}

/** Pierce open shadow roots plus closed ones when the browser's extension API exposes them. */
export function getShadow(el: Element): ShadowRoot | null {
  if (el.shadowRoot) return el.shadowRoot;
  const fx = (el as { openOrClosedShadowRoot?: ShadowRoot | null }).openOrClosedShadowRoot;
  if (fx) return fx;
  if (el.namespaceURI === 'http://www.w3.org/1999/xhtml') {
    try {
      const dom = (globalThis as { chrome?: { dom?: { openOrClosedShadowRoot?: (e: Element) => ShadowRoot | null } } })
        .chrome?.dom;
      return dom?.openOrClosedShadowRoot?.(el) ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

export function safeMatches(el: Element, sel: string): boolean {
  try {
    return el.matches(sel);
  } catch {
    return false;
  }
}

export function isAtomic(el: Element, ctx: WalkContext): boolean {
  return (
    ATOMIC_TAGS.has(tagOf(el)) ||
    safeMatches(el, GLOBAL_KEEP_SEL) ||
    (ctx.keepSel !== '' && safeMatches(el, ctx.keepSel))
  );
}

export function styleOf(el: Element, ctx: WalkContext): CSSStyleDeclaration {
  let s = ctx.styles.get(el);
  if (!s) {
    s = winOf(el).getComputedStyle(el);
    ctx.styles.set(el, s);
  }
  return s;
}

/** Sites often set translate="no" / .notranslate on <html>, <body> or #root/#app solely to stop
 *  Chrome's destructive built-in translator from crashing React/Vue; don't let that lock us out. */
function isRootNoTranslateShield(el: Element): boolean {
  const t = tagOf(el);
  if (t === 'HTML' || t === 'BODY') return true;
  const body = el.ownerDocument?.body;
  return !!body && el.parentElement === body && /^(app|root|__next|__nuxt|svelte)$/i.test(el.id);
}

export function hasNoTranslate(el: Element): boolean {
  if (isRootNoTranslateShield(el)) return false;
  return el.getAttribute('translate') === 'no' || el.classList.contains('notranslate');
}

function isVisuallyClipped(s: CSSStyleDeclaration): boolean {
  if (s.clip === 'rect(0px, 0px, 0px, 0px)' || s.clipPath === 'inset(50%)' || s.clipPath === 'inset(100%)') return true;
  return (
    (s.overflow === 'hidden' || s.overflow === 'clip') &&
    (s.position === 'absolute' || s.position === 'fixed') &&
    (parseFloat(s.width) <= 1 || parseFloat(s.height) <= 1)
  );
}

/** Hard skip checks that must win even over ATOMIC_TAGS (e.g. <svg aria-hidden="true">,
 *  .octicon decorative icons, or <code style="display:none">). Excludes .notranslate so
 *  visible inline <code class="notranslate"> / <span translate="no"> still stay atomic. */
export function isHardSkipped(el: Element, ctx: WalkContext): boolean {
  if (isOurs(el) || DROP_TAGS.has(tagOf(el))) return true;
  if (el.hasAttribute('data-ilt-skip')) return true;
  if (el.getAttribute('aria-hidden') === 'true' || (el as HTMLElement).hidden) return true;
  if ((el as HTMLElement).isContentEditable) return true;
  if (safeMatches(el, GLOBAL_IGNORE_SEL) || (ctx.ignoreSel !== '' && safeMatches(el, ctx.ignoreSel))) return true;
  const sr = getShadow(el);
  if (sr && !sr.querySelector('slot')) return true;
  const s = styleOf(el, ctx);
  if (s.display === 'none') {
    ctx.onHidden?.(el);
    return true;
  }
  const slot = (el as HTMLElement).assignedSlot;
  if (slot && styleOf(slot, ctx).display === 'none') {
    ctx.onHidden?.(el);
    return true;
  }
  return s.visibility === 'hidden' || isVisuallyClipped(s);
}

/** Visible inline [translate="no"]/.notranslate tokens (e.g. brand names or shortcuts mid-sentence)
 *  must be kept in place as {{id}} placeholders rather than stripped out of the sentence. */
export function isInlineKeep(el: Element, ctx: WalkContext): boolean {
  return hasNoTranslate(el) && !isHardSkipped(el, ctx);
}

export function shouldSkip(el: Element, ctx: WalkContext): boolean {
  return hasNoTranslate(el) || isHardSkipped(el, ctx);
}

/** Walk up through light DOM and shadow hosts to make sure partial rescans honor outer skip/atomic regions. */
export function isBlockedByAncestor(el: Element, ctx: WalkContext): boolean {
  let cur: Element | null = el;
  while (cur) {
    if (isOurs(cur) || isAtomic(cur, ctx) || shouldSkip(cur, ctx)) return true;
    if (cur === cur.ownerDocument?.body) break;
    if (cur.parentElement) {
      cur = cur.parentElement;
    } else {
      const root = cur.getRootNode();
      cur = root.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? (root as ShadowRoot).host : null;
    }
  }
  return false;
}

const INVALID_TEXT = [
  /^(https?:\/\/|www\.)\S+$/i,
  /^[\w.+-]+@[\w-]+\.[\w.]+$/,
  // Whole-unit machine tokens carry no prose; skip them so they aren't sent for translation
  // (and mangled, e.g. "@user" -> "@用户名"). Mirrors kiss-translator's BUILTIN_SKIP_PATTERNS.
  /^(?:[a-zA-Z]:\\|\/|\\)(?:[\w\-. ]+\/|[\w\-. ]+\\)*[\w\-. ]*\.?[\w\-. ]*$/, // file path
  /^\.[\w-]+(?:\/[\w.-]+)+$|^[\w.-]+(?:\/[\w.-]+){2,}$/, // relative path (.github/workflows, src/a/b)
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, // UUID
  /^(?=.*\d)[0-9a-fA-F]{7,64}$/, // git commit SHA / hex digest
  /^v?\d+(\.\d+){1,3}$/, // version (v1.2.3)
  /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:[T\s]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/, // ISO date/time
  /^[+-]?\d+(?:[.,]\d+)?\s*(?:px|em|rem|vh|vw|vmin|vmax|ch|ex|pt|pc|cm|mm|in|deg|rad|turn|s|ms|hz|khz|mhz|ghz|b|kb|mb|gb|tb|pb|kib|mib|gib|%)(?:\/\w+)?$/i, // number + unit
  /^({{[^}]+}}|\${[^}]+}|__\w+__|%\w+)$/, // template placeholder
  /^(?:\.|#)[\w-]+$|^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, // CSS selector / hex color
  /^[@#$][\w.-]+$/, // @username / #hashtag / $cashtag
  /^&\w+;$/, // HTML entity
  /^[^\s\\/:]+?\.[a-zA-Z0-9]{2,5}$/, // filename.ext
];

/** Text validity: has letters, not pure digits/symbols, not a URL/email/machine token. */
export function isValidText(text: string): boolean {
  if (text.length < 2) return false;
  if (!/\p{L}/u.test(text)) return false;
  if (/^[\d\p{P}\p{S}\s]+$/u.test(text)) return false;
  return !INVALID_TEXT.some((re) => re.test(text));
}