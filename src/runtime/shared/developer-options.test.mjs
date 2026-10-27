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
      ['approvals', [['allowAllActions', 'Allow all actions', undefined]]],
      [
        'providers',
        [
          ['antigravityOAuth', 'Gemini (Antigravity)', 'antigravity-oauth'],
          ['cursorOAuth', 'Cursor', 'cursor-oauth'],
          ['devinOAuth', 'Devin', 'devin-oauth'],
          ['mimoOAuth', 'MiMo', 'mimo-oauth'],
        ],
      ],
      ['remote', [['directPhoneConnection', 'Direct phone connection (test)', undefined]]],
    ]
  );
  for (const option of DEVELOPER_SECTIONS.find((section) => section.id === 'providers').options) {
    assert.match(option.warning, /OAuth carries a high risk of penalties such as account restrictions/);
  }
  assert.equal(developerOptionForProvider('antigravity-oauth').id, 'antigravityOAuth');
  assert.equal(developerOptionForProvider('cursor-oauth').id, 'cursorOAuth');
  assert.equal(developerOptionForProvider('devin-oauth').id, 'devinOAuth');
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
        id: 'approvals',
        label: 'Approvals',
        options: [
          {
            id: 'allowAllActions',
            label: 'Allow all actions',
            description: 'Skips the approval cards for every action except payments and permanent deletes.',
            warning:
              'Turning this on lets agents act without asking you first, except for payments and permanent deletes. Use it only if you accept that risk.',
            enabled: false,
          },
        ],
      },
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
            id: 'devinOAuth',
            label: 'Devin',
            description: 'Show Devin OAuth in Providers and the model picker.',
            warning,
            provider: 'devin-oauth',
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
      {
        id: 'remote',
        label: 'Remote',
        options: [
          {
            id: 'directPhoneConnection',
            label: 'Direct phone connection (test)',
            description:
              'Lets a paired phone talk to this PC directly instead of through the relay. Takes effect after you restart Mixdog.',
            warning:
              'Experimental: the direct phone connection is still being tested and may make the phone connection less reliable. Restart Mixdog after changing it.',
            enabled: false,
          },
        ],
      },
    ],
  });
});

test('Direct phone connection is off by default and on only while stored true', () => {
  assert.equal(developerOptionEnabled('directPhoneConnection'), false);
  storeDeveloper({ directPhoneConnection: true });
  assert.equal(developerOptionEnabled('directPhoneConnection'), true);
  storeDeveloper({ directPhoneConnection: 'yes' });
  assert.equal(developerOptionEnabled('directPhoneConnection'), false);
});

test('Allow all actions is a warned, provider-less option that is on only while stored true', () => {
  assert.equal(developerOptionEnabled('allowAllActions'), false);
  storeDeveloper({ allowAllActions: true });
  assert.equal(developerOptionEnabled('allowAllActions'), true);
  assert.equal(developerOptionEnabled('cursorOAuth'), false);
  const approvals = developerSettingsView().sections.find((section) => section.id === 'approvals');
  const [option] = approvals.options;
  assert.equal(option.id, 'allowAllActions');
  assert.equal(option.enabled, true);
  assert.match(option.warning, /payments and permanent deletes/);
  assert.equal('provider' in option, false);
  storeDeveloper({ allowAllActions: 'yes' });
  assert.equal(developerOptionEnabled('allowAllActions'), false, 'only a stored boolean true turns it on');
});

test('each stored value turns only its own option on', () => {
  storeDeveloper({ cursorOAuth: true });
  assert.equal(developerOptionEnabled('cursorOAuth'), true);
  assert.equal(developerOptionEnabled('antigravityOAuth'), false);
  assert.deepEqual(
    developerSettingsView()
      .sections.find((section) => section.id === 'providers')
      .options.map((option) => [option.id, option.enabled]),
    [
      ['antigravityOAuth', false],
      ['cursorOAuth', true],
      ['devinOAuth', false],
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
