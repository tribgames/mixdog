import assert from 'node:assert/strict';
import test from 'node:test';

import { listLeadSessions } from '../lifecycle/session-catalog.mjs';
import { sessionOptions } from './session-options.mjs';

function optionsFor(toolProfile, sessionProfile = null) {
  return sessionOptions(
    {
      rt: {
        route: { provider: 'openai-oauth', model: 'gpt-test' },
        config: {},
        mode: 'full',
        toolProfile,
        sessionProfile,
        currentCwd: process.cwd(),
      },
      cfgMod: { getPluginData: () => process.cwd() },
      activeWorkflowContext: () => ({
        summary: null,
        context: '',
        packContext: '',
        leadPromptParts: () => ({}),
        orchestrationMode: 'none',
      }),
      featureDisallowedTools: () => [],
    },
    null
  );
}

test('agent profile fallback routes reach the shared session creator unchanged', () => {
  const routeFallbacks = [
    { provider: 'anthropic', model: 'second', contextTokens: 48000 },
    { provider: 'gemini', model: 'third', effort: 'low' },
  ];
  const opts = optionsFor('interactive', { owner: 'agent', agent: 'worker', routeFallbacks });
  assert.equal(opts.agent, 'worker');
  assert.deepEqual(opts.routeFallbacks, routeFallbacks);
  assert.equal(Object.hasOwn(optionsFor('interactive'), 'routeFallbacks'), false);
});

test('headless exec sessions get their own source and stay out of the Lead catalog', () => {
  assert.equal(optionsFor('headless').sourceType, 'exec');
  assert.equal(optionsFor('interactive').sourceType, 'lead');

  const session = (id, sourceType) => ({
    id,
    owner: 'cli',
    agent: 'lead',
    sourceType,
    messages: [{ role: 'user', content: 'hello' }],
  });
  const rows = listLeadSessions({ listSessions: () => [session('lead1', 'lead'), session('exec1', 'exec')] });
  assert.deepEqual(
    rows.map((row) => row.id),
    ['lead1']
  );
});
