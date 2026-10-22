import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createToolPolicyRefresh } from './tool-policy-refresh.mjs';
import { createStyleAndModeApi } from './workflow-agents-api/style-and-mode.mjs';
import { createWorkflowPacksApi } from './workflow-agents-api/workflow-packs.mjs';
import {
  composeSessionSystem,
  seedSessionMessages,
} from '../runtime/agent/orchestrator/session/manager/session-prompt-composition.mjs';
import { buildUserTurn as buildTurn } from '../runtime/agent/orchestrator/session/manager/ask-turn-prepare.mjs';
import { acknowledgePendingOrchestrationModeNotice } from '../runtime/agent/orchestrator/session/manager/orchestration-mode-switch-notice.mjs';
import { acknowledgePendingWorkflowNotice } from '../runtime/agent/orchestrator/session/manager/workflow-switch-notice.mjs';
import { orchestrationInstructions } from '../runtime/agent/orchestrator/runtime-core/orchestration.mjs';
import { restoreTranscriptItems } from '../runtime/agent/orchestrator/session/transcript-restore/restore.mjs';
import { preDispatchDenyForSession } from '../runtime/agent/orchestrator/session/loop/pre-dispatch-deny.mjs';
import { agentProfileRevision, leadRosterRevision } from '../runtime/agent/orchestrator/context/role-instructions.mjs';
import { _sessionForDisk } from '../runtime/agent/orchestrator/session/store/serialize.mjs';
import { isAgentDisabled, withAgentDisabled } from '../runtime/shared/agent-route-config.mjs';
import { createSpawnPlanner } from './services/agent-tool/spawn-flow/spawn-plan.mjs';
import { stripRuntimeUserContext } from '../runtime/agent/orchestrator/session/runtime-user-context.mjs';
import { buildAgentListingNotice } from '../runtime/agent/orchestrator/session/manager/agent-listing-notice.mjs';

const PACKS = {
  alpha: { id: 'alpha', name: 'Alpha', delegatesAgents: true, body: 'ALPHA RULES' },
  beta: { id: 'beta', name: 'Beta', delegatesAgents: true, body: 'BETA RULES' },
};

// As workflow/context.mjs: the one agent (Worker) delegates unless switched off.
function workflowContext(cfg) {
  const pack = PACKS[cfg?.workflow?.active] || PACKS.alpha;
  const mode = cfg?.orchestrationMode || 'swarm';
  const agents = !isAgentDisabled(cfg, 'worker');
  return {
    summary: { id: pack.id, name: pack.name, description: '', source: 'built-in', delegatesAgents: agents },
    orchestrationMode: mode,
    packContext: `# Active Workflow: ${pack.name}\n\n${pack.body}`,
    leadPromptParts: () => ({
      orchestrationContext: mode === 'none' && !agents ? '' : orchestrationInstructions(mode),
      agentCatalogContext: agents ? '# Available Agents\n\n- Worker (worker)' : '',
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

// As the session runtime's turn does (turn-run.mjs): the turn is built with
// the agents enabled as it starts.
const runtimeOf = new WeakMap();
const buildUserTurn = (args) => buildTurn({ currentAgents: runtimeOf.get(args.session)?.currentAgents?.(), ...args });

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
  runtimeOf.set(session, refresh);
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

/** A lead session that started on `mode` (resolved while empty) and has a
 *  conversation; `agentsOff`: with Worker, its one agent, switched off. */
async function conversationSession(mode = 'swarm', { agentsOff = false, sessionMode = 'coding' } = {}) {
  const session = leadSession();
  session.sessionMode = sessionMode;
  const base = { workflow: { active: 'alpha' }, orchestrationMode: mode };
  const h = harness(session, { config: agentsOff ? withAgentDisabled(base, 'worker', true) : base });
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

// The persisted state produced by the pre-1.3.2 profile-refresh bug: the mode
// setting survived, but the generated prompt took the global default instead.
async function mismatchedModeSession(presented = 'none', selected = 'balanced') {
  const h = await conversationSession(presented);
  h.session.orchestrationMode = selected;
  h.session.agentProfileRevision = agentProfileRevision('lead', { mixy: false });
  h.session.agentRosterRevision = leadRosterRevision(workflowContext(h.state.config).leadPromptParts());
  return h;
}

test('legacy mode recovery on resume repairs the prompt once without changing the selection or tools', async () => {
  const { session, state, refresh } = await mismatchedModeSession();
  const tools = JSON.stringify(session.tools);
  const otherSystem = JSON.stringify(session.messages.filter((m) => m.role === 'system' && m.cacheTier !== 'tier3'));
  const transcript = JSON.stringify(session.messages.filter((m) => m.role !== 'system'));
  assert.equal(await refresh.refreshAgentProfile({ trigger: 'resume' }), true);
  assert.match(bp3(session), /# Orchestration Mode: Balanced/);
  assert.doesNotMatch(bp3(session), /# Orchestration Mode: Solo/);
  assert.equal(session.orchestrationMode, 'balanced');
  assert.equal(state.config.orchestrationMode, 'none', 'the new-session default is not changed');
  assert.deepEqual(state.saved, []);
  assert.equal(JSON.stringify(session.tools), tools);
  assert.equal(
    JSON.stringify(session.messages.filter((m) => m.role === 'system' && m.cacheTier !== 'tier3')),
    otherSystem
  );
  assert.equal(JSON.stringify(session.messages.filter((m) => m.role !== 'system')), transcript);
  assert.equal(session.providerState, undefined, 'old provider replay state cannot carry the stale prefix');
  assert.deepEqual(dividers(session), [], 'repairing the prompt is not a user mode change');

  const restored = JSON.parse(JSON.stringify(_sessionForDisk(session)));
  const resumed = harness(restored, { config: state.config });
  const stable = prefix(restored);
  assert.equal(await resumed.refresh.refreshAgentProfile({ trigger: 'resume' }), false);
  assert.equal(await resumed.refresh.applyPendingAgentProfile(), false);
  assert.equal(prefix(restored), stable, 'the recovery does not break the prefix again');
  const turn = await buildUserTurn({ session: restored, prompt: 'continue' });
  assert.match(turn.historyMessages.find((m) => m.cacheTier === 'tier3').content, /# Orchestration Mode: Balanced/);
  assert.equal(turn.orchestrationModeNotice, null, 'the repaired system prompt itself carries the mode');
});

test('legacy mode recovery reaches the next turn for every recognized mode without a resume or profile edit', async (t) => {
  for (const presented of ['none', 'focused', 'balanced', 'swarm']) {
    for (const selected of ['none', 'focused', 'balanced', 'swarm']) {
      if (presented === selected) continue;
      await t.test(`${presented} → ${selected}`, async () => {
        const { session, refresh } = await mismatchedModeSession(presented, selected);
        assert.equal(await refresh.applyPendingAgentProfile(), true);
        assert.ok(bp3(session).includes(orchestrationInstructions(selected)));
        assert.ok(!bp3(session).includes(orchestrationInstructions(presented)));
        assert.equal(session.orchestrationMode, selected);
        assert.equal(await refresh.applyPendingAgentProfile(), false);
      });
    }
  }
});

test('legacy mode recovery does not rewrite an executing turn and applies before the next one', async () => {
  const { session, state, refresh } = await mismatchedModeSession();
  const before = prefix(session);
  state.turns = 1;
  assert.equal(await refresh.refreshAgentProfile({ trigger: 'resume' }), false);
  assert.equal(prefix(session), before);
  state.turns = 0;
  assert.equal(await refresh.applyPendingAgentProfile(), true);
  assert.match(bp3(session), /# Orchestration Mode: Balanced/);
});

test('legacy mode recovery also repairs recognized unstamped and cold-cache records', async (t) => {
  for (const cold of [false, true]) {
    await t.test(cold ? 'after compaction' : 'unstamped resume', async () => {
      const { session, refresh } = await mismatchedModeSession();
      delete session.agentProfileRevision;
      delete session.agentRosterRevision;
      if (cold) session.pendingCacheBreakIntent = 'manual_compaction';
      assert.equal(await refresh.refreshAgentProfile({ trigger: 'resume' }), true);
      assert.match(bp3(session), /# Orchestration Mode: Balanced/);
      assert.equal(await refresh.applyPendingAgentProfile(), false);
    });
  }
});

test('legacy mode recovery leaves pending user choices and valid overlays in charge', async () => {
  const { session, state, refresh, switchMode } = await mismatchedModeSession();
  state.turns = 1;
  await switchMode('focused');
  state.turns = 0;
  const before = prefix(session);
  assert.equal(await refresh.refreshAgentProfile({ trigger: 'resume' }), false);
  assert.equal(session.pendingOrchestrationMode, 'focused');
  assert.equal(prefix(session), before);
  refresh.applyPendingSessionSwitches();
  assert.equal(await refresh.applyPendingAgentProfile(), false);
  assert.equal(session.orchestrationMode, 'focused');
  assert.equal(prefix(session), before, 'normal mode switches still preserve their cached prefix');
  const turn = await deliver(session);
  assert.ok(turn.orchestrationModeNotice.content.includes(orchestrationInstructions('focused')));
});

test('legacy mode recovery preserves the notice when a user returns to the original mode or workflow', async (t) => {
  for (const kind of ['mode', 'workflow']) {
    await t.test(kind, async () => {
      const { session, refresh, switchMode, switchWorkflow } = await mismatchedModeSession();
      if (kind === 'mode') await switchMode('focused');
      else await switchWorkflow('beta');
      await deliver(session);
      if (kind === 'mode') await switchMode('balanced');
      else await switchWorkflow('alpha');
      const field = kind === 'mode' ? 'orchestrationModeSwitch' : 'workflowSwitch';
      const notice = JSON.stringify(session[field]);
      assert.ok(session[field], 'the return-to-prompt notice is still pending');
      assert.equal(await refresh.applyPendingAgentProfile(), true);
      assert.match(bp3(session), /# Orchestration Mode: Balanced/);
      assert.equal(JSON.stringify(session[field]), notice, 'the user change is not dropped or replaced');
      const turn = await deliver(session);
      assert.ok(kind === 'mode' ? turn.orchestrationModeNotice : turn.workflowNotice);
      assert.equal(await refresh.applyPendingAgentProfile(), false);
    });
  }
});

test('legacy mode recovery does not infer modes from custom, ambiguous, or non-coding prompts', async (t) => {
  const cases = {
    custom: (session) => {
      const message = session.messages.find((m) => m.cacheTier === 'tier3');
      // Still listing the agent: a missing one would be announced (agent-listing-notice.mjs).
      message.content =
        '# Active Workflow: Alpha\n\n# Orchestration Mode: Solo\n\nCustom rules.\n\n---\n\n# Available Agents\n\n- Worker (worker)';
      session.bp3CoreContext = message.content;
    },
    ambiguous: (session) => {
      const message = session.messages.find((m) => m.cacheTier === 'tier3');
      message.content += `\n\n---\n\n${orchestrationInstructions('focused')}`;
      session.bp3CoreContext = message.content;
    },
    'no identity': (session) => {
      delete session.promptIdentity;
    },
    'no recorded mode': (session) => {
      delete session.orchestrationMode;
    },
    'unknown recorded mode': (session) => {
      session.orchestrationMode = 'custom';
    },
    'custom role policy': (session) => {
      session.promptIdentity.skipAgentRules = true;
    },
    'agent mode': (session) => {
      session.sessionMode = 'agent';
    },
    worker: (session) => {
      session.owner = 'agent';
      session.agent = 'worker';
    },
  };
  for (const [name, arrange] of Object.entries(cases)) {
    await t.test(name, async () => {
      const { session, refresh } = await mismatchedModeSession();
      arrange(session);
      const before = prefix(session);
      assert.equal(await refresh.applyPendingAgentProfile(), false);
      assert.equal(prefix(session), before);
    });
  }
});

// #184: agents switched on or off while a conversation is open.
const setWorker = (state, on) => {
  state.config = withAgentDisabled(state.config, 'worker', !on);
};
const ROSTER_WORKER = /# Available Agents\n\n- Worker \(worker\)/;

const ADDED_WORKER = /# Available Agents Changed\n[\s\S]*New agents are now available[^\n]*\n- Worker \(worker\)/;
const REMOVED_WORKER = /no longer available[^\n]*\n- Worker \(worker\)/;
const loadable = (session) => (session.deferredToolCatalog || []).some((tool) => tool.name === 'agent');

/** A session saved before agents reached a coding Lead as a reminder: it
 *  started without agents, so the old rule denied `agent` and dropped it. */
function savedBeforeTheFix(session) {
  session.workflow.delegatesAgents = false;
  session.disallowedTools = [...new Set([...(session.disallowedTools || []), 'agent'])];
  session.tools = session.tools.filter((tool) => tool.name !== 'agent');
  session.deferredToolCatalog = (session.deferredToolCatalog || []).filter((tool) => tool.name !== 'agent');
}

/** The session as it is read back after a restart, in a new runtime. */
async function restart(session, state) {
  const restored = JSON.parse(JSON.stringify(_sessionForDisk(session)));
  const after = harness(restored, { config: state.config });
  await after.refresh.refreshAgentProfile({ trigger: 'resume' });
  return { session: restored, ...after };
}

test('a Lead started without agents keeps `agent` loadable; an agent switched on is announced at the next turn', async () => {
  const { session, state, refresh } = await conversationSession('none', { agentsOff: true });
  assert.ok(loadable(session) && agentDenied(session) === null, 'Solo keeps `agent` deferred without agents');
  assert.doesNotMatch(bp3(session), ROSTER_WORKER);
  const before = prefix(session);

  setWorker(state, true);
  await refresh.applyPendingAgentProfile();
  const turn = await deliver(session);
  assert.match(turn.agentListingNotice.content, ADDED_WORKER);
  assert.ok(turn.userTurnMessage.content.includes(turn.agentListingNotice.content), 'it rides the user turn');
  assert.equal(prefix(session), before, 'system blocks and tool schemas are byte-identical');
  assert.equal(session.pendingCacheBreakIntent, undefined, 'no cache break');
  assert.deepEqual(session.providerState, { previousResponseId: 'resp_1' });
  assert.equal(agentDenied(session), null);

  assert.equal(await refresh.applyPendingAgentProfile(), false, 'nothing changed since');
  assert.equal((await buildUserTurn({ session, prompt: 'more' })).agentListingNotice, null);
});

test('an agent switched on while the app was closed is announced after the restart; told once', async () => {
  const { session, state } = await conversationSession('none', { agentsOff: true });
  setWorker(state, true);
  const first = await restart(session, state);
  await first.refresh.applyPendingAgentProfile();
  assert.match((await deliver(first.session)).agentListingNotice.content, ADDED_WORKER);

  const second = await restart(first.session, state);
  assert.equal(await second.refresh.applyPendingAgentProfile(), false);
  assert.equal((await buildUserTurn({ session: second.session, prompt: 'go' })).agentListingNotice, null);
});

test('switching off the last agent: the next turn says it was removed, and a spawn naming it is refused', async (t) => {
  const { session, state, refresh } = await conversationSession('swarm');
  assert.match(bp3(session), ROSTER_WORKER);
  const before = prefix(session);
  setWorker(state, false);
  await refresh.applyPendingAgentProfile();
  const told = (await deliver(session)).agentListingNotice.content;
  assert.match(told, REMOVED_WORKER);
  assert.match(told, /No agents are enabled now/);
  assert.equal(prefix(session), before);

  const root = mkdtempSync(join(tmpdir(), 'mixdog-agent-listing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'agents'), { recursive: true });
  writeFileSync(join(root, 'agents', 'worker.md'), '---\ndescription: worker\n---\nWork.\n');
  const { resolveSpawnPlan } = createSpawnPlanner({
    cfgMod: { loadConfig: () => state.config },
    dataDir: join(root, 'data'),
    STANDALONE_SOURCE_ROOT: root,
    defaultCwd: root,
    nextTag: () => 'tag1',
    resolveTag: () => null,
    wantsSessionScan: () => false,
  });
  await assert.rejects(
    resolveSpawnPlan({ agent: 'worker', provider: 'p', model: 'm', prompt: 'do it' }, root, {}),
    /agent "worker" is turned off/
  );
});

// The user turn is in the conversation from the moment it is built (the
// provider call comes after); `settle` is how the turn then ends.
async function turnThat(session, settle) {
  const turn = await buildUserTurn({ session, prompt: 'go' });
  session.messages.push(turn.userTurnMessage);
  if (settle === 'answered') session.messages.push({ role: 'assistant', content: 'ok' });
  if (settle === 'rolled back') session.messages.pop();
  return turn;
}

test('an agent switched off while the turn announcing it runs is told as removed at the next turn', async () => {
  const { session, state, refresh } = await conversationSession('none', { agentsOff: true });
  setWorker(state, true);
  await refresh.applyPendingAgentProfile();
  const turn = await buildUserTurn({ session, prompt: 'go' });
  session.messages.push(turn.userTurnMessage);
  assert.match(turn.agentListingNotice.content, ADDED_WORKER);
  // While it runs: switched off, and the agents re-read (another path, as a resume does).
  setWorker(state, false);
  await refresh.refreshAgentProfile({ trigger: 'resume' });
  session.messages.push({ role: 'assistant', content: 'ok' });
  await refresh.applyPendingAgentProfile();
  const next = (await buildUserTurn({ session, prompt: 'more' })).agentListingNotice;
  assert.match(next.content, REMOVED_WORKER);
});

test('a failed turn that kept its reminder counts as told; a rolled-back one is told again', async (t) => {
  for (const [settle, repeated] of [
    ['failed', false],
    ['rolled back', true],
  ]) {
    await t.test(settle, async () => {
      const { session, state, refresh } = await conversationSession('none', { agentsOff: true });
      setWorker(state, true);
      await refresh.applyPendingAgentProfile();
      assert.match((await turnThat(session, settle)).agentListingNotice.content, ADDED_WORKER);
      await refresh.applyPendingAgentProfile();
      const next = (await buildUserTurn({ session, prompt: 'retry' })).agentListingNotice;
      if (repeated) assert.match(next.content, ADDED_WORKER);
      else assert.equal(next, null);
    });
  }
});

test("a compaction that strips the retained turn's reminder makes the agent announced again", async () => {
  const { session, state, refresh } = await conversationSession('none', { agentsOff: true });
  setWorker(state, true);
  await refresh.applyPendingAgentProfile();
  assert.match((await turnThat(session, 'answered')).agentListingNotice.content, ADDED_WORKER);
  assert.equal((await buildUserTurn({ session, prompt: 'more' })).agentListingNotice, null, 'told while it is held');
  // Compaction keeps older user turns without their runtime reminders.
  session.messages = session.messages.map(stripRuntimeUserContext);
  assert.ok(
    session.messages.every((message) => !message.meta?.agentListing),
    'no stale told-record'
  );
  assert.match((await buildUserTurn({ session, prompt: 'after' })).agentListingNotice.content, ADDED_WORKER);
});

const rosterSlice = (session) =>
  bp3(session)
    .split('\n\n---\n\n')
    .filter((slice) => slice.startsWith('# Available Agents'));

test('a prompt rebuilt at a cold point keeps the agent list the model saw first; reminders still apply once', async () => {
  const { session, state, refresh, switchMode } = await conversationSession('swarm', { agentsOff: true });
  const roster = rosterSlice(session);
  assert.deepEqual(roster, [], 'built without agents');
  setWorker(state, true);
  await refresh.applyPendingAgentProfile();
  assert.match((await deliver(session)).agentListingNotice.content, ADDED_WORKER);
  setWorker(state, false);
  await refresh.applyPendingAgentProfile();
  assert.match((await deliver(session)).agentListingNotice.content, REMOVED_WORKER);
  setWorker(state, true);
  // A pending fold (a mode switch) at a compaction that kept the recent turns.
  await switchMode('focused');
  session.pendingCacheBreakIntent = 'manual_compaction';
  await refresh.applyPendingAgentProfile();
  assert.match(bp3(session), /# Orchestration Mode: Focused/, 'the fold ran');
  assert.deepEqual(rosterSlice(session), roster, 'the agent list slice is unchanged');
  const told = (await deliver(session)).agentListingNotice.content;
  assert.equal(told.match(/- Worker \(worker\)/g).length, 1);
  assert.match(told, ADDED_WORKER);
  await refresh.applyPendingAgentProfile();
  assert.equal((await buildUserTurn({ session, prompt: 'more' })).agentListingNotice, null, 'no duplicate');
});

test('the agents enabled now are the turn input, never session state', async () => {
  const { session, refresh } = await conversationSession('swarm');
  const before = JSON.stringify(session);
  assert.deepEqual(
    refresh.currentAgents().map((entry) => entry.id),
    ['worker'],
    'resolved even when the conversation already knows them'
  );
  await refresh.applyPendingAgentProfile();
  assert.equal(JSON.stringify(session), before);
  assert.equal(buildAgentListingNotice(session, undefined), null, 'no input, no reminder');
});

test('a custom or duplicated agent list slice is not kept by a rebuilt prompt nor taken as the list told', async (t) => {
  const cases = {
    custom: '# Available Agents\n\nAsk the user before delegating anything.',
    duplicate: '# Available Agents\n\n- Worker (worker)\n\n---\n\n# Available Agents\n\n- Worker (worker)',
  };
  for (const [name, slice] of Object.entries(cases)) {
    await t.test(name, async () => {
      const { session, refresh, switchMode } = await conversationSession('swarm');
      const message = session.messages.find((m) => m.cacheTier === 'tier3');
      message.content = message.content.replace('# Available Agents\n\n- Worker (worker)', slice);
      assert.equal(
        buildAgentListingNotice(session, refresh.currentAgents()).meta.added[0].id,
        'worker',
        'the prompt lists no valid agent list'
      );
      await switchMode('focused');
      session.pendingCacheBreakIntent = 'manual_compaction';
      await refresh.applyPendingAgentProfile();
      assert.match(bp3(session), /# Orchestration Mode: Focused/, 'the fold ran');
      assert.equal(bp3(session).includes(slice), false, 'rebuilt, not kept');
      assert.match(bp3(session), /# Available Agents\n\n- Worker \(worker\)/);
    });
  }
});

test('a compaction that dropped the reminder announces the agents again', async () => {
  const { session, state, refresh } = await conversationSession('none', { agentsOff: true });
  setWorker(state, true);
  await refresh.applyPendingAgentProfile();
  await deliver(session);
  assert.equal(await refresh.applyPendingAgentProfile(), false);
  session.messages = [
    ...session.messages.filter((message) => message.role === 'system'),
    { role: 'user', content: 'summary of the work so far' },
  ];
  await refresh.applyPendingAgentProfile();
  assert.match((await buildUserTurn({ session, prompt: 'go' })).agentListingNotice.content, ADDED_WORKER);
});

test('a mode switch after an agent was switched on offers `agent` and announces it (repro #184)', async () => {
  const { session, state, refresh, switchMode } = await conversationSession('none', { agentsOff: true });
  setWorker(state, true);
  await switchMode('swarm');
  assert.deepEqual(session.orchestrationModeOverlay.loadableTools, ['agent']);
  await refresh.applyPendingAgentProfile();
  const turn = await buildUserTurn({ session, prompt: 'split it' });
  assert.match(turn.orchestrationModeNotice.content, /`agent`: not among your directly defined tools yet; load it/);
  assert.ok(turn.orchestrationModeNotice.content.includes(orchestrationInstructions('swarm')));
  assert.match(turn.agentListingNotice.content, ADDED_WORKER);
});

test('a session saved before the fix, its prompt listing no agents, hears of Worker and gets `agent` back', async () => {
  // As reported: started without agents, switched to Swarm (delivered), Worker enabled, app restarted.
  const { session, state, switchMode } = await conversationSession('none', { agentsOff: true });
  savedBeforeTheFix(session);
  await switchMode('swarm');
  await deliver(session);
  assert.match(String(agentDenied(session)), /not available/, 'the old rule refused it');
  setWorker(state, true);

  const resumed = await restart(session, state);
  const before = JSON.stringify([
    resumed.session.messages.filter((message) => message.role === 'system'),
    resumed.session.tools,
  ]);
  await resumed.refresh.applyPendingAgentProfile();
  assert.equal(agentDenied(resumed.session), null, 'lifted');
  assert.ok(loadable(resumed.session), 'loadable through load_tool');
  assert.deepEqual(
    resumed.session.pendingDeferredToolDelta.added.map((entry) => entry.name),
    ['agent'],
    'the deferred_tools_delta announces it'
  );
  const turn = await buildUserTurn({ session: resumed.session, prompt: 'continue' });
  assert.match(turn.agentListingNotice.content, ADDED_WORKER);
  assert.equal(turn.orchestrationModeNotice, null, 'the delivered mode notice is not repeated');
  assert.equal(
    JSON.stringify([resumed.session.messages.filter((message) => message.role === 'system'), resumed.session.tools]),
    before,
    'the request prefix is untouched'
  );
});

test('a session saved before the fix whose prompt already lists Worker gets no reminder', async () => {
  const { session, state } = await conversationSession('swarm');
  const resumed = await restart(session, state);
  assert.equal(await resumed.refresh.applyPendingAgentProfile(), false);
  assert.ok(!(await buildUserTurn({ session: resumed.session, prompt: 'go' })).agentListingNotice);
});

test('a bot thread keeps its own agent handling: no listing reminder, and no `agent` without sub-agents', async () => {
  const { session, state, refresh } = await conversationSession('swarm', { agentsOff: true, sessionMode: 'agent' });
  assert.match(String(agentDenied(session)), /not available/);
  setWorker(state, true);
  await refresh.applyPendingAgentProfile();
  assert.ok(!(await buildUserTurn({ session, prompt: 'go' })).agentListingNotice);
});
