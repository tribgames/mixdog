// A delegation mode or workflow chosen while a turn runs is saved to the
// session store before it is acknowledged: a daemon that restarts right after
// reads it back from disk and applies it when the next turn starts.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-switch-durability-'));
const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = root;

const { saveSessionAsync } = await import('../runtime/agent/orchestrator/session/store.mjs');
const { settleSessionSummaryIndex } = await import('../runtime/agent/orchestrator/session/store/listing.mjs');
const { createToolPolicyRefresh } = await import('./tool-policy-refresh.mjs');
const { orchestrationInstructions } = await import('../runtime/agent/orchestrator/runtime-core/orchestration.mjs');

test.after(async () => {
  await settleSessionSummaryIndex();
  await (await import('../runtime/agent/orchestrator/session/store/lifecycle-barriers.mjs')).flushSessionCloseMetrics();
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(root, { recursive: true, force: true });
});

const PACKS = { alpha: 'Alpha', beta: 'Beta' };

function runtimeFor(session, turns) {
  return createToolPolicyRefresh({
    getSession: () => session,
    getRoute: () => ({ provider: 'openai', model: 'test' }),
    getMode: () => 'full',
    getConfig: () => ({ workflow: { active: 'alpha' }, orchestrationMode: 'swarm' }),
    getDataDir: () => root,
    getActiveTurnCount: () => turns,
    modelStandaloneTools: () => [{ name: 'read' }],
    featureDisallowedTools: () => [],
    loadCoreMemoryContext: async () => '',
    activeWorkflowContext: (cfg) => {
      const id = PACKS[cfg?.workflow?.active] ? cfg.workflow.active : 'alpha';
      return {
        summary: { id, name: PACKS[id], description: '', source: 'built-in', delegatesAgents: true },
        orchestrationMode: cfg?.orchestrationMode || 'swarm',
        packContext: `# Active Workflow: ${PACKS[id]}`,
        leadPromptParts: () => ({ orchestrationContext: orchestrationInstructions(cfg?.orchestrationMode || 'swarm') }),
      };
    },
    invalidatePreSessionToolSurface: () => {},
    // As the runtime boot wires it (boot/apis.mjs).
    persistSession: (saved) => saveSessionAsync(saved, { expectedGeneration: saved.generation }),
  });
}

test('a choice accepted during a turn is on disk when acknowledged and applies after a restart', async () => {
  const now = Date.now();
  const session = {
    id: 'sess_switch_durability',
    owner: 'user',
    agent: 'lead',
    sessionMode: 'coding',
    status: 'running',
    createdAt: now,
    updatedAt: now,
    provider: 'openai',
    model: 'test',
    promptIdentity: { agent: 'lead' },
    callerDisallowedTools: [],
    tools: [{ name: 'read' }],
    workflow: { id: 'alpha', name: 'Alpha', delegatesAgents: true },
    orchestrationMode: 'swarm',
    messages: [
      { role: 'system', content: '# Tool Calls' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ],
  };
  await saveSessionAsync(session);
  const running = runtimeFor(session, 1);
  assert.equal((await running.switchSessionOrchestrationMode('none')).deferred, true);
  assert.equal((await running.switchSessionWorkflow('beta')).deferred, true);

  // Crash right after the acknowledgement: only the file survives.
  const disk = JSON.parse(readFileSync(join(root, 'sessions', `${session.id}.json`), 'utf8'));
  assert.equal(disk.pendingOrchestrationMode, 'none');
  assert.equal(disk.pendingWorkflowId, 'beta');

  const restarted = runtimeFor(disk, 0);
  const switches = restarted.applyPendingSessionSwitches();
  assert.deepEqual([switches.orchestrationModeSwitch.from, switches.orchestrationModeSwitch.to], ['swarm', 'none']);
  assert.deepEqual([switches.workflowSwitch.fromId, switches.workflowSwitch.toId], ['alpha', 'beta']);
  assert.equal(disk.orchestrationMode, 'none');
  assert.equal(disk.workflow.id, 'beta');
  assert.equal(disk.pendingOrchestrationMode, undefined);
  assert.equal(disk.pendingWorkflowId, undefined);
});
