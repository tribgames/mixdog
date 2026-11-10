// Records js_trim.json: what `String.prototype.trim()` removes.
//   trimmed: EVERY non-surrogate code point `c` for which `('a' + c + 'b' + c).trim()` is `'a' + c + 'b'` (removed at the end and
//            kept inside), in ascending order;
//   node:    the Node version that recorded it.
// Run: node js_trim.mjs > js_trim.json
const trimmed = [];
for (let cp = 0; cp <= 0x10ffff; cp += 1) {
  if (cp >= 0xd800 && cp <= 0xdfff) continue;
  const c = String.fromCodePoint(cp);
  const end = `a${c}b${c}`.trim() === `a${c}b`;
  const start = `${c}a${c}b`.trim() === `a${c}b`;
  if (end !== start) throw new Error(`U+${cp.toString(16)} is trimmed at one end only`);
  if (end) trimmed.push(cp);
}
process.stdout.write(`${JSON.stringify({ node: process.version, trimmed })}\n`);
