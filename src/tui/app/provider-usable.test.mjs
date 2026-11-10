import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { providerSetupHasUsableProvider } from './app-format.mjs';
import { setupWith } from './node-oracle/cases.mjs';
import { providerStatusFooter } from './provider-setup/provider-items.mjs';

// One "usable provider" rule for every TUI surface. The rows and what Node's own TUI modules (b6f10295a) answered
// for them — the welcome-hint probe and the setup footer — are recorded by node-oracle/record.mjs; the rows include
// a custom provider with an invalid stored config and the same entry once valid (Node's provider setup rows).
const golden = JSON.parse(readFileSync(new URL('./node-oracle/node-oracle.golden.json', import.meta.url), 'utf8'));

test('the golden is pinned to b6f10295a', () => {
  assert.match(golden.recordedFrom, /^b6f10295a[0-9a-f]{31}$/);
});

test('the welcome-hint probe counts a provider as usable as Node does', () => {
  for (const { row, usable } of golden.providers) {
    assert.equal(providerSetupHasUsableProvider(setupWith(row)), usable, `${row.id} ${JSON.stringify(row)}`);
  }
});

test('the provider setup footer marks a provider as Node does', () => {
  for (const { row, glyph, text } of golden.providers) {
    const [footer] = providerStatusFooter(row);
    assert.deepEqual({ glyph: footer.glyph, text: footer.text }, { glyph, text }, `${row.id} ${JSON.stringify(row)}`);
  }
});

test('a custom provider with an invalid stored config is never ready on any TUI surface', () => {
  const { row, usable, glyph, text } = golden.providers.find((p) => p.row.configError);
  assert.ok(row.configError);
  assert.equal(row.usable, false);
  assert.equal(usable, false);
  assert.equal(glyph, '○');
  assert.match(text, /Invalid config/);
  assert.equal(providerSetupHasUsableProvider({ api: [row], oauth: [], local: [] }), false);
});

test('the same custom provider, once its config is valid, is ready', () => {
  const valid = golden.providers.find((p) => p.row.id.startsWith('custom-') && !p.row.configError);
  assert.equal(valid.usable, true);
  assert.equal(providerSetupHasUsableProvider({ api: [valid.row], oauth: [], local: [] }), true);
  assert.equal(providerStatusFooter(valid.row)[0].glyph, '●');
});
