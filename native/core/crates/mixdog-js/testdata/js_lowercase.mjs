// Records js_lowercase.json: what `String.prototype.toLowerCase()` (no locale) does.
//   rows:    [codePoint, lowered] for EVERY non-surrogate code point whose lowering is not itself;
//   strings: [input, output] where the context matters (Final_Sigma) or the mapping is special (İ).
// Run: node js_lowercase.mjs > js_lowercase.json
const rows = [];
for (let cp = 0; cp <= 0x10ffff; cp += 1) {
  if (cp >= 0xd800 && cp <= 0xdfff) continue;
  const text = String.fromCodePoint(cp);
  const lowered = text.toLowerCase();
  if (lowered !== text) rows.push([cp, lowered]);
}
const strings = [
  '\u0130',
  '\u0130STANBUL',
  'I',
  'I\u0307',
  '\u0397\u03a3',
  '\u0391\u03a3.',
  '\u03a3',
  '\u0391\u03a3 \u0391',
  '\u0391\u03a3\u0391',
  'A.\u03a3',
  '\u0391\u03a3\u0345',
  '\u0391\u00ad\u03a3',
  '\u0391\u03a3\u00ad',
  '\u03a3\u03a3',
  '\u0391\u03a3\u03a3',
  '\u01c5',
  '\u1e9e',
  '\u0390',
  'HELLO W\u00d6RLD \u0178',
  'TOKEN API_KEY \u212a',
  '\u{10400}\u{1d7ce}',
  '',
];
process.stdout.write(`${JSON.stringify({ rows, strings: strings.map((s) => [s, s.toLowerCase()]) })}\n`);
