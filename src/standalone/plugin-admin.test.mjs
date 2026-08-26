import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';

import {
  _publishManagedPluginRoot,
  addPlugin,
  listRegisteredPlugins,
  setPluginEnabled,
} from './plugin-admin.mjs';
import { hookConfigEntries } from './hook-bus/config.mjs';

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
    assert.equal(listRegisteredPlugins({ dataDir })[0].enabled, true);
    assert.equal(hookConfigEntries(dataDir, root).some((entry) => entry.sourceType === 'plugin'), true);
    setPluginEnabled('local-test', false, { dataDir });
    assert.equal(listRegisteredPlugins({ dataDir })[0].enabled, false);
    assert.equal(hookConfigEntries(dataDir, root).some((entry) => entry.sourceType === 'plugin'), false);
    if (process.platform !== 'win32') {
      assert.equal(statSync(registryPath).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('plugin Git sources reject insecure transport and embedded credentials', () => {
  assert.throws(
    () => addPlugin('http://plugins.example.test/example.git'),
    /must use HTTPS or SSH/,
  );
  assert.throws(
    () => addPlugin('https://token@plugins.example.test/example.git'),
    /must not contain credentials/,
  );
});

test('managed plugin publish rolls back the previous install on replacement failure', () => {
  const base = mkdtempSync(join(tmpdir(), 'mixdog-plugin-publish-'));
  const root = join(base, 'plugin');
  const missing = join(base, 'missing');
  try {
    mkdirSync(root);
    writeFileSync(join(root, 'version.txt'), 'old');
    assert.throws(() => _publishManagedPluginRoot(root, missing), /ENOENT|no such file/i);
    assert.equal(readFileSync(join(root, 'version.txt'), 'utf8'), 'old');
    assert.equal(existsSync(`${root}.backup`), false);

    const next = join(base, 'next');
    mkdirSync(next);
    writeFileSync(join(next, 'version.txt'), 'new');
    _publishManagedPluginRoot(root, next);
    assert.equal(readFileSync(join(root, 'version.txt'), 'utf8'), 'new');
    assert.equal(existsSync(`${root}.backup`), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('plugin registry mutation re-reads under the cross-process lock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-plugin-concurrent-'));
  const childSource = join(root, 'child-plugin');
  const parentSource = join(root, 'parent-plugin');
  const dataDir = join(root, 'data');
  const registry = join(dataDir, 'plugins', 'registry.json');
  const marker = join(root, 'locked');
  mkdirSync(childSource);
  mkdirSync(parentSource);
  writeFileSync(join(childSource, 'plugin.json'), JSON.stringify({ name: 'child-plugin' }));
  writeFileSync(join(parentSource, 'plugin.json'), JSON.stringify({ name: 'parent-plugin' }));
  const atomicUrl = new URL('../runtime/shared/atomic-file.mjs', import.meta.url).href;
  const script = `
    import { mkdirSync, writeFileSync } from 'node:fs';
    import { dirname } from 'node:path';
    import { withFileLockSync, writeJsonAtomicSync } from ${JSON.stringify(atomicUrl)};
    const registry = process.env.MIXDOG_TEST_REGISTRY;
    const marker = process.env.MIXDOG_TEST_MARKER;
    const source = process.env.MIXDOG_TEST_SOURCE;
    mkdirSync(dirname(registry), { recursive: true });
    withFileLockSync(registry + '.lock', () => {
      writeFileSync(marker, 'locked');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      writeJsonAtomicSync(registry, {
        version: 1,
        plugins: [{
          id: 'child-plugin',
          source,
          sourceType: 'local',
          root: source,
          managed: false,
          name: 'child-plugin',
          title: 'child-plugin',
        }],
      }, { lock: false, secret: true, fsyncDir: true });
    }, { secret: true });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: {
      ...process.env,
      MIXDOG_TEST_REGISTRY: registry,
      MIXDOG_TEST_MARKER: marker,
      MIXDOG_TEST_SOURCE: childSource,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `child exited ${code}`));
    });
  });
  try {
    for (let attempt = 0; attempt < 200 && !existsSync(marker); attempt += 1) {
      await sleep(10);
    }
    assert.equal(existsSync(marker), true, stderr || 'child did not acquire registry lock');
    addPlugin(parentSource, { dataDir });
    await exited;
    assert.deepEqual(
      listRegisteredPlugins({ dataDir }).map((plugin) => plugin.name).sort(),
      ['child-plugin', 'parent-plugin'],
    );
  } finally {
    if (child.exitCode === null) child.kill();
    await exited.catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test('plugin registry corruption fails closed without overwriting evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-plugin-corrupt-'));
  const source = join(root, 'local-plugin');
  const dataDir = join(root, 'data');
  const registry = join(dataDir, 'plugins', 'registry.json');
  try {
    mkdirSync(source, { recursive: true });
    mkdirSync(join(dataDir, 'plugins'), { recursive: true });
    writeFileSync(join(source, 'plugin.json'), JSON.stringify({ name: 'local-test' }));
    writeFileSync(registry, '{corrupt');
    assert.throws(() => addPlugin(source, { dataDir }), /registry is corrupt/);
    assert.equal(readFileSync(registry, 'utf8'), '{corrupt');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
