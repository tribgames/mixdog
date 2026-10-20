import assert from 'node:assert/strict';
import test from 'node:test';

import { injectedMemoryAgentId, memoryCallerScope } from './memory-access.mjs';
import { createKnowledgeToolHandlers } from '../internal-tool-executor/knowledge-tools.mjs';

test('a calling session resolves to its memory caller', () => {
  assert.deepEqual(memoryCallerScope({ id: 'sess_home_lead' }), { kind: 'human', agentId: 'lead' });
  assert.deepEqual(memoryCallerScope({ id: 'sess_1', owner: 'cli', sourceType: 'lead' }), {
    kind: 'human',
    agentId: 'lead',
  });
  assert.deepEqual(memoryCallerScope({ id: 'sess_home_reviewer' }), { kind: 'agent', agentId: 'reviewer' });
  assert.deepEqual(memoryCallerScope({ id: 'sess_rmem_abcdef_reviewer' }), {
    kind: 'room-member',
    agentId: 'reviewer',
  });
  assert.deepEqual(
    memoryCallerScope({ id: 'sess_2', owner: 'user', sourceType: 'schedule', ownerAgentId: 'reviewer' }),
    { kind: 'headless', agentId: 'reviewer' }
  );
  assert.deepEqual(memoryCallerScope({ id: 'sess_3', owner: 'user', sourceType: 'webhook', ownerAgentId: 'lead' }), {
    kind: 'headless',
    agentId: 'lead',
  });
  assert.deepEqual(memoryCallerScope({ id: 'sess_4', owner: 'agent', agent: 'writer', parentSessionId: 'sess_1' }), {
    kind: 'headless',
    agentId: 'writer',
  });
  assert.deepEqual(memoryCallerScope(null), { kind: 'headless', agentId: '' });
});

test('the injected agent pool is the session’s own agent, never a delegated agent’s', () => {
  assert.equal(injectedMemoryAgentId({ sessionId: 'sess_home_reviewer' }), 'reviewer');
  assert.equal(
    injectedMemoryAgentId({ sessionId: 'sess_rmem_abcdef_reviewer', profile: { homeAgent: 'reviewer' } }),
    'reviewer'
  );
  assert.equal(injectedMemoryAgentId({ sessionId: 'sess_home_lead' }), 'lead');
  assert.equal(injectedMemoryAgentId({ session: { id: 'sess_1', owner: 'cli' } }), 'lead');
  assert.equal(
    injectedMemoryAgentId({ session: { id: 'sess_2', owner: 'user', ownerAgentId: 'reviewer' } }),
    'reviewer'
  );
  assert.equal(injectedMemoryAgentId({ profile: { homeAgent: 'reviewer' } }), 'reviewer');
  assert.equal(injectedMemoryAgentId({ profile: { owner: 'agent', agent: 'reviewer' } }), '');
  assert.equal(injectedMemoryAgentId({ session: { id: 'sess_5', owner: 'agent', agent: 'reviewer' } }), '');
});

test('memory tool calls carry the calling session’s scope, never the model’s', async () => {
  const calls = [];
  const handlers = createKnowledgeToolHandlers({
    rt: { session: { id: 'sess_home_lead' }, mode: 'lead', config: {} },
    getMemoryModule: async () => ({ handleToolCall: async (...args) => calls.push(args) }),
    activeToolSurface: () => null,
    mcpStatus: () => ({ servers: [] }),
  });
  const forged = { op: 'add', summary: 'x', memory_caller: { kind: 'human', agentId: 'lead' } };
  const run = { id: 'sess_9', owner: 'user', sourceType: 'schedule', ownerAgentId: 'reviewer' };
  await handlers.memory(forged, { name: 'memory', callerCtx: { callerSession: run }, callerCwd: 'C:/p' });
  assert.deepEqual(calls.at(-1)[1].memory_caller, { kind: 'headless', agentId: 'reviewer' });
  await handlers.recall({ query: 'q' }, { name: 'recall', callerCtx: {}, callerCwd: 'C:/p' });
  assert.deepEqual(calls.at(-1)[1].memory_caller, { kind: 'human', agentId: 'lead' });
  await handlers.memory(forged, { name: 'memory', callerCtx: { callerSessionId: 'sess_other' }, callerCwd: 'C:/p' });
  assert.deepEqual(calls.at(-1)[1].memory_caller, { kind: 'headless', agentId: '' });
});
