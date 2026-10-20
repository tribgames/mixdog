import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createToolPolicyRefresh } from './tool-policy-refresh.mjs';
import { publishAgentProfileChange, subscribeAgentProfileChanges } from './agent-profile-changes.mjs';
import { createAgentEditorApi } from './workflow-agents-api/agent-editor.mjs';
import {
  composeSessionSystem,
  seedSessionMessages,
} from '../runtime/agent/orchestrator/session/manager/session-prompt-composition.mjs';
import { agentProfileRevision, leadRosterRevision } from '../runtime/agent/orchestrator/context/role-instructions.mjs';
import { createWorkflowAgentsApi } from './workflow-agents-api.mjs';
import {
  createWorkflowHelpers,
  createWorkflowRouteHelpers,
} from '../runtime/agent/orchestrator/runtime-core/workflow.mjs';
import { normalizeAgentPermissionOrNone, readMarkdownDocument } from '../runtime/shared/markdown-frontmatter.mjs';
import { agentDefinitionExists, normalizeAgentName } from './services/agent-tool/helpers.mjs';
import { resolveWorkerCompactPolicy } from '../runtime/agent/orchestrator/session/loop/compact-policy.mjs';

const PACK = {
  summary: { id: 'default', name: 'Default', description: '', source: 'built-in', delegatesAgents: false },
  packContext: '# Active Workflow: Default\n\nDEFAULT RULES',
  leadPromptParts: () => ({}),
};
const WORKFLOW = { id: 'default', name: 'Default', delegatesAgents: false };
const CONFIG = { workflow: { active: 'default' } };

function withDataDir(t) {
  const base = mkdtempSync(join(tmpdir(), 'agent-profile-refresh-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = join(base, 'data');
  t.after(() => {
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(base, { recursive: true, force: true });
  });
  const dataDir = join(base, 'data');
  const agentDir = (id) => {
    const dir = join(dataDir, 'agents', id);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  return { dataDir, agentDir };
}

/** An agent-mode thread as session creation builds it, with a conversation. */
function agentThread(
  agentId,
  { sessionMode = 'agent', id = `sess_home_${agentId}`, pack = PACK, workflow = WORKFLOW, leadWorkflowParts = {} } = {}
) {
  const prompt = composeSessionSystem(
    {
      owner: 'user',
      workflow,
      workflowContext: pack.packContext,
      leadWorkflowParts,
      coreMemoryContext: 'MEMORY',
    },
    {
      profile: { skip: { claudemd: true, skills: true } },
      providerName: 'openai',
      modelName: 'test',
      surface: { ownerIsAgent: false, resolvedAgent: agentId, skills: [], toolsForRouting: [], ruleOmitTools: [] },
      sessionMode,
    }
  );
  const messages = seedSessionMessages(prompt, []);
  messages.push({ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' });
  return {
    id,
    owner: 'user',
    agent: agentId,
    sessionMode,
    provider: 'openai',
    cwd: 'C:/repo',
    promptIdentity: prompt.promptIdentity,
    agentProfileRevision: agentProfileRevision(agentId),
    agentRosterRevision: leadRosterRevision(leadWorkflowParts),
    callerDisallowedTools: [],
    messages,
    tools: [{ name: 'read' }],
    bp3CoreContext: prompt.sessionMarkerCore,
    bp3EnvSplit: true,
    bp3EnvironmentContext: prompt.environmentTailContext,
    workflow,
    providerState: { previousResponseId: 'resp_1' },
  };
}

function refresher(
  session,
  { activeTurns = () => 0, activeWorkflowContext = () => ({ ...PACK, orchestrationMode: 'none' }), dataDir = '' } = {}
) {
  return createToolPolicyRefresh({
    getSession: () => session,
    getRoute: () => ({ provider: 'openai', model: 'test' }),
    getMode: () => 'full',
    getConfig: () => CONFIG,
    getDataDir: () => dataDir,
    getActiveTurnCount: activeTurns,
    modelStandaloneTools: () => [{ name: 'read' }],
    featureDisallowedTools: () => [],
    loadCoreMemoryContext: async () => 'NEWER MEMORY',
    activeWorkflowContext,
    invalidatePreSessionToolSurface: () => {},
  });
}

/** The runtime wiring (boot/apis.mjs): a saved profile reaches this thread. */
function subscribe(t, refresh) {
  const applied = [];
  const subscription = subscribeAgentProfileChanges(async () => {
    if (await refresh.refreshAgentProfile()) applied.push('rebuilt');
  });
  t.after(subscription.unsubscribe);
  return applied;
}

const settled = () => new Promise((resolve) => setImmediate(resolve));
const tier3 = (session) => session.messages.find((message) => message.cacheTier === 'tier3').content;
const systemText = (session) =>
  session.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n');

test("a saved persona reaches the bot's existing thread for its next turn, with one cache break", async (t) => {
  const { agentDir } = withDataDir(t);
  const dir = agentDir('poet');
  writeFileSync(join(dir, 'AGENT.md'), 'Write poems.');
  writeFileSync(join(dir, 'PERSONA.md'), 'Formal tone.');
  const session = agentThread('poet');
  const refresh = refresher(session);
  const applied = subscribe(t, refresh);
  const before = tier3(session);
  assert.match(before, /Formal tone\./);
  const conversation = session.messages.slice(-2);

  writeFileSync(join(dir, 'PERSONA.md'), 'PERSONA_MARKER_42 casual tone.');
  await publishAgentProfileChange();

  assert.deepEqual(applied, ['rebuilt']);
  assert.match(systemText(session), /## Persona[\s\S]*PERSONA_MARKER_42 casual tone\./);
  assert.doesNotMatch(systemText(session), /Formal tone\./);
  assert.match(tier3(session), /Write poems\./, 'the role stays');
  assert.match(tier3(session), /MEMORY/, 'the workspace slices the model was told stay');
  assert.doesNotMatch(tier3(session), /NEWER MEMORY/);
  assert.deepEqual(session.messages.slice(-2), conversation, 'the conversation is untouched');
  assert.equal(session.pendingCacheBreakIntent, 'agent_profile');
  assert.equal(session.providerState, undefined, 'provider replay state is dropped once');
  assert.equal(session.agentProfileRevision, agentProfileRevision('poet'));

  // The next send consumes the tag; an unchanged profile never sets it again.
  delete session.pendingCacheBreakIntent;
  const rebuilt = tier3(session);
  await publishAgentProfileChange();
  assert.equal(await refresh.refreshAgentProfile({ trigger: 'resume' }), false);
  assert.equal(session.pendingCacheBreakIntent, undefined);
  assert.equal(tier3(session), rebuilt);
  assert.deepEqual(applied, ['rebuilt']);
});

test('another agent, or an unchanged prompt, leaves the thread and its cache alone', async (t) => {
  const { agentDir } = withDataDir(t);
  const dir = agentDir('poet');
  writeFileSync(join(dir, 'AGENT.md'), 'Write poems.');
  agentDir('critic');
  writeFileSync(join(agentDir('critic'), 'AGENT.md'), 'Critique.');
  const session = agentThread('poet');
  const refresh = refresher(session);
  const before = JSON.stringify(session);
  writeFileSync(join(agentDir('critic'), 'PERSONA.md'), 'Harsh.');
  assert.equal(await refresh.refreshAgentProfile(), false);
  assert.equal(JSON.stringify(session), before);
  // A change outside the prompt (the face) only moves the stamp.
  writeFileSync(join(dir, 'agent.json'), '{ "avatar": { "kind": "mascot" } }\n');
  assert.equal(await refresh.refreshAgentProfile(), false);
  assert.equal(session.pendingCacheBreakIntent, undefined);
  assert.deepEqual(session.providerState, { previousResponseId: 'resp_1' });
  assert.equal(session.agentProfileRevision, agentProfileRevision('poet'));
});

test('a thread mid-turn keeps its prompt and takes the edit at its next turn', async (t) => {
  const { agentDir } = withDataDir(t);
  const dir = agentDir('poet');
  writeFileSync(join(dir, 'AGENT.md'), 'Write poems.');
  const session = agentThread('poet');
  session.liveTurnMessages = [...session.messages, { role: 'user', content: 'next' }];
  // One turn is counted throughout: the running one, then the next one opening.
  const refresh = refresher(session, { activeTurns: () => 1 });
  const before = JSON.stringify(session);

  writeFileSync(join(dir, 'PERSONA.md'), 'MIDTURN_MARKER');
  assert.equal(await refresh.refreshAgentProfile(), false);
  assert.equal(JSON.stringify(session), before, 'the running turn sees no change');

  // The turn settles; the next one opens (counted) and applies it first.
  session.liveTurnMessages = null;
  assert.equal(await refresh.applyPendingAgentProfile(), true);
  assert.match(tier3(session), /MIDTURN_MARKER/);
  assert.equal(session.pendingCacheBreakIntent, 'agent_profile');
  assert.equal(await refresh.applyPendingAgentProfile(), false, 'applied once');
});

test("a renamed Mixy is named in its thread's next prompt", async (t) => {
  const { dataDir } = withDataDir(t);
  const session = agentThread('lead');
  const refresh = refresher(session);
  const applied = subscribe(t, refresh);
  assert.match(tier3(session), /You are Mixy, the user's assistant in Mixdog\./);
  const editor = createAgentEditorApi({ cfgMod: { getPluginData: () => dataDir }, getConfig: () => ({}) });

  // The save answers at once; its threads are rebuilt right behind it.
  editor.saveLeadIdentity({ name: 'Navi' });
  await settled();

  assert.deepEqual(applied, ['rebuilt']);
  assert.match(tier3(session), /You are Navi, the user's assistant in Mixdog\./);
  assert.doesNotMatch(tier3(session), /You are Mixy/);
  assert.equal(session.pendingCacheBreakIntent, 'agent_profile');

  // Mixy's persona, saved through its editor, follows the same way.
  delete session.pendingCacheBreakIntent;
  editor.saveLeadPersona('LEAD_PERSONA_MARKER');
  await settled();
  assert.deepEqual(applied, ['rebuilt', 'rebuilt']);
  assert.match(tier3(session), /## Persona[\s\S]*LEAD_PERSONA_MARKER/);
  assert.equal(session.pendingCacheBreakIntent, 'agent_profile');
});

test('a reopened thread catches up on an edit made while no runtime held it', async (t) => {
  const { agentDir } = withDataDir(t);
  const dir = agentDir('poet');
  writeFileSync(join(dir, 'AGENT.md'), 'Write poems.');
  const session = agentThread('poet');
  writeFileSync(join(dir, 'PERSONA.md'), 'COLD_MARKER');
  assert.equal(await refresher(session).refreshAgentProfile({ trigger: 'resume' }), true);
  assert.match(tier3(session), /COLD_MARKER/);

  // A thread from before profile stamps is checked too; a coding session of
  // that age keeps its prompt when reopened.
  const legacy = agentThread('poet');
  delete legacy.agentProfileRevision;
  assert.equal(await refresher(legacy).refreshAgentProfile({ trigger: 'resume' }), false, 'already current');
  assert.equal(legacy.agentProfileRevision, agentProfileRevision('poet'));
  const coding = agentThread('lead', { sessionMode: 'coding', id: 'sess_task' });
  delete coding.agentProfileRevision;
  const codingBefore = JSON.stringify(coding);
  assert.equal(await refresher(coding).refreshAgentProfile({ trigger: 'resume' }), false);
  assert.equal(JSON.stringify(coding), codingBefore);
});

test('a delegated worker running as the agent keeps its prompt', async (t) => {
  const { agentDir } = withDataDir(t);
  const dir = agentDir('poet');
  writeFileSync(join(dir, 'AGENT.md'), 'Write poems.');
  const worker = { ...agentThread('poet'), owner: 'agent', id: 'sess_worker' };
  const before = JSON.stringify(worker);
  writeFileSync(join(dir, 'PERSONA.md'), 'WORKER_MARKER');
  assert.equal(await refresher(worker).refreshAgentProfile(), false);
  assert.equal(JSON.stringify(worker), before);
});

/** The real workflow/agents surface over the test data dir. */
function botCatalog(dataDir) {
  const helpers = createWorkflowHelpers({
    rootDir: join(process.cwd(), 'src'),
    dataDir,
    readMarkdownDocument,
    normalizeAgentPermissionOrNone,
  });
  const state = { config: CONFIG };
  const api = createWorkflowAgentsApi({
    ...helpers,
    getConfig: () => state.config,
    displayConfig: () => state.config,
    cfgMod: { getPluginData: () => dataDir },
    STANDALONE_DATA_DIR: dataDir,
    resolveRoute: () => ({ provider: 'openai', model: 'main-model' }),
    agentRouteFromConfig: createWorkflowRouteHelpers({ findPreset: () => null }).agentRouteFromConfig,
    saveConfigAndAdopt: (value) => {
      state.config = value;
    },
    invalidateContextStatusCache() {},
  });
  /** A Lead thread as creation builds it, listing the current roster. */
  const thread = (agentId, { mixy = agentId === 'lead' } = {}) => {
    const context = helpers.activeWorkflowContext(CONFIG, dataDir);
    return agentThread(agentId, {
      pack: context,
      workflow: context.summary,
      leadWorkflowParts: context.leadPromptParts({ agentMode: true, mixy }),
    });
  };
  const refresherFor = (session) =>
    refresher(session, { activeWorkflowContext: helpers.activeWorkflowContext, dataDir });
  return { api, thread, refresherFor };
}

test("a bot created, renamed, archived or restored reaches the roster in Mixy's next prompt", async (t) => {
  const { dataDir, agentDir } = withDataDir(t);
  writeFileSync(join(agentDir('poet'), 'AGENT.md'), 'Write poems.');
  const { api, thread, refresherFor } = botCatalog(dataDir);
  await api.saveAgentDefinition({ name: 'Watcher', description: 'Watches the repo', body: 'Watch.', kind: 'bot' });
  const mixy = thread('lead');
  const poet = thread('poet');
  const mixyApplied = subscribe(t, refresherFor(mixy));
  const poetApplied = subscribe(t, refresherFor(poet));
  assert.match(tier3(mixy), /- Watcher \(watcher\): Watches the repo/);
  const poetBefore = JSON.stringify(poet);

  // Renamed: the id stays, the name in the roster follows.
  await api.saveAgentDefinition({ id: 'watcher', name: 'Sentinel', description: 'Watches the repo', body: 'Watch.' });
  assert.deepEqual(mixyApplied, ['rebuilt']);
  assert.match(tier3(mixy), /- Sentinel \(watcher\): Watches the repo/);
  assert.doesNotMatch(tier3(mixy), /Watcher \(/);
  assert.equal(mixy.pendingCacheBreakIntent, 'agent_profile');
  assert.equal(mixy.providerState, undefined, 'one cache break');
  // A contact bot is in Mixy's roster only: another bot's thread lists none.
  assert.deepEqual(poetApplied, []);
  assert.equal(JSON.stringify(poet), poetBefore);

  // Archived, then restored.
  delete mixy.pendingCacheBreakIntent;
  await api.deleteAgentDefinition('watcher');
  assert.doesNotMatch(tier3(mixy), /\(watcher\)/);
  assert.equal(mixy.pendingCacheBreakIntent, 'agent_profile');
  delete mixy.pendingCacheBreakIntent;
  await api.restoreAgentDefinition('watcher');
  assert.match(tier3(mixy), /- Sentinel \(watcher\)/);
  assert.equal(mixy.pendingCacheBreakIntent, 'agent_profile');
  assert.deepEqual(mixyApplied, ['rebuilt', 'rebuilt', 'rebuilt']);

  // Created: a new bot joins the roster too.
  delete mixy.pendingCacheBreakIntent;
  await api.saveAgentDefinition({ name: 'Scout', description: 'Finds things', body: 'Scout.', kind: 'bot' });
  assert.match(tier3(mixy), /- Scout \(scout\)/);
  assert.deepEqual(mixyApplied.length, 4);
});

test('a reopened Mixy thread catches up on a roster change made while no runtime held it', async (t) => {
  const { dataDir } = withDataDir(t);
  const { api, thread, refresherFor } = botCatalog(dataDir);
  await api.saveAgentDefinition({ name: 'Watcher', description: 'Watches', body: 'Watch.', kind: 'bot' });
  const mixy = thread('lead');
  await api.saveAgentDefinition({ id: 'watcher', name: 'Sentinel', description: 'Watches', body: 'Watch.' });
  assert.match(tier3(mixy), /Watcher \(watcher\)/, 'no runtime held it');
  assert.equal(await refresherFor(mixy).refreshAgentProfile({ trigger: 'resume' }), true);
  assert.match(tier3(mixy), /Sentinel \(watcher\)/);
});

test('delegation resolves a bot by its id; its display name is never an address', async (t) => {
  const { dataDir } = withDataDir(t);
  const { api } = botCatalog(dataDir);
  await api.saveAgentDefinition({ name: 'Watcher', description: 'Watches', body: 'Watch.', kind: 'bot' });
  await api.saveAgentDefinition({ id: 'watcher', name: 'Sentinel', description: 'Watches', body: 'Watch.' });
  const root = join(process.cwd(), 'src');
  assert.equal(agentDefinitionExists(normalizeAgentName('watcher'), dataDir, root), true);
  assert.equal(agentDefinitionExists(normalizeAgentName('Sentinel'), dataDir, root), false);
});

test('a bot thread compacts at the same threshold as the Lead', () => {
  const base = { owner: 'user', provider: 'openai', contextWindow: 200_000, messages: [] };
  const policy = (id, sessionMode, compaction = {}) =>
    resolveWorkerCompactPolicy({ ...base, id, sessionMode, compaction }, []);
  const lead = policy('sess_task', 'coding');
  const home = policy('sess_home_poet', 'agent');
  for (const key of ['boundaryTokens', 'triggerTokens', 'compactTargetTokens', 'reserveTokens']) {
    assert.equal(home[key], lead[key], key);
  }
  const tuned = { reservedTokens: 4_000, targetTokens: 50_000 };
  assert.equal(
    policy('sess_home_poet', 'agent', tuned).triggerTokens,
    policy('sess_task', 'coding', tuned).triggerTokens
  );
  // The one difference: a bot never asks the user, so it compacts even when
  // the user turned automatic compaction off.
  assert.equal(policy('sess_task', 'coding', { auto: false }).auto, false);
  assert.equal(policy('sess_home_poet', 'agent', { auto: false }).auto, true);
});
