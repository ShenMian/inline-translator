// Unit checks for language detection: Latin languages must not be conflated with English.
import { detectLang, isSameLang, langFamily } from '../src/lib/lang.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}  ${detail}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}  ${detail}`);
  }
}

const en = 'The quick brown fox jumps over the lazy dog. This is a sample English sentence with several common words.';
const fr = 'Le petit prince est un livre célèbre. La vie est belle et nous allons dans le jardin pour voir les fleurs.';
const de = 'Der schnelle Fuchs springt über den faulen Hund. Dies ist ein deutscher Satz mit vielen häufigen Wörtern und der die das.';
const es = 'El rápido zorro salta sobre el perro perezoso. Esta es una oración en español con muchas palabras comunes y que para.';
const vi = 'Đây là một câu tiếng Việt với nhiều từ phổ biến và các từ thường gặp trong văn bản của người dân.';
const id = 'Ini adalah kalimat bahasa Indonesia dengan banyak kata umum yang sering muncul dalam teks untuk saya dan anda.';

check('English detected as en', detectLang(en) === 'en', detectLang(en));
check('French detected as fr', detectLang(fr) === 'fr', detectLang(fr));
check('German detected as de', detectLang(de) === 'de', detectLang(de));
check('Spanish detected as es', detectLang(es) === 'es', detectLang(es));
check('Vietnamese detected as vi', detectLang(vi) === 'vi', detectLang(vi));
check('Indonesian detected as id', detectLang(id) === 'id', detectLang(id));
// Vietnamese diacritics (à â ê ô) must not be mistaken for French; Indonesian must not be Italian.
check('Vietnamese not conflated with French', detectLang(vi) !== 'fr', detectLang(vi));
check('Indonesian not conflated with Italian', detectLang(id) !== 'it', detectLang(id));

check('French not skipped for English target', !isSameLang(fr, 'en'));
check('German not skipped for English target', !isSameLang(de, 'en'));
check('Spanish not skipped for English target', !isSameLang(es, 'en'));
check('English skipped for English target', isSameLang(en, 'en'));
check('Vietnamese skipped for vi target', isSameLang(vi, 'vi'));
check('Indonesian skipped for id target', isSameLang(id, 'id'));
check('Vietnamese not skipped for en target', !isSameLang(vi, 'en'));
check('Indonesian not skipped for en target', !isSameLang(id, 'en'));
check('English not skipped for Chinese target', !isSameLang(en, 'zh-CN'));
check('Chinese skipped for Chinese target', isSameLang('这是一个中文句子，用来测试语言检测功能。', 'zh-CN'));
check('Traditional Chinese skipped for zh-TW target', isSameLang('這是一個繁體中文句子，用來測試語言檢測功能。', 'zh-TW'));
check('Simplified not skipped for zh-TW target', !isSameLang('这是一个简体中文句子，用来测试语言检测功能。', 'zh-TW'));
check('Traditional not skipped for zh-CN target', !isSameLang('這是一個繁體中文句子，用來測試語言檢測功能。', 'zh-CN'));
check('langFamily zh-CN -> zh-Hans', langFamily('zh-CN') === 'zh-Hans', langFamily('zh-CN'));
check('langFamily zh-TW -> zh-Hant', langFamily('zh-TW') === 'zh-Hant', langFamily('zh-TW'));
check('langFamily zh -> zh', langFamily('zh') === 'zh', langFamily('zh'));

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) throw new Error(`${fail} language detection checks failed`);