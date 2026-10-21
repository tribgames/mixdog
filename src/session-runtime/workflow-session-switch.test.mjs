import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createToolPolicyRefresh } from './tool-policy-refresh.mjs';
import { createWorkflowPacksApi } from './workflow-agents-api/workflow-packs.mjs';
import {
  composeSessionSystem,
  seedSessionMessages,
} from '../runtime/agent/orchestrator/session/manager/session-prompt-composition.mjs';
import { buildUserTurn } from '../runtime/agent/orchestrator/session/manager/ask-turn-prepare.mjs';
import { acknowledgePendingWorkflowNotice } from '../runtime/agent/orchestrator/session/manager/workflow-switch-notice.mjs';
import { restoreTranscriptItems } from '../runtime/agent/orchestrator/session/transcript-restore/restore.mjs';
import { preDispatchDenyForSession } from '../runtime/agent/orchestrator/session/loop/pre-dispatch-deny.mjs';
import { selectDeferredTools } from '../runtime/agent/orchestrator/runtime-core/tool-catalog.mjs';
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

  // A denied tool keeps its schema and is refused at call time.
  assert.match(
    String(preDispatchDenyForSession(session, { name: 'agent', arguments: {} })),
    /not available in workflow Beta/
  );
  assert.equal(preDispatchDenyForSession(session, { name: 'read', arguments: {} }), null);

  const turn = await buildUserTurn({ session, prompt: 'continue' });
  const content = turn.userTurnMessage.content;
  assert.ok(content.startsWith(`continue\n\n${NOTICE_HEAD}`));
  assert.match(content, /still Alpha's: they no longer apply; follow Beta's below instead/);
  assert.match(content, /replaces every earlier Workflow Changed reminder/);
  assert.match(content, /Not available in Beta \(calls are refused\): `agent`\./);
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
  acknowledgePendingWorkflowNotice(session, turn.workflowNotice.revision);
  session.messages.push(turn.userTurnMessage, { role: 'assistant', content: 'ok' });
  // Warm: nothing folds.
  assert.equal(await refresh.applyPendingAgentProfile(), false);
  assert.ok(session.workflowOverlay);

  session.pendingCacheBreakIntent = 'post_turn_compaction';
  assert.equal(await refresh.applyPendingAgentProfile(), true);
  assert.match(bp3(session), /# Active Workflow: Beta/);
  assert.doesNotMatch(bp3(session), /ALPHA RULES|# Available Agents/);
  assert.match(bp3(session), /OLD MEMORY/, 'the workspace slices the model was told stay');
  assert.equal(toolNames(session).includes('agent'), false);
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

test('no agents → agents: the prefix stays, `agent` is loadable and callable, and a fold makes it a real tool', async () => {
  const { session, api, refresh } = await conversationSession({ config: { workflow: { active: 'beta' } } });
  assert.equal(
    session.tools.some((tool) => tool.name === 'agent'),
    false,
    'built without agents'
  );
  assert.match(String(preDispatchDenyForSession(session, { name: 'agent', arguments: {} })), /not available/);
  const before = prefix(session);
  const tools = JSON.stringify(session.tools);

  await api.setWorkflow('alpha', { scope: 'session' });
  assert.equal(JSON.stringify(session.tools), tools, 'tool schemas are byte-identical');
  assert.equal(
    JSON.stringify(session.messages.filter((message) => message.role === 'system')),
    JSON.stringify(JSON.parse(before)[0])
  );
  assert.equal(session.pendingCacheBreakIntent, undefined);
  assert.ok(
    session.deferredToolCatalog.some((tool) => tool.name === 'agent'),
    'in the deferred catalog'
  );
  assert.deepEqual(
    session.pendingDeferredToolDelta.added.map((entry) => entry.name),
    ['agent']
  );
  assert.equal(isToolPermittedBySessionPolicy(session, 'agent'), true, 'load_tool may load it');
  selectDeferredTools(session, ['agent'], 'full');
  assert.ok(
    [...(session.deferredDiscoveredTools || []), ...(session.deferredCallableTools || [])].includes('agent'),
    'loaded into the conversation'
  );
  assert.equal(JSON.stringify(session.tools), tools, 'loading never makes it eager');
  assert.equal(preDispatchDenyForSession(session, { name: 'agent', arguments: {} }), null);
  const turn = await buildUserTurn({ session, prompt: 'delegate it' });
  assert.match(turn.userTurnMessage.content, /Alpha adds `agent`: .*load it with `load_tool` before the first call\./);
  assert.match(turn.userTurnMessage.content, /# Available Agents\n\n- Worker \(worker\)/);

  // Fold at the next cold point: `agent` joins the real tool list.
  session.pendingCacheBreakIntent = 'post_turn_compaction';
  assert.equal(await refresh.applyPendingAgentProfile(), true);
  assert.ok(session.tools.some((tool) => tool.name === 'agent'));
  assert.match(bp3(session), /ALPHA RULES[\s\S]*# Available Agents/);
  assert.equal(session.workflowOpenedTools, undefined);
});

test('agents → none → agents: `agent` is refused, then allowed again, with the prefix unchanged', async () => {
  const { session, api } = await conversationSession({ config: { workflow: { active: 'beta' } } });
  const tools = JSON.stringify(session.tools);
  const agentCall = () => preDispatchDenyForSession(session, { name: 'agent', arguments: {} });
  await api.setWorkflow('alpha', { scope: 'session' });
  assert.equal(agentCall(), null);
  await api.setWorkflow('beta', { scope: 'session' });
  assert.match(String(agentCall()), /not available/, 'refused on the prompt workflow again');
  await api.setWorkflow('alpha', { scope: 'session' });
  assert.equal(agentCall(), null, 'allowed again');
  assert.equal(JSON.stringify(session.tools), tools);
  assert.equal(session.pendingCacheBreakIntent, undefined);
  const turn = await buildUserTurn({ session, prompt: 'go' });
  assert.match(turn.userTurnMessage.content, /Alpha adds `agent`/);
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
  // New delegation is refused under Beta; the schema itself is untouched.
  assert.ok(toolNames(session).includes('agent'));
  assert.match(String(preDispatchDenyForSession(session, { name: 'agent', arguments: {} })), /workflow Beta/);
});

test('agent-owned sessions have no workflow to switch', async () => {
  const session = { ...leadSession(), owner: 'agent', agent: 'worker' };
  session.messages.push({ role: 'user', content: 'task' }, { role: 'assistant', content: 'done' });
  const { api, state } = harness(session);
  await assert.rejects(api.setWorkflow('beta', { scope: 'session' }), /Only a coding session/);
  assert.deepEqual(state.saved, []);
});
