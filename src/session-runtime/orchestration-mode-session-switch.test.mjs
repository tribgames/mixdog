import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createToolPolicyRefresh } from './tool-policy-refresh.mjs';
import { createStyleAndModeApi } from './workflow-agents-api/style-and-mode.mjs';
import { createWorkflowPacksApi } from './workflow-agents-api/workflow-packs.mjs';
import {
  composeSessionSystem,
  seedSessionMessages,
} from '../runtime/agent/orchestrator/session/manager/session-prompt-composition.mjs';
import { buildUserTurn } from '../runtime/agent/orchestrator/session/manager/ask-turn-prepare.mjs';
import { acknowledgePendingOrchestrationModeNotice } from '../runtime/agent/orchestrator/session/manager/orchestration-mode-switch-notice.mjs';
import { acknowledgePendingWorkflowNotice } from '../runtime/agent/orchestrator/session/manager/workflow-switch-notice.mjs';
import { orchestrationInstructions } from '../runtime/agent/orchestrator/runtime-core/orchestration.mjs';
import { restoreTranscriptItems } from '../runtime/agent/orchestrator/session/transcript-restore/restore.mjs';
import { preDispatchDenyForSession } from '../runtime/agent/orchestrator/session/loop/pre-dispatch-deny.mjs';

const PACKS = {
  alpha: { id: 'alpha', name: 'Alpha', delegatesAgents: true, body: 'ALPHA RULES' },
  beta: { id: 'beta', name: 'Beta', delegatesAgents: true, body: 'BETA RULES' },
};

function workflowContext(cfg) {
  const pack = PACKS[cfg?.workflow?.active] || PACKS.alpha;
  const mode = cfg?.orchestrationMode || 'swarm';
  return {
    summary: { id: pack.id, name: pack.name, description: '', source: 'built-in', delegatesAgents: true },
    orchestrationMode: mode,
    packContext: `# Active Workflow: ${pack.name}\n\n${pack.body}`,
    leadPromptParts: () => ({
      orchestrationContext: orchestrationInstructions(mode),
      agentCatalogContext: '# Available Agents\n\n- Worker (worker)',
    }),
  };
}

function leadSession() {
  const prompt = composeSessionSystem(
    { owner: 'user', workflowContext: workflowContext({}).packContext, coreMemoryContext: 'MEMORY' },
    {
      profile: { skip: { claudemd: true, skills: true } },
      providerName: 'openai',
      modelName: 'test',
      surface: { ownerIsAgent: false, resolvedAgent: 'lead', skills: [], toolsForRouting: [], ruleOmitTools: [] },
    }
  );
  return {
    id: 'sess_lead',
    owner: 'user',
    agent: 'lead',
    sessionMode: 'coding',
    provider: 'openai',
    cwd: 'C:/repo',
    promptIdentity: prompt.promptIdentity,
    callerDisallowedTools: [],
    messages: seedSessionMessages(prompt, []),
    tools: [{ name: 'read' }, { name: 'agent' }],
    bp3CoreContext: prompt.sessionMarkerCore,
    bp3EnvSplit: true,
    bp3EnvironmentContext: prompt.environmentTailContext,
    workflow: { id: 'alpha', name: 'Alpha', delegatesAgents: true },
    orchestrationMode: 'swarm',
    contextWindow: 200_000,
  };
}

function harness(session, { config = { workflow: { active: 'alpha' }, orchestrationMode: 'swarm' } } = {}) {
  const state = { config, turns: 0, saved: [], persisted: [], persistGate: null };
  const refresh = createToolPolicyRefresh({
    getSession: () => session,
    getRoute: () => ({ provider: 'openai', model: 'test' }),
    getMode: () => 'full',
    getConfig: () => state.config,
    getDataDir: () => '',
    getActiveTurnCount: () => state.turns,
    modelStandaloneTools: () => [{ name: 'read' }, { name: 'agent' }],
    featureDisallowedTools: () => [],
    loadCoreMemoryContext: async () => 'MEMORY',
    activeWorkflowContext: workflowContext,
    invalidatePreSessionToolSurface: () => {},
    // What the store would write: a copy taken when the save is issued.
    persistSession: async (saved) => {
      state.persisted.push(JSON.parse(JSON.stringify(saved)));
      await state.persistGate;
    },
  });
  const save = (next) => {
    state.saved.push({ workflow: next.workflow?.active, mode: next.orchestrationMode });
    state.config = next;
  };
  const modes = createStyleAndModeApi({
    getConfig: () => state.config,
    getSession: () => session,
    adoptConfig: () => {},
    saveConfigAndAdopt: save,
    displayConfig: () => state.config,
    getOutputStyleStatusCached: () => ({}),
    seedOutputStyleStatusCache: () => {},
    scheduleOutputStyleSave: () => {},
    invalidateContextStatusCache: () => {},
    refreshEmptySessionToolPolicy: refresh.refreshEmptySessionToolPolicy,
    switchSessionOrchestrationMode: refresh.switchSessionOrchestrationMode,
  });
  const workflows = createWorkflowPacksApi({
    getConfig: () => state.config,
    saveConfigAndAdopt: save,
    displayConfig: () => state.config,
    activeWorkflowId: (cfg) => cfg?.workflow?.active || 'alpha',
    listWorkflowPacks: () => [],
    loadWorkflowPack: (_dir, id) => (PACKS[id] ? { id, name: PACKS[id].name } : null),
    workflowSummary: (pack) => ({ id: pack.id, name: pack.name }),
    cfgMod: { getPluginData: () => 'data' },
    refreshEmptySessionToolPolicy: refresh.refreshEmptySessionToolPolicy,
    switchSessionWorkflow: refresh.switchSessionWorkflow,
  });
  const switchMode = (mode) => modes.setOrchestrationMode(mode, { scope: 'session' });
  const switchWorkflow = (id) => workflows.setWorkflow(id, { scope: 'session' });
  return { state, refresh, switchMode, switchWorkflow, modes };
}

/** A lead session that started on `mode` (resolved while empty) and has a conversation. */
async function conversationSession(mode = 'swarm') {
  const session = leadSession();
  const h = harness(session, { config: { workflow: { active: 'alpha' }, orchestrationMode: mode } });
  assert.equal((await h.refresh.refreshEmptySessionToolPolicy()).appliedToCurrentSession, true);
  assert.equal(session.orchestrationMode, mode);
  session.messages.push({ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' });
  session.providerState = { previousResponseId: 'resp_1' };
  return { session, ...h };
}

const bp3 = (session) => session.messages.find((message) => message.cacheTier === 'tier3').content;
const prefix = (session) =>
  JSON.stringify([
    session.messages.filter((message) => message.role === 'system'),
    session.tools,
    session.deferredToolCatalog,
  ]);
const dividers = (session) =>
  restoreTranscriptItems(session.messages)
    .filter((item) => item.status === 'orchestration-mode-switched')
    .map((item) => `${item.from}>${item.to}`);
const agentDenied = (session) => preDispatchDenyForSession(session, { name: 'agent', arguments: {} });

async function deliver(session, prompt = 'go') {
  const turn = await buildUserTurn({ session, prompt });
  if (turn.orchestrationModeNotice) {
    acknowledgePendingOrchestrationModeNotice(session, turn.orchestrationModeNotice.revision);
  }
  if (turn.workflowNotice) acknowledgePendingWorkflowNotice(session, turn.workflowNotice.revision);
  session.messages.push(turn.userTurnMessage, { role: 'assistant', content: 'ok' });
  return turn;
}

test('a mid-conversation switch keeps the prompt bytes and tells the next turn the new mode with its rules', async () => {
  const { session, state, switchMode } = await conversationSession('swarm');
  assert.match(bp3(session), /# Orchestration Mode: Swarm/);
  const before = prefix(session);

  const result = await switchMode('none');

  assert.equal(result.appliedToCurrentSession, true);
  assert.equal(result.mode, 'none');
  assert.deepEqual(state.saved, [], 'the default for new sessions stays');
  assert.equal(state.config.orchestrationMode, 'swarm');
  assert.equal(session.orchestrationMode, 'none');
  assert.equal(prefix(session), before, 'system blocks and tool schemas are byte-identical');
  assert.deepEqual(session.providerState, { previousResponseId: 'resp_1' });
  assert.equal(session.pendingCacheBreakIntent, undefined, 'no cache break');
  assert.deepEqual(
    result.orchestrationModeSwitch && [result.orchestrationModeSwitch.from, result.orchestrationModeSwitch.to],
    ['swarm', 'none']
  );
  assert.deepEqual(dividers(session), ['swarm>none']);
  assert.equal(agentDenied(session), null, 'Solo still lets the Lead delegate on request');

  const turn = await buildUserTurn({ session, prompt: 'continue' });
  const content = turn.userTurnMessage.content;
  assert.match(content, /# Orchestration Mode Changed\nThis conversation now uses the Solo orchestration mode\./);
  assert.match(content, /replaces every earlier Orchestration Mode Changed reminder/);
  assert.ok(content.includes(orchestrationInstructions('none')), 'the rules BP3 carries for Solo');
  const retry = await buildUserTurn({ session, prompt: 'continue' });
  assert.equal(retry.orchestrationModeNotice.content, turn.orchestrationModeNotice.content, 're-sent until accepted');
  assert.equal(acknowledgePendingOrchestrationModeNotice(session, turn.orchestrationModeNotice.revision), true);
  session.messages.push(turn.userTurnMessage, { role: 'assistant', content: 'ok' });
  const later = await buildUserTurn({ session, prompt: 'more' });
  assert.equal(later.orchestrationModeNotice, null);
  assert.equal(later.userTurnMessage.content, 'more');
  assert.equal(prefix(session), before);
});

test('Solo → Swarm: `agent` stays deferred and the notice says to load it', async () => {
  const { session, switchMode } = await conversationSession('none');
  assert.equal(
    session.tools.some((tool) => tool.name === 'agent'),
    false,
    'Solo built `agent` deferred'
  );
  assert.ok(session.deferredToolCatalog.some((tool) => tool.name === 'agent'));
  const before = prefix(session);
  await switchMode('swarm');
  assert.equal(prefix(session), before);
  assert.equal(agentDenied(session), null);
  assert.deepEqual(session.orchestrationModeOverlay.loadableTools, ['agent']);
  const turn = await buildUserTurn({ session, prompt: 'split it' });
  assert.match(
    turn.userTurnMessage.content,
    /`agent`: not among your directly defined tools yet; load it with `load_tool`/
  );
  assert.ok(turn.userTurnMessage.content.includes(orchestrationInstructions('swarm')));
});

test('back to the prompt mode removes the overlay; after a delivered notice the newest says the prompt applies', async (t) => {
  const { session, switchMode } = await conversationSession('swarm');
  const before = prefix(session);
  t.mock.method(Date, 'now', () => 1_800_000_000_000);
  await switchMode('none');
  await switchMode('swarm');
  assert.equal(session.orchestrationModeOverlay, undefined);
  assert.equal(session.orchestrationModeSwitch, undefined, 'nothing to tell');
  assert.deepEqual(dividers(session), ['swarm>none', 'none>swarm']);

  await switchMode('focused');
  await deliver(session);
  await switchMode('swarm');
  assert.equal(session.orchestrationModeOverlay, undefined);
  const back = await buildUserTurn({ session, prompt: 'again' });
  assert.match(
    back.orchestrationModeNotice.content,
    /now uses the Swarm orchestration mode, the one the system prompt carries/
  );
  assert.equal(prefix(session), before);
});

test('a compaction after a switch folds the new mode into the prompt', async () => {
  const { session, refresh, switchMode } = await conversationSession('swarm');
  await switchMode('focused');
  await deliver(session);
  assert.equal(await refresh.applyPendingAgentProfile(), false, 'warm: nothing folds');
  session.pendingCacheBreakIntent = 'post_turn_compaction';
  assert.equal(await refresh.applyPendingAgentProfile(), true);
  assert.match(bp3(session), /# Orchestration Mode: Focused/);
  assert.doesNotMatch(bp3(session), /# Orchestration Mode: Swarm/);
  assert.equal(session.orchestrationModeOverlay, undefined);
  assert.equal(session.orchestrationMode, 'focused');
});

test('a switch during a turn is accepted, shown at once and applied when the next turn starts', async () => {
  const { session, state, refresh, switchMode } = await conversationSession('swarm');
  const before = JSON.stringify(session);
  state.turns = 1;
  const result = await switchMode('none');
  assert.equal(result.deferred, true);
  assert.equal(result.mode, 'none', 'the select shows the choice');
  assert.equal(session.orchestrationMode, 'swarm', 'the running turn keeps its mode');
  assert.equal(session.orchestrationModeSwitch, undefined);
  assert.deepEqual(dividers(session), []);
  // Several choices collapse to the last one.
  assert.equal((await switchMode('focused')).mode, 'focused');
  assert.equal(session.pendingOrchestrationMode, 'focused');
  assert.deepEqual(state.saved, []);

  // Next turn start (the turn counter already holds it).
  const switches = refresh.applyPendingSessionSwitches();
  assert.deepEqual([switches.orchestrationModeSwitch.from, switches.orchestrationModeSwitch.to], ['swarm', 'focused']);
  assert.equal(session.orchestrationMode, 'focused');
  assert.equal(session.pendingOrchestrationMode, undefined);
  assert.deepEqual(dividers(session), ['swarm>focused']);
  const turn = await buildUserTurn({ session, prompt: 'next' });
  assert.ok(turn.userTurnMessage.content.includes(orchestrationInstructions('focused')));
  assert.equal(refresh.applyPendingSessionSwitches(), null, 'applied once');
  assert.notEqual(JSON.stringify(session), before);
});

test('choosing the current mode again during the turn cancels the pending switch', async () => {
  const { session, state, refresh, switchMode } = await conversationSession('swarm');
  state.turns = 1;
  await switchMode('none');
  const result = await switchMode('swarm');
  assert.equal(result.mode, 'swarm');
  assert.equal(session.pendingOrchestrationMode, undefined);
  assert.equal(refresh.applyPendingSessionSwitches(), null);
  assert.equal(session.orchestrationMode, 'swarm');
  assert.deepEqual(dividers(session), []);
});

test('a workflow switch during a turn is deferred the same way, collapsing and cancelling', async () => {
  const { session, state, refresh, switchWorkflow } = await conversationSession('swarm');
  state.turns = 1;
  const result = await switchWorkflow('beta');
  assert.equal(result.deferred, true);
  assert.equal(result.id, 'beta');
  assert.equal(session.workflow.id, 'alpha');
  await switchWorkflow('alpha');
  assert.equal(session.pendingWorkflowId, undefined, 'cancelled');
  assert.equal(refresh.applyPendingSessionSwitches(), null);
  await switchWorkflow('beta');
  const switches = refresh.applyPendingSessionSwitches();
  assert.deepEqual([switches.workflowSwitch.from, switches.workflowSwitch.to], ['Alpha', 'Beta']);
  assert.equal(session.workflow.id, 'beta');
  assert.equal(session.orchestrationMode, 'swarm', 'the session keeps its own mode');
  assert.deepEqual(state.saved, []);
});

const workflowNotes = (session) =>
  restoreTranscriptItems(session.messages)
    .filter((item) => item.status === 'workflow-switched')
    .map((item) => `${item.from}>${item.to}${item.unavailable ? ' unavailable' : ''}`);
const occurrences = (text, needle) => text.split(needle).length - 1;

test('a switch is saved before it is acknowledged; after a restart the pending choice applies on the next turn', async () => {
  const { state, switchMode, switchWorkflow } = await conversationSession('swarm');
  state.turns = 1;
  let release;
  state.persistGate = new Promise((resolve) => {
    release = resolve;
  });
  let acknowledged = false;
  const accepted = switchMode('none').then((result) => {
    acknowledged = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(acknowledged, false, 'no success before the save lands');
  assert.equal(state.persisted.at(-1)?.pendingOrchestrationMode, 'none');
  release();
  assert.equal((await accepted).deferred, true);
  state.persistGate = null;
  await switchWorkflow('beta');
  assert.equal(state.persisted.at(-1).pendingWorkflowId, 'beta');
  assert.equal(state.persisted.at(-1).pendingOrchestrationMode, 'none');

  // The daemon restarts: a fresh runtime over the saved record.
  const restored = state.persisted.at(-1);
  const after = harness(restored);
  const switches = after.refresh.applyPendingSessionSwitches();
  assert.deepEqual([switches.orchestrationModeSwitch.from, switches.orchestrationModeSwitch.to], ['swarm', 'none']);
  assert.deepEqual([switches.workflowSwitch.from, switches.workflowSwitch.to], ['Alpha', 'Beta']);
  assert.equal(restored.orchestrationMode, 'none');
  assert.equal(restored.workflow.id, 'beta');
  assert.equal(restored.pendingOrchestrationMode, undefined);
  assert.equal(restored.pendingWorkflowId, undefined);
  assert.deepEqual(dividers(restored), ['swarm>none']);
  const turn = await buildUserTurn({ session: restored, prompt: 'next' });
  assert.ok(turn.userTurnMessage.content.includes(orchestrationInstructions('none')));

  // A switch between turns is saved too.
  state.turns = 0;
  const saves = state.persisted.length;
  await switchMode('focused');
  assert.equal(state.persisted.length, saves + 1);
  assert.equal(state.persisted.at(-1).orchestrationMode, 'focused');
});

test('a pending workflow that is gone at the next turn is dropped alone with a note; the mode still applies', async () => {
  const { session, state, refresh, switchMode, switchWorkflow } = await conversationSession('swarm');
  state.turns = 1;
  await switchMode('none');
  await switchWorkflow('beta');
  const beta = PACKS.beta;
  delete PACKS.beta;
  try {
    const switches = refresh.applyPendingSessionSwitches();
    assert.equal(switches.workflowSwitch.unavailable, true);
    assert.equal(session.workflow.id, 'alpha', 'the turn runs on the current workflow');
    assert.equal(session.workflowOverlay, undefined);
    assert.equal(session.workflowSwitch, undefined, 'no workflow notice');
    assert.equal(session.orchestrationMode, 'none', 'the valid mode choice is kept');
    assert.deepEqual(dividers(session), ['swarm>none']);
    assert.deepEqual(workflowNotes(session), ['Alpha>beta unavailable']);
    assert.equal(session.pendingWorkflowId, undefined);
    assert.equal(session.pendingOrchestrationMode, undefined);
  } finally {
    PACKS.beta = beta;
  }

  // A pack that cannot be read is dropped the same way, never failing the turn.
  session.pendingWorkflowId = 'broken';
  Object.defineProperty(PACKS, 'broken', {
    configurable: true,
    get() {
      throw new Error('WORKFLOW.md unreadable');
    },
  });
  try {
    const switches = refresh.applyPendingSessionSwitches();
    assert.equal(switches.workflowSwitch.unavailable, true);
    assert.match(switches.workflowSwitch.reason, /unreadable/);
    assert.equal(session.workflow.id, 'alpha');
    assert.equal(session.pendingWorkflowId, undefined);
  } finally {
    delete PACKS.broken;
  }
});

test('a retried turn carries the notice once and adds no second divider', async () => {
  const { session, state, refresh, switchMode } = await conversationSession('swarm');
  state.turns = 1;
  await switchMode('none');
  refresh.applyPendingSessionSwitches();
  const failed = await buildUserTurn({ session, prompt: 'go' });
  assert.equal(occurrences(failed.userTurnMessage.content, '# Orchestration Mode Changed'), 1);
  // The turn failed before the provider accepted it; the retry starts again.
  assert.equal(refresh.applyPendingSessionSwitches(), null);
  const retry = await buildUserTurn({ session, prompt: 'go' });
  assert.equal(occurrences(retry.userTurnMessage.content, '# Orchestration Mode Changed'), 1);
  assert.equal(retry.orchestrationModeNotice.revision, failed.orchestrationModeNotice.revision);
  assert.deepEqual(dividers(session), ['swarm>none']);
});

test('a compaction between acceptance and the next turn: the choice survives and is folded into the prompt', async () => {
  const { session, state, refresh, switchMode } = await conversationSession('swarm');
  state.turns = 1;
  await switchMode('focused');
  state.turns = 0;
  // The post-turn compaction rewrites the conversation in place.
  session.messages = [
    ...session.messages.filter((message) => message.role === 'system'),
    { role: 'user', content: 'Summary of the conversation so far.' },
  ];
  session.pendingCacheBreakIntent = 'post_turn_compaction';
  assert.equal(session.pendingOrchestrationMode, 'focused');

  state.turns = 1;
  const switches = refresh.applyPendingSessionSwitches();
  assert.deepEqual([switches.orchestrationModeSwitch.from, switches.orchestrationModeSwitch.to], ['swarm', 'focused']);
  assert.equal(await refresh.applyPendingAgentProfile(), true, 'the cold cache folds the new mode in');
  assert.match(bp3(session), /# Orchestration Mode: Focused/);
  assert.equal(session.orchestrationModeOverlay, undefined);
  assert.deepEqual(dividers(session), ['swarm>focused']);
  const turn = await buildUserTurn({ session, prompt: 'next' });
  assert.equal(occurrences(turn.userTurnMessage.content, '# Orchestration Mode Changed'), 1);
  assert.match(turn.userTurnMessage.content, /Focused orchestration mode, the one the system prompt carries/);
});

test('a workflow switch keeps a switched mode', async () => {
  const { session, switchMode, switchWorkflow } = await conversationSession('swarm');
  await switchMode('none');
  await switchWorkflow('beta');
  assert.equal(session.orchestrationMode, 'none');
  assert.equal(session.workflowOverlay.promptOrchestrationMode, 'swarm');
  assert.match(session.workflowOverlay.content, /# Orchestration Mode: Solo/);
  await switchWorkflow('alpha');
  assert.equal(session.workflowOverlay, undefined);
  assert.equal(session.orchestrationModeOverlay.prompt, 'swarm', 'the prompt still carries Swarm');
});

test('an empty session keeps today’s semantics: the pick becomes the default and applies in place', async () => {
  const session = leadSession();
  const { state, refresh, switchMode } = harness(session);
  assert.equal(await refresh.switchSessionOrchestrationMode('none'), null);
  const result = await switchMode('none');
  assert.equal(result.appliedToCurrentSession, true);
  assert.deepEqual(
    state.saved.map((entry) => entry.mode),
    ['none']
  );
  assert.equal(session.orchestrationMode, 'none');
  assert.equal(session.orchestrationModeSwitch, undefined);
  assert.match(bp3(session), /# Orchestration Mode: Solo/);
});

test('agent-owned sessions have no orchestration mode to switch', async () => {
  const session = { ...leadSession(), owner: 'agent', agent: 'worker' };
  session.messages.push({ role: 'user', content: 'task' }, { role: 'assistant', content: 'done' });
  const { switchMode, state } = harness(session);
  await assert.rejects(switchMode('none'), /Only a coding session/);
  assert.deepEqual(state.saved, []);
});
