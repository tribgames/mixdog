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

test('an exact id is forwarded as the same route', async () => {
  const { routedAgentTool, calls } = routedWithCatalog(async () => CATALOG);
  const args = { agent: 'worker', provider: 'openai-oauth', model: 'gpt-6.1-sol' };
  await routedAgentTool.execute(args);
  assert.deepEqual(calls[0], args);
});

test('an exact id is not rejected as ambiguous by ids that collide once normalized', async () => {
  const { routedAgentTool, calls } = routedWithCatalog(async () => [
    { provider: 'custom-x', id: 'foo-bar', display: 'Foo Bar' },
    { provider: 'custom-x', id: 'foo_bar', display: 'Foo Bar' },
  ]);
  const args = { type: 'spawn', agent: 'worker', tag: 't', provider: 'custom-x', model: 'foo-bar' };
  await routedAgentTool.execute(args);
  assert.deepEqual(calls[0], args);
});

test('a display name is matched case-insensitively, and an omitted provider is filled from the one match', async () => {
  const { routedAgentTool, calls } = routedWithCatalog(async () => CATALOG);
  await routedAgentTool.execute({ agent: 'worker', model: 'gpt-6.1-LUNA' });
  assert.deepEqual(calls[0], { agent: 'worker', provider: 'openai-oauth', model: 'gpt-6.1-luna' });
});

test('a unique word match within the provider resolves to its catalog id', async () => {
  const { routedAgentTool, calls } = routedWithCatalog(async () => [
    { provider: 'custom', id: 'foo-pro', display: 'Foo Pro' },
  ]);
  await routedAgentTool.execute({ agent: 'worker', provider: 'custom', model: 'foo' });
  assert.deepEqual(calls[0], { agent: 'worker', provider: 'custom', model: 'foo-pro' });
});

test('bot surface: model "opus" on provider "anthropic" fails with candidates unless one model matches', async () => {
  const rows = [
    { provider: 'anthropic', id: 'claude-opus-5-5', display: 'Claude Opus 5.5' },
    { provider: 'anthropic', id: 'claude-opus-4-8', display: 'Claude Opus 4.8' },
    { provider: 'anthropic', id: 'claude-sonnet-5-5', display: 'Claude Sonnet 5.5' },
    { provider: 'anthropic-oauth', id: 'claude-opus-5-5', display: 'Claude Opus 5.5' },
  ];
  const ambiguous = routedWithCatalog(async () => rows);
  await assert.rejects(
    ambiguous.routedAgentTool.execute({ type: 'spawn', agent: 'worker', provider: 'anthropic', model: 'opus' }),
    /ambiguous: anthropic\/claude-opus-5-5, anthropic\/claude-opus-4-8/
  );
  assert.deepEqual(ambiguous.calls, []);

  const unique = routedWithCatalog(async () => rows.filter((row) => row.id !== 'claude-opus-4-8'));
  await unique.routedAgentTool.execute({ type: 'spawn', agent: 'worker', provider: 'anthropic', model: 'opus' });
  assert.deepEqual(unique.calls[0], {
    type: 'spawn',
    agent: 'worker',
    provider: 'anthropic',
    model: 'claude-opus-5-5',
  });
});

test('an unknown model fails with candidates after one forced catalog read, and is never forwarded', async () => {
  const seen = [];
  const { routedAgentTool, calls } = routedWithCatalog(async (options) => {
    seen.push(options?.force === true ? 'force' : 'cache');
    return CATALOG;
  });
  await assert.rejects(
    routedAgentTool.execute({ agent: 'worker', provider: 'openai-oauth', model: 'nope' }),
    /"nope" for provider "openai-oauth" not found; available: openai-oauth\/gpt-6\.1-sol, openai-oauth\/gpt-6\.1-luna/
  );
  // The quick read, the full read of an incomplete catalog, then the refresh.
  assert.deepEqual(seen, ['cache', 'cache', 'force']);
  assert.deepEqual(calls, []);
});

test('a routed spawn reads the quick catalog on a hit and refreshes only the requested provider on a miss', async () => {
  const reads = [];
  const { routedAgentTool, calls } = routedWithCatalog(async (options = {}) => {
    reads.push(options);
    return CATALOG;
  });
  await routedAgentTool.execute({ agent: 'worker', provider: 'openai-oauth', model: 'gpt-6.1-sol' });
  assert.deepEqual(reads, [{ quick: true }]);
  assert.equal(calls.length, 1);

  reads.length = 0;
  await assert.rejects(
    routedAgentTool.execute({ agent: 'worker', provider: 'openai-oauth', model: 'nope' }),
    /"nope" for provider "openai-oauth" not found/
  );
  assert.deepEqual(
    reads.filter((options) => options.force === true),
    [{ force: true, provider: 'openai-oauth' }]
  );
  assert.equal(calls.length, 1);
});

test('an empty or failing catalog refuses instead of forwarding the name', async () => {
  for (const [list, pattern] of [
    [async () => [], /has no available models/],
    [
      async () => {
        throw new Error('catalog down');
      },
      /catalog down/,
    ],
  ]) {
    const { routedAgentTool, calls } = routedWithCatalog(list);
    await assert.rejects(routedAgentTool.execute({ agent: 'worker', provider: 'custom', model: 'foo' }), pattern);
    assert.deepEqual(calls, []);
  }
});

test('an ambiguous name fails with candidates instead of being forwarded', async () => {
  const { routedAgentTool, calls } = routedWithCatalog(async () => [
    { provider: 'a', id: 'm-1', display: 'Same' },
    { provider: 'b', id: 'm-2', display: 'Same' },
  ]);
  await assert.rejects(
    routedAgentTool.execute({ agent: 'worker', model: 'same' }),
    /"same" is ambiguous: a\/m-1, b\/m-2; pass the exact one/
  );
  assert.deepEqual(calls, []);
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
