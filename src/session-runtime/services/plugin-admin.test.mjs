import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test, { mock } from 'node:test';
import * as realFs from 'node:fs';

import { _publishManagedPluginRoot, addPlugin, listRegisteredPlugins, setPluginEnabled } from './plugin-admin.mjs';
import { hookConfigEntries } from './hook-bus/config.mjs';

// A fresh copy of plugin-admin over a wrapped `node:fs`: the wrapper lets a
// test act between the module's own fs calls (a swap right after a directory
// listing, an EPERM on the first rmSync) without touching the other tests.
const seams = { afterListing: null, failFirstRm: null };
const { default: _realFsDefault, ...realFsNamed } = realFs;
mock.module('node:fs', {
  namedExports: {
    ...realFsNamed,
    readdirSync(path, ...rest) {
      const listing = realFs.readdirSync(path, ...rest);
      if (seams.afterListing?.path === String(path)) {
        const { action } = seams.afterListing;
        seams.afterListing = null;
        action();
      }
      return listing;
    },
    rmSync(path, ...rest) {
      if (seams.failFirstRm === String(path)) {
        seams.failFirstRm = null;
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      }
      return realFs.rmSync(path, ...rest);
    },
  },
});
const { _publishManagedPluginRoot: publishWithSeams } = await import(
  `${new URL('./plugin-admin.mjs', import.meta.url).href}?fs-seams`
);

test('plugin registry persists atomically with owner-only permissions', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-plugin-registry-'));
  const source = join(root, 'local-plugin');
  const dataDir = join(root, 'data');
  try {
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'plugin.json'), JSON.stringify({ name: 'local-test' }));
    const added = addPlugin(source, { dataDir });

    const registryPath = join(dataDir, 'plugins', 'registry.json');
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    assert.equal(registry.plugins.length, 1);
    assert.equal(listRegisteredPlugins({ dataDir })[0].name, 'local-test');
    assert.equal(listRegisteredPlugins({ dataDir })[0].enabled, true);
    assert.equal(
      hookConfigEntries(dataDir, root).some((entry) => entry.sourceType === 'plugin'),
      true
    );
    setPluginEnabled('local-test', false, { dataDir });
    assert.equal(listRegisteredPlugins({ dataDir })[0].enabled, false);
    assert.equal(
      hookConfigEntries(dataDir, root).some((entry) => entry.sourceType === 'plugin'),
      false
    );
    const updated = addPlugin(source, { dataDir });
    assert.equal(updated.id, added.id);
    assert.equal(updated.installedAt, added.installedAt);
    assert.equal(updated.enabled, false);
    assert.equal(listRegisteredPlugins({ dataDir }).length, 1);
    if (process.platform !== 'win32') {
      assert.equal(statSync(registryPath).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('plugin Git sources reject insecure transport and embedded credentials', () => {
  assert.throws(() => addPlugin('http://plugins.example.test/example.git'), /must use HTTPS or SSH/);
  assert.throws(() => addPlugin('https://token@plugins.example.test/example.git'), /must not contain credentials/);
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

test('managed plugin publish removes a backup holding read-only git pack files', () => {
  const base = mkdtempSync(join(tmpdir(), 'mixdog-plugin-readonly-'));
  const root = join(base, 'plugin');
  const pack = join(root, '.git', 'objects', 'pack', 'pack-x.pack');
  const outside = join(base, 'outside');
  const outsideFile = join(outside, 'keep.txt');
  const makeNext = (name) => {
    const next = join(base, name);
    mkdirSync(next);
    writeFileSync(join(next, 'version.txt'), name);
    return next;
  };
  try {
    mkdirSync(join(root, '.git', 'objects', 'pack'), { recursive: true });
    writeFileSync(pack, 'pack');
    chmodSync(pack, 0o444);
    // A link to a read-only file outside the plugin must not have its mode changed.
    mkdirSync(outside);
    writeFileSync(outsideFile, 'outside');
    chmodSync(outsideFile, 0o444);
    symlinkSync(outside, join(root, 'link'), 'junction');
    const outsideMode = statSync(outsideFile).mode;

    _publishManagedPluginRoot(root, makeNext('first'));
    assert.equal(existsSync(`${root}.backup`), false);
    assert.equal(statSync(outsideFile).mode, outsideMode);
    assert.equal(readFileSync(outsideFile, 'utf8'), 'outside');
    assert.equal(readFileSync(join(root, 'version.txt'), 'utf8'), 'first');

    assert.doesNotThrow(() => _publishManagedPluginRoot(root, makeNext('second')));
    assert.equal(readFileSync(join(root, 'version.txt'), 'utf8'), 'second');
  } finally {
    try {
      chmodSync(outsideFile, 0o666);
    } catch {}
    try {
      chmodSync(pack, 0o666);
    } catch {}
    try {
      chmodSync(join(`${root}.backup`, '.git', 'objects', 'pack', 'pack-x.pack'), 0o666);
    } catch {}
    rmSync(base, { recursive: true, force: true });
  }
});

test('managed plugin publish never deletes through a link into an outside folder', () => {
  const base = mkdtempSync(join(tmpdir(), 'mixdog-plugin-link-'));
  const root = join(base, 'plugin');
  const outside = join(base, 'outside');
  const next = join(base, 'next');
  try {
    mkdirSync(root);
    mkdirSync(next);
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'outside');
    symlinkSync(outside, join(root, 'link'), 'junction');

    _publishManagedPluginRoot(root, next);
    assert.equal(existsSync(`${root}.backup`), false);
    assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'outside');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('EPERM recovery never changes the mode of a file that has another hard link', () => {
  const base = mkdtempSync(join(tmpdir(), 'mixdog-plugin-hardlink-'));
  const root = join(base, 'plugin');
  const outsideFile = join(base, 'outside.txt');
  const next = join(base, 'next');
  try {
    mkdirSync(root);
    mkdirSync(next);
    writeFileSync(outsideFile, 'outside');
    chmodSync(outsideFile, 0o444);
    linkSync(outsideFile, join(root, 'linked.txt'));
    const outsideMode = statSync(outsideFile).mode;

    seams.failFirstRm = `${root}.backup`;
    // Where the platform refuses to unlink the read-only name, the failure stays
    // swallowed by the publish; either way the outside name must be untouched.
    publishWithSeams(root, next);
    assert.equal(seams.failFirstRm, null, 'the injected EPERM was not reached');
    assert.equal(statSync(outsideFile).mode, outsideMode);
    assert.equal(readFileSync(outsideFile, 'utf8'), 'outside');
  } finally {
    seams.failFirstRm = null;
    try {
      chmodSync(outsideFile, 0o666);
    } catch {}
    try {
      chmodSync(join(`${root}.backup`, 'linked.txt'), 0o666);
    } catch {}
    rmSync(base, { recursive: true, force: true });
  }
});

test('a directory swapped for a link after it was listed is detached, not entered', () => {
  const base = mkdtempSync(join(tmpdir(), 'mixdog-plugin-swap-'));
  const root = join(base, 'plugin');
  const outside = join(base, 'outside');
  const elsewhere = join(base, 'elsewhere');
  const next = join(base, 'next');
  try {
    mkdirSync(join(root, 'sub'), { recursive: true });
    mkdirSync(next);
    mkdirSync(outside);
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(outside, 'inner'), 'junction');

    seams.afterListing = {
      path: `${root}.backup`,
      action: () => {
        rmSync(join(`${root}.backup`, 'sub'), { recursive: true });
        symlinkSync(outside, join(`${root}.backup`, 'sub'), 'junction');
      },
    };
    publishWithSeams(root, next);
    assert.equal(seams.afterListing, null, 'the swap was not reached');
    assert.equal(lstatSync(join(outside, 'inner')).isSymbolicLink(), true);
    assert.equal(existsSync(elsewhere), true);
    assert.equal(existsSync(`${root}.backup`), false);
  } finally {
    seams.afterListing = null;
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
  const atomicUrl = new URL('../../runtime/shared/atomic-file.mjs', import.meta.url).href;
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
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
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
      listRegisteredPlugins({ dataDir })
        .map((plugin) => plugin.name)
        .sort(),
      ['child-plugin', 'parent-plugin']
    );
  } finally {
    if (child.exitCode === null) child.kill();
    await exited.catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

// A damaged registry never blocks the plugin features: its bytes are kept
// aside (never overwritten) and the registry continues from the last good copy
// (registry.json.bak) or empty.
for (const [name, damaged] of [
  ['malformed', '{corrupt'],
  ['NUL-filled', '\0'.repeat(96)],
  ['empty', ''],
]) {
  test(`a ${name} plugin registry is kept aside and plugins keep working`, () => {
    const root = mkdtempSync(join(tmpdir(), 'mixdog-plugin-corrupt-'));
    const source = join(root, 'local-plugin');
    const dataDir = join(root, 'data');
    const registry = join(dataDir, 'plugins', 'registry.json');
    try {
      mkdirSync(source, { recursive: true });
      mkdirSync(join(dataDir, 'plugins'), { recursive: true });
      writeFileSync(join(source, 'plugin.json'), JSON.stringify({ name: 'local-test' }));
      writeFileSync(registry, damaged);
      assert.deepEqual(listRegisteredPlugins({ dataDir }), []);
      const added = addPlugin(source, { dataDir });
      assert.equal(added.name, 'local-test');
      assert.equal(listRegisteredPlugins({ dataDir }).length, 1);
      const aside = readdirSync(join(dataDir, 'plugins')).filter((file) => file.startsWith('registry.json.corrupt-'));
      assert.equal(aside.length, 1);
      assert.equal(readFileSync(join(dataDir, 'plugins', aside[0]), 'utf8'), damaged);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('a damaged plugin registry is restored from its last good copy', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-plugin-restore-'));
  const source = join(root, 'local-plugin');
  const dataDir = join(root, 'data');
  const registry = join(dataDir, 'plugins', 'registry.json');
  try {
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'plugin.json'), JSON.stringify({ name: 'local-test' }));
    addPlugin(source, { dataDir });
    setPluginEnabled('local-test', false, { dataDir }); // the write keeps the replaced copy as registry.json.bak
    writeFileSync(registry, '\0'.repeat(96));
    const [plugin] = listRegisteredPlugins({ dataDir });
    assert.equal(plugin.name, 'local-test');
    assert.equal(JSON.parse(readFileSync(registry, 'utf8')).plugins.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
