import assert from 'node:assert/strict';
import test from 'node:test';
import { readRowsForDisplay, readRowsForModel } from './read-row-numbers.mjs';

const rows = (from, to, body = (n) => `  line ${n}`) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${from + i}→${body(from + i)}`);

test('model rows drop their numbers under one range marker and keep exact content bytes', () => {
  const text = [
    'read 1',
    '',
    'a.go [ok]',
    ...rows(5, 7, (n) => (n === 6 ? '\t\tx' : `  line ${n}`)),
    '[lines 5-7 of 90]',
  ].join('\n');
  assert.equal(
    readRowsForModel(text),
    ['read 1', '', 'a.go [ok]', '[lines 5-7]', '  line 5', '\t\tx', '  line 7', '[lines 5-7 of 90]'].join('\n')
  );
});

test('every gap starts a new run and a footer equal to the marker is dropped', () => {
  const text = [...rows(1, 2), '... [TRUNCATED] ...', ...rows(40, 41), '[lines 40-41]'].join('\n');
  assert.equal(
    readRowsForModel(text),
    ['[lines 1-2]', '  line 1', '  line 2', '... [TRUNCATED] ...', '[lines 40-41]', '  line 40', '  line 41'].join('\n')
  );
  assert.deepEqual(readRowsForModel([...rows(3, 3), ...rows(9, 9)].join('\n')).split('\n'), [
    '[lines 3-3]',
    '  line 3',
    '[lines 9-9]',
    '  line 9',
  ]);
});

test('display rebuilds the numbered rows, including blank and row-like content', () => {
  const text = [
    'read 2',
    '',
    'a.js [ok]',
    ...rows(5, 27, (n) => {
      if (n === 9) return '';
      if (n === 10) return '12→not a row';
      return `  line ${n}`;
    }),
    '[lines 5-27 of 90; offset:28 for more]',
    '',
    'b.go [ok]',
    ...rows(1, 4, () => '\tx'),
  ].join('\n');
  assert.equal(readRowsForDisplay(readRowsForModel(text)), text);
});

test('read cards show numbered rows while the model-facing text has none', async () => {
  const { deriveToolCardModel } = await import('./tool-card-model.mjs');
  const card = deriveToolCardModel({
    name: 'read',
    args: { file_path: 'a.js' },
    result: readRowsForModel(rows(1, 3).join('\n')),
  });
  assert.match(card.displayedResultBodyText, /^2→ {2}line 2$/m);
  assert.doesNotMatch(card.displayedResultBodyText, /\[lines 1-3\]/);
});

test('text without numbered rows or markers is returned unchanged', () => {
  for (const text of ['[file unchanged: a.js]', 'Error: not found', '', '[lines 1-5]']) {
    assert.equal(readRowsForModel(text), text);
  }
  assert.equal(readRowsForDisplay('[lines 1-5]\nonly one row'), '[lines 1-5]\nonly one row');
});
