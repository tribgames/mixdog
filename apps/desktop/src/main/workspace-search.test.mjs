import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { replaceWorkspaceTextIn, searchWorkspaceTextIn } from './workspace-search.ts';

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('workspace text search groups line matches and honors include, case, word, and regex options', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-search-'));
  roots.push(root);
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'ignored'), { recursive: true });
  await writeFile(join(root, 'src', 'one.ts'), 'Alpha alpha alphabet\nconst value = 42;\n');
  await writeFile(join(root, 'src', 'two.js'), 'alpha\n');
  await writeFile(join(root, 'node_modules', 'ignored', 'three.ts'), 'alpha\n');
  const literal = await searchWorkspaceTextIn(root, {
    query: 'alpha',
    include: '**/*.ts',
    matchCase: true,
    wholeWord: true,
  });
  assert.equal(literal.matchCount, 1);
  assert.equal(literal.files[0].relPath, 'src/one.ts');
  assert.deepEqual(literal.files[0].matches.map((match) => [match.line, match.column]), [[1, 7]]);
  const regex = await searchWorkspaceTextIn(root, { query: 'value\\s*=\\s*\\d+', regex: true });
  assert.equal(regex.matchCount, 1);
  assert.equal(regex.files[0].matches[0].line, 2);
});

test('workspace replace is compare-and-swap, records history first, and preserves excluded files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-replace-'));
  roots.push(root);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'one.ts'), 'const alpha = "alpha";\n');
  await writeFile(join(root, 'src', 'two.ts'), 'const alpha = "alpha";\n');
  const history = [];
  const result = await replaceWorkspaceTextIn(
    root,
    { query: 'alpha', include: 'src/one.ts' },
    'beta',
    undefined,
    async (write) => { history.push([write.relPath, write.expectedContent]); },
  );
  assert.deepEqual(result, { filesChanged: 1, replacements: 2, paths: ['src/one.ts'] });
  assert.equal(history.length, 1);
  assert.equal(await readFile(join(root, 'src', 'one.ts'), 'utf8'), 'const beta = "beta";\n');
  assert.equal(await readFile(join(root, 'src', 'two.ts'), 'utf8'), 'const alpha = "alpha";\n');
});
