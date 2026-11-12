/** Lightweight language detection by script share; enough for same-language skipping. */
const RE = {
  kana: /[\u3040-\u30ff]/g,
  hangul: /[\uac00-\ud7af]/g,
  cjk: /[\u4e00-\u9fff\u3400-\u4dbf]/g,
  cyrillic: /[\u0400-\u04ff]/g,
  arabic: /[\u0600-\u06ff]/g,
  hebrew: /[\u0590-\u05ff]/g,
  thai: /[\u0e00-\u0e7f]/g,
  devanagari: /[\u0900-\u097f]/g,
};

export function detectLang(text: string): string {
  const len = text.length;
  if (!len) return 'en';
  const ratio = (re: RegExp) => (text.match(re)?.length ?? 0) / len;
  if (ratio(RE.kana) > 0.05) return 'ja';
  if (ratio(RE.hangul) > 0.2) return 'ko';
  if (ratio(RE.cjk) > 0.2) return 'zh';
  if (ratio(RE.cyrillic) > 0.3) return 'ru';
  if (ratio(RE.arabic) > 0.3) return 'ar';
  if (ratio(RE.hebrew) > 0.3) return 'he';
  if (ratio(RE.thai) > 0.3) return 'th';
  if (ratio(RE.devanagari) > 0.3) return 'hi';
  return 'en';
}

export function langFamily(code: string): string {
  const c = code.toLowerCase();
  if (c.startsWith('zh') || c.startsWith('ch')) return 'zh';
  if (c.startsWith('jp')) return 'ja';
  return c.split('-')[0] ?? c;
}

export function isSameLang(text: string, target: string): boolean {
  return detectLang(text) === langFamily(target);
}

/** Primary page language (html[lang] first), for the whole-page same-language check before auto-translate. */
export function pageLang(): string {
  const attr = document.documentElement.getAttribute('lang');
  return attr ? langFamily(attr) : '';
}