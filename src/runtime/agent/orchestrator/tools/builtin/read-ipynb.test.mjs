import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { extractIpynbText } from './read-special-files.mjs';

function notebook(t, cells) {
  const dir = mkdtempSync(join(tmpdir(), 'read-ipynb-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'nb.ipynb');
  writeFileSync(file, JSON.stringify({ cells }));
  return file;
}

test('range args are refused for notebooks', async (t) => {
  const file = notebook(t, []);
  assert.match(await extractIpynbText(file, { hasRangeArgs: true }), /^Error: range args \(offset\/limit\/line\)/);
});

test('an empty notebook says so', async (t) => {
  assert.equal(await extractIpynbText(notebook(t, [])), '(empty notebook)');
});

test('markdown and code cells render in notebook order with their text outputs', async (t) => {
  const file = notebook(t, [
    { cell_type: 'markdown', source: ['# T'] },
    { cell_type: 'code', source: 'print(1)', outputs: [{ text: ['1\n'] }] },
  ]);
  assert.equal(await extractIpynbText(file), '# T\n\n```python\nprint(1)\n# Output:\n1\n\n```');
});

test('an oversized output becomes a jq hint and a textOnly image stays a placeholder', async (t) => {
  const file = notebook(t, [
    { cell_type: 'code', source: 'x', outputs: [{ data: { 'text/plain': 'y'.repeat(10_001) } }] },
    { cell_type: 'code', source: 'plot()', outputs: [{ data: { 'image/png': 'AAAA' } }] },
  ]);
  assert.equal(
    await extractIpynbText(file, { textOnly: true }),
    [
      `\`\`\`python\nx\n# Output: [large output omitted — 10001 chars; inspect with: cat "${file}" | jq '.cells[0].outputs']\n\`\`\``,
      '```python\nplot()\n# Output: [image output — cell 1]\n```',
    ].join('\n\n')
  );
});

test('text past the output budget is cut and marked', async (t) => {
  const file = notebook(t, [{ cell_type: 'markdown', source: 'abcdefghijklmnop' }]);
  assert.equal(
    await extractIpynbText(file, { maxOutputBytes: 10 }),
    'abcdefghij\n\n\n\n... [notebook output truncated at 0 KB]'
  );
});
