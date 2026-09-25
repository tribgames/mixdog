import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { replaceWorkspaceTextIn, searchWorkspaceTextIn } from './workspace-search.ts';

async function fixture(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-workspace-search-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [relPath, content] of Object.entries(files)) {
    const absolute = join(root, relPath);
    await mkdir(join(absolute, '..'), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
}

const options = (overrides) => ({ query: '', regex: false, matchCase: false, wholeWord: false, ...overrides });

test('text search reports every match on every line with 1-based columns', async (t) => {
  const root = await fixture(t, {
    'a.txt': 'Foo foo\nbar\nfoo',
    'src/b.txt': 'nothing here\nxFOOx',
  });
  const result = await searchWorkspaceTextIn(root, options({ query: 'foo' }));
  const byPath = Object.fromEntries(
    result.files.map((file) => [file.relPath, file.matches.map((m) => [m.line, m.column, m.endColumn, m.matchText])])
  );
  assert.deepEqual(byPath, {
    'a.txt': [
      [1, 1, 4, 'Foo'],
      [1, 5, 8, 'foo'],
      [3, 1, 4, 'foo'],
    ],
    'src/b.txt': [[2, 2, 5, 'FOO']],
  });
  assert.equal(result.matchCount, 4);
  assert.equal(result.limitHit, false);
});

test('text search honors case, whole word, regex and the result cap', async (t) => {
  const root = await fixture(t, { 'a.txt': 'foo food Foo\nfoo foo foo' });
  const cased = await searchWorkspaceTextIn(root, options({ query: 'Foo', matchCase: true }));
  assert.equal(cased.matchCount, 1);
  const whole = await searchWorkspaceTextIn(root, options({ query: 'foo', wholeWord: true }));
  assert.deepEqual(
    whole.files[0].matches.map((m) => [m.line, m.column]),
    [
      [1, 1],
      [1, 10],
      [2, 1],
      [2, 5],
      [2, 9],
    ]
  );
  const regex = await searchWorkspaceTextIn(root, options({ query: 'fo+d?', regex: true, matchCase: true }));
  assert.deepEqual(
    regex.files[0].matches.map((m) => m.matchText),
    ['foo', 'food', 'foo', 'foo', 'foo']
  );
  const capped = await searchWorkspaceTextIn(root, options({ query: 'foo', maxResults: 4 }));
  assert.equal(capped.matchCount, 4);
  assert.equal(capped.limitHit, true);
  assert.deepEqual(
    capped.files[0].matches.map((m) => [m.line, m.column]),
    [
      [1, 1],
      [1, 5],
      [1, 10],
      [2, 1],
    ]
  );
});

test('text search rejects an invalid regular expression', async (t) => {
  const root = await fixture(t, { 'a.txt': 'foo' });
  await assert.rejects(searchWorkspaceTextIn(root, options({ query: '(', regex: true })), /Invalid search pattern/);
});

test('text replace rewrites matches with regex group references', async (t) => {
  const root = await fixture(t, { 'a.txt': 'key=1\nkey=22\n', 'b.txt': 'other' });
  const result = await replaceWorkspaceTextIn(root, options({ query: 'key=(\\d+)', regex: true }), 'val:$1', undefined);
  assert.equal(result.replacements, 2);
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'val:1\nval:22\n');
  assert.equal(await readFile(join(root, 'b.txt'), 'utf8'), 'other');
});
