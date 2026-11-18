const MAX_Q = 4000;
const SENTENCE_END_RE = /^(?:[.!?]\s|[。！？\n])/;

/** Split over-long text at sentence boundaries outside <tN>...</tN>, {{N}}, and HTML entities. */
export function splitLong(text: string, maxLen = MAX_Q): string[] {
  if (text.length <= maxLen) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > maxLen) {
    const win = rest.slice(0, maxLen);
    let tagDepth = 0;
    let lastSafe = 0;
    let lastSentence = 0;
    let i = 0;
    while (i < win.length) {
      if (win[i] === '<') {
        const close = win.indexOf('>', i);
        if (close < 0) break;
        const tok = win.slice(i, close + 1);
        if (/^<t\d+>$/i.test(tok)) tagDepth++;
        else if (/^<\/t\d+>$/i.test(tok)) tagDepth = Math.max(0, tagDepth - 1);
        i = close + 1;
        if (tagDepth === 0) lastSafe = i;
        continue;
      }
      if (win[i] === '{' && win[i + 1] === '{') {
        const close = win.indexOf('}}', i + 2);
        if (close < 0) break;
        i = close + 2;
        if (tagDepth === 0) lastSafe = i;
        continue;
      }
      if (win[i] === '&') {
        const semi = win.indexOf(';', i + 1);
        if (semi > i && semi - i <= 10) {
          i = semi + 1;
          if (tagDepth === 0) lastSafe = i;
          continue;
        }
      }
      if (tagDepth === 0) {
        if (SENTENCE_END_RE.test(win.slice(i))) {
          lastSentence = i + 1;
        }
        lastSafe = i + 1;
      }
      i++;
    }
    const at = lastSentence > maxLen / 3 ? lastSentence : lastSafe > maxLen / 3 ? lastSafe : maxLen;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Encode <tN>...</tN> as unquoted <b i=N>...</b> so Edge's endpoint preserves inline wrappers. */
export function encodeEdgeRich(rich: string): string {
  return rich
    .replace(/&amp;/g, '&')
    .replace(/<t(\d+)>/g, '<b i=$1>')
    .replace(/<\/t\d+>/g, '</b>');
}

/** Stack-decode Edge's <b i=N>...</b> wrappers back into balanced <tN>...</tN> pseudo-tags. */
export function decodeEdgeRich(translated: string): string {
  const stack: string[] = [];
  let out = '';
  let last = 0;
  let balanced = true;
  const re = /<\s*b\s+i\s*=\s*["“”'「『]?(\d+)["“”'」』]?\s*>|<\s*\/\s*b\s*>/gi;
  for (const m of translated.matchAll(re)) {
    out += translated.slice(last, m.index);
    if (m[1] !== undefined) {
      stack.push(m[1]);
      out += `<t${m[1]}>`;
    } else if (stack.length > 0) {
      const id = stack.pop()!;
      out += `</t${id}>`;
    } else {
      balanced = false;
    }
    last = m.index! + m[0].length;
  }
  out += translated.slice(last);
  if (!balanced || stack.length > 0) {
    return translated.replace(/<\s*\/?\s*b(?:\s+[^>]*)?>/gi, '');
  }
  return out;
}

function stripTrailingCommas(json: string): string {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i]!;
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < json.length && /\s/.test(json[j]!)) j++;
      if (json[j] === ']' || json[j] === '}') continue;
    }
    out += ch;
  }
  return out;
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return JSON.parse(stripTrailingCommas(raw));
  }
}

/** Parse LLM JSON output into an exact-length string array, tolerating <think> blocks, code fences,
 *  trailing commas, json_object wrappers ({"translations":[...]}), and indexed maps ({"0":"..."}). */
export function parseOpenAIArray(content: string, expected: number): string[] | null {
  let s = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1]!.trim();

  const bIdx = s.indexOf('[');
  const oIdx = s.indexOf('{');
  if (bIdx >= 0 && (oIdx < 0 || bIdx < oIdx)) {
    const end = s.lastIndexOf(']');
    if (end > bIdx) s = s.slice(bIdx, end + 1);
  } else if (oIdx >= 0) {
    const end = s.lastIndexOf('}');
    if (end > oIdx) s = s.slice(oIdx, end + 1);
  }

  let parsed: unknown;
  try {
    parsed = tryParseJson(s);
  } catch {
    return null;
  }

  if (Array.isArray(parsed)) {
    return parsed.length === expected ? parsed.map((x) => String(x)) : null;
  }
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    for (const k of ['translations', 'results', 'result', 'items', 'data', 'output']) {
      if (Array.isArray(obj[k]) && (obj[k] as unknown[]).length === expected) {
        return (obj[k] as unknown[]).map((x) => String(x));
      }
    }
    const vals = Object.values(obj);
    if (vals.length === 1 && Array.isArray(vals[0]) && vals[0].length === expected) {
      return vals[0].map((x) => String(x));
    }
    if (expected > 0) {
      for (const base of [0, 1]) {
        const mapped: string[] = [];
        let ok = true;
        for (let i = 0; i < expected; i++) {
          const v = obj[String(i + base)];
          if (typeof v === 'string' || typeof v === 'number') mapped.push(String(v));
          else {
            ok = false;
            break;
          }
        }
        if (ok && Object.keys(obj).length === expected) return mapped;
      }
    }
  }
  return null;
}
