import assert from 'node:assert/strict';
import test from 'node:test';

import { listLeadSessions } from '../lifecycle/session-catalog.mjs';
import { sessionOptions } from './session-options.mjs';

function optionsFor(toolProfile) {
  return sessionOptions(
    {
      rt: {
        route: { provider: 'openai-oauth', model: 'gpt-test' },
        config: {},
        mode: 'full',
        toolProfile,
        currentCwd: process.cwd(),
      },
      cfgMod: { getPluginData: () => process.cwd() },
      activeWorkflowContext: () => ({ summary: null, context: '', packContext: '', orchestrationMode: 'none' }),
      featureDisallowedTools: () => [],
    },
    null
  );
}

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
