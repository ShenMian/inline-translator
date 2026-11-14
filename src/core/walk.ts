import { isAtomic, isValidText, safeMatches, shouldSkip, styleOf } from './filter';
import { serializeRun } from './serialize';
import type { Paragraph, Root, WalkContext } from './types';

/** These displays count as inline (contents expands transparently); everything else is block.
 *  Inline-level *containers* (inline-block/flex/grid/table) are paragraph boundaries, not
 *  transparent content: a tab strip or badge row must translate inside each item, otherwise
 *  one wrapper lands as a sibling of the items and breaks the strip's layout. */
const INLINE_DISPLAYS = new Set([
  'inline', 'contents', 'ruby', 'inline-list-item',
]);

/** Inline-level displays for wrapper placement decisions (includes the containers above). */
export const INLINE_LEVEL_DISPLAYS = new Set([
  'inline', 'inline-block', 'inline-flex', 'inline-grid', 'inline-table',
  'contents', 'ruby', 'inline-list-item',
]);

export function isBlock(el: Element, ctx: WalkContext): boolean {
  if (ctx.blockSel && safeMatches(el, ctx.blockSel)) return true;
  if (ctx.inlineSel && safeMatches(el, ctx.inlineSel)) return false;
  return !INLINE_DISPLAYS.has(styleOf(el, ctx).display);
}

/** Whether an inline element hides block descendants (e.g. invalid <a><div> nesting). */
function hasBlockDesc(el: Element, ctx: WalkContext): boolean {
  const cached = ctx.blockDesc.get(el);
  if (cached !== undefined) return cached;
  let found = false;
  for (const child of el.children) {
    if (shouldSkip(child, ctx) || isAtomic(child, ctx)) continue;
    if (isBlock(child, ctx) || hasBlockDesc(child, ctx)) {
      found = true;
      break;
    }
  }
  ctx.blockDesc.set(el, found);
  return found;
}

export function hashText(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Body-level wrappers that hold the whole page (header/main/nav inside). Direct text runs of
 *  such shells are leaked UI (portaled tooltips/palette help), never article content. */
function isPageShell(el: Element, ctx: WalkContext): boolean {
  const cached = ctx.shell.get(el);
  if (cached !== undefined) return cached;
  const body = el.ownerDocument.body;
  const shell = el === body || (el.parentElement === body && !!el.querySelector('header, main, [role="main"], nav'));
  ctx.shell.set(el, shell);
  return shell;
}

function makeParagraph(root: Element, run: Node[], ctx: WalkContext): Paragraph | null {
  if (isPageShell(root, ctx)) return null;
  const { rich, text, tokens } = serializeRun(run, (el) => isAtomic(el, ctx));
  const trimmed = text.trim();
  if (!isValidText(trimmed)) return null;
  return {
    root,
    nodes: run,
    anchor: run[run.length - 1]!,
    text: trimmed,
    rich,
    tokens,
    hash: hashText(trimmed),
  };
}

/**
 * Iterative DFS paragraph extraction: consecutive text/inline nodes between block
 * boundaries form one translation unit. Blockness comes from computed display, not tag names.
 */
export function extractParagraphs(root: Root, ctx: WalkContext): Paragraph[] {
  const out: Paragraph[] = [];
  if (root.nodeType === Node.ELEMENT_NODE && shouldSkip(root as Element, ctx)) return out;
  const stack: Root[] = [root];
  while (stack.length) {
    const el = stack.pop()!;
    if (el !== root && el.nodeType === Node.ELEMENT_NODE) {
      const e = el as Element;
      if (shouldSkip(e, ctx) || isAtomic(e, ctx)) continue;
    }
    let run: Node[] = [];
    const flush = () => {
      if (run.length) {
        // Text directly under a ShadowRoot: normalize the paragraph root to its host
        const rootEl = el.nodeType === Node.ELEMENT_NODE ? (el as Element) : ((el as ShadowRoot).host ?? document.body);
        const p = makeParagraph(rootEl, run, ctx);
        if (p) out.push(p);
      }
      run = [];
    };
    const visit = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        run.push(node);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const child = node as Element;
      if (child.tagName === 'BR') {
        flush();
        return;
      }
      if (isAtomic(child, ctx)) {
        run.push(child);
        return;
      }
      if (shouldSkip(child, ctx)) return;
      if (styleOf(child, ctx).display === 'contents') {
        for (const c of child.childNodes) visit(c);
        return;
      }
      if (isBlock(child, ctx) || hasBlockDesc(child, ctx)) {
        flush();
        stack.push(child);
        return;
      }
      run.push(child);
    };
    for (const child of el.childNodes) visit(child);
    flush();
  }
  return out;
}