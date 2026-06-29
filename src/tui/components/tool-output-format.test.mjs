import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatExpandedResult,
  inferLangFamily,
  stripUnderlineAnsi,
  linkifyUrls,
  tryFormatJson,
} from './tool-output-format.mjs';

const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;;[^\x07]*\x07/g, '');

test('inferLangFamily maps known extensions, null otherwise', () => {
  assert.equal(inferLangFamily('src/x.mjs'), 'js');
  assert.equal(inferLangFamily('a.py'), 'py');
  assert.equal(inferLangFamily('x.json'), 'json');
  assert.equal(inferLangFamily('run.sh'), 'sh');
  assert.equal(inferLangFamily('readme'), null);
  assert.equal(inferLangFamily(''), null);
});

test('read line-number gutter is split into a dim column and body is highlighted', () => {
  const read = '900\u2192function f() {\n901\u2192  return 1;\n902\u2192}';
  const out = formatExpandedResult(read, { pathArg: 'a.mjs' });
  assert.equal(out.length, 3);
  // gutter text survives, body keyword colored (output carries SGR escapes).
  assert.ok(stripAnsi(out[0]).startsWith('900\u2192function f() {'));
  assert.ok(out[0].includes('\x1b['), 'first line carries color escapes');
});

test('grep file:line: gutter is split too', () => {
  const grep = 'src/a.mjs:5581:  value: foo,';
  const out = formatExpandedResult(grep, { pathArg: 'src/a.mjs' });
  assert.equal(out.length, 1);
  assert.ok(stripAnsi(out[0]).startsWith('src/a.mjs:5581:'));
});

test('JSON result is auto pretty-printed (size-capped, precision-safe)', () => {
  const out = formatExpandedResult('{"a":1,"b":[2,3]}', {});
  assert.ok(out.length > 1, 'single-line JSON expands to multiple rows');
  assert.equal(stripAnsi(out[0]), '{');
  // precision loss → keep original line
  const big = '{"id":123456789012345678901234567890}';
  assert.equal(tryFormatJson(big), big);
});

test('shell output keeps color ANSI but strips underline and never highlights', () => {
  const sh = 'PASS \x1b[32mok\x1b[0m\n\x1b[4mfile.js\x1b[24m done';
  const out = formatExpandedResult(sh, { isShell: true });
  assert.ok(out[0].includes('\x1b[32m'), 'color ANSI preserved');
  assert.ok(!out[1].includes('\x1b[4m'), 'underline stripped');
  assert.equal(stripAnsi(out[1]), 'file.js done');
});

test('unified diff is colored by line class', () => {
  const diff = 'diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new\n ctx';
  const out = formatExpandedResult(diff, {});
  assert.equal(out.length, 5);
  assert.ok(out.every((l) => l.includes('\x1b[')), 'every diff line colored');
});

test('oversize output is capped with a truncation marker', () => {
  const many = Array.from({ length: 5000 }, (_, i) => `line${i}`).join('\n');
  const out = formatExpandedResult(many, {});
  assert.ok(out.length <= 4001);
  assert.ok(/truncated/.test(stripAnsi(out[out.length - 1])));

  const huge = 'x'.repeat(300 * 1024);
  const out2 = formatExpandedResult(huge, {});
  assert.ok(/truncated/.test(stripAnsi(out2[out2.length - 1])));
});

test('stripUnderlineAnsi removes only underline SGR', () => {
  assert.equal(stripUnderlineAnsi('a\x1b[4mu\x1b[24mb'), 'aub');
  assert.equal(stripUnderlineAnsi('a\x1b[32mg\x1b[0mb'), 'a\x1b[32mg\x1b[0mb');
});

test('linkifyUrls wraps bare URLs in OSC 8', () => {
  const out = linkifyUrls('see https://x.com/y here');
  assert.ok(out.includes('\x1b]8;;https://x.com/y\x07'));
  assert.equal(linkifyUrls('no url here'), 'no url here');
});

test('empty input yields no lines', () => {
  assert.deepEqual(formatExpandedResult('', {}), []);
});
