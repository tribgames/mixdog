import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { providerSetupHasUsableProvider } from './app-format.mjs';
import { providerStatusFooter } from './provider-setup/provider-items.mjs';

// One "usable provider" rule for every TUI surface, per the provider setup
// contract: OAuth and local rows carry `usable` themselves; API-key rows carry
// no `usable`, and only a credential (`authenticated`) makes them usable —
// `enabled` alone is the "No Key" state.
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

// The rows of a custom provider with an invalid stored config, and of the same entry once valid, as Node's
// provider setup (session-runtime/services/provider-admin.mjs `providerSetup`) answered them at b6f10295a.
const recorded = JSON.parse(readFileSync(new URL('./provider-usable-golden/node-rows.golden.json', import.meta.url), 'utf8'));

test('a custom provider with an invalid stored config is never ready on any TUI surface', () => {
  const row = recorded.invalid;
  assert.ok(row.configError);
  assert.equal(row.usable, false);
  assert.equal(row.authenticated, false);
  const only = { api: [row], oauth: [], local: [] };
  assert.equal(providerSetupHasUsableProvider(only), false);
  assert.equal(providerStatusFooter(row)[0].glyph, '○');
  assert.match(providerStatusFooter(row)[0].text, /Invalid config/);
});

test('the same custom provider, once its config is valid, is ready', () => {
  assert.equal(providerSetupHasUsableProvider({ api: [recorded.valid], oauth: [], local: [] }), true);
  assert.equal(providerStatusFooter(recorded.valid)[0].glyph, '●');
});
