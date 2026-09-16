import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import {
  TIDY_CORE_ENGINE_IDS,
  installTidyCoreEngines,
  resetTidyInstallStatus,
  tidyEngineStatus,
  tidyInstallStatus,
} from './core-install.mjs';
import { platformAssetKey } from './install.mjs';

const NO_PATH_ENV = { PATH: '', Path: '' };

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'tidy-core-install-'));
  t.after(() => {
    resetTidyInstallStatus();
    rmSync(root, { recursive: true, force: true });
  });
  resetTidyInstallStatus();
  return root;
}

function coreManifest(sha256 = 'a'.repeat(64)) {
  const engines = {};
  for (const id of TIDY_CORE_ENGINE_IDS) {
    engines[id] = {
      version: '1.2.3',
      license: 'MIT',
      kind: ['format'],
      languages: ['bash'],
      assets: {
        [id === 'psscriptanalyzer' ? 'any' : platformAssetKey()]: {
          url: `https://example.invalid/${id}`,
          sha256,
          archive: 'none',
          binPath: id,
        },
      },
    };
  }
  return { version: 1, engines };
}

/** Pretend an engine version is already installed under the managed tools dir. */
function managedInstall(root, id, version = '1.2.3', body = 'binary') {
  const dir = join(root, 'tools', id, version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, id), body);
  return dir;
}

test('the core install skips what is present, survives one failure, and reports each engine', async (t) => {
  const root = workspace(t);
  managedInstall(root, 'shfmt');
  const calls = [];
  const midFlight = [];
  const result = await installTidyCoreEngines({
    pluginData: root,
    manifest: coreManifest(),
    env: NO_PATH_ENV,
    installEngines: async (options) => {
      calls.push(options);
      options.onProgress({ id: 'biome', receivedBytes: 25, totalBytes: 100 });
      midFlight.push(tidyInstallStatus());
      return {
        installed: [
          { id: 'biome', version: '1.2.3', status: 'installed', bytes: 100 },
          { id: 'ruff', version: '1.2.3', status: 'installed', bytes: 100 },
        ],
        errors: [{ id: 'shellcheck', error: 'HTTP 503 for https://example.invalid/shellcheck' }],
        needsApproval: null,
      };
    },
  });

  // Present (managed) and host-less engines never reach the installer.
  assert.deepEqual(calls.length, 1);
  assert.deepEqual(calls[0].ids, ['biome', 'ruff', 'shellcheck']);
  assert.equal(calls[0].approveDownloads, true);
  assert.equal(calls[0].policy, 'auto');

  assert.equal(result.toolsDir, join(root, 'tools'));
  const byId = new Map(result.engines.map((engine) => [engine.id, engine]));
  assert.deepEqual(
    result.engines.map((engine) => engine.id),
    [...TIDY_CORE_ENGINE_IDS]
  );
  assert.equal(byId.get('biome').status, 'installed');
  assert.equal(byId.get('ruff').status, 'installed');
  assert.equal(byId.get('shfmt').status, 'present');
  assert.ok(byId.get('shfmt').bytes > 0, 'a present managed engine reports its on-disk size');
  assert.equal(byId.get('shellcheck').status, 'failed');
  assert.match(byId.get('shellcheck').error, /HTTP 503/);
  // No PowerShell host on this PATH: skipped with its hint, never an error.
  assert.equal(byId.get('psscriptanalyzer').status, 'skipped');
  assert.match(byId.get('psscriptanalyzer').installHint, /pwsh|powershell/);

  // Progress is observable while the install runs, and finishes at 100.
  assert.equal(midFlight[0].active, true);
  assert.ok(midFlight[0].percent > 0 && midFlight[0].percent < 100);
  assert.equal(midFlight[0].engines.find((engine) => engine.id === 'biome').receivedBytes, 25);
  const final = tidyInstallStatus();
  assert.equal(final.active, false);
  assert.equal(final.percent, 100);
  assert.equal(final.engines.filter((engine) => engine.status === 'failed').length, 1);
});

test('an installer that throws fails the pending engines instead of the whole call', async (t) => {
  const root = workspace(t);
  const result = await installTidyCoreEngines({
    pluginData: root,
    manifest: coreManifest(),
    env: NO_PATH_ENV,
    installEngines: async () => {
      throw new Error('network is down');
    },
  });
  const statuses = new Map(result.engines.map((engine) => [engine.id, engine.status]));
  assert.equal(statuses.get('biome'), 'failed');
  assert.equal(statuses.get('shellcheck'), 'failed');
  assert.equal(statuses.get('psscriptanalyzer'), 'skipped');
  assert.match(result.engines.find((engine) => engine.id === 'ruff').error, /network is down/);
  assert.equal(tidyInstallStatus().active, false);
});

test('overlapping installs share one job and download each engine exactly once', async (t) => {
  const root = workspace(t);
  const payload = Buffer.from('#!/bin/sh\necho engine\n');
  const manifest = coreManifest(createHash('sha256').update(payload).digest('hex'));
  const fetched = [];
  const options = {
    pluginData: root,
    manifest,
    env: NO_PATH_ENV,
    // The real installer runs here: a second press must not re-enter it.
    fetchFn: async (url) => {
      fetched.push(url);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ok: true, status: 200, headers: { get: () => '' }, body: Readable.from([payload]) };
    },
  };

  const [first, second] = await Promise.all([installTidyCoreEngines(options), installTidyCoreEngines(options)]);

  assert.equal(first, second, 'both callers observe the same install result');
  assert.deepEqual(
    [...fetched].sort(),
    ['biome', 'ruff', 'shellcheck', 'shfmt'].map((id) => `https://example.invalid/${id}`),
    'one download per engine, not one per caller'
  );
  const byId = new Map(first.engines.map((engine) => [engine.id, engine]));
  for (const id of ['biome', 'ruff', 'shfmt', 'shellcheck']) {
    assert.equal(byId.get(id).status, 'installed', `${id} installs once`);
    assert.ok(byId.get(id).bytes > 0);
  }
  assert.equal(byId.get('psscriptanalyzer').status, 'skipped');
  const job = tidyInstallStatus();
  assert.equal(job.active, false);
  assert.equal(job.percent, 100);

  // The job is released: a later install starts a fresh one.
  const again = await installTidyCoreEngines(options);
  assert.notEqual(again, first);
  assert.equal(again.engines.find((engine) => engine.id === 'biome').status, 'present');
  assert.equal(fetched.length, 4, 'an already-installed engine is never downloaded again');
});

test('a polled status memoizes its inventory and never spawns a version probe', async (t) => {
  const root = workspace(t);
  const manifest = coreManifest();
  const env = { ...NO_PATH_ENV };
  const calls = [];
  const resolveEngines = async (options) => {
    calls.push(options);
    return { engines: [], policy: {}, config: {} };
  };

  const first = await tidyEngineStatus({ pluginData: root, manifest, env, resolveEngines });
  const second = await tidyEngineStatus({ pluginData: root, manifest, env, resolveEngines });
  assert.equal(calls.length, 1, 'a second poll inside the TTL reuses the inventory');
  assert.equal(calls[0].probeVersions, false, 'status never runs an engine to read its version');
  assert.equal(typeof calls[0].hostModuleProbe, 'function', 'the PowerShell probe is served from cache');
  assert.deepEqual(first.engines, second.engines);
  assert.notEqual(first.engines, second.engines, 'each caller gets its own copy');

  // An install changes state, so the next poll rebuilds instead of serving the
  // inventory that predates it.
  await installTidyCoreEngines({
    pluginData: root,
    manifest,
    env,
    resolveEngines: async () => ({ engines: [], policy: {}, config: {} }),
    installEngines: async () => ({ installed: [], errors: [], needsApproval: null }),
  });
  const third = await tidyEngineStatus({ pluginData: root, manifest, env, resolveEngines });
  assert.equal(calls.length, 2);
  assert.equal(third.installing.active, false);
});

test('engine status reports managed installs, host gaps, and never downloads', async (t) => {
  const root = workspace(t);
  managedInstall(root, 'biome', '1.2.3', 'biome-binary-bytes');
  const status = await tidyEngineStatus({
    pluginData: root,
    manifest: coreManifest(),
    env: NO_PATH_ENV,
    probeVersions: false,
  });

  assert.equal(status.toolsDir, join(root, 'tools'));
  assert.deepEqual(status.core, [...TIDY_CORE_ENGINE_IDS]);
  assert.equal(status.installing, null);
  assert.equal(
    status.engines.some((engine) => engine.id === 'ast-grep' || engine.id === 'structural'),
    false,
    'structural rules ship in mixdog-graph, not as a tidy engine'
  );

  const byId = new Map(status.engines.map((engine) => [engine.id, engine]));
  const biome = byId.get('biome');
  assert.equal(biome.source, 'managed');
  assert.equal(biome.version, '1.2.3');
  assert.equal(biome.title, 'Biome');
  assert.equal(biome.core, true);
  assert.equal(biome.managed, true);
  assert.equal(biome.toolchain, false);
  assert.ok(biome.bytes > 0);
  assert.deepEqual(biome.kind, ['format', 'lint']);

  const shellcheck = byId.get('shellcheck');
  assert.equal(shellcheck.source, 'missing');
  assert.equal(shellcheck.core, true);
  assert.equal(shellcheck.bytes, undefined, 'a missing engine has nothing on disk');
  assert.match(shellcheck.installHint, /shellcheck/);

  const rustfmt = byId.get('rustfmt');
  assert.equal(rustfmt.source, 'missing');
  assert.equal(rustfmt.toolchain, true);
  assert.equal(rustfmt.core, false);
  assert.match(rustfmt.installHint, /rustup/);
});

test('status carries the last install job so the card can report failures', async (t) => {
  const root = workspace(t);
  managedInstall(root, 'shfmt');
  await installTidyCoreEngines({
    pluginData: root,
    manifest: coreManifest(),
    env: NO_PATH_ENV,
    installEngines: async () => ({
      installed: [{ id: 'biome', version: '1.2.3', status: 'installed', bytes: 10 }],
      errors: [
        { id: 'ruff', error: 'sha256 mismatch' },
        { id: 'shellcheck', error: 'sha256 mismatch' },
      ],
      needsApproval: null,
    }),
  });
  const status = await tidyEngineStatus({
    pluginData: root,
    manifest: coreManifest(),
    env: NO_PATH_ENV,
    probeVersions: false,
  });
  assert.equal(status.installing.active, false);
  assert.equal(status.installing.percent, 100);
  assert.deepEqual(
    status.installing.engines.filter((engine) => engine.status === 'failed').map((engine) => engine.id),
    ['ruff', 'shellcheck']
  );
});
