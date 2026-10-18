import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { executeFindFilesTool, executeFuzzyFindTool, executeListTool } from './list-tool.mjs';

const NAMES = ['e.txt', 'b.txt', 'f.txt', 'a.txt', 'd.txt', 'c.txt'];
const SORTED = [...NAMES].sort();

// Every file shares size and mtime, so only the tiebreak can order them.
async function seedTies(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(root, 'sub'));
  for (const name of NAMES) {
    const file = join(root, 'sub', name);
    await writeFile(file, 'same');
    await utimes(file, 1_700_000_000, 1_700_000_000);
  }
  return root;
}

const names = (out) =>
  out
    .split('\n')
    .filter((line) => line && !line.startsWith('['))
    .map((line) => line.split('\t')[0].split('/').pop());

test('find sort=size|mtime pages the same total order whatever order the walk returns', async (t) => {
  for (const sort of ['size', 'mtime']) {
    const seen = [];
    for (const order of [NAMES, [...NAMES].reverse()]) {
      const root = await seedTies(`mixdog-find-ties-${sort}-`);
      t.after(() => rm(root, { recursive: true, force: true }));
      const options = { __runRg: async () => order.map((name) => `sub/${name}`).join('\n') };
      const pages = [];
      for (let offset = 0; offset < NAMES.length; offset += 2) {
        pages.push(
          ...names(
            await executeFindFilesTool(
              { path: root, name: '.txt', type: 'file', sort, head_limit: 2, offset },
              process.cwd(),
              options
            )
          )
        );
      }
      seen.push(pages);
    }
    assert.deepEqual(seen[0], SORTED, sort);
    assert.deepEqual(seen[1], SORTED, sort);
  }
});

test('list sort=size|mtime pages the same total order whatever order the native walk returns', async (t) => {
  for (const sort of ['size', 'mtime']) {
    const seen = [];
    for (const order of [NAMES, [...NAMES].reverse()]) {
      const root = await seedTies(`mixdog-list-ties-${sort}-`);
      t.after(() => rm(root, { recursive: true, force: true }));
      const options = {
        __runRgWindowedLines: async () => ({
          complete: true,
          cacheSafe: true,
          lines: order.map((name) => join(root, 'sub', name)),
        }),
        __tryServeListMetadata: async (paths) =>
          paths.map(() => ({ type: 'file', mode: 0o644, size: 4, mtimeMs: 1_700_000_000_000 })),
      };
      const pages = [];
      for (let offset = 0; offset < NAMES.length; offset += 2) {
        pages.push(
          ...names(
            await executeListTool({ path: root, depth: 2, type: 'file', sort, head_limit: 2, offset }, root, options)
          )
        );
      }
      seen.push(pages);
    }
    assert.deepEqual(seen[0], SORTED, sort);
    assert.deepEqual(seen[1], SORTED, sort);
  }
});

test('fuzzy find has no offset, so its byte-cap marker must not offer one', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-find-fuzzy-cap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const matches = Array.from({ length: 40 }, (_, i) => `src/some/long/directory/name/file-${i}.mjs`);
  const out = String(
    await executeFuzzyFindTool({ query: 'file', path: '.', head_limit: 40 }, root, {
      toolOutputMaxBytes: 512,
      __tryServeFuzzySearch: async () => ({ complete: true, matches, hasMore: false, cacheSafe: false }),
    })
  );
  assert.match(out, /\[output capped at/);
  assert.doesNotMatch(out, /offset:\d+ for more/);
  assert.match(out, /narrow: /);
});
