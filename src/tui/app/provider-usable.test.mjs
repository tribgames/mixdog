import assert from 'node:assert/strict';
import test from 'node:test';
import { providerSetupHasUsableProvider } from './app-format.mjs';
import { buildDoctorReport } from './doctor.mjs';
import { providerStatusFooter } from './provider-setup/provider-items.mjs';

// One "usable provider" rule for every TUI surface, per the provider setup
// contract (provider-admin.mjs providerSetup): OAuth and local rows carry
// `usable` themselves; API-key rows carry no `usable`, and only a credential
// (`authenticated`) makes them usable — `enabled` alone is the "No Key" state.
const ROWS = [
  [{ id: 'openai', type: 'api-key', enabled: true, authenticated: true, stored: true, env: false }, true],
  [{ id: 'anthropic', type: 'api-key', enabled: true, authenticated: false, stored: false, env: false }, false],
  [{ id: 'gemini', type: 'api-key', enabled: false, authenticated: false, stored: false, env: false }, false],
  [
    { id: 'anthropic-oauth', type: 'oauth', enabled: true, authenticated: true, usable: true, reauthRequired: false },
    true,
  ],
  [
    { id: 'grok-oauth', type: 'oauth', enabled: true, authenticated: true, usable: false, reauthRequired: false },
    false,
  ],
  [
    { id: 'openai-oauth', type: 'oauth', enabled: false, authenticated: false, usable: false, reauthRequired: true },
    false,
  ],
  [{ id: 'mixdog-local', type: 'local', enabled: true, detected: true, authenticated: true, usable: true }, true],
  [{ id: 'mixdog-local', type: 'local', enabled: false, detected: true, authenticated: true, usable: false }, false],
];

const setupWith = (row) => ({
  api: row.type === 'api-key' ? [row] : [],
  oauth: row.type === 'oauth' ? [row] : [],
  local: row.type === 'local' ? [row] : [],
});

test('the welcome-hint probe counts a provider as usable only per the setup contract', () => {
  for (const [row, usable] of ROWS) {
    assert.equal(providerSetupHasUsableProvider(setupWith(row)), usable, `${row.id} ${JSON.stringify(row)}`);
  }
});

test('the provider setup footer marks a provider active only per the same rule', () => {
  for (const [row, usable] of ROWS) {
    assert.equal(providerStatusFooter(row)[0].glyph, usable ? '●' : '○', `${row.id} ${JSON.stringify(row)}`);
  }
});

test('a custom provider with an invalid stored config is never ready on any TUI surface', async () => {
  // The real service row (provider-admin providerSetup), keyless so it would
  // otherwise count as authenticated.
  const { providerSetup } = await import('../../session-runtime/services/provider-admin.mjs');
  const id = 'custom-0b7e1c2a-3d4f-4a5b-8c6d-7e8f9a0b1c2d';
  const entry = {
    type: 'custom',
    schemaVersion: 2,
    name: 'Broken',
    protocol: 'openai-chat',
    baseURL: 'https://gw.example.com/v1',
    enabled: true,
    auth: 'none',
    modelOverrides: { m: { contextWindow: '4096' } },
  };
  const setup = await providerSetup({ providers: { [id]: entry } }, { checkSecrets: false });
  const row = setup.api.find((r) => r.id === id);
  assert.ok(row.configError);
  assert.equal(row.usable, false);
  assert.equal(row.authenticated, false);
  const only = { api: [row], oauth: [], local: [] };
  assert.equal(providerSetupHasUsableProvider(only), false);
  assert.equal(providerStatusFooter(row)[0].glyph, '○');
  assert.match(providerStatusFooter(row)[0].text, /Invalid config/);
  const report = await buildDoctorReport({ getProviderSetup: () => only }, () => ({ provider: id }));
  const line = report.split('\n').find((l) => l.includes(' providers: '));
  assert.match(line, /^✗ providers: route .* has an invalid configuration \(.*contextWindow.*\) · 0 ready/);
  // The same entry, once valid, is ready.
  const fixed = await providerSetup(
    { providers: { [id]: { ...entry, modelOverrides: { m: { contextWindow: 4096 } } } } },
    { checkSecrets: false }
  );
  assert.equal(
    providerSetupHasUsableProvider({ api: fixed.api.filter((r) => r.id === id), oauth: [], local: [] }),
    true
  );
});

test('/doctor reports the active route ready only per the same rule', async () => {
  for (const [row, usable] of ROWS) {
    const report = await buildDoctorReport({ getProviderSetup: () => setupWith(row) }, () => ({ provider: row.id }));
    const line = report.split('\n').find((entry) => entry.includes(' providers: '));
    assert.equal(line.startsWith('✓'), usable, `${row.id} ${line}`);
  }
});
