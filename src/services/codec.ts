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
