/** Site adaptation rules: an incremental tuning layer over the generic heuristics. Fields kept minimal on purpose. */
export interface SiteRule {
  /** URL glob, e.g. "*://*.wikipedia.org/*" */
  matches: string[];
  /** Extra selectors for regions never to translate */
  ignore?: string[];
  /** Selectors forced to block level */
  block?: string[];
  /** Selectors forced to inline level */
  inline?: string[];
  /** Selectors kept verbatim (atomic placeholders) */
  keep?: string[];
  /** Injected CSS patch (fixes host-site truncation etc.) */
  css?: string;
}

export interface EffectiveRule {
  ignore: string[];
  block: string[];
  inline: string[];
  keep: string[];
  css: string;
}

const globCache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  let re = globCache.get(glob);
  if (!re) {
    const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    re = new RegExp(`^${escaped}$`, 'i');
    globCache.set(glob, re);
  }
  return re;
}

/** Merge all matching rules (builtin first, custom last; arrays appended, CSS concatenated). */
export function matchRules(url: string, rules: SiteRule[]): EffectiveRule {
  const out: EffectiveRule = { ignore: [], block: [], inline: [], keep: [], css: '' };
  for (const r of rules) {
    if (!r?.matches?.some((m) => globToRegExp(m).test(url))) continue;
    if (r.ignore) out.ignore.push(...r.ignore);
    if (r.block) out.block.push(...r.block);
    if (r.inline) out.inline.push(...r.inline);
    if (r.keep) out.keep.push(...r.keep);
    if (r.css) out.css += r.css + '\n';
  }
  return out;
}

/** Join selector arrays into one string safe for matches(); invalid selectors are dropped. */
export function joinSelectors(list: string[]): string {
  const valid: string[] = [];
  for (const s of list) {
    const t = s.trim();
    if (!t) continue;
    try {
      document.createElement('div').matches(t);
      valid.push(t);
    } catch {
      /* invalid selector in user custom rules: ignore */
    }
  }
  return valid.join(',');
}