import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeGlobTool } from './search-glob-tool.mjs';

test('glob opt-in includes ignored files without leaking across cached scopes', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-glob-ignore-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['.git', 'bundle-one', 'bundle-two', 'node_modules/pkg']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(join(root, '.gitignore'), 'bundle-*/\n');
  for (const file of ['visible.txt', 'bundle-one/item.txt', 'bundle-two/item.txt', 'node_modules/pkg/item.txt']) {
    writeFileSync(join(root, file), 'fixture\n');
  }
  for (const window of [
    { sort: 'natural', limit: 100 },
    { sort: 'mtime', limit: 0 },
  ]) {
    const args = { pattern: '**/*.txt', path: root, ...window };
    const before = String(await executeGlobTool({ ...args }, root)).replaceAll('\\', '/');
    assert.match(before, /visible\.txt/);
    assert.doesNotMatch(before, /bundle-(?:one|two)|node_modules/);

    const included = String(await executeGlobTool({ ...args, include_noise: true }, root)).replaceAll('\\', '/');
    for (const file of ['visible.txt', 'bundle-one/item.txt', 'bundle-two/item.txt', 'node_modules/pkg/item.txt']) {
      assert.ok(included.includes(file), `missing ${file} in ${window.sort} result: ${included}`);
    }
    assert.equal(String(await executeGlobTool({ ...args, include_noise: false }, root)).replaceAll('\\', '/'), before);

    const excluded = String(
      await executeGlobTool(
        {
          ...args,
          pattern: ['bundle-*/item.txt', '!bundle-two/**'],
          include_noise: true,
        },
        root
      )
    ).replaceAll('\\', '/');
    assert.match(excluded, /bundle-one\/item\.txt/);
    assert.doesNotMatch(excluded, /bundle-two|visible\.txt|node_modules/);
  }
});
