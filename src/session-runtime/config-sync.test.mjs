import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SOURCE = `
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve } from 'node:path';
import * as cfgMod from './src/runtime/agent/orchestrator/config.mjs';
import * as sharedCfgMod from './src/runtime/shared/config.mjs';
import { createConfigLifecycle } from './src/session-runtime/config-lifecycle.mjs';

function runtime() {
  let config = cfgMod.loadConfig();
  let route = null;
  let hasSecrets = true;
  let reloads = 0;
  const lifecycle = createConfigLifecycle({
    getConfig: () => config,
    setConfig: (next) => { config = next; },
    getWebSearchRoute: () => route,
    setWebSearchRoute: (next) => { route = next; },
    getConfigHasSecrets: () => hasSecrets,
    setConfigHasSecrets: (next) => { hasSecrets = next; },
    getRoute: () => ({ provider: 'demo' }),
    cfgMod,
    sharedCfgMod,
    setConfiguredShell() {},
    normalizeSystemShellConfig: () => ({ command: '' }),
    normalizeWebSearchRouteConfig: (value) => value || null,
    outputStyleStatus: () => ({}),
    LAZY_SECRET_PROVIDERS: new Set(),
    clean: (value) => String(value || '').trim(),
    resolve,
    onConfigReloaded: () => { reloads += 1; },
    STANDALONE_DATA_DIR: process.cwd(),
  });
  return { lifecycle, config: () => config, route: () => route, reloads: () => reloads };
}

const a = runtime();
const b = runtime();

// B holds an unsaved edit while A persists profile / autoClear / webSearchRoute.
b.lifecycle.saveConfigAndAdopt({ ...b.config(), compaction: { ...b.config().compaction, auto: false } });
const aNext = {
  ...a.config(),
  profile: { ...a.config().profile, title: 'Alice' },
  autoClear: { enabled: false },
  webSearchRoute: { provider: 'openai', model: 'gpt-x' },
};
a.lifecycle.saveConfigAndAdopt(aNext);
await a.lifecycle.flushAllConfigSavesAsync();
await sleep(500);

assert.equal(b.config().profile.title, 'Alice');
assert.equal(b.config().autoClear.enabled, false);
assert.deepEqual(b.config().webSearchRoute, a.config().webSearchRoute);
assert.deepEqual(b.route(), a.route());
assert.ok(b.reloads() >= 1);
// B's own edit survived the reload and reaches disk without dropping A's change.
assert.equal(b.config().compaction.auto, false);
await b.lifecycle.flushAllConfigSavesAsync();
const disk = cfgMod.loadConfig();
assert.equal(disk.compaction.auto, false);
assert.equal(disk.profile.title, 'Alice');

// Disposed runtimes stop reloading.
b.lifecycle.disposeConfigSync();
const before = b.reloads();
a.lifecycle.saveConfigAndAdopt({ ...a.config(), autoClear: { enabled: true } });
await a.lifecycle.flushAllConfigSavesAsync();
await sleep(400);
assert.equal(b.reloads(), before);
assert.equal(b.config().autoClear.enabled, false);
a.lifecycle.disposeConfigSync();
`;

test('a config saved by one runtime is visible to another without restart, keeping its pending edit', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-config-sync-'));
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', SOURCE], {
      cwd: repoRoot,
      env: {
        ...process.env,
        MIXDOG_DATA_DIR: dataDir,
        MIXDOG_CONFIG_READ_TTL_MS: '0',
        MIXDOG_USER_DATA_BACKUP_ROOT: join(dataDir, 'backups'),
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
