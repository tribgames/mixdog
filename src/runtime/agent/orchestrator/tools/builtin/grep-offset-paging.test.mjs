import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { executeBuiltinTool } from '../builtin.mjs';
import { relativePathPrefix } from './search-path-diagnostics.mjs';

const FILES = 90;
const PAGE = 20;

async function seed(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  for (let i = 0; i < FILES; i++) {
    const file = join(root, `f-${String(i).padStart(3, '0')}.txt`);
    await writeFile(file, 'needle\nneedle\n');
    // Groups of three share an mtime so the path tiebreak is exercised; the
    // mtime order is the reverse of the path order.
    const seconds = 1_700_000_000 + Math.floor((FILES - i) / 3) * 10;
    await utimes(file, seconds, seconds);
  }
  return root;
}

function rowsOf(out, mode) {
  return out
    .split('\n')
    .filter((line) => line && !line.startsWith('[') && !line.startsWith('('))
    .map((line) => (mode === 'count' ? line.replace(/:\d+$/, '') : line));
}

async function pageAll(root, mode) {
  const pages = [];
  for (let offset = 0; offset < FILES + PAGE; offset += PAGE) {
    pages.push(await executeBuiltinTool('grep', { pattern: 'needle', path: root, mode, limit: PAGE, offset }, root));
  }
  return pages;
}

for (const mode of ['files_with_matches', 'count']) {
  test(`grep ${mode}: offset pages neither repeat nor skip and match the unpaged order`, async (t) => {
    const root = await seed(`mixdog-grep-page-${mode}-`);
    t.after(() => rm(root, { recursive: true, force: true }));
    const whole = rowsOf(
      await executeBuiltinTool('grep', { pattern: 'needle', path: root, mode, limit: 0 }, root),
      mode
    );
    assert.equal(whole.length, FILES);
    assert.equal(new Set(whole).size, FILES);
    const paged = (await pageAll(root, mode)).flatMap((page) => rowsOf(page, mode));
    assert.deepEqual(paged, whole);
    const again = (await pageAll(root, mode)).flatMap((page) => rowsOf(page, mode));
    assert.deepEqual(again, whole);
  });
}

test('grep files_with_matches: newest first, path tiebreak, across pages', async (t) => {
  const root = await seed('mixdog-grep-page-order-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const paged = (await pageAll(root, 'files_with_matches')).flatMap((page) => rowsOf(page, 'files_with_matches'));
  const name = (row) => row.split(/[\\/]/).pop();
  const expected = Array.from({ length: FILES }, (_, i) => `f-${String(i).padStart(3, '0')}.txt`).sort((a, b) => {
    const ga = Math.floor((FILES - Number(a.slice(2, 5))) / 3);
    const gb = Math.floor((FILES - Number(b.slice(2, 5))) / 3);
    return gb - ga || (a < b ? -1 : 1);
  });
  assert.deepEqual(paged.map(name), expected);
});

// A root reached through a symlink (macOS /var -> /private/var) or junction is
// walked under its realpath: results must still be relative to the root the
// caller gave, and a file reported under both spellings must page once.
test('grep through a symlinked root prints root-relative rows and pages each file once', async (t) => {
  const real = await seed('mixdog-grep-page-real-');
  const link = `${real}-link`;
  await symlink(real, link, 'junction');
  t.after(async () => {
    await rm(link, { recursive: true, force: true });
    await rm(real, { recursive: true, force: true });
  });
  const whole = rowsOf(
    await executeBuiltinTool('grep', { pattern: 'needle', path: link, mode: 'files_with_matches', limit: 0 }, link),
    'files_with_matches'
  );
  assert.equal(whole.length, FILES);
  assert.ok(
    whole.every((row) => /^f-\d{3}\.txt$/.test(row)),
    whole.find((row) => !/^f-\d{3}\.txt$/.test(row))
  );
  const spellings = [
    relativePathPrefix(join(await realpath(real), 'f-000.txt'), link),
    relativePathPrefix(join(link, 'f-000.txt'), link),
  ];
  assert.deepEqual(spellings, ['f-000.txt', 'f-000.txt']);
});

test('grep byte-capped files_with_matches page offers a real offset continuation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-grep-cap-continuation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const names = [];
  for (let i = 0; i < 300; i++) {
    const name = `file-${String(i).padStart(3, '0')}-${'n'.repeat(40)}.txt`;
    names.push(name);
    await writeFile(join(root, name), 'needle');
  }
  const args = { pattern: 'needle', path: root, mode: 'files_with_matches', limit: 1000 };
  const first = await executeBuiltinTool('grep', { ...args }, root);
  const marker = /\[output capped at 5 KB; (\d+) match row\(s\) shown; offset:(\d+) for more\]$/.exec(first);
  assert.ok(marker, first.slice(-200));
  const shown = Number(marker[1]);
  assert.equal(Number(marker[2]), shown);
  const firstRows = rowsOf(first, 'files_with_matches');
  assert.equal(firstRows.length, shown);
  const second = await executeBuiltinTool('grep', { ...args, offset: shown }, root);
  const secondRows = rowsOf(second, 'files_with_matches');
  assert.equal(secondRows.filter((row) => firstRows.includes(row)).length, 0);
  assert.equal(new Set([...firstRows, ...secondRows]).size, firstRows.length + secondRows.length);
});
