import assert from 'node:assert/strict';
import test from 'node:test';
import { createRoutedAgentTool } from './agent-tool-routing.mjs';

function routed() {
  const calls = [];
  const { routedAgentTool } = createRoutedAgentTool({
    rt: { currentCwd: '/work', session: { id: 'sess_lead', clientHostPid: 7 } },
    agentTool: {},
    executeAgentControl: async (args, context) => {
      calls.push({ args, context });
    },
  });
  return { routedAgentTool, calls };
}

const CATALOG = [
  { provider: 'openai-oauth', id: 'gpt-6.1-sol', display: 'GPT-6.1-Sol' },
  { provider: 'openai-oauth', id: 'gpt-6.1-luna', display: 'GPT-6.1-Luna' },
];

function routedWithCatalog(listProviderModels) {
  const calls = [];
  const { routedAgentTool } = createRoutedAgentTool({
    rt: { currentCwd: '/work', session: { id: 'sess_lead' } },
    agentTool: {},
    executeAgentControl: async (args) => {
      calls.push(args);
      return 'ok';
    },
    listProviderModels,
  });
  return { routedAgentTool, calls };
}

test('a spawn pinned by display name reaches the agent control as the catalog id', async () => {
  const { routedAgentTool, calls } = routedWithCatalog(async () => CATALOG);
  await routedAgentTool.execute({ agent: 'worker', prompt: 'p', provider: 'openai-oauth', model: 'GPT-6.1-Sol' });
  assert.equal(calls[0].model, 'gpt-6.1-sol');
  assert.equal(calls[0].provider, 'openai-oauth');
});

test('an exact id is forwarded unchanged', async () => {
  const { routedAgentTool, calls } = routedWithCatalog(async () => CATALOG);
  const args = { agent: 'worker', provider: 'openai-oauth', model: 'gpt-6.1-sol' };
  await routedAgentTool.execute(args);
  assert.equal(calls[0], args);
});

test('a display name is matched case-insensitively, and an omitted provider is filled from the one match', async () => {
  const { routedAgentTool, calls } = routedWithCatalog(async () => CATALOG);
  await routedAgentTool.execute({ agent: 'worker', model: 'gpt-6.1-LUNA' });
  assert.deepEqual(calls[0], { agent: 'worker', provider: 'openai-oauth', model: 'gpt-6.1-luna' });
});

test('a name that only word-matches a catalog row is never substituted', async () => {
  const { routedAgentTool, calls } = routedWithCatalog(async () => [
    { provider: 'custom', id: 'foo-pro', display: 'Foo Pro' },
  ]);
  const args = { agent: 'worker', provider: 'custom', model: 'foo' };
  await routedAgentTool.execute(args);
  assert.equal(calls[0], args);
});

test('an empty, partial or failing catalog never refuses or rewrites a model', async () => {
  for (const list of [
    async () => [],
    async () => [{ provider: 'other', id: 'x', display: 'X' }],
    async () => undefined,
    async () => {
      throw new Error('catalog down');
    },
  ]) {
    const { routedAgentTool, calls } = routedWithCatalog(list);
    const args = { agent: 'worker', provider: 'custom', model: 'foo' };
    assert.equal(await routedAgentTool.execute(args), 'ok');
    assert.equal(calls[0], args);
  }
});

test('a partial catalog never aliases a display name onto another id', async () => {
  const partialRow = { catalogPartial: true, catalogMissing: ['custom'], catalogRetryAt: 1 };
  const { routedAgentTool, calls } = routedWithCatalog(async () => [
    { provider: 'custom', id: 'bar', display: 'foo', ...partialRow },
  ]);
  const args = { agent: 'worker', provider: 'custom', model: 'foo' };
  await routedAgentTool.execute(args);
  assert.equal(calls[0], args);
  // An exact id still passes there, and the same alias resolves once complete.
  const exact = { agent: 'worker', provider: 'custom', model: 'bar' };
  await routedAgentTool.execute(exact);
  assert.equal(calls[1], exact);
  const complete = routedWithCatalog(async () => [{ provider: 'custom', id: 'bar', display: 'foo' }]);
  await complete.routedAgentTool.execute(args);
  assert.equal(complete.calls[0].model, 'bar');
});

test('an ambiguous exact match is forwarded unchanged', async () => {
  const { routedAgentTool, calls } = routedWithCatalog(async () => [
    { provider: 'a', id: 'm-1', display: 'Same' },
    { provider: 'b', id: 'm-2', display: 'Same' },
  ]);
  const args = { agent: 'worker', model: 'same' };
  await routedAgentTool.execute(args);
  assert.equal(calls[0], args);
});

test('the catalog is read quick only, so a spawn never waits on a full or forced read', async () => {
  const seen = [];
  const { routedAgentTool } = routedWithCatalog(async (options) => (seen.push(options), CATALOG));
  await routedAgentTool.execute({ agent: 'worker', provider: 'openai-oauth', model: 'GPT-6.1-Sol' });
  await routedAgentTool.execute({ agent: 'worker', provider: 'openai-oauth', model: 'nope' });
  assert.deepEqual(seen, [{ quick: true }, { quick: true }]);
});

test('without a catalog the model passes through unchanged', async () => {
  const { routedAgentTool, calls } = routedWithCatalog(null);
  const args = { agent: 'worker', provider: 'my-custom', model: 'Any.Id' };
  await routedAgentTool.execute(args);
  assert.equal(calls[0], args);
});

test('a non-spawn request is not resolved against the catalog', async () => {
  const { routedAgentTool, calls } = routedWithCatalog(async () => {
    throw new Error('catalog must not be read');
  });
  await routedAgentTool.execute({ type: 'status' });
  assert.deepEqual(calls[0], { type: 'status' });
});

test('a process-exit closeAll reaches the agent control as one, so the rows survive the exit', async () => {
  const { routedAgentTool, calls } = routed();
  await routedAgentTool.closeAll('SIGTERM', { processExit: true });
  assert.deepEqual(calls[0].args, { type: '__close_all', reason: 'SIGTERM', processExit: true });
  assert.equal(calls[0].context.callerSessionId, 'sess_lead');
});

test('any other closeAll stays a plain close', async () => {
  const { routedAgentTool, calls } = routed();
  await routedAgentTool.closeAll('agent owner closed');
  assert.deepEqual(calls[0].args, { type: '__close_all', reason: 'agent owner closed' });
});
