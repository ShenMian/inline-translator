import type { WalkContext } from './types';

/** Never entered: invisible, lazy, code-block and similar regions. */
const DROP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'TITLE', 'META', 'LINK', 'BASE',
  'SLOT', 'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'PRE',
]);

/** Kept verbatim: atomic placeholder inside a paragraph, never split for translation. */
export const ATOMIC_TAGS = new Set([
  'CODE', 'KBD', 'SAMP', 'VAR', 'TT', 'SUB', 'SUP',
  'IMG', 'SVG', 'MATH', 'PICTURE', 'CANVAS', 'VIDEO', 'AUDIO', 'EMBED',
  'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'MAP', 'AREA',
]);

export function safeMatches(el: Element, sel: string): boolean {
  try {
    return el.matches(sel);
  } catch {
    return false;
  }
}

export function isAtomic(el: Element, ctx: WalkContext): boolean {
  return ATOMIC_TAGS.has(el.tagName) || (ctx.keepSel !== '' && safeMatches(el, ctx.keepSel));
}

export function styleOf(el: Element, ctx: WalkContext): CSSStyleDeclaration {
  let s = ctx.styles.get(el);
  if (!s) {
    s = getComputedStyle(el);
    ctx.styles.set(el, s);
  }
  return s;
}

export function shouldSkip(el: Element, ctx: WalkContext): boolean {
  if (DROP_TAGS.has(el.tagName)) return true;
  if (el.getAttribute('translate') === 'no' || el.classList.contains('notranslate') || el.hasAttribute('data-ilt-skip')) return true;
  if (el.getAttribute('aria-hidden') === 'true') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  if (ctx.ignoreSel && safeMatches(el, ctx.ignoreSel)) return true;
  // Light DOM of a slot-less shadow host is unrendered fallback; the shadow side is scanned separately
  const sr = el.shadowRoot;
  if (sr && !sr.querySelector('slot')) return true;
  const s = styleOf(el, ctx);
  if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return true;
  return false;
}

const INVALID_TEXT = [
  /^(https?:\/\/|www\.)\S+$/i,
  /^[\w.+-]+@[\w-]+\.[\w.]+$/,
  // Whole-unit machine tokens carry no prose; skip them so they aren't sent for translation
  // (and mangled, e.g. "@user" -> "@用户名"). Mirrors kiss-translator's BUILTIN_SKIP_PATTERNS.
  /^(?:[a-zA-Z]:\\|\/|\\)(?:[\w\-. ]+\/|[\w\-. ]+\\)*[\w\-. ]*\.?[\w\-. ]*$/, // file path
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, // UUID
  /^v?\d+(\.\d+){1,3}$/, // version (v1.2.3)
  /^({{[^}]+}}|\${[^}]+}|__\w+__|%\w+)$/, // template placeholder
  /^(?:\.|#)[\w-]+$|^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, // CSS selector / hex color
  /^@[\w.-]+$/, // @username
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