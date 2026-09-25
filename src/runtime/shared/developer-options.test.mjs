import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The config path is fixed at module load: point it at a scratch dir first.
const dir = mkdtempSync(join(tmpdir(), 'mixdog-developer-options-'));
process.env.MIXDOG_DATA_DIR = dir;
process.env.MIXDOG_CONFIG_READ_TTL_MS = '0';
process.env.MIXDOG_USER_DATA_BACKUP_ROOT = join(dir, 'backups');
delete process.env.MIXDOG_DEV_PROVIDERS;

const { updateSection, readSection } = await import('./config.mjs');
const { DEVELOPER_SECTIONS, developerOptionEnabled, developerSettingsView, normalizeDeveloperConfig } = await import(
  './developer-options.mjs'
);
const cfgMod = await import('../agent/orchestrator/config.mjs');

const storeDeveloper = (developer) => updateSection('agent', (current) => ({ ...current, developer }));

test.after(() => rmSync(dir, { recursive: true, force: true }));

test.afterEach(() => {
  delete process.env.MIXDOG_DEV_PROVIDERS;
  updateSection('agent', (current) => {
    const next = { ...current };
    delete next.developer;
    return next;
  });
});

test('registry: the Providers section holds the Dev providers option', () => {
  assert.deepEqual(
    DEVELOPER_SECTIONS.map((section) => [section.id, section.options.map((option) => [option.id, option.env])]),
    [['providers', [['devProviders', 'MIXDOG_DEV_PROVIDERS']]]]
  );
  assert.ok(Object.isFrozen(DEVELOPER_SECTIONS));
});

test('default off: no env and no stored value', () => {
  assert.equal(developerOptionEnabled('devProviders'), false);
  assert.equal(developerOptionEnabled('unknown'), false);
  assert.deepEqual(developerSettingsView(), {
    sections: [
      {
        id: 'providers',
        label: 'Providers',
        options: [
          {
            id: 'devProviders',
            label: 'Dev providers',
            description: 'Show Cursor OAuth and Antigravity OAuth in Providers and the model picker.',
            env: 'MIXDOG_DEV_PROVIDERS',
            enabled: false,
            envForced: false,
          },
        ],
      },
    ],
  });
});

test('stored config value turns the option on', () => {
  storeDeveloper({ devProviders: true });
  assert.equal(developerOptionEnabled('devProviders'), true);
  const [option] = developerSettingsView().sections[0].options;
  assert.equal(option.enabled, true);
  assert.equal(option.envForced, false);
  storeDeveloper({ devProviders: false });
  assert.equal(developerOptionEnabled('devProviders'), false);
});

test('a truthy env forces the option on over a stored false; a falsy env defers to config', () => {
  for (const raw of ['1', 'true', 'YES', ' on ']) {
    process.env.MIXDOG_DEV_PROVIDERS = raw;
    storeDeveloper({ devProviders: false });
    assert.equal(developerOptionEnabled('devProviders'), true, raw);
    const [option] = developerSettingsView().sections[0].options;
    assert.equal(option.enabled, true);
    assert.equal(option.envForced, true);
  }
  process.env.MIXDOG_DEV_PROVIDERS = '0';
  assert.equal(developerOptionEnabled('devProviders'), false);
  storeDeveloper({ devProviders: true });
  assert.equal(developerOptionEnabled('devProviders'), true);
  assert.equal(developerSettingsView().sections[0].options[0].envForced, false);
});

test('stored values normalize to booleans only', () => {
  assert.deepEqual(normalizeDeveloperConfig({ devProviders: 'yes', other: true, n: 1 }), { other: true });
  assert.deepEqual(normalizeDeveloperConfig(null), {});
  assert.deepEqual(normalizeDeveloperConfig([true]), {});
});

test('the developer key survives agent config load and save', () => {
  storeDeveloper({ devProviders: true });
  const loaded = cfgMod.loadConfig({ secrets: false });
  assert.deepEqual(loaded.developer, { devProviders: true });
  cfgMod.saveConfig({ ...loaded, profile: { ...loaded.profile, title: 'Dev' } }, { baseConfig: loaded });
  assert.deepEqual(readSection('agent').developer, { devProviders: true });

  const reloaded = cfgMod.loadConfig({ secrets: false });
  cfgMod.saveConfig({ ...reloaded, developer: { devProviders: false } }, { baseConfig: reloaded });
  assert.deepEqual(readSection('agent').developer, { devProviders: false });
  assert.equal(developerOptionEnabled('devProviders'), false);

  // A whole-section save keeps it too.
  const full = cfgMod.loadConfig({ secrets: false });
  cfgMod.saveConfig({ ...full, developer: { devProviders: true } });
  assert.deepEqual(readSection('agent').developer, { devProviders: true });
});
