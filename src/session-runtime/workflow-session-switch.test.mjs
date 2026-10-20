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

const NOTICE_HEAD = '<system-reminder>\n# Workflow Changed\nThe workflow changed from Alpha to Beta.';

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
  const state = { config, memory: 'OLD MEMORY', saved: [] };
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

test('a switch in a conversation gives the next turn the new rules and tools plus a one-time notice', async () => {
  const { session, state, api } = await conversationSession();
  assert.ok(toolNames(session).includes('agent'));
  assert.match(bp3(session), /ALPHA RULES[\s\S]*# Available Agents/);
  state.memory = 'NEW MEMORY';

  const result = await api.setWorkflow('beta', { scope: 'session' });

  assert.equal(result.appliedToCurrentSession, true);
  assert.equal(result.id, 'beta');
  assert.deepEqual(state.saved, [], 'the default for new sessions stays');
  assert.equal(state.config.workflow.active, 'alpha');
  assert.equal(session.workflow.id, 'beta');
  assert.equal(session.workflow.delegatesAgents, false);
  assert.equal(toolNames(session).includes('agent'), false, 'the delegation surface follows the new workflow');
  const core = bp3(session);
  assert.match(core, /# Active Workflow: Beta/);
  assert.doesNotMatch(core, /ALPHA RULES|# Available Agents/);
  assert.match(core, /OLD MEMORY/, 'the workspace slices the model was told stay');
  assert.doesNotMatch(core, /NEW MEMORY/);
  assert.equal(session.providerState, undefined, 'the prompt cache is rebuilt once');
  assert.equal(session.pendingCacheBreakIntent, 'workflow_switch');
  assert.deepEqual({ from: result.workflowSwitch.from, to: result.workflowSwitch.to }, { from: 'Alpha', to: 'Beta' });
  const divider = restoreTranscriptItems(session.messages).find((item) => item.status === 'workflow-switched');
  assert.deepEqual({ from: divider.from, to: divider.to }, { from: 'Alpha', to: 'Beta' });

  const turn = await buildUserTurn({ session, prompt: 'continue' });
  assert.ok(turn.userTurnMessage.content.startsWith(`continue\n\n${NOTICE_HEAD}`));
  // A turn the provider never accepted re-sends it.
  const retry = await buildUserTurn({ session, prompt: 'continue' });
  assert.equal(retry.workflowNotice.content, turn.workflowNotice.content);

  assert.equal(acknowledgePendingWorkflowNotice(session, turn.workflowNotice.revision), true);
  assert.equal(acknowledgePendingWorkflowNotice(session, turn.workflowNotice.revision), false);
  const later = await buildUserTurn({ session, prompt: 'more' });
  assert.equal(later.workflowNotice, null);
  assert.equal(later.userTurnMessage.content, 'more');
});

test('switching back before the next turn leaves no notice, but each switch keeps its divider', async (t) => {
  const { session, api } = await conversationSession();
  // Both switches in the same millisecond, as on a fast machine.
  t.mock.method(Date, 'now', () => 1_800_000_000_000);
  await api.setWorkflow('beta', { scope: 'session' });
  await api.setWorkflow('alpha', { scope: 'session' });
  assert.equal(session.workflowSwitch, undefined);
  assert.match(bp3(session), /ALPHA RULES/);
  assert.ok(toolNames(session).includes('agent'));
  assert.deepEqual(
    restoreTranscriptItems(session.messages)
      .filter((item) => item.status === 'workflow-switched')
      .map((item) => `${item.from}>${item.to}`),
    ['Alpha>Beta', 'Beta>Alpha']
  );
});

test('a switch is refused while a turn runs and changes nothing', async () => {
  let turns = 0;
  const { session, state, api } = await conversationSession({ activeTurns: () => turns });
  turns = 1;
  const before = JSON.stringify(session);
  await assert.rejects(api.setWorkflow('beta', { scope: 'session' }), /running a turn/);
  turns = 0;
  session.liveTurnMessages = [...session.messages, { role: 'user', content: 'next' }];
  const live = JSON.stringify(session);
  await assert.rejects(api.setWorkflow('beta', { scope: 'session' }), /running a turn/);
  assert.equal(JSON.stringify(session), live);
  delete session.liveTurnMessages;
  assert.equal(JSON.stringify(session), before);
  assert.deepEqual(state.saved, []);
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
  assert.equal(toolNames(session).includes('agent'), false);
});

test('agent-owned sessions have no workflow to switch', async () => {
  const session = { ...leadSession(), owner: 'agent', agent: 'worker' };
  session.messages.push({ role: 'user', content: 'task' }, { role: 'assistant', content: 'done' });
  const { api, state } = harness(session);
  await assert.rejects(api.setWorkflow('beta', { scope: 'session' }), /Only a coding session/);
  assert.deepEqual(state.saved, []);
});
