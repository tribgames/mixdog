import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createToolPolicyRefresh } from './tool-policy-refresh.mjs';
import { createWorkflowPacksApi } from './workflow-agents-api/workflow-packs.mjs';
import {
  composeSessionSystem,
  seedSessionMessages,
} from '../runtime/agent/orchestrator/session/manager/session-prompt-composition.mjs';
import { buildUserTurn as buildTurn } from '../runtime/agent/orchestrator/session/manager/ask-turn-prepare.mjs';
import { acknowledgePendingWorkflowNotice } from '../runtime/agent/orchestrator/session/manager/workflow-switch-notice.mjs';
import { restoreTranscriptItems } from '../runtime/agent/orchestrator/session/transcript-restore/restore.mjs';
import { preDispatchDenyForSession } from '../runtime/agent/orchestrator/session/loop/pre-dispatch-deny.mjs';
import { isToolPermittedBySessionPolicy } from '../runtime/agent/orchestrator/runtime-core/deferred-tool-availability.mjs';

const PACKS = {
  alpha: {
    summary: { id: 'alpha', name: 'Alpha', description: '', source: 'built-in', delegatesAgents: true },
    packContext: '# Active Workflow: Alpha\n\nALPHA RULES',
    leadPromptParts: () => ({
      orchestrationContext: '# Delegation\n\nDelegate with `agent`.',
      agentCatalogContext: '# Available Agents\n\n- Worker (worker)',
    }),
  },
  beta: {
    summary: { id: 'beta', name: 'Beta', description: '', source: 'user', delegatesAgents: false },
    packContext: '# Active Workflow: Beta\n\nBETA RULES',
    leadPromptParts: () => ({}),
  },
};

const NOTICE_HEAD = '<system-reminder>\n# Workflow Changed\nThis conversation now runs the Beta workflow.';

function leadSession() {
  const prompt = composeSessionSystem(
    { owner: 'user', workflowContext: PACKS.alpha.packContext, coreMemoryContext: 'OLD MEMORY' },
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

function harness(session, { activeTurns = () => 0, config = { workflow: { active: 'alpha' } } } = {}) {
  const state = { config, memory: 'OLD MEMORY', saved: [], persisted: [] };
  const refresh = createToolPolicyRefresh({
    getSession: () => session,
    getRoute: () => ({ provider: 'openai', model: 'test' }),
    getMode: () => 'full',
    getConfig: () => state.config,
    getDataDir: () => '',
    getActiveTurnCount: activeTurns,
    modelStandaloneTools: () => [{ name: 'read' }, { name: 'agent' }],
    featureDisallowedTools: () => [],
    loadCoreMemoryContext: async () => state.memory,
    activeWorkflowContext: (cfg) => {
      const pack = PACKS[cfg?.workflow?.active] || PACKS.alpha;
      return { ...pack, orchestrationMode: cfg?.orchestrationMode || 'swarm' };
    },
    invalidatePreSessionToolSurface: () => {},
    persistSession: async (saved) => {
      state.persisted.push(JSON.parse(JSON.stringify(saved)));
    },
  });
  runtimeOf.set(session, refresh);
  const api = createWorkflowPacksApi({
    getConfig: () => state.config,
    saveConfigAndAdopt: (next) => {
      state.saved.push(next.workflow.active);
      state.config = next;
    },
    displayConfig: () => state.config,
    activeWorkflowId: (cfg) => cfg?.workflow?.active || 'alpha',
    listWorkflowPacks: () => [],
    loadWorkflowPack: (_dir, id) => (PACKS[id] ? { id, name: PACKS[id].summary.name } : null),
    workflowSummary: (pack) => ({ id: pack.id, name: pack.name }),
    cfgMod: { getPluginData: () => 'data' },
    refreshEmptySessionToolPolicy: refresh.refreshEmptySessionToolPolicy,
    switchSessionWorkflow: refresh.switchSessionWorkflow,
  });
  return { state, refresh, api };
}

/** A lead session that started on Alpha (tools resolved while empty) and has a conversation. */
async function conversationSession(options) {
  const session = leadSession();
  const h = harness(session, options);
  assert.equal((await h.refresh.refreshEmptySessionToolPolicy()).appliedToCurrentSession, true);
  session.messages.push({ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' });
  session.providerState = { previousResponseId: 'resp_1' };
  return { session, ...h };
}

const toolNames = (session) => [
  ...new Set([...(session.tools || []), ...(session.deferredToolCatalog || [])].map((tool) => tool.name)),
];
const bp3 = (session) => session.messages.find((message) => message.cacheTier === 'tier3').content;

/** What the next request sends ahead of the conversation: system blocks and tool schemas. */
const prefix = (session) =>
  JSON.stringify([
    session.messages.filter((message) => message.role === 'system'),
    session.tools,
    session.deferredToolCatalog,
  ]);

test('a switch in a conversation keeps the request prefix and gives the next turn the new workflow as a reminder', async () => {
  const { session, state, api } = await conversationSession();
  assert.ok(toolNames(session).includes('agent'));
  assert.match(bp3(session), /ALPHA RULES[\s\S]*# Available Agents/);
  const before = prefix(session);
  state.memory = 'NEW MEMORY';

  const result = await api.setWorkflow('beta', { scope: 'session' });

  assert.equal(result.appliedToCurrentSession, true);
  assert.equal(result.id, 'beta');
  assert.deepEqual(state.saved, [], 'the default for new sessions stays');
  assert.equal(state.config.workflow.active, 'alpha');
  assert.equal(session.workflow.id, 'beta');
  assert.equal(session.workflow.delegatesAgents, false);
  assert.equal(prefix(session), before, 'system blocks and tool schemas are byte-identical');
  assert.deepEqual(session.providerState, { previousResponseId: 'resp_1' }, 'the provider chain is kept');
  assert.equal(session.pendingCacheBreakIntent, undefined, 'no cache break');
  assert.deepEqual({ from: result.workflowSwitch.from, to: result.workflowSwitch.to }, { from: 'Alpha', to: 'Beta' });
  const divider = restoreTranscriptItems(session.messages).find((item) => item.status === 'workflow-switched');
  assert.deepEqual({ from: divider.from, to: divider.to }, { from: 'Alpha', to: 'Beta' });

  // A coding Lead keeps `agent` when the workflow has no agents: the agent
  // list reminder says who is there (agent-listing-notice.mjs).
  assert.equal(preDispatchDenyForSession(session, { name: 'agent', arguments: {} }), null);
  assert.equal(preDispatchDenyForSession(session, { name: 'read', arguments: {} }), null);

  const turn = await buildUserTurn({ session, prompt: 'continue' });
  const content = turn.userTurnMessage.content;
  assert.ok(content.startsWith(`continue\n\n${NOTICE_HEAD}`));
  assert.match(content, /still Alpha's: they no longer apply; follow Beta's below instead/);
  assert.match(content, /replaces every earlier Workflow Changed reminder/);
  assert.doesNotMatch(content, /Not available in Beta/);
  assert.match(content, /# Active Workflow: Beta\n\nBETA RULES/);
  assert.match(content, /Beta has no agents to delegate to/);
  // A turn the provider never accepted re-sends it.
  const retry = await buildUserTurn({ session, prompt: 'continue' });
  assert.equal(retry.workflowNotice.content, turn.workflowNotice.content);

  assert.equal(acknowledgePendingWorkflowNotice(session, turn.workflowNotice.revision), true);
  assert.equal(acknowledgePendingWorkflowNotice(session, turn.workflowNotice.revision), false);
  session.messages.push(turn.userTurnMessage, { role: 'assistant', content: 'ok' });
  const later = await buildUserTurn({ session, prompt: 'more' });
  assert.equal(later.workflowNotice, null);
  assert.equal(later.userTurnMessage.content, 'more');
  assert.equal(prefix(session), before);
});

test('a compaction after a switch builds the prompt with the new workflow', async () => {
  const { session, api, refresh } = await conversationSession();
  await api.setWorkflow('beta', { scope: 'session' });
  const turn = await buildUserTurn({ session, prompt: 'continue' });
  // Beta's missing agent is told as a reminder with the switch.
  assert.match(turn.agentListingNotice.content, /no longer available[^\n]*\n- Worker \(worker\)/);
  acknowledgePendingWorkflowNotice(session, turn.workflowNotice.revision);
  session.messages.push(turn.userTurnMessage, { role: 'assistant', content: 'ok' });
  // Warm: nothing folds.
  await refresh.applyPendingAgentProfile();
  assert.ok(session.workflowOverlay);

  session.pendingCacheBreakIntent = 'post_turn_compaction';
  assert.equal(await refresh.applyPendingAgentProfile(), true);
  assert.match(bp3(session), /# Active Workflow: Beta/);
  assert.doesNotMatch(bp3(session), /ALPHA RULES/);
  assert.match(bp3(session), /OLD MEMORY/, 'the workspace slices the model was told stay');
  assert.match(bp3(session), /# Available Agents\n\n- Worker \(worker\)/, 'and the agent list it was built with');
  assert.equal(toolNames(session).includes('agent'), true, 'a coding Lead keeps `agent`');
  assert.equal(
    (await buildUserTurn({ session, prompt: 'go' })).agentListingNotice,
    null,
    'the removal told on top of that list still applies'
  );
  assert.equal(session.workflowOverlay, undefined);
  assert.equal(session.pendingCacheBreakIntent, 'post_turn_compaction');
});

test('a compaction that dropped the delivered reminder folds the new workflow in', async () => {
  const { session, api, refresh } = await conversationSession();
  await api.setWorkflow('beta', { scope: 'session' });
  const turn = await buildUserTurn({ session, prompt: 'continue' });
  acknowledgePendingWorkflowNotice(session, turn.workflowNotice.revision);
  // The compacted transcript kept a summary, not the reminder.
  session.messages = [
    ...session.messages.filter((message) => message.role === 'system'),
    { role: 'user', content: 'Summary of earlier work.' },
    { role: 'assistant', content: 'ok' },
  ];
  assert.equal(await refresh.applyPendingAgentProfile(), true);
  assert.match(bp3(session), /# Active Workflow: Beta/);
  assert.equal(session.workflowOverlay, undefined);
});

test('no agents → agents → none: `agent` stays callable and the prefix unchanged', async () => {
  const { session, api, refresh } = await conversationSession({ config: { workflow: { active: 'beta' } } });
  assert.ok(toolNames(session).includes('agent'), 'built without agents, a coding Lead keeps `agent`');
  assert.equal(isToolPermittedBySessionPolicy(session, 'agent'), true, 'load_tool may load it');
  const agentCall = () => preDispatchDenyForSession(session, { name: 'agent', arguments: {} });
  const before = prefix(session);

  await api.setWorkflow('alpha', { scope: 'session' });
  assert.equal(agentCall(), null);
  await refresh.applyPendingAgentProfile();
  const turn = await buildUserTurn({ session, prompt: 'delegate it' });
  assert.match(turn.userTurnMessage.content, /# Available Agents\n\n- Worker \(worker\)/);
  await api.setWorkflow('beta', { scope: 'session' });
  assert.equal(agentCall(), null);
  assert.equal(prefix(session), before);
  assert.equal(session.pendingCacheBreakIntent, undefined);
});

test('A→B→A: back before the notice leaves nothing; after it, the latest reminder says the prompt applies again', async (t) => {
  const { session, api } = await conversationSession();
  const before = prefix(session);
  // Both switches in the same millisecond, as on a fast machine.
  t.mock.method(Date, 'now', () => 1_800_000_000_000);
  await api.setWorkflow('beta', { scope: 'session' });
  await api.setWorkflow('alpha', { scope: 'session' });
  assert.equal(session.workflowSwitch, undefined);
  assert.equal(session.workflowOverlay, undefined);
  assert.equal(preDispatchDenyForSession(session, { name: 'agent', arguments: {} }), null);
  assert.equal(prefix(session), before);
  assert.deepEqual(
    restoreTranscriptItems(session.messages)
      .filter((item) => item.status === 'workflow-switched')
      .map((item) => `${item.from}>${item.to}`),
    ['Alpha>Beta', 'Beta>Alpha']
  );

  // Told about Beta, then back to Alpha: the newest reminder supersedes it.
  await api.setWorkflow('beta', { scope: 'session' });
  const told = await buildUserTurn({ session, prompt: 'go' });
  acknowledgePendingWorkflowNotice(session, told.workflowNotice.revision);
  session.messages.push(told.userTurnMessage, { role: 'assistant', content: 'ok' });
  await api.setWorkflow('alpha', { scope: 'session' });
  const back = await buildUserTurn({ session, prompt: 'again' });
  assert.match(back.workflowNotice.content, /now runs the Alpha workflow, the one the system prompt carries/);
  assert.match(back.workflowNotice.content, /replaces every earlier Workflow Changed reminder/);
  assert.equal(session.workflowOverlay, undefined);
  assert.equal(prefix(session), before);
});
test('a switch while a turn runs is never refused: it waits for the next turn', async () => {
  let turns = 0;
  const { session, state, api, refresh } = await conversationSession({ activeTurns: () => turns });
  turns = 1;
  const before = prefix(session);
  const result = await api.setWorkflow('beta', { scope: 'session' });
  assert.equal(result.deferred, true);
  assert.equal(result.id, 'beta', 'the selector shows the choice');
  assert.equal(result.workflowSwitch, null);
  assert.equal(session.workflow.id, 'alpha', 'the running turn keeps its workflow');
  assert.equal(session.workflowSwitch, undefined);
  turns = 0;
  session.liveTurnMessages = [...session.messages, { role: 'user', content: 'next' }];
  assert.equal((await api.setWorkflow('beta', { scope: 'session' })).deferred, true);
  delete session.liveTurnMessages;
  assert.equal(session.pendingWorkflowId, 'beta');
  assert.equal(state.persisted.at(-1).pendingWorkflowId, 'beta', 'saved before it was acknowledged');
  assert.deepEqual(state.saved, []);
  // The next turn's start applies it, with the notice and the divider.
  const switches = refresh.applyPendingSessionSwitches();
  assert.deepEqual([switches.workflowSwitch.from, switches.workflowSwitch.to], ['Alpha', 'Beta']);
  assert.equal(session.workflow.id, 'beta');
  assert.equal(prefix(session), before);
  const turn = await buildUserTurn({ session, prompt: 'continue' });
  assert.ok(turn.userTurnMessage.content.includes(NOTICE_HEAD));
});

test('an empty session keeps today\u2019s semantics: the pick becomes the default and applies in place', async () => {
  const session = leadSession();
  const { state, refresh, api } = harness(session);
  assert.equal(await refresh.switchSessionWorkflow('beta'), null);
  const result = await api.setWorkflow('beta', { scope: 'session' });
  assert.equal(result.appliedToCurrentSession, true);
  assert.deepEqual(state.saved, ['beta']);
  assert.equal(session.workflow.id, 'beta');
  assert.equal(session.workflowSwitch, undefined, 'an empty session gets no notice');
  assert.match(bp3(session), /# Active Workflow: Beta/);
});

test('without the session scope a conversation keeps its workflow and the pick only becomes the default', async () => {
  const { session, state, api } = await conversationSession();
  const result = await api.setWorkflow('beta');
  assert.equal(result.appliedToCurrentSession, false);
  assert.deepEqual(state.saved, ['beta']);
  assert.equal(session.workflow.id, 'alpha');
  assert.match(bp3(session), /ALPHA RULES/);
});

test('agents already running under the old workflow keep running; only new delegation sees the switch', async () => {
  const { session, api } = await conversationSession();
  // A worker the Lead delegated to under Alpha: its own session, prompt and tools.
  const worker = {
    id: 'sess_worker',
    owner: 'agent',
    parentSessionId: session.id,
    status: 'running',
    messages: [{ role: 'system', content: '# Agent\n\n# Active Workflow: Alpha' }],
    tools: [{ name: 'read' }, { name: 'apply_patch' }],
  };
  const before = JSON.stringify(worker);
  const result = await api.setWorkflow('beta', { scope: 'session' });
  assert.equal(result.appliedToCurrentSession, true, 'a running worker does not refuse the switch');
  assert.equal(JSON.stringify(worker), before);
  // The schema is untouched; a spawn of an agent that is not there is refused when it is called.
  assert.ok(toolNames(session).includes('agent'));
});

test('agent-owned sessions have no workflow to switch', async () => {
  const session = { ...leadSession(), owner: 'agent', agent: 'worker' };
  session.messages.push({ role: 'user', content: 'task' }, { role: 'assistant', content: 'done' });
  const { api, state } = harness(session);
  await assert.rejects(api.setWorkflow('beta', { scope: 'session' }), /Only a coding session/);
  assert.deepEqual(state.saved, []);
});
