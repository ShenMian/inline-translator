// Unit checks for translation service helpers (tag-safe splitting, Edge tag round-trip, OpenAI JSON parsing).
import { splitLong } from '../src/services/codec.ts';

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

// Construct a >4000-char rich string where the 4000-char boundary lands right inside <t0>...</t0>
const prefix = 'This is a normal introductory sentence. '.repeat(99); // 3960 chars
const tagged = `${prefix}<t0>This linked span crosses the four thousand character mark safely. And more inside link.</t0> Trailing sentence after link.`;
const chunks = splitLong(tagged);
check('splitLong splits over-long string into >=2 chunks', chunks.length >= 2, `len=${chunks.length}`);
check('splitLong preserves full text when rejoined', chunks.join('') === tagged);
check(
  'splitLong never leaves unclosed <t0> in any chunk',
  chunks.every((c) => (c.match(/<t0>/g) ?? []).length === (c.match(/<\/t0>/g) ?? []).length),
  JSON.stringify(chunks.map((c) => c.length)),
);

const atomicBoundary = `${'A'.repeat(3999)}{{12}} trailing text.`;
const atomicChunks = splitLong(atomicBoundary);
check('splitLong never splits {{12}} atomic placeholder', atomicChunks.every((c) => !c.includes('{{1') || c.includes('{{12}}')));

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) throw new Error(`${fail} service checks failed`);
