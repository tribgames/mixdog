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

const { updateSection, readSection } = await import('./config.mjs');
const {
  DEVELOPER_SECTIONS,
  developerOptionEnabled,
  developerOptionForProvider,
  developerSettingsView,
  normalizeDeveloperConfig,
} = await import('./developer-options.mjs');
const cfgMod = await import('../agent/orchestrator/config.mjs');

const storeDeveloper = (developer) => updateSection('agent', (current) => ({ ...current, developer }));

test.after(() => rmSync(dir, { recursive: true, force: true }));

test.afterEach(() => {
  updateSection('agent', (current) => {
    const next = { ...current };
    delete next.developer;
    return next;
  });
});

test('registry: Gemini (Antigravity), Cursor and MiMo are separate provider options with the OAuth risk warning', () => {
  assert.deepEqual(
    DEVELOPER_SECTIONS.map((section) => [
      section.id,
      section.options.map((option) => [option.id, option.label, option.provider]),
    ]),
    [
      [
        'providers',
        [
          ['antigravityOAuth', 'Gemini (Antigravity)', 'antigravity-oauth'],
          ['cursorOAuth', 'Cursor', 'cursor-oauth'],
          ['mimoOAuth', 'MiMo', 'mimo-oauth'],
        ],
      ],
    ]
  );
  for (const option of DEVELOPER_SECTIONS[0].options) {
    assert.match(option.warning, /OAuth carries a high risk of penalties such as account restrictions/);
  }
  assert.equal(developerOptionForProvider('antigravity-oauth').id, 'antigravityOAuth');
  assert.equal(developerOptionForProvider('cursor-oauth').id, 'cursorOAuth');
  assert.equal(developerOptionForProvider('mimo-oauth').id, 'mimoOAuth');
  assert.equal(developerOptionForProvider('muse-code-oauth'), null);
  assert.equal(developerOptionForProvider('openai-oauth'), null);
  assert.ok(Object.isFrozen(DEVELOPER_SECTIONS));
});

test('default off: no stored value', () => {
  assert.equal(developerOptionEnabled('antigravityOAuth'), false);
  assert.equal(developerOptionEnabled('cursorOAuth'), false);
  assert.equal(developerOptionEnabled('mimoOAuth'), false);
  assert.equal(developerOptionEnabled('unknown'), false);
  const warning = 'Using this provider through OAuth carries a high risk of penalties such as account restrictions.';
  assert.deepEqual(developerSettingsView(), {
    sections: [
      {
        id: 'providers',
        label: 'Providers',
        description: warning,
        options: [
          {
            id: 'antigravityOAuth',
            label: 'Gemini (Antigravity)',
            description: 'Show Antigravity (Gemini) OAuth in Providers and the model picker.',
            warning,
            provider: 'antigravity-oauth',
            enabled: false,
          },
          {
            id: 'cursorOAuth',
            label: 'Cursor',
            description: 'Show Cursor OAuth in Providers and the model picker.',
            warning,
            provider: 'cursor-oauth',
            enabled: false,
          },
          {
            id: 'mimoOAuth',
            label: 'MiMo',
            description: 'Show Xiaomi MiMo OAuth in Providers and the model picker.',
            warning,
            provider: 'mimo-oauth',
            enabled: false,
          },
        ],
      },
    ],
  });
});

test('each stored value turns only its own option on', () => {
  storeDeveloper({ cursorOAuth: true });
  assert.equal(developerOptionEnabled('cursorOAuth'), true);
  assert.equal(developerOptionEnabled('antigravityOAuth'), false);
  assert.deepEqual(
    developerSettingsView().sections[0].options.map((option) => [option.id, option.enabled]),
    [
      ['antigravityOAuth', false],
      ['cursorOAuth', true],
      ['mimoOAuth', false],
    ]
  );
  storeDeveloper({ cursorOAuth: false, antigravityOAuth: true });
  assert.equal(developerOptionEnabled('cursorOAuth'), false);
  assert.equal(developerOptionEnabled('antigravityOAuth'), true);
});

test('stored values normalize to booleans only', () => {
  assert.deepEqual(normalizeDeveloperConfig({ cursorOAuth: 'yes', other: true, n: 1 }), { other: true });
  assert.deepEqual(normalizeDeveloperConfig(null), {});
  assert.deepEqual(normalizeDeveloperConfig([true]), {});
});

test('the developer key survives agent config load and save', () => {
  storeDeveloper({ cursorOAuth: true });
  const loaded = cfgMod.loadConfig({ secrets: false });
  assert.deepEqual(loaded.developer, { cursorOAuth: true });
  cfgMod.saveConfig({ ...loaded, profile: { ...loaded.profile, title: 'Dev' } }, { baseConfig: loaded });
  assert.deepEqual(readSection('agent').developer, { cursorOAuth: true });

  const reloaded = cfgMod.loadConfig({ secrets: false });
  cfgMod.saveConfig({ ...reloaded, developer: { cursorOAuth: false } }, { baseConfig: reloaded });
  assert.deepEqual(readSection('agent').developer, { cursorOAuth: false });
  assert.equal(developerOptionEnabled('cursorOAuth'), false);

  // A whole-section save keeps it too.
  const full = cfgMod.loadConfig({ secrets: false });
  cfgMod.saveConfig({ ...full, developer: { cursorOAuth: true } });
  assert.deepEqual(readSection('agent').developer, { cursorOAuth: true });
});
