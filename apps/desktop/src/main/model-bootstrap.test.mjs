import assert from 'node:assert/strict';
import { test } from 'node:test';

import { desktopModelBootstrapFromConfig } from './model-bootstrap.ts';

test('a shipped preset selected by agent.default still yields a bootstrap snapshot from the delta form', () => {
  const snapshot = desktopModelBootstrapFromConfig({ agent: { default: 'opus-high' } });
  assert.equal(snapshot.provider, 'anthropic-oauth');
  assert.match(snapshot.model, /opus/);
  assert.equal(snapshot.effort, 'high');
});

test('a stored preset overrides the shipped one of the same id and custom presets resolve', () => {
  const override = { id: 'haiku', provider: 'openai', model: 'gpt-x' };
  assert.equal(desktopModelBootstrapFromConfig({ agent: { default: 'haiku', presets: [override] } }).model, 'gpt-x');
  const custom = { id: 'mine', provider: 'openai', model: 'gpt-y' };
  assert.equal(desktopModelBootstrapFromConfig({ agent: { default: 'mine', presets: [custom] } }).model, 'gpt-y');
  assert.equal(desktopModelBootstrapFromConfig({ agent: { default: 'missing' } }), null);
});
