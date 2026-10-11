import assert from 'node:assert/strict';
import test from 'node:test';
import {
  autoEffortModel,
  customAutoEffortCapable,
  prepareTurnEffortConfiguration,
  projectEffortConfiguration,
  turnEffortConfigurationMode,
} from './effort-configuration.mjs';

const LEVELS = { reasoningLevels: ['low', 'medium', 'high'] };

function customProvider(protocol, row) {
  return {
    config: {},
    customConfig: { protocol },
    getCachedModelInfo: (id) => (row ? { id, ...row } : null),
  };
}

test('custom auto effort: Chat/Responses with levels on; no levels, explicit none or Anthropic off', () => {
  assert.equal(customAutoEffortCapable('custom-a', 'openai-chat', LEVELS), true);
  assert.equal(
    customAutoEffortCapable('custom-a', 'openai-responses', {
      reasoningOptions: [{ type: 'effort', values: ['medium'] }],
    }),
    true
  );
  assert.equal(customAutoEffortCapable('custom-a', 'openai-chat', {}), false);
  assert.equal(customAutoEffortCapable('custom-a', 'openai-chat', { reasoningLevels: [] }), false);
  assert.equal(customAutoEffortCapable('custom-a', 'anthropic', LEVELS), false);
  assert.equal(customAutoEffortCapable('openai', 'openai-chat', LEVELS), false);
});

test('the turn mode: custom routes per request, first-party unchanged', () => {
  const session = (provider, model) => ({ provider, model, messages: [] });
  assert.equal(turnEffortConfigurationMode(session('custom-a', 'm'), customProvider('openai-chat', LEVELS)), 'custom');
  assert.equal(
    turnEffortConfigurationMode(session('custom-a', 'm'), customProvider('openai-responses', LEVELS)),
    'custom'
  );
  assert.equal(turnEffortConfigurationMode(session('custom-a', 'm'), customProvider('openai-chat', {})), null);
  assert.equal(turnEffortConfigurationMode(session('custom-a', 'm'), customProvider('openai-chat', null)), null);
  assert.equal(turnEffortConfigurationMode(session('custom-a', 'm'), customProvider('anthropic', LEVELS)), null);
  assert.equal(
    turnEffortConfigurationMode(session('custom-a', 'claude-opus-5-5'), customProvider('anthropic', LEVELS)),
    null
  );
  assert.equal(turnEffortConfigurationMode(session('anthropic-oauth', 'claude-opus-5-5'), { config: {} }), 'anthropic');
  assert.equal(turnEffortConfigurationMode(session('openai', 'gpt-6-astra'), { config: {} }), 'responses');
  assert.equal(turnEffortConfigurationMode(session('openai', 'gpt-5.5'), { config: {} }), null);
});

test('the auto-effort model is the custom effective row; first-party keeps the bare id', () => {
  const provider = customProvider('openai-chat', LEVELS);
  assert.deepEqual(autoEffortModel('custom-a', provider, 'm'), { id: 'm', ...LEVELS });
  assert.deepEqual(autoEffortModel('anthropic-oauth', provider, 'claude-opus-5-5'), { id: 'claude-opus-5-5' });
});

test('a custom snapshot records the turn effort and is never projected into the history', () => {
  const session = { provider: 'custom-a', model: 'm', effort: 'high', messages: [] };
  const provider = customProvider('openai-chat', { reasoningLevels: ['none', 'low', 'high'] });
  const snapshot = prepareTurnEffortConfiguration(session, provider, 'low');
  assert.equal(snapshot.mode, 'custom');
  assert.equal(snapshot.effort, 'low');
  assert.equal(session.effort, 'high');
  assert.equal(prepareTurnEffortConfiguration(session, provider, 'none').effort, 'none');
  const messages = [{ role: 'user', content: 'go', meta: { effortConfiguration: snapshot } }];
  assert.equal(projectEffortConfiguration(messages, 'custom-a', 'm', { effortConfiguration: snapshot }), null);
  assert.equal(prepareTurnEffortConfiguration(session, customProvider('anthropic', LEVELS), 'low'), null);
});
