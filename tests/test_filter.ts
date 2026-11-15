// Unit checks for text validity: machine tokens are skipped, prose is kept.
import { isValidText } from '../src/core/filter.ts';

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

const skipped = [
  'https://example.com/some/path', // URL
  'user@example.com', // email
  '/usr/local/bin', // file path
  'C:\\Users\\sms\\file.txt', // Windows file path
  '550e8400-e29b-41d4-a716-446655440000', // UUID
  'v1.2.3', // version
  '10.0.1', // version
  '{{username}}', // template placeholder
  '${name}', // template placeholder
  '__init__', // template placeholder
  '%s', // printf token
  '.gitignore', // CSS selector / dotfile
  '#fff', // hex color
  '#1a2b3c', // hex color
  '@john.doe', // @username
  '&amp;', // HTML entity
  'document.pdf', // filename
  'Node.js', // filename
  '12345', // pure number
  'x', // single char
];
for (const s of skipped) check(`skip: ${JSON.stringify(s)}`, !isValidText(s));

const kept = [
  'The quick brown fox jumps over the lazy dog.',
  'Hello world, this is a sentence.',
  'Hello @john', // embedded mention is prose
  '# Introduction', // heading with a space is prose
  'Read the document.pdf file for details.', // filename inside prose
  'Version v1.2.3 was released today.', // version inside prose
  'This is a test.',
  'U.S.', // not a filename
  'Mixed language text should still translate.',
  '这是一个中文段落。',
];
for (const s of kept) check(`keep: ${JSON.stringify(s)}`, isValidText(s));

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) throw new Error(`${fail} text validity checks failed`);