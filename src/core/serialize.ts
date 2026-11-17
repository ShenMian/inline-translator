import DOMPurify from 'dompurify';
import { isOurs, tagOf, winOf } from './filter';
import type { Token } from './types';

/** Inline tags safe to wrap: shells become <tN> pseudo tags that round-trip with the translation. */
export const WRAP_TAGS = new Set([
  'A', 'B', 'STRONG', 'EM', 'I', 'U', 'S', 'SPAN', 'SMALL', 'MARK', 'ABBR', 'CITE',
  'Q', 'BDI', 'BDO', 'FONT', 'TIME', 'DATA', 'LABEL', 'DEL', 'INS', 'STRIKE', 'NOBR', 'RUBY', 'RB',
]);
const KEEP_ATTRS = ['href', 'target', 'rel', 'title', 'alt', 'lang', 'dir'];
const MARKER_RE = /\{\{(\d+)\}\}/g;
const UNSAFE_URI_RE = /^\s*(?:javascript|vbscript|data):/i;

export function serializeRun(
  nodes: Node[],
  isAtomic: (el: Element) => boolean,
  shouldSkip?: (el: Element) => boolean,
  preserveNewlines = false,
): { rich: string; text: string; tokens: Token[] } {
  const tokens: Token[] = [];
  let rich = '';
  let text = '';
  let marginGap = false;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const emitGapIfNeeded = (el?: Element) => {
    let need = marginGap;
    if (!need && el && text.length > 0 && !/\s$/.test(text)) {
      const cs = winOf(el).getComputedStyle(el);
      if (parseFloat(cs.marginLeft) > 0 || parseFloat(cs.paddingLeft) > 0) need = true;
    }
    marginGap = false;
    if (need && text.length > 0 && !/\s$/.test(text)) {
      rich += ' ';
      text += ' ';
    }
  };
  const noteRightGap = (el: Element) => {
    const cs = winOf(el).getComputedStyle(el);
    if (parseFloat(cs.marginRight) > 0 || parseFloat(cs.paddingRight) > 0) marginGap = true;
  };
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) {
      let v = n.nodeValue ?? '';
      if (!v) return;
      v = preserveNewlines ? v.replace(/\r\n?/g, '\n') : v.replace(/[\t\f\r\n ]+/g, ' ');
      if (!/^\s/.test(v)) emitGapIfNeeded();
      else marginGap = false;
      rich += esc(v);
      text += v;
      return;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const el = n as Element;
    const tag = tagOf(el);
    if (isOurs(el) || tag === 'WBR') return;
    if (isAtomic(el)) {
      emitGapIfNeeded(el);
      const id = tokens.length;
      tokens.push({ kind: 'atomic', el });
      rich += `{{${id}}}`;
      text += ' ';
      noteRightGap(el);
      return;
    }
    if (shouldSkip?.(el)) return;
    if (tag === 'BR') {
      const id = tokens.length;
      tokens.push({ kind: 'atomic', el });
      rich += `{{${id}}}`;
      text += '\n';
      marginGap = false;
      return;
    }
    // Preserve empty inline icon/badge elements (e.g. <i class="fa fa-star"></i>) as atomic clones
    if (el.textContent === '' && el.attributes.length > 0) {
      emitGapIfNeeded(el);
      const id = tokens.length;
      tokens.push({ kind: 'atomic', el });
      rich += `{{${id}}}`;
      text += ' ';
      noteRightGap(el);
      return;
    }
    if (WRAP_TAGS.has(tag)) {
      emitGapIfNeeded(el);
      const attrs: Record<string, string> = {};
      for (const a of KEEP_ATTRS) {
        const v = el.getAttribute(a);
        if (v !== null && !(a === 'href' && UNSAFE_URI_RE.test(v))) attrs[a] = v;
      }
      if (attrs.target === '_blank' && !attrs.rel) attrs.rel = 'noopener noreferrer';
      const id = tokens.length;
      const tok: Token = { kind: 'wrap', tag: tag.toLowerCase(), attrs };
      if (tag === 'A') {
        const cs = winOf(el).getComputedStyle(el);
        tok.css = { color: cs.color, 'text-decoration-line': cs.textDecorationLine };
      }
      tokens.push(tok);
      rich += `<t${id}>`;
      for (const c of el.childNodes) walk(c);
      rich += `</t${id}>`;
      noteRightGap(el);
      return;
    }
    for (const c of el.childNodes) walk(c);
  };
  for (const n of nodes) walk(n);
  // Hoist boundary spaces out of <tN>...</tN> so MT engines don't strip spaces around links/bold
  let prev = '';
  while (rich !== prev) {
    prev = rich;
    rich = rich
      .replace(/<t(\d+)>([ \t]+)((?:(?!<t\d+>)[\s\S])*?)<\/t\1>/g, '$2<t$1>$3</t$1>')
      .replace(/<t(\d+)>((?:(?!<t\d+>)[\s\S])*?)([ \t]+)<\/t\1>/g, '<t$1>$2</t$1>$3')
      .replace(/<t(\d+)><\/t\1>/g, '');
  }
  if (!preserveNewlines) {
    rich = rich.replace(/ {2,}/g, ' ');
    text = text.replace(/ {2,}/g, ' ');
  }
  return { rich: rich.trim(), text: text.trim(), tokens };
}

/** Plain-text mode (Edge etc.): strip wrap pseudo tags, keep atomic placeholders. */
export function richToPlain(rich: string): string {
  return rich.replace(/<\/?t\d+>/g, '');
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
};

function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-zA-Z]+));/g, (full, dec, hex, named) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return ENTITIES[named] ?? full;
  });
}

let ttPolicy: { createHTML: (s: string) => unknown } | null | undefined;
function toTrustedHtml(html: string): string {
  if (ttPolicy === undefined) {
    ttPolicy = null;
    const tt = (globalThis as { trustedTypes?: { defaultPolicy?: { createHTML: (s: string) => unknown }; createPolicy?: (n: string, r: { createHTML: (s: string) => string }) => { createHTML: (s: string) => unknown } } }).trustedTypes;
    if (tt?.createPolicy) {
      for (const name of ['inline-translator', 'dompurify', 'default']) {
        try {
          ttPolicy = tt.createPolicy(name, { createHTML: (x) => x });
          break;
        } catch {
          /* policy name disallowed by CSP; try next or fall back */
        }
      }
      if (!ttPolicy && tt.defaultPolicy) ttPolicy = tt.defaultPolicy;
    }
  }
  if (ttPolicy) {
    try {
      return ttPolicy.createHTML(html) as string;
    } catch {
      /* fall through */
    }
  }
  return html;
}

/** Pure-DOM fallback parser used when strict Trusted Types CSP blocks DOMParser.parseFromString. */
function parseMarkupWithoutSink(html: string): DocumentFragment {
  const root = document.createDocumentFragment();
  const stack: { tag: string; node: Node }[] = [{ tag: '', node: root }];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  let last = 0;
  for (const m of html.matchAll(tagRe)) {
    const top = stack[stack.length - 1]!;
    if (m.index! > last) {
      top.node.appendChild(document.createTextNode(decodeEntities(html.slice(last, m.index))));
    }
    const closing = m[1] === '/';
    const rawName = m[2]!;
    const lower = rawName.toLowerCase();
    const attrPart = m[3] ?? '';
    if (closing) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i]!.tag === lower) {
          stack.length = i;
          break;
        }
      }
    } else if (/^t\d+$/i.test(rawName) || WRAP_TAGS.has(rawName.toUpperCase()) || lower === 'br') {
      const el = document.createElement(lower);
      for (const am of attrPart.matchAll(/([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
        const k = am[1]!.toLowerCase();
        const v = decodeEntities(am[2] ?? am[3] ?? am[4] ?? '');
        if (KEEP_ATTRS.includes(k) && !(k === 'href' && UNSAFE_URI_RE.test(v))) el.setAttribute(k, v);
      }
      top.node.appendChild(el);
      if (lower !== 'br' && !attrPart.trimEnd().endsWith('/')) {
        stack.push({ tag: lower, node: el });
      }
    }
    last = m.index! + m[0].length;
  }
  if (last < html.length) {
    stack[stack.length - 1]!.node.appendChild(document.createTextNode(decodeEntities(html.slice(last))));
  }
  return root;
}

function parseToBodyOrFragment(html: string): Node {
  try {
    const doc = new DOMParser().parseFromString(toTrustedHtml(html), 'text/html');
    return doc.body;
  } catch {
    return parseMarkupWithoutSink(html);
  }
}

function appendTextWithMarkers(text: string, dest: Node, tokens: Token[], restored: { n: number }): void {
  let last = 0;
  for (const m of text.matchAll(MARKER_RE)) {
    const idx = Number(m[1]);
    if (m.index! > last) dest.appendChild(document.createTextNode(text.slice(last, m.index)));
    const tok = tokens[idx];
    if (tok?.kind === 'atomic' && tok.el) {
      dest.appendChild(tok.el.cloneNode(true));
      restored.n++;
    }
    last = m.index! + m[0].length;
  }
  if (last < text.length) dest.appendChild(document.createTextNode(text.slice(last)));
}

function rebuild(src: Node, dest: Node, tokens: Token[], restored: { n: number }): void {
  for (const child of Array.from(src.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      appendTextWithMarkers(child.nodeValue ?? '', dest, tokens, restored);
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as Element;
    const m = /^t(\d+)$/i.exec(el.tagName);
    if (m) {
      const tok = tokens[Number(m[1])];
      if (tok?.kind === 'wrap' && tok.tag) {
        const shell = document.createElement(tok.tag);
        for (const [k, v] of Object.entries(tok.attrs ?? {})) {
          if (!(k === 'href' && UNSAFE_URI_RE.test(v))) shell.setAttribute(k, v);
        }
        for (const [k, v] of Object.entries(tok.css ?? {})) shell.style.setProperty(k, v);
        rebuild(el, shell, tokens, restored);
        dest.appendChild(shell);
      } else {
        rebuild(el, dest, tokens, restored);
      }
      continue;
    }
    // Real tags returned by the service (e.g. <b>/<a> kept by Google): preserve structure, sanitize later
    const childTag = tagOf(el);
    if (WRAP_TAGS.has(childTag) || childTag === 'BR' || childTag === 'IMG') {
      const clone = document.createElement(childTag.toLowerCase());
      for (const a of Array.from(el.attributes)) {
        if (
          (KEEP_ATTRS.includes(a.name) || ['src', 'width', 'height'].includes(a.name)) &&
          !((a.name === 'href' || a.name === 'src') && UNSAFE_URI_RE.test(a.value))
        ) {
          clone.setAttribute(a.name, a.value);
        }
      }
      rebuild(el, clone, tokens, restored);
      dest.appendChild(clone);
    } else {
      rebuild(el, dest, tokens, restored);
    }
  }
}

const FORBID_TAGS = ['iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'style', 'link', 'meta', 'base'];

function sanitizeFragment(frag: DocumentFragment): DocumentFragment {
  try {
    return DOMPurify.sanitize(frag, {
      RETURN_DOM_FRAGMENT: true,
      FORBID_TAGS,
      ADD_ATTR: ['target', 'rel'],
    });
  } catch {
    // Strict Trusted-Types CSP rejected DOMPurify's internal policy creation; rebuild() already
    // constructed every element from an explicit tag/attribute allowlist and stripped unsafe URIs.
    return frag;
  }
}

/**
 * Post-translation restore: prefer rich-text rebuild (pseudo tags → original shells,
 * placeholders → cloned originals); fall back to plain text + atomic recovery when too many
 * markers are lost. Output is sanitized with DOMPurify and safe under Trusted Types CSP.
 */
export function restore(translated: string, tokens: Token[]): Node[] {
  const s = translated.trim().replace(/\{\{\s*(\d+)\s*\}\}/g, '{{$1}}');
  const atomicCount = tokens.filter((t) => t.kind === 'atomic').length;
  if (/<t\d+[\s/>]/i.test(s)) {
    try {
      const parsed = parseToBodyOrFragment(s);
      const frag = document.createDocumentFragment();
      const restored = { n: 0 };
      rebuild(parsed, frag, tokens, restored);
      if (atomicCount === 0 || restored.n * 2 >= atomicCount) {
        return Array.from(sanitizeFragment(frag).childNodes);
      }
    } catch {
      /* fall through to plain-text fallback */
    }
  }
  const plain = parseToBodyOrFragment(s).textContent ?? '';
  const frag = document.createDocumentFragment();
  appendTextWithMarkers(plain, frag, tokens, { n: 0 });
  return Array.from(frag.childNodes);
}