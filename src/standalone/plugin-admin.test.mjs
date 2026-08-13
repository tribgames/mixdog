import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { addPlugin, listRegisteredPlugins } from './plugin-admin.mjs';

test('plugin registry persists atomically with owner-only permissions', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-plugin-registry-'));
  const source = join(root, 'local-plugin');
  const dataDir = join(root, 'data');
  try {
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'plugin.json'), JSON.stringify({ name: 'local-test' }));
    addPlugin(source, { dataDir });

    const registryPath = join(dataDir, 'plugins', 'registry.json');
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    assert.equal(registry.plugins.length, 1);
    assert.equal(listRegisteredPlugins({ dataDir })[0].name, 'local-test');
    if (process.platform !== 'win32') {
      assert.equal(statSync(registryPath).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
