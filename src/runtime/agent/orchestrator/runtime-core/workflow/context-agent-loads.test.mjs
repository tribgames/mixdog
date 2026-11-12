// Composing a session prompt must not cost a stat storm on the main thread: a
// definition is validated once per composition, and the definition cache holds
// every agent (a cap below the agent count evicted in a loop and re-read every
// definition from disk for every prompt).
import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkflowContext } from './context.mjs';
import { agentDefinitionCache, clearAgentDefinitionCache, setAgentDefinitionCache } from '../workflow-ids.mjs';

const AGENTS = 100;

test('a prompt composition loads each agent definition once', () => {
  const ids = Array.from({ length: AGENTS }, (_, index) => `agent-${index}`);
  const loads = new Map();
  const context = createWorkflowContext({
    packs: { loadWorkflowPack: () => null, activeWorkflowId: () => 'default' },
    agents: {
      delegatableAgentIds: () => ids,
      loadAgentDefinition: (_dir, id) => {
        loads.set(id, (loads.get(id) ?? 0) + 1);
        return { id, name: id, description: '', kind: 'agent' };
      },
    },
  });
  const { leadPromptParts } = context.activeWorkflowContext({}, '/data');
  loads.clear();
  const parts = leadPromptParts({ agentMode: true, agentId: 'agent-0' });
  assert.match(parts.agentCatalogContext, /agent-99/);
  assert.equal(loads.size, AGENTS);
  assert.deepEqual(
    [...loads.values()].filter((count) => count !== 1),
    [],
    'every definition was validated exactly once'
  );
});

test('the definition cache keeps every agent of a large store', () => {
  clearAgentDefinitionCache();
  for (let index = 0; index < AGENTS; index += 1) {
    setAgentDefinitionCache(`/data\nagent-${index}`, { definition: null, files: [], signature: '' });
  }
  assert.equal(agentDefinitionCache.size, AGENTS);
  clearAgentDefinitionCache();
});
