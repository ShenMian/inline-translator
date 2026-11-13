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

/** Common stopwords per Latin language; the language with the most whole-word matches wins. */
const STOPWORDS: Record<string, string[]> = {
  en: ['the', 'of', 'and', 'to', 'in', 'that', 'is', 'was', 'for', 'it', 'with', 'as', 'be', 'on', 'not', 'he', 'by', 'are', 'this', 'have', 'from', 'or', 'his', 'but', 'they', 'we', 'you'],
  fr: ['le', 'la', 'les', 'de', 'des', 'du', 'un', 'une', 'et', 'est', 'en', 'que', 'qui', 'dans', 'pour', 'pas', 'sur', 'ce', 'il', 'ne', 'au', 'aux', 'avec', 'elle', 'nous', 'vous', 'je', 'mais', 'par'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ein', 'eine', 'zu', 'den', 'von', 'mit', 'sich', 'des', 'auf', 'für', 'im', 'dem', 'dass', 'er', 'sie', 'es', 'wir', 'als', 'auch', 'an', 'werden', 'aus', 'hat'],
  es: ['el', 'la', 'los', 'las', 'de', 'que', 'y', 'en', 'un', 'una', 'por', 'con', 'no', 'se', 'su', 'para', 'es', 'al', 'lo', 'como', 'más', 'pero', 'sus', 'le', 'ya', 'o', 'este', 'muy', 'sin'],
  pt: ['o', 'a', 'os', 'as', 'de', 'que', 'e', 'do', 'da', 'em', 'um', 'uma', 'para', 'com', 'não', 'se', 'na', 'por', 'mais', 'dos', 'das', 'no', 'ao', 'ele', 'ela', 'você', 'nós', 'mas', 'foi'],
  it: ['il', 'la', 'di', 'che', 'e', 'un', 'una', 'per', 'non', 'con', 'del', 'della', 'le', 'gli', 'si', 'come', 'ma', 'più', 'sono', 'nel', 'nella', 'dei', 'delle', 'questo', 'anche', 'lo', 'ha', 'ci'],
};

/** Distinguish Latin languages by stopword share; 'und' (undetermined) when no clear winner, so a
 *  French/German/… page is never mistaken for English and wrongly skipped. */
function detectLatin(text: string): string {
  const words = new Set(text.toLowerCase().match(/[\p{L}']+/gu) ?? []);
  let best = 'und';
  let bestScore = 0;
  let tie = false;
  for (const [lang, stops] of Object.entries(STOPWORDS)) {
    let score = 0;
    for (const w of stops) if (words.has(w)) score++;
    if (score > bestScore) {
      best = lang;
      bestScore = score;
      tie = false;
    } else if (score === bestScore && score > 0) {
      tie = true;
    }
  }
  return tie ? 'und' : best;
}

export function detectLang(text: string): string {
  const len = text.length;
  if (!len) return 'und';
  const ratio = (re: RegExp) => (text.match(re)?.length ?? 0) / len;
  if (ratio(RE.kana) > 0.05) return 'ja';
  if (ratio(RE.hangul) > 0.2) return 'ko';
  if (ratio(RE.cjk) > 0.2) return 'zh';
  if (ratio(RE.cyrillic) > 0.3) return 'ru';
  if (ratio(RE.arabic) > 0.3) return 'ar';
  if (ratio(RE.hebrew) > 0.3) return 'he';
  if (ratio(RE.thai) > 0.3) return 'th';
  if (ratio(RE.devanagari) > 0.3) return 'hi';
  return detectLatin(text);
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