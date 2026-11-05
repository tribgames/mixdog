// Records V8's SyntaxError text for invalid search patterns (WP-WS): the workspace text search
// shows `Invalid search pattern: ${error.message}` and the Rust port must be byte-equal.
// Each pattern is compiled exactly as workspace-search.ts does (`new RegExp(source, 'giu')` and
// the matchCase form 'gu'). Run: node benchmarks/rust-core/recorders/record-regex-errors.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const patterns = [
  '(', '((a)', '(a', ')', 'a)', '[', '[a', '[a-', '*', '+a', '?a', 'a**', 'a+*', 'a{2,1}', '{1}', '{', 'a{', 'a{1', 'a{1,', '}', 'a}', ']', 'a]',
  '\\', 'a\\', '\\c', '\\c1', '\\x', '\\x1', '\\u', '\\u12', '\\u{', '\\u{110000}', '\\u{}', '\\p', '\\p{', '\\p{Foo}', '\\p{L', '\\P{Nope}', '\\k', '\\k<a>',
  '(?<a>x)\\k<b>', '(?<a>x)(?<a>y)', '(?<1a>x)', '(?<', '(?<a', '(?<a>', '(?', '(?x)', '(?:', '(?=', '(?!a', '(?<=a', '(?<!a',
  '[b-a]', '[\\d-a]', '[a-\\d]', '\\1', '\\2(a)', '\\00', '\\_', '\\-', '\\a', '[\\_]', '[\\-]', '(?i:a)', 'a{1}{2}', '^*', '$+', '(?=a)*', '(?<=a)+', '\\b+', '\\B*',
  'a/(', '/(', '\n(', '\\k<a', '[\\1]', '[\\k<a>]', '[\\B]', '[[', '[]', '[^]', '(?<a-b>x)', '\\k<>', '(?<>x)', 'a|*', '(|*)', '(*)', '(+)', '(?:*)', '\\p{Script=Foo}', '\\p{Script=}', '\\p{=L}', '\\u{1F600', '[\\u{110000}]',
];

function message(source, flags) {
  try {
    new RegExp(source, flags);
    return null;
  } catch (error) {
    return error.message;
  }
}

// A seeded fuzz corpus: V8's verdict on short random patterns built from regex tokens, valid
// ones included (message null) so the validator is also held to accepting what V8 accepts.
function rng(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const tokens = ['(', ')', '[', ']', '{', '}', '*', '+', '?', '|', '^', '$', '.', '\\', 'a', 'b', 'z', '1', '0', '2', ',', '-', '<', '>', '=', '!', ':',
  '\\d', '\\w', '\\b', '\\B', '\\k<a>', '\\k<b>', '(?<a>', '(?:', '(?=', '(?!', '(?<=', '(?<!', '\\p{L}', '\\p{Lu}', '\\u{41}', '\\u0041', '\\x41', '\\cA',
  '\\1', '\\2', '{2}', '{1,2}', '{2,1}', '*?', 'a-z', '\\-', '\\/', '\\_', '/', '\\0', '\\00', '\\u', '\\x', '\\c', '\\k', '\\p', '(?<b>'];
const next = rng(20260101);
const fuzz = [];
for (let i = 0; i < 6000; i += 1) {
  const length = 1 + Math.floor(next() * 7);
  let query = '';
  for (let k = 0; k < length; k += 1) query += tokens[Math.floor(next() * tokens.length)];
  fuzz.push(query);
}
const fuzzCases = [...new Set(fuzz)].map((query) => ({ query, flags: 'giu', message: message(query, 'giu') }));

const cases = patterns.flatMap((query) =>
  ['giu', 'gu'].map((flags) => ({ query, flags, message: message(query, flags) })).filter((c) => c.message !== null)
);
const out = join(dirname(fileURLToPath(import.meta.url)), '../../../native/core/fixtures/desktop/search/regex-errors.json');
writeFileSync(out, `${JSON.stringify({ node: process.version, v8: process.versions.v8, cases, fuzz: fuzzCases })}\n`);
const { FIXTURES_ROOT, refreshSetManifest } = await import('./lib/common.mjs');
refreshSetManifest(join(FIXTURES_ROOT, 'desktop'), null);
console.log(`${cases.length} error cases, node ${process.version}`);
