import DOMPurify from 'dompurify';
import type { Token } from './types';

/** Inline tags safe to wrap: shells become <tN> pseudo tags that round-trip with the translation. */
const WRAP_TAGS = new Set([
  'A', 'B', 'STRONG', 'EM', 'I', 'U', 'S', 'SPAN', 'SMALL', 'MARK', 'ABBR', 'CITE',
  'Q', 'BDI', 'BDO', 'FONT', 'TIME', 'DATA', 'LABEL', 'DEL', 'INS', 'STRIKE', 'NOBR',
]);
const KEEP_ATTRS = ['href', 'title', 'alt', 'lang', 'dir'];
const MARKER_RE = /\{\{(\d+)\}\}/g;

export function serializeRun(
  nodes: Node[],
  isAtomic: (el: Element) => boolean,
): { rich: string; text: string; tokens: Token[] } {
  const tokens: Token[] = [];
  let rich = '';
  let text = '';
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const walk = (n: Node) => {
    if (n.nodeType === Node.TEXT_NODE) {
      const v = n.nodeValue ?? '';
      rich += esc(v);
      text += v;
      return;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    const el = n as Element;
    if (isAtomic(el)) {
      const id = tokens.length;
      tokens.push({ kind: 'atomic', el });
      rich += `{{${id}}}`;
      text += ' ';
      return;
    }
    if (WRAP_TAGS.has(el.tagName)) {
      const attrs: Record<string, string> = {};
      for (const a of KEEP_ATTRS) {
        const v = el.getAttribute(a);
        if (v !== null) attrs[a] = v;
      }
      const id = tokens.length;
      const tok: Token = { kind: 'wrap', tag: el.tagName.toLowerCase(), attrs };
      if (el.tagName === 'A') {
        const cs = getComputedStyle(el);
        tok.css = { color: cs.color, 'text-decoration-line': cs.textDecorationLine };
      }
      tokens.push(tok);
      rich += `<t${id}>`;
      for (const c of el.childNodes) walk(c);
      rich += `</t${id}>`;
      return;
    }
    for (const c of el.childNodes) walk(c);
  };
  for (const n of nodes) walk(n);
  return { rich: rich.trim(), text: text.trim(), tokens };
}

/** Plain-text mode (Edge etc.): strip wrap pseudo tags, keep atomic placeholders. */
export function richToPlain(rich: string): string {
  return rich.replace(/<\/?t\d+>/g, '');
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
        for (const [k, v] of Object.entries(tok.attrs ?? {})) shell.setAttribute(k, v);
        for (const [k, v] of Object.entries(tok.css ?? {})) shell.style.setProperty(k, v);
        rebuild(el, shell, tokens, restored);
        dest.appendChild(shell);
      } else {
        rebuild(el, dest, tokens, restored);
      }
      continue;
    }
    // Real tags returned by the service (e.g. <b>/<a> kept by Google): preserve structure, sanitize later
    if (WRAP_TAGS.has(el.tagName) || el.tagName === 'BR' || el.tagName === 'IMG') {
      const clone = document.createElement(el.tagName.toLowerCase());
      for (const a of Array.from(el.attributes)) {
        if (KEEP_ATTRS.includes(a.name) || ['src', 'width', 'height'].includes(a.name)) {
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

/**
 * Post-translation restore: prefer rich-text rebuild (pseudo tags → original shells,
 * placeholders → cloned originals); fall back to plain text + atomic recovery when too many
 * markers are lost. Output is sanitized with DOMPurify.
 */
export function restore(translated: string, tokens: Token[]): Node[] {
  const s = translated.trim().replace(/\{\{\s*(\d+)\s*\}\}/g, '{{$1}}');
  const atomicCount = tokens.filter((t) => t.kind === 'atomic').length;
  if (/<t\d+[\s/>]/i.test(s)) {
    try {
      const doc = new DOMParser().parseFromString(s, 'text/html');
      const frag = document.createDocumentFragment();
      const restored = { n: 0 };
      rebuild(doc.body, frag, tokens, restored);
      if (atomicCount === 0 || restored.n * 2 >= atomicCount) {
        const clean = DOMPurify.sanitize(frag, { RETURN_DOM_FRAGMENT: true, FORBID_TAGS });
        return Array.from(clean.childNodes);
      }
    } catch {
      /* fall through to plain-text fallback */
    }
  }
  const plain = new DOMParser().parseFromString(s, 'text/html').body.textContent ?? '';
  const frag = document.createDocumentFragment();
  appendTextWithMarkers(plain, frag, tokens, { n: 0 });
  return Array.from(frag.childNodes);
}