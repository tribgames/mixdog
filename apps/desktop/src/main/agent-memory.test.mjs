import assert from 'node:assert/strict';
import test from 'node:test';

import { deleteAgentMemory, listAgentMemory, requiredAgentMemoryEntry } from './agent-memory.ts';

function control(pages, results = []) {
  const calls = [];
  return {
    calls,
    invoke: async (method, args) => {
      calls.push([method, args]);
      return args[0].op === 'list' ? JSON.stringify(pages[args[0].offset]) : results.shift();
    },
  };
}

test('the host lists every page of an agent’s own memory', async () => {
  const row = (id, summary) => ({ id, index_revision: 'rev-1', summary, agent_id: 'reviewer', record_id: id + 40 });
  const { calls, invoke } = control({
    0: { entries: [row(1, 'First note.')], nextOffset: 1 },
    1: { entries: [row(2, 'Second note.')], nextOffset: null },
  });
  assert.deepEqual(await listAgentMemory(invoke, 'reviewer'), [
    { id: 1, indexRevision: 'rev-1', summary: 'First note.' },
    { id: 2, indexRevision: 'rev-1', summary: 'Second note.' },
  ]);
  assert.deepEqual(
    calls.map(([method, [args]]) => [method, args]),
    [
      ['memoryControl', { op: 'list', agent_id: 'reviewer', format: 'json', limit: 100, offset: 0 }],
      ['memoryControl', { op: 'list', agent_id: 'reviewer', format: 'json', limit: 100, offset: 1 }],
    ]
  );
  await assert.rejects(listAgentMemory(invoke, '../lead'), /agent id is invalid/);
  const refused = async () => 'core list failed: the memory of agent "x" is readable only by that agent';
  await assert.rejects(listAgentMemory(refused, 'reviewer'), /readable only by that agent/);
});

test('the host deletes one entry by its list address and surfaces a refusal', async () => {
  const { calls, invoke } = control({}, [
    'core deleted (agent=reviewer id=2): Second note. Remaining indices were compacted; list memories before the next write.',
    'core delete failed: memory indices changed; list memories again before editing or deleting',
  ]);
  await deleteAgentMemory(invoke, 'reviewer', { id: 2, indexRevision: 'rev-1' });
  assert.deepEqual(calls[0], [
    'memoryControl',
    [{ op: 'delete', agent_id: 'reviewer', id: 2, index_revision: 'rev-1' }],
  ]);
  await assert.rejects(deleteAgentMemory(invoke, 'reviewer', { id: 2, indexRevision: 'rev-1' }), /indices changed/);
  assert.throws(() => requiredAgentMemoryEntry({ id: 0, indexRevision: 'rev' }), /memory id is invalid/);
  assert.throws(() => requiredAgentMemoryEntry({ id: 1, indexRevision: '' }), /indexRevision is invalid/);
});
