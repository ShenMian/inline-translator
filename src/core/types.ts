import type { EffectiveRule } from '../lib/rules';

/** Rich-text placeholder snapshot: wrap keeps the shell structure, atomic keeps the original whole. */
export interface Token {
  kind: 'wrap' | 'atomic';
  tag?: string;
  attrs?: Record<string, string>;
  /** Computed link styling captured at serialize time so restored anchors match the original color/decoration. */
  css?: Record<string, string>;
  el?: Element;
}

/** One translation unit: a run of consecutive inline content inside a block container. */
export interface Paragraph {
  root: Element;
  nodes: Node[];
  anchor: Node;
  text: string;
  rich: string;
  tokens: Token[];
  hash: string;
  wrapper?: HTMLElement;
}

export type Root = Element | ShadowRoot;

export interface WalkContext {
  rule: EffectiveRule;
  ignoreSel: string;
  blockSel: string;
  inlineSel: string;
  keepSel: string;
  /** Per-scan style cache to avoid layout thrashing */
  styles: WeakMap<Element, CSSStyleDeclaration>;
  blockDesc: WeakMap<Element, boolean>;
  shell: WeakMap<Element, boolean>;
}