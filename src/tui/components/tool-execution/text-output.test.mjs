import assert from 'node:assert/strict';
import test from 'node:test';
import { theme } from '../../theme.mjs';
import { deltaTextParts } from './text-format.mjs';
import { formatExpandedResult, wrapExpandedResultLines } from '../tool-output-format.mjs';

function setRenderCap(context, value) {
  const names = ['MIXDOG_TUI_TOOL_OUTPUT_MAX_RENDER_LINES', 'MIXDOG_TUI_EXPANDED_MAX_ROWS'];
  const saved = names.map((name) => process.env[name]);
  context.after(() => {
    names.forEach((name, index) => {
      if (saved[index] === undefined) delete process.env[name];
      else process.env[name] = saved[index];
    });
  });
  delete process.env.MIXDOG_TUI_EXPANDED_MAX_ROWS;
  process.env.MIXDOG_TUI_TOOL_OUTPUT_MAX_RENDER_LINES = value;
}

test('delta parts retain boundaries and color only signed line counts', () => {
  assert.deepEqual(deltaTextParts('Changed (+ 12 Lines, - 3 lines).'), [
    { text: 'Changed ' },
    { text: '(' },
    { text: '+12', color: theme.success },
    { text: ' Lines,' },
    { text: ' ' },
    { text: '-3', color: theme.error },
    { text: ' lines).' },
  ]);
  assert.deepEqual(deltaTextParts('+0 line\n- 2 LINES'), [
    { text: '+0', color: theme.success },
    { text: ' line' },
    { text: '\n' },
    { text: '-2', color: theme.error },
    { text: ' LINES' },
  ]);
});

test('delta parts leave non-line counts and adjacent signs unchanged', () => {
  const text = 'x+2 Lines +4 bytes a-3 Lines';
  assert.deepEqual(deltaTextParts(text), [{ text }]);
  assert.deepEqual(deltaTextParts(''), []);
  assert.deepEqual(deltaTextParts(null), []);
});

test('shell row caps keep the newest tail and count every omitted row', (context) => {
  setRenderCap(context, '3');
  assert.deepEqual(wrapExpandedResultLines(['a', 'b', 'c', 'd', 'e'], 160, { isShell: true }), [
    '… [3 lines omitted above — showing newest output below]',
    'd',
    'e',
  ]);
  assert.deepEqual(wrapExpandedResultLines(['a', 'b', 'c'], 160, { isShell: true }), ['a', 'b', 'c']);
  assert.deepEqual(wrapExpandedResultLines([], 160, { isShell: true }), [' ']);
  process.env.MIXDOG_TUI_TOOL_OUTPUT_MAX_RENDER_LINES = '1';
  assert.deepEqual(wrapExpandedResultLines(['a', 'b', 'c'], 160, { isShell: true }), [
    '… [3 lines omitted above — showing newest output below]',
  ]);
});

test('non-shell row caps retain the head and reserve one truncation marker', (context) => {
  setRenderCap(context, '3');
  const marker = '… [output truncated for display — collapse (ctrl+o) or re-read a narrower range]';
  assert.deepEqual(wrapExpandedResultLines(['a', 'b', 'c', 'd'], 160), ['a', 'b', marker]);
  assert.deepEqual(wrapExpandedResultLines(['a', 'b', 'c'], 160), ['a', 'b', 'c']);
  assert.deepEqual(wrapExpandedResultLines([], 160), [' ']);
  process.env.MIXDOG_TUI_TOOL_OUTPUT_MAX_RENDER_LINES = '1';
  assert.deepEqual(wrapExpandedResultLines(['a', 'b'], 160), [marker]);
});

test('disabled caps and legacy limits retain their precedence', (context) => {
  setRenderCap(context, '0');
  process.env.MIXDOG_TUI_EXPANDED_MAX_ROWS = '1';
  assert.deepEqual(wrapExpandedResultLines(['a', 'b', 'c'], 160), ['a', 'b', 'c']);
  delete process.env.MIXDOG_TUI_TOOL_OUTPUT_MAX_RENDER_LINES;
  assert.deepEqual(wrapExpandedResultLines(['a', 'b'], 160, { isShell: true }), [
    '… [2 lines omitted above — showing newest output below]',
  ]);
});

test('shell normalization preserves ANSI and OSC bytes while removing visible controls', () => {
  assert.deepEqual(formatExpandedResult('\x1b[4;31mA\tB\x1b[24;39m\r\nC\x00D', { isShell: true }), [
    '\x1b[31mA B\x1b[39m',
    'C D',
  ]);
  for (const end of ['\x07', '\x1b\\']) {
    const link = `\x1b]8;;https://example.test${end}label\x1b]8;;${end}`;
    assert.deepEqual(formatExpandedResult(link, { isShell: true }), [link]);
  }
});
