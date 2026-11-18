import { getShadow, isAtomic, isHardSkipped, isInlineKeep, isOurs, isValidText, safeMatches, shouldSkip, styleOf, tagOf } from './filter';
import { serializeRun, WRAP_TAGS } from './serialize';
import type { Paragraph, Root, WalkContext } from './types';

/** These displays count as inline (contents expands transparently); everything else is block.
 *  Inline-level *containers* (inline-block/flex/grid/table) are paragraph boundaries when standing
 *  alone (tab strips, chip rows), while phrasing inline-block/flex spans inside prose stay inline. */
const INLINE_DISPLAYS = new Set([
  'inline', 'inline flow', 'contents',
  'ruby', 'ruby-base', 'ruby-text', 'ruby-base-container', 'ruby-text-container',
  'inline-list-item', 'math', 'inline-math',
]);

/** Inline-level displays for wrapper placement decisions (includes the containers above). */
export const INLINE_LEVEL_DISPLAYS = new Set([
  ...INLINE_DISPLAYS,
  'inline-block', 'inline-flex', 'inline-grid', 'inline-table',
]);

const DROP_CAP_TAGS = new Set(['SPAN', 'B', 'STRONG', 'EM', 'I', 'FONT']);
const WIDGET_ROLES = new Set(['button', 'tab', 'menuitem', 'option', 'switch']);

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

/** Floated / inline-block single-letter drop-caps (<span style="float:left">T</span>he...) belong to the first word. */
function isDropCap(el: Element, ctx: WalkContext): boolean {
  if (!DROP_CAP_TAGS.has(tagOf(el))) return false;
  if (!/^\s*\p{L}\s*$/u.test(el.textContent ?? '')) return false;
  const next = el.nextSibling;
  if (!next || next.nodeType !== Node.TEXT_NODE || !/^\p{L}/u.test(next.nodeValue ?? '')) return false;
  const s = styleOf(el, ctx);
  return s.float !== 'none' || s.display === 'inline-block';
}

function hasDirectProse(el: Root, hostShadow: ShadowRoot | null, ctx: WalkContext): boolean {
  for (const c of el.childNodes) {
    if (hostShadow && 'assignedSlot' in c && (c as Element | Text).assignedSlot === null) continue;
    if (c.nodeType === Node.TEXT_NODE && /\S/.test(c.nodeValue ?? '')) return true;
    if (c.nodeType === Node.ELEMENT_NODE) {
      const ce = c as Element;
      if (!isOurs(ce) && !shouldSkip(ce, ctx) && INLINE_DISPLAYS.has(styleOf(ce, ctx).display) && /\S/.test(ce.textContent ?? '')) {
        return true;
      }
    }
  }
  return false;
}

export function hashText(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Body-level wrappers that hold the whole page (header/main/nav inside). Direct text runs of
 *  such shells are leaked UI (portaled tooltips/palette help), never article content — except on
 *  minimalist HTML1.0 pages whose <body> holds raw prose directly without semantic chrome. */
function isPageShell(el: Element, ctx: WalkContext): boolean {
  const cached = ctx.shell.get(el);
  if (cached !== undefined) return cached;
  const body = el.ownerDocument.body;
  let shell = false;
  if (el === body) {
    shell =
      !!body.querySelector('header, main, [role="main"], nav, article, section') ||
      body.querySelectorAll('p, div, ul, ol, table').length >= 3;
  } else if (el.parentElement === body) {
    shell = !!el.querySelector('header, main, [role="main"], nav');
  }
  ctx.shell.set(el, shell);
  return shell;
}

function isInlineAtomic(el: Element, ctx: WalkContext): boolean {
  if (isHardSkipped(el, ctx)) return false;
  return isAtomic(el, ctx) || (!isBlock(el, ctx) && !hasBlockDesc(el, ctx) && isInlineKeep(el, ctx));
}

function isWithinOnly(el: Element, onlySel: string): boolean {
  if (!onlySel) return true;
  let cur: Element | null = el;
  while (cur) {
    try {
      if (cur.matches(onlySel) || cur.closest(onlySel)) return true;
    } catch {
      return true;
    }
    const root = cur.getRootNode();
    cur = root.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? (root as ShadowRoot).host : null;
  }
  return false;
}

function makeParagraph(root: Element, run: Node[], ctx: WalkContext): Paragraph | null {
  if (
    ctx.onlySel &&
    !isWithinOnly(root, ctx.onlySel) &&
    !run.some((n) => n.nodeType === Node.ELEMENT_NODE && isWithinOnly(n as Element, ctx.onlySel))
  ) {
    return null;
  }
  if (isPageShell(root, ctx)) return null;
  const ws = styleOf(root, ctx).whiteSpace;
  const preWhitespace = ws === 'pre' || ws === 'pre-wrap' || ws === 'pre-line' || ws === 'break-spaces';
  const { rich, text, tokens } = serializeRun(
    run,
    (el) => isInlineAtomic(el, ctx),
    (el) => shouldSkip(el, ctx),
    preWhitespace,
  );
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
    preWhitespace,
  };
}

/**
 * Iterative DFS paragraph extraction: consecutive text/inline nodes between block
 * boundaries form one translation unit. Blockness comes from computed display, not tag names.
 */
export function extractParagraphs(root: Root, ctx: WalkContext): Paragraph[] {
  const out: Paragraph[] = [];
  if (root.nodeType === Node.ELEMENT_NODE && (shouldSkip(root as Element, ctx) || isAtomic(root as Element, ctx))) return out;
  const stack: Root[] = [root];
  while (stack.length) {
    const el = stack.pop()!;
    if (el !== root && el.nodeType === Node.ELEMENT_NODE) {
      const e = el as Element;
      if (shouldSkip(e, ctx) || isAtomic(e, ctx)) continue;
    }
    const hostShadow = el.nodeType === Node.ELEMENT_NODE ? getShadow(el as Element) : null;
    let proseChecked = false;
    let proseParent = false;
    const inProse = () => {
      if (!proseChecked) {
        proseChecked = true;
        proseParent = hasDirectProse(el, hostShadow, ctx);
      }
      return proseParent;
    };
    let run: Node[] = [];
    const subBlocks: Element[] = [];
    const flush = () => {
      if (run.length) {
        // Text directly under a ShadowRoot: normalize the paragraph root to its host
        const rootEl = el.nodeType === Node.ELEMENT_NODE ? (el as Element) : ((el as ShadowRoot).host ?? document.body);
        const p = makeParagraph(rootEl, run, ctx);
        if (p) out.push(p);
      }
      run = [];
    };
    const visit = (node: Node, checkSlot: boolean) => {
      if (checkSlot && hostShadow && 'assignedSlot' in node && (node as Element | Text).assignedSlot === null) return;
      if (node.nodeType === Node.TEXT_NODE) {
        run.push(node);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const child = node as Element;
      if (isOurs(child)) return;
      const childTag = tagOf(child);
      if (childTag === 'BR') {
        flush();
        return;
      }
      if (isInlineAtomic(child, ctx)) {
        run.push(child);
        return;
      }
      if (shouldSkip(child, ctx)) {
        // Visible skipped blocks (<pre>, block .notranslate, ignored banners) still break surrounding prose;
        // inline graphics like <svg> (even when Tailwind sets `svg { display: block }`) do not split sentences.
        if (childTag !== 'SVG' && styleOf(child, ctx).display !== 'none' && isBlock(child, ctx)) flush();
        return;
      }
      const display = styleOf(child, ctx).display;
      if (display === 'contents') {
        for (const c of child.childNodes) visit(c, false);
        return;
      }
      // Phrasing links/badges with inline-block/inline-flex inside prose (e.g. Tailwind <a class="inline-flex">)
      // and floated single-letter drop-caps belong in the surrounding sentence rather than splitting it.
      if (
        (run.length === 0 && isDropCap(child, ctx)) ||
        ((display === 'inline-block' || display === 'inline-flex') &&
          WRAP_TAGS.has(childTag) &&
          !WIDGET_ROLES.has(child.getAttribute('role') ?? '') &&
          !hasBlockDesc(child, ctx) &&
          inProse())
      ) {
        run.push(child);
        return;
      }
      if (isBlock(child, ctx) || hasBlockDesc(child, ctx)) {
        flush();
        subBlocks.push(child);
        return;
      }
      run.push(child);
    };
    for (const child of el.childNodes) visit(child, true);
    flush();
    // Push in reverse so LIFO stack visits blocks in true top-to-bottom document order
    for (let i = subBlocks.length - 1; i >= 0; i--) stack.push(subBlocks[i]!);
  }
  return out;
}