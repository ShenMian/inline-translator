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
