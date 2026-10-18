import assert from 'node:assert/strict';
import test from 'node:test';
import { hydrateProviderModelRow } from './row-hydration.mjs';

const cfg = {
  providers: {
    'custom-chat': { type: 'custom', protocol: 'openai-chat', enabled: true },
    'custom-responses': { type: 'custom', protocol: 'openai-responses', enabled: true },
    'custom-anthropic': { type: 'custom', protocol: 'anthropic', enabled: true },
  },
};
const LEVELS = ['low', 'medium', 'high'];
const capable = (provider, row) => hydrateProviderModelRow(cfg, { provider, ...row }).autoEffortCapable;

test('autoEffortCapable: custom Chat/Responses with levels on, without levels or on Anthropic off, first-party unchanged', () => {
  assert.equal(capable('custom-chat', { id: 'm', reasoningLevels: LEVELS }), true);
  assert.equal(capable('custom-responses', { id: 'm', reasoningOptions: [{ type: 'effort', values: LEVELS }] }), true);
  assert.equal(capable('custom-chat', { id: 'm' }), false);
  assert.equal(capable('custom-chat', { id: 'm', reasoningLevels: [] }), false);
  assert.equal(capable('custom-anthropic', { id: 'claude-opus-5-5', reasoningLevels: LEVELS }), false);
  assert.equal(capable('anthropic-oauth', { id: 'claude-opus-5-5' }), true);
  assert.equal(capable('openai', { id: 'gpt-5.5' }), false);
});

test('savedAutoEffort exposes the saved per-model Auto effort choice next to savedFast', () => {
  const saved = (setting) =>
    hydrateProviderModelRow(
      { ...cfg, modelSettings: { 'openai/gpt-5.5': setting } },
      { provider: 'openai', id: 'gpt-5.5' }
    ).savedAutoEffort;
  assert.equal(saved({ fast: true }), undefined);
  assert.equal(saved({ autoEffort: false }), false);
  assert.equal(saved({ autoEffort: true }), true);
});

test('model management state rides every row: explicit visibility and the favorite mark', () => {
  const row = (setting) =>
    hydrateProviderModelRow(
      { ...cfg, modelSettings: { 'openai/gpt-5.5': setting } },
      { provider: 'openai', id: 'gpt-5.5' }
    );
  assert.equal('savedHidden' in row({ effort: 'high' }), false);
  assert.equal('favorite' in row({ effort: 'high' }), false);
  assert.equal(row({ hidden: true }).savedHidden, true);
  assert.equal(row({ hidden: false }).savedHidden, false);
  assert.equal(row({ favorite: true }).favorite, true);
});

test('a hydrated custom row keeps its contract fields', () => {
  const customReasoning = { wireFormat: 'standard', wireValues: {}, replay: false };
  const row = hydrateProviderModelRow(cfg, {
    provider: 'custom-chat',
    id: 'm',
    hidden: false,
    manual: true,
    supportsReasoning: false,
    reasoningLevels: [],
    customReasoning,
  });
  assert.equal(row.hidden, false);
  assert.equal(row.manual, true);
  assert.equal(row.supportsReasoning, false);
  assert.deepEqual(row.reasoningLevels, []);
  assert.deepEqual(row.customReasoning, customReasoning);
});
