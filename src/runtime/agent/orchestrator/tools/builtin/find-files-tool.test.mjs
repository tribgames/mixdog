import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { executeFindFilesTool } from './find-files-tool.mjs';

async function withFixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-find-files-'));
  try {
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'entry.txt'), 'ok');
    await writeFile(join(root, 'nested', 'entry.mjs'), 'ok');
    await writeFile(join(root, 'other.md'), 'ok');
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('find_files answers a name fragment with the matching paths', async () => {
  await withFixture(async (root) => {
    const out = await executeFindFilesTool({ path: root, name: 'entry' }, process.cwd());
    assert.doesNotMatch(out, /^Error:/);
    assert.match(out, /^entry\.txt\t/m);
    assert.match(out, /^nested\/entry\.mjs\t/m);
    assert.doesNotMatch(out, /other\.md/);
  });
});

test('find_files takes a glob in path as the name pattern', async () => {
  await withFixture(async (root) => {
    const out = await executeFindFilesTool({ path: join(root, '**', '*.mjs') }, process.cwd());
    assert.doesNotMatch(out, /^Error:/);
    assert.match(out, /^nested\/entry\.mjs\t/m);
    assert.doesNotMatch(out, /entry\.txt/);
  });
});

test('find_files rejects an unparseable modified window instead of dropping the filter', async () => {
  await withFixture(async (root) => {
    const out = await executeFindFilesTool({ path: root, modified_after: 'yesterday-ish' }, process.cwd());
    assert.match(out, /^Error: invalid modified_after "yesterday-ish"/);
  });
});
