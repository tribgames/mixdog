import assert from 'node:assert/strict';
import test from 'node:test';
import { effortOptionsFor } from '../runtime-core/effort.mjs';
import { autoEffortApplicable } from './auto-effort.mjs';
import { applyAnthropicEffortToBody, setModelEffortCapabilities } from './anthropic-effort.mjs';
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

test('the auto-effort model is the provider cached row on custom and first-party routes', () => {
  const provider = customProvider('openai-chat', LEVELS);
  assert.deepEqual(autoEffortModel('custom-a', provider, 'm'), { id: 'm', ...LEVELS });
  const empty = { config: {}, getCachedModelInfo: () => null };
  assert.deepEqual(autoEffortModel('openai-oauth', empty, 'gpt-6.1-sol'), { id: 'gpt-6.1-sol' });
  assert.deepEqual(effortOptionsFor('openai-oauth', autoEffortModel('openai-oauth', empty, 'gpt-6.1-sol')), []);
  const row = effortRecord('gpt-6.1-sol', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra');
  const cached = { config: {}, getCachedModelInfo: (id) => (id === row.id ? row : null) };
  const model = autoEffortModel('openai-oauth', cached, 'gpt-6.1-sol');
  assert.equal(model.id, 'gpt-6.1-sol');
  assert.equal(autoEffortApplicable({ base: 'medium', options: effortOptionsFor('openai-oauth', model) }), true);
});

const effortRecord = (id, ...values) => ({ id, reasoningOptions: [{ type: 'effort', values }] });
const AUTO_IDS = [
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-mythos-5-1',
  'claude-mythos-5-1-20260101',
  'claude-3-5-sonnet-20241022',
  'mystery-model',
];

function autoLadder(id, impl = {}) {
  return effortOptionsFor('anthropic-oauth', autoEffortModel('anthropic-oauth', impl, id));
}

// The levels (reserved `max` aside) the wire builder sends unchanged.
function wireLevels(id) {
  const write = process.stderr.write;
  process.stderr.write = () => true;
  try {
    return ['low', 'medium', 'high', 'xhigh'].filter((effort) => {
      const body = {};
      try {
        applyAnthropicEffortToBody(body, {
          model: id,
          opts: { effort },
          maxTokens: 8192,
          clampThinkingBudgetTokens: (tokens) => tokens,
        });
      } catch {
        return false; // the builder refuses the request: nothing is accepted
      }
      return body.output_config?.effort === effort;
    });
  } finally {
    process.stderr.write = write;
  }
}

test('Anthropic auto ladder equals the wire builder accepted levels, cold and warm catalog', () => {
  try {
    setModelEffortCapabilities([]);
    for (const id of AUTO_IDS) assert.deepEqual(autoLadder(id), wireLevels(id), `cold ${id}`);
    assert.deepEqual(autoLadder('claude-opus-5-5'), ['low', 'medium', 'high', 'xhigh']);
    assert.deepEqual(autoLadder('claude-sonnet-5-5'), ['low', 'medium', 'high', 'xhigh']);
    assert.deepEqual(autoLadder('claude-mythos-5-1'), ['low', 'medium', 'high', 'xhigh']);
    assert.deepEqual(autoLadder('claude-3-5-sonnet-20241022'), []);
    assert.deepEqual(autoLadder('mystery-model'), []);

    setModelEffortCapabilities([
      effortRecord('claude-opus-5-5', 'low', 'medium', 'high', 'xhigh', 'max'),
      effortRecord('claude-sonnet-5-5', 'low', 'medium', 'high'),
      effortRecord('claude-mythos-5-1', 'low', 'medium', 'high', 'xhigh'),
      effortRecord('claude-3-5-sonnet-20241022', 'low', 'medium', 'high'),
    ]);
    for (const id of AUTO_IDS) assert.deepEqual(autoLadder(id), wireLevels(id), `warm ${id}`);
    assert.deepEqual(autoLadder('claude-sonnet-5-5'), ['low', 'medium', 'high']);
    assert.deepEqual(autoLadder('claude-mythos-5-1-20260101'), ['low', 'medium', 'high', 'xhigh']);
  } finally {
    setModelEffortCapabilities([]);
  }
});

test('Anthropic auto ladder: a shared record declaring no levels yields none, only an absent record falls back; provider rows are ignored', () => {
  try {
    setModelEffortCapabilities([effortRecord('claude-opus-5-5')]);
    assert.deepEqual(autoLadder('claude-opus-5-5'), []);
    assert.deepEqual(autoLadder('claude-opus-5-5'), wireLevels('claude-opus-5-5'));
    assert.deepEqual(autoLadder('claude-sonnet-5-5'), ['low', 'medium', 'high', 'xhigh']);
    setModelEffortCapabilities([]);
    // The wire builder ignores provider rows, so they never change the ladder.
    const row = (fields) => ({ getCachedModelInfo: () => fields });
    const full = ['low', 'medium', 'high', 'xhigh'];
    assert.deepEqual(autoLadder('claude-opus-5-5', row({ reasoningLevels: [] })), full);
    assert.deepEqual(autoLadder('claude-opus-5-5', row({ reasoningOptions: [{ type: 'effort', values: [] }] })), full);
    assert.deepEqual(autoLadder('claude-opus-5-5', row({ reasoningLevels: ['low', 'high'] })), full);
    assert.deepEqual(autoLadder('claude-3-5-sonnet-20241022', row({ reasoningLevels: ['low', 'high'] })), []);
  } finally {
    setModelEffortCapabilities([]);
  }
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
