import assert from 'node:assert/strict';
import test from 'node:test';
import { executeInternalTool, getInternalTools, isInternalTool, setInternalToolsProvider } from './internal-tools.mjs';
import { coerceToolArgsForSession } from './session/loop/arg-schema-coerce.mjs';
import { getToolKind } from './session/loop/tool-helpers.mjs';
import { resolveSessionTools } from './session/manager/tool-resolution.mjs';

test('internal executors, catalogs and argument schemas belong to their runtime scope', async (t) => {
  const scopeA = 'internal-test-A';
  const scopeB = 'internal-test-B';
  const toolA = {
    name: 'scoped_lookup',
    description: 'A',
    inputSchema: { type: 'object', properties: { query: { type: 'array' } } },
  };
  const toolB = {
    name: 'scoped_lookup',
    description: 'B',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  };
  const calls = [];
  for (const [scopeId, tool] of [
    [scopeA, toolA],
    [scopeB, toolB],
  ]) {
    t.after(
      setInternalToolsProvider({
        scopeId,
        tools: [tool],
        executor: async (_name, args, ctx) => {
          calls.push({ scopeId, args, caller: ctx.callerSessionId });
          await new Promise(setImmediate);
          return tool.description;
        },
      })
    );
  }
  assert.deepEqual(
    await Promise.all([
      executeInternalTool('scoped_lookup', { query: ['a'] }, { scopeId: scopeA, callerSessionId: 'session-A' }),
      executeInternalTool('scoped_lookup', { query: 'b' }, { scopeId: scopeB, callerSessionId: 'session-B' }),
    ]),
    ['A', 'B']
  );
  assert.deepEqual(calls, [
    { scopeId: scopeA, args: { query: ['a'] }, caller: 'session-A' },
    { scopeId: scopeB, args: { query: 'b' }, caller: 'session-B' },
  ]);
  for (const [scopeId, tool] of [
    [scopeA, toolA],
    [scopeB, toolB],
  ]) {
    assert.deepEqual(getInternalTools(scopeId), [tool]);
    assert.equal(isInternalTool(tool.name, scopeId), true);
    assert.equal(getToolKind(tool.name, scopeId), 'internal');
    const resolved = resolveSessionTools(['full'], [], { mcpScopeId: scopeId });
    assert.equal(resolved.find((row) => row.name === tool.name).description, tool.description);
  }
  assert.deepEqual(coerceToolArgsForSession({ mcpScopeId: scopeA }, toolA.name, { query: '["a"]' }), { query: ['a'] });
  assert.deepEqual(coerceToolArgsForSession({ mcpScopeId: scopeB }, toolB.name, { query: '["a"]' }), {
    query: '["a"]',
  });
});

test('closing or missing scopes never fall back to the legacy global executor', async (t) => {
  let globalCalls = 0;
  t.after(
    setInternalToolsProvider({
      tools: [{ name: 'web_search' }],
      executor: async () => {
        globalCalls++;
        return 'legacy';
      },
    })
  );
  const dispose = setInternalToolsProvider({
    scopeId: 'closing-scope',
    tools: [{ name: 'web_search' }],
    executor: async () => 'scoped',
  });
  t.after(dispose);
  assert.equal(await executeInternalTool('web_search', {}), 'legacy');
  assert.equal(await executeInternalTool('web_search', {}, { scopeId: 'closing-scope' }), 'scoped');
  assert.equal(dispose(), true);
  assert.equal(dispose(), false);
  for (const scopeId of ['closing-scope', 'unknown-scope']) {
    assert.deepEqual(getInternalTools(scopeId), []);
    assert.equal(isInternalTool('web_search', scopeId), false);
    await assert.rejects(executeInternalTool('web_search', {}, { scopeId }), /not registered/);
  }
  assert.equal(globalCalls, 1);
});

test('an old registration disposer cannot remove its replacement', async (t) => {
  const scopeId = 'replaced-scope';
  const disposeOld = setInternalToolsProvider({
    scopeId,
    tools: [{ name: 'lookup' }],
    executor: async () => 'old',
  });
  t.after(disposeOld);
  const disposeNew = setInternalToolsProvider({
    scopeId,
    tools: [{ name: 'lookup' }],
    executor: async () => 'new',
  });
  t.after(disposeNew);
  assert.equal(disposeOld(), false);
  assert.equal(await executeInternalTool('lookup', {}, { scopeId }), 'new');
  await assert.rejects(executeInternalTool('other_tool', {}, { scopeId }), /not registered/);
});
