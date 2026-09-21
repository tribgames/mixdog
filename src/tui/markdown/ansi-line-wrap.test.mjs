import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { extraColorizers, formatToken } from './format-token.mjs';
import { wrapText } from './table-layout.mjs';

test('wrapText preserves nonpositive-width inputs and normalizes positive-width lines', () => {
  const original = { toString: () => 'converted' };
  for (const width of [0, -1]) {
    assert.strictEqual(wrapText(original, width)[0], original);
    assert.deepEqual(wrapText(' a\n\nb  \n', width), [' a\n\nb  \n']);
    assert.deepEqual(wrapText(null, width), [null]);
  }
  for (const [text, expected] of [
    ['', ['']],
    [' \n\t', ['']],
    ['  a\n\nb  \n', ['  a', 'b']],
    [null, ['null']],
    [undefined, ['undefined']],
    [original, ['converted']],
  ]) {
    assert.deepEqual(wrapText(text, 80), expected);
  }
  assert.deepEqual(wrapText('abcdef', 3), ['abcdef']);
  assert.deepEqual(wrapText('abcdef', 3, { hard: true }), ['abc', 'def']);
});

test('wrapText keeps exact ANSI boundaries and whole Unicode graphemes', () => {
  assert.deepEqual(wrapText('\x1b[31mabcdef\x1b[39m', 3, { hard: true }), [
    '\x1b[31mabc\x1b[39m',
    '\x1b[31mdef\x1b[39m',
  ]);
  for (const [text, width, expected] of [
    ['界界界', 4, ['界界', '界']],
    // wrap-ansi normalizes to NFC before wrapping.
    ['e\u0301e\u0301e\u0301', 2, ['éé', 'é']],
    ['👩‍💻👩‍💻👩‍💻', 4, ['👩‍💻👩‍💻', '👩‍💻']],
  ]) {
    assert.deepEqual(wrapText(text, width, { hard: true }), expected);
  }
});

test('plain and settled code blocks preserve wrapped ANSI rows, gutters and blank lines', () => {
  const color = extraColorizers().body;
  const cases = [
    ['abcdefghi', ['abcdef', 'ghi']],
    ['界界界界', ['界界界', '界']],
    ['e\u0301'.repeat(7), ['é'.repeat(6), 'é']],
    ['👩‍💻'.repeat(4), ['👩‍💻'.repeat(3), '👩‍💻']],
    ['line\n\nnext', ['line', '', 'next']],
    ['', ['']],
  ];
  for (const plain of [false, true]) {
    for (const [text, lines] of cases) {
      const expected = lines.map((line) => `  ${color(line)}\n`).join('');
      assert.equal(formatToken({ type: 'code', text, plain }, 0, null, null, 8), expected);
    }
    // The plain short-line fast path deliberately bypasses wrap-ansi.
    const shortText = plain ? 'e\u0301' : 'é';
    assert.equal(formatToken({ type: 'code', text: 'e\u0301', plain }, 0, null, null, 8), `  ${color(shortText)}\n`);
  }
});

test('vertical tables retain exact ANSI and ambiguous-width fallback under both width policies', () => {
  const tableModule = JSON.stringify(new URL('./table-layout.mjs', import.meta.url).href);
  const script = `
    import { buildTableRender, wrapText } from ${tableModule};
    const cell = (text) => ({ tokens: [{ type: 'text', text }] });
    const text = '①②③④⑤';
    const token = { header: [cell('A')], rows: [[cell(text)]] };
    console.log(JSON.stringify({
      table: buildTableRender(token, 10),
      soft: wrapText(text, 7, { hard: true }),
    }));
  `;
  const label = '\x1b[1mA:\x1b[22m ';
  for (const [policy, lines] of [
    ['0', [`${label}①②③④⑤`]],
    ['1', [`${label}①②③`, '  ④⑤']],
  ]) {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: { ...process.env, MIXDOG_TUI_AMBIGUOUS_WIDE: policy },
      timeout: 10000,
    });
    assert.deepEqual(JSON.parse(output), {
      table: { lines, useVerticalFormat: true },
      soft: ['①②③④⑤'],
    });
  }
});
