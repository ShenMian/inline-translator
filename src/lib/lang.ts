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
  vi: ['và', 'của', 'là', 'có', 'không', 'được', 'người', 'trong', 'với', 'các', 'một', 'những', 'này', 'cho', 'từ', 'khi', 'đã', 'sẽ', 'đang', 'rất', 'nhưng', 'nếu', 'thì', 'bạn', 'tôi', 'họ', 'nhiều', 'cũng', 'như', 'để'],
  id: ['yang', 'dan', 'itu', 'dengan', 'untuk', 'tidak', 'ini', 'dari', 'dalam', 'akan', 'pada', 'juga', 'saya', 'karena', 'bisa', 'ada', 'mereka', 'lebih', 'telah', 'atau', 'anda', 'tersebut', 'sangat', 'adalah', 'bahwa', 'oleh', 'setelah', 'sebagai', 'dapat', 'hanya'],
};

/** Chinese characters whose simplified and traditional forms differ; counts decide the script. */
const ZH_PAIRS: [string, string][] = [
  ['这', '這'], ['个', '個'], ['们', '們'], ['来', '來'], ['说', '說'], ['时', '時'],
  ['会', '會'], ['对', '對'], ['开', '開'], ['关', '關'], ['国', '國'], ['学', '學'],
  ['语', '語'], ['湾', '灣'], ['么', '麼'], ['样', '樣'], ['发', '發'], ['现', '現'],
  ['为', '為'], ['与', '與'], ['从', '從'], ['进', '進'], ['过', '過'], ['还', '還'],
  ['没', '沒'], ['请', '請'], ['电', '電'], ['话', '話'], ['见', '見'], ['觉', '覺'],
  ['让', '讓'], ['认', '認'], ['识', '識'], ['听', '聽'], ['问', '問'], ['长', '長'],
  ['车', '車'], ['门', '門'], ['马', '馬'], ['鸟', '鳥'], ['鱼', '魚'], ['龙', '龍'],
  ['龟', '龜'], ['头', '頭'], ['页', '頁'], ['风', '風'], ['飞', '飛'], ['齿', '齒'],
  ['贝', '貝'], ['书', '書'], ['万', '萬'], ['专', '專'], ['产', '產'], ['业', '業'],
  ['东', '東'], ['丝', '絲'], ['两', '兩'], ['严', '嚴'], ['丽', '麗'], ['举', '舉'],
  ['义', '義'], ['乌', '烏'], ['乐', '樂'], ['习', '習'], ['乡', '鄉'], ['买', '買'],
  ['乱', '亂'], ['争', '爭'],
];
const HANS_ONLY = new Set(ZH_PAIRS.map(([hans]) => hans));
const HANT_ONLY = new Set(ZH_PAIRS.map(([, hant]) => hant));

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

/** 'zh-Hans' / 'zh-Hant' when the text carries script-specific characters, plain 'zh' when ambiguous. */
function detectZhScript(text: string): string {
  let hans = 0;
  let hant = 0;
  for (const ch of text) {
    if (HANS_ONLY.has(ch)) hans++;
    else if (HANT_ONLY.has(ch)) hant++;
  }
  if (hans > hant) return 'zh-Hans';
  if (hant > hans) return 'zh-Hant';
  return 'zh';
}

export function detectLang(text: string): string {
  const len = text.length;
  if (!len) return 'und';
  const ratio = (re: RegExp) => (text.match(re)?.length ?? 0) / len;
  if (ratio(RE.kana) > 0.05) return 'ja';
  if (ratio(RE.hangul) > 0.2) return 'ko';
  if (ratio(RE.cjk) > 0.2) return detectZhScript(text);
  if (ratio(RE.cyrillic) > 0.3) return 'ru';
  if (ratio(RE.arabic) > 0.3) return 'ar';
  if (ratio(RE.hebrew) > 0.3) return 'he';
  if (ratio(RE.thai) > 0.3) return 'th';
  if (ratio(RE.devanagari) > 0.3) return 'hi';
  return detectLatin(text);
}

/** Normalize a language tag for skip comparisons: Chinese keeps its script (Hans/Hant), others drop
 *  the region so en-US/en-GB stay comparable. */
export function langFamily(code: string): string {
  const c = code.toLowerCase();
  if (c.startsWith('zh') || c.startsWith('ch')) {
    const parts = c.split('-');
    if (parts.includes('hant') || parts.includes('tw') || parts.includes('hk') || parts.includes('mo')) return 'zh-Hant';
    if (parts.includes('hans') || parts.includes('cn') || parts.includes('sg') || parts.includes('my')) return 'zh-Hans';
    return 'zh';
  }
  if (c.startsWith('jp')) return 'ja';
  return c.split('-')[0] ?? c;
}

function isChinese(lang: string): boolean {
  return lang === 'zh' || lang === 'zh-Hans' || lang === 'zh-Hant';
}

/** Same language as the target? Chinese script must match too: a zh-TW target still translates
 *  Simplified source instead of silently skipping it. Ambiguous Chinese counts as the target script. */
export function isSameLang(text: string, target: string): boolean {
  const detected = detectLang(text);
  const family = langFamily(target);
  if (isChinese(family)) {
    if (!isChinese(detected)) return false;
    return family === 'zh' || detected === 'zh' || detected === family;
  }
  return detected === family;
}

/** Primary page language (html[lang] first), for the whole-page same-language check before auto-translate. */
export function pageLang(): string {
  const attr = document.documentElement.getAttribute('lang');
  return attr ? langFamily(attr) : '';
}
