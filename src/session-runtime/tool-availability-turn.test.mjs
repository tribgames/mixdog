import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createToolPolicyRefresh } from './tool-policy-refresh.mjs';
import { preDispatchDenyForSession } from '../runtime/agent/orchestrator/session/loop/pre-dispatch-deny.mjs';
import {
  reconcileDeferredMcpToolCatalog,
  refreshInitialDeferredMcpSurface,
  renderToolSearch,
} from '../runtime/agent/orchestrator/runtime-core/tool-catalog.mjs';

const tool = (name) => ({ name, description: `${name} tool.`, inputSchema: { type: 'object', properties: {} } });

/** A Lead with a conversation, built while web search was off and git on. */
function conversation(overrides = {}) {
  return {
    id: 'sess_live',
    provider: 'anthropic',
    callerDisallowedTools: ['get_goal'],
    disallowedTools: ['get_goal', 'web_search', 'web_fetch'],
    messages: [
      { role: 'system', content: '# Tool Calls\nrules' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ],
    tools: [tool('read'), tool('git'), tool('load_tool')],
    deferredToolCatalog: [tool('read'), tool('git'), tool('office')],
    deferredProviderMode: 'native',
    deferredCallableTools: ['read', 'git', 'load_tool'],
    ...overrides,
  };
}

function refresher(session, state) {
  return createToolPolicyRefresh({
    getSession: () => session,
    getRoute: () => ({ provider: 'anthropic', model: 'test' }),
    getMode: () => 'full',
    getConfig: () => state.config,
    getDataDir: () => '',
    modelStandaloneTools: () => [tool('read')],
    featureDisallowedTools: () => state.denied,
    toolDefinitionsFor: (names) => [tool('web_search'), tool('web_fetch')].filter((t) => names.includes(t.name)),
    loadCoreMemoryContext: async () => state.memory || '',
    activeWorkflowContext: () => ({
      summary: { id: 'solo', name: 'Solo', description: '', source: 'built-in', delegatesAgents: false },
      packContext: '# Active Workflow: Solo',
      leadPromptParts: () => ({}),
    }),
    invalidatePreSessionToolSurface: () => {},
  });
}

const prefix = (session) =>
  JSON.stringify([session.messages.filter((m) => m.role === 'system'), session.tools, session.deferredToolCatalog]);

test('a conversation takes moved settings gates at its next turn start with a byte-stable prefix', async () => {
  const session = conversation();
  const state = { config: {}, denied: ['web_search', 'web_fetch'] };
  const refresh = refresher(session, state);
  assert.equal(await refresh.reconcileTurnSettings(), null, 'nothing moved');
  const before = prefix(session);

  // Another runtime saved: web search on, git off (a reload replaces the config object).
  state.config = {};
  state.denied = ['git', 'github'];
  const result = await refresh.reconcileTurnSettings();
  assert.deepEqual(result.added.sort(), ['web_fetch', 'web_search']);
  assert.deepEqual(result.removed, ['git']);
  assert.equal(prefix(session), before, 'system blocks, eager tools and the boot catalog are unchanged');
  assert.deepEqual(
    session.deferredLateToolCatalog.map((t) => t.name),
    ['web_search', 'web_fetch'],
    'opened tools join the late pool'
  );
  assert.deepEqual(
    session.pendingDeferredToolDelta.added.map((e) => e.name),
    ['web_fetch', 'web_search']
  );
  assert.deepEqual(session.pendingDeferredToolDelta.removed, ['git']);
  assert.equal(session.promptFoldPending, true, 'folded at the next cold point');

  // git is disabled: it cannot run though its schema stays in the cached prefix.
  assert.match(preDispatchDenyForSession(session, { name: 'git', arguments: {} }), /"git" is disabled in settings/);
  assert.equal(preDispatchDenyForSession(session, { name: 'web_search', arguments: {} }), null);
  // web_fetch routed to a transport is judged under its own gate.
  state.denied = ['web_search', 'web_fetch'];
  state.config = {};
  await refresh.reconcileTurnSettings();
  assert.match(
    preDispatchDenyForSession(session, { name: 'local_fetch', schemaName: 'web_fetch', arguments: {} }),
    /"web_fetch" is disabled in settings/
  );
  assert.equal(preDispatchDenyForSession(session, { name: 'git', arguments: {} }), null, 'git back on');
  const loaded = JSON.parse(renderToolSearch({ names: ['web_search'] }, session));
  assert.deepEqual(loaded.disabledInSettings, ['web_search']);
  assert.deepEqual(loaded.missing, []);
  assert.equal(prefix(session), before);
});

test('a turn start with the same settings does no work', async () => {
  const session = conversation();
  const state = { config: {}, denied: ['web_search', 'web_fetch'] };
  const refresh = refresher(session, state);
  await refresh.reconcileTurnSettings();
  let reads = 0;
  const counted = createToolPolicyRefresh({
    getSession: () => session,
    getConfig: () => state.config,
    featureDisallowedTools: () => {
      reads += 1;
      return state.denied;
    },
    modelStandaloneTools: () => [],
    getRoute: () => ({}),
    getMode: () => 'full',
    getDataDir: () => '',
    activeWorkflowContext: () => ({}),
  });
  await counted.reconcileTurnSettings();
  const after = reads;
  assert.equal(await counted.reconcileTurnSettings(), null);
  assert.equal(reads, after + 1, 'only the key is read');
});

test('a delegated worker takes the gates too, and a gate the caller denied stays denied', async () => {
  const session = conversation({
    id: 'sess_worker',
    owner: 'agent',
    callerDisallowedTools: ['web_fetch'],
    disallowedTools: ['web_search', 'web_fetch'],
  });
  const state = { config: {}, denied: ['web_search', 'web_fetch'] };
  const refresh = refresher(session, state);
  await refresh.reconcileTurnSettings();
  state.config = {};
  state.denied = [];
  const result = await refresh.reconcileTurnSettings();
  assert.deepEqual(result.added, ['web_search']);
  assert.deepEqual(session.disallowedTools, ['web_fetch']);
});

test('an empty session is rebuilt from the settings at its turn start', async () => {
  const session = {
    id: 'sess_empty',
    promptIdentity: { systemPrompt: '', profileSkip: {}, agent: null, skipAgentRules: false },
    callerDisallowedTools: [],
    disallowedTools: [],
    messages: [
      { role: 'system', content: '# Tool Calls\nweb→`web_search`;\n' },
      { role: 'system', content: '# Profile' },
      { role: 'system', content: '# Active Workflow: Solo\n', cacheTier: 'tier3' },
    ],
    tools: [tool('read'), tool('web_search')],
    deferredToolCatalog: [tool('read'), tool('web_search')],
    workflow: { id: 'solo', delegatesAgents: false },
  };
  const state = { config: {}, denied: [] };
  const refresh = refresher(session, state);
  refresh.noteToolAvailability(session);
  assert.equal(await refresh.reconcileTurnSettings(), null, 'built from these settings');
  state.config = {};
  state.denied = ['web_search', 'web_fetch'];
  const result = await refresh.reconcileTurnSettings();
  assert.equal(result.rebuilt, true);
  assert.equal(
    session.tools.some((t) => t.name === 'web_search'),
    false
  );
  assert.ok(session.disallowedTools.includes('web_search'));
  assert.equal(session.pendingDeferredToolDelta, undefined, 'nothing to announce: nothing was sent');
});

/** A coding Lead whose prompt was composed from `config` and `memory`. */
function leadSession({ conversation: withConversation = true } = {}) {
  return {
    id: 'sess_lead',
    provider: 'anthropic',
    model: 'test',
    promptIdentity: { systemPrompt: '', profileSkip: {}, agent: null, skipAgentRules: false },
    callerDisallowedTools: [],
    disallowedTools: [],
    bp3EnvSplit: true,
    bp3EnvironmentContext: '- Cwd: C:/work',
    bp3CoreContext: '# Active Workflow: Solo',
    messages: [
      { role: 'system', content: '# Tool Calls\nrules' },
      { role: 'system', content: '# Profile' },
      { role: 'system', content: '# Active Workflow: Solo', cacheTier: 'tier3' },
      { role: 'system', content: '# Session\nCwd: C:/work\n\n---\n\n- Cwd: C:/work', cacheTier: 'env' },
      ...(withConversation
        ? [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi' },
          ]
        : []),
    ],
    tools: [tool('read'), tool('web_search')],
    deferredToolCatalog: [tool('read'), tool('web_search')],
    workflow: { id: 'solo', delegatesAgents: false },
    // What the composer recorded for an empty profile and no memory.
    promptSettings: undefined,
  };
}

const systemText = (session) =>
  session.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');

// Review P2: an empty session read before its first turn (tool status,
// context status) shows the settings that turn will send.
test('an empty session read before any turn reflects a feature just disabled', async () => {
  const { createAgentOps } = await import('./turn/agent-ops.mjs');
  const session = leadSession({ conversation: false });
  const state = { config: {}, denied: [] };
  const refresh = refresher(session, state);
  refresh.noteToolAvailability(session);
  const ops = createAgentOps({
    getSession: () => session,
    getMode: () => 'full',
    activeToolSurface: () => session,
    reconcileEmptySession: refresh.reconcileEmptySession,
  });
  state.config = {};
  state.denied = ['web_search', 'web_fetch'];
  assert.equal(refresh.emptySessionStale(), true);
  const status = await ops.toolsStatus();
  assert.equal(
    status.tools.some((row) => row.name === 'web_search'),
    false
  );
  assert.equal(refresh.emptySessionStale(), false);
});

test('prompt settings changed mid-conversation are told once, prefix intact, and folded when cold', async () => {
  const session = leadSession();
  const state = { config: { profile: { language: 'en' } }, denied: [], memory: '- old fact' };
  const refresh = refresher(session, state);
  // The first look records what the prompt presents.
  await refresh.reconcileTurnSettings();
  assert.ok(session.promptSettings?.revision);
  assert.equal(session.promptSettingsNotice, undefined);
  const before = prefix(session);

  // Another runtime saved a title and Korean; core memory was edited.
  state.config = { profile: { title: 'Boss', language: 'ja' } };
  state.memory = '- new fact';
  const result = await refresh.reconcileTurnSettings();
  assert.deepEqual(result.settingsChanged.sort(), ['coreMemory', 'language', 'meta']);
  assert.equal(prefix(session), before, 'the cached prefix is byte-identical');
  const notice = session.promptSettingsNotice.content;
  assert.match(notice, /^<system-reminder>\nSettings changed during this conversation/);
  // Changed fields, one line each; the language as one line; memory as a diff.
  assert.match(notice, /# Profile\n\+ - Address the user as "Boss"/);
  assert.match(notice, /# Language\nRespond in Japanese[^\n]* from now on\./);
  assert.match(notice, /# Core Memory\nCore memory was updated:\n- - old fact\n\+ - new fact/);
  assert.doesNotMatch(notice, /The user changed/);
  assert.equal(session.promptFoldPending, true);

  // The provider accepted the turn: told once.
  const { acknowledgePendingPromptSettingsNotice } = await import(
    '../runtime/agent/orchestrator/session/manager/prompt-settings.mjs'
  );
  assert.equal(acknowledgePendingPromptSettingsNotice(session, session.promptSettingsNotice.revision), true);
  state.config = { ...state.config };
  await refresh.reconcileTurnSettings();
  assert.equal(session.promptSettingsNotice, undefined, 'no repeat for what was told');

  // A compaction makes the cache cold: the prompt takes every setting.
  session.pendingCacheBreakIntent = 'post_turn_compaction';
  assert.equal(await refresh.applyPendingAgentProfile(), true);
  const text = systemText(session);
  assert.match(text, /Address the user as "Boss"/);
  assert.match(text, /# Core Memory\n- new fact/);
  const env = session.messages.find((m) => m.cacheTier === 'env').content;
  assert.match(env, /- Always respond in Japanese[\s\S]*$/, 'the language block closes the environment');
  assert.equal(session.promptFoldPending, undefined);
  assert.equal(session.promptSettingsTold, undefined);
});

test('a compacted Lead lists its late tools in the rebuilt manifest instead of re-announcing them', async () => {
  const session = leadSession();
  const state = { config: {}, denied: [], memory: '' };
  const refresh = refresher(session, state);
  await refresh.reconcileTurnSettings();
  session.deferredLateToolCatalog = [tool('office')];
  session.deferredAnnouncedTools = ['read', 'web_search'];
  session.pendingDeferredToolDelta = {
    version: 1,
    type: 'deferred_tools_delta',
    revision: 1,
    added: [{ name: 'office', description: 'office tool.' }],
    removed: [],
  };
  session.pendingCacheBreakIntent = 'post_turn_compaction';
  assert.equal(await refresh.applyPendingAgentProfile(), true);
  assert.ok(session.deferredToolCatalog.some((t) => t.name === 'office'), 'folded into the boot catalog');
  assert.deepEqual(session.deferredLateToolCatalog, []);
  assert.equal(session.pendingDeferredToolDelta, undefined, 'the manifest lists it: no notice');
});

test('an empty session takes prompt settings into BP2, the core and the language block', async () => {
  const session = leadSession({ conversation: false });
  const state = { config: { profile: { language: 'en' } }, denied: [], memory: '' };
  const refresh = refresher(session, state);
  refresh.noteToolAvailability(session, '');
  state.config = { profile: { title: 'Boss', language: 'ja' } };
  state.memory = '- remembered';
  const result = await refresh.reconcileTurnSettings();
  assert.equal(result.rebuilt, true);
  const text = systemText(session);
  assert.match(text, /Address the user as "Boss"/, 'BP2 profile section rebuilt');
  assert.match(text, /# Core Memory\n- remembered/);
  assert.match(session.messages.find((m) => m.cacheTier === 'env').content, /Always respond in Japanese/);
  assert.equal(session.promptSettingsNotice, undefined, 'nothing to tell: nothing was sent');
});

test('the first turn drops MCP tools whose server left after the session was made', () => {
  const session = {
    messages: [{ role: 'system', content: 'x' }],
    tools: [tool('read')],
    deferredProviderMode: 'native',
    deferredToolCatalog: [tool('read'), tool('mcp__gone__a'), tool('mcp__here__b')],
  };
  assert.equal(refreshInitialDeferredMcpSurface(session, [tool('mcp__here__b')]), true);
  assert.deepEqual(
    session.deferredToolCatalog.map((t) => t.name),
    ['read', 'mcp__here__b']
  );
});

test('an MCP reconcile keeps a built-in a settings gate opened in the late pool', () => {
  const session = conversation({ deferredLateToolCatalog: [tool('web_search')], disallowedTools: [] });
  reconcileDeferredMcpToolCatalog(session, []);
  assert.deepEqual(
    session.deferredLateToolCatalog.map((t) => t.name),
    ['web_search']
  );
});
