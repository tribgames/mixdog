import assert from 'node:assert/strict';
import test from 'node:test';
import { agentActivityGroups, islandAgentRows } from './agent-activity-model.ts';

const LEAD = 'lead-island';
const lead = {
  tag: `lead:${LEAD}`,
  sessionId: LEAD,
  ownerSessionId: LEAD,
  agent: 'lead',
  status: 'idle',
  stage: 'idle',
};
const child = (id, extra = {}) => ({
  tag: id,
  sessionId: id,
  ownerSessionId: LEAD,
  parentSessionId: LEAD,
  agent: 'worker',
  status: 'completed',
  stage: 'completed',
  ...extra,
});
const ids = (pool) => islandAgentRows(pool, LEAD).map((row) => row.node.sessionId);

test('agents the Lead closed drop out of the island rows and its count', () => {
  const pool = [lead, child('a'), child('b', { released: true }), child('c')];
  assert.deepEqual(ids(pool), ['a', 'c']);
  assert.deepEqual(ids([lead, child('a', { released: true })]), []);
});

test('a closed agent keeps its completed status and stays in the Agents window group', () => {
  const pool = [lead, child('a', { released: true })];
  const window = agentActivityGroups(pool, (id) => id === LEAD)[0];
  assert.deepEqual(
    window.nodes[0].children.map((node) => [node.sessionId, node.agent.status]),
    [['a', 'completed']]
  );
});

test('a reused agent (no released mark) and a reused descendant of a closed agent reappear', () => {
  const closedParent = child('p', { released: true });
  const reusedChild = child('q', { parentSessionId: 'p', status: 'running', stage: 'streaming' });
  assert.deepEqual(ids([lead, closedParent, reusedChild]), ['q']);
  assert.deepEqual(ids([lead, { ...closedParent, released: undefined }]), ['p']);
  const { released: _released, ...reused } = closedParent;
  assert.deepEqual(ids([lead, reused]), ['p']);
});
