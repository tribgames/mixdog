import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentRouteApi } from './workflow-agents-api/agent-route.mjs';
import { makeResolveRoute, validateRequestedModelSelector } from '../runtime/agent/orchestrator/runtime-core/config-helpers.mjs';
import { createWorkflowRouteHelpers } from '../runtime/agent/orchestrator/runtime-core/workflow.mjs';

test('OpenRouter rolling aliases save and reload as agent routes without changing Main or other agents', async () => {
  const main = { id: 'main', provider: 'anthropic-oauth', model: 'claude-sonnet-5-5' };
  const maintainer = { provider: 'openai-oauth', model: 'gpt-6-astra', effort: 'high' };
  const modelSettings = { 'anthropic-oauth/claude-sonnet-5-5': { effort: 'medium' } };
  let config = { default: 'main', presets: [main], agents: { maintainer }, modelSettings };
  const helpers = createWorkflowRouteHelpers({ findPreset: () => null });
  let writes = 0;
  const api = createAgentRouteApi({
    getConfig: () => config,
    resolveRoute: makeResolveRoute(() => 'anthropic-oauth'),
    agentRouteFromConfig: helpers.agentRouteFromConfig,
    ensureProvidersReady: async () => {},
    lookupModelMeta: async () => ({}),
    saveConfigAndAdopt: (next) => {
      config = next;
      writes += 1;
    },
  });

  for (const model of [
    '~google/gemini-flash-latest',
    '~deepseek/deepseek-flash-latest',
    '~anthropic/claude-opus-latest',
    'google/gemini-3.8-flash',
  ]) {
    const requested = { provider: 'openrouter', model };
    assert.doesNotThrow(() => validateRequestedModelSelector(config, requested));
    const saved = await api.setAgentRoute('worker', requested);
    assert.equal(saved.provider, requested.provider);
    assert.equal(saved.model, model);
    assert.deepEqual(helpers.agentRouteFromConfig(config, 'worker'), saved);
    assert.deepEqual(config.presets, [main]);
    assert.deepEqual(config.agents.maintainer, maintainer);
    assert.deepEqual(config.modelSettings, modelSettings);
  }
  assert.equal(writes, 4);

  const beforeInvalid = config;
  for (const model of ['', '~', '~~google/model', 'Google: Gemini Flash Latest']) {
    await assert.rejects(
      api.setAgentRoute('worker', { provider: 'openrouter', model }),
      /agent route requires provider and model/
    );
    assert.equal(config, beforeInvalid);
  }
  assert.equal(writes, 4);
});
