// Settings that reach a live session without a new one: tool gates, connector
// switches and compaction, read from the runtime's settings.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const dataRoot = mkdtempSync(join(tmpdir(), 'settings-reach-'));
const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = dataRoot;
test.after(() => {
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(dataRoot, { recursive: true, force: true });
});

const { createToolPolicyRefresh } = await import('./tool-policy-refresh.mjs');
const { wireContextStatus } = await import('./boot/tools.mjs');
const { mergePendingDeferredToolDelta, DELTA_DESCRIPTION_MAX } = await import(
  '../runtime/agent/orchestrator/runtime-core/deferred-tool-delta.mjs'
);
const { registerLiveFeatureGates, settingDisabledTool } = await import(
  '../runtime/agent/orchestrator/runtime-core/tool-availability.mjs'
);
const { dispatchToolCall } = await import('../runtime/agent/orchestrator/session/loop/tool-exec/dispatch.mjs');
const { reconcileAgentSession } = await import('../runtime/agent/orchestrator/agent-runtime/session-builder.mjs');

const tool = (name) => ({ name, description: `${name} tool.`, inputSchema: { type: 'object', properties: {} } });

function refresher(session, { modelStandaloneTools = () => [tool('read')] } = {}) {
  return createToolPolicyRefresh({
    getSession: () => session,
    getRoute: () => ({ provider: 'anthropic', model: 'test' }),
    getMode: () => 'full',
    getConfig: () => ({}),
    getDataDir: () => dataRoot,
    modelStandaloneTools,
    featureDisallowedTools: () => [],
    loadCoreMemoryContext: async () => '',
    activeWorkflowContext: () => ({ summary: { id: 'solo', name: 'Solo' }, packContext: '', leadPromptParts: {} }),
    invalidatePreSessionToolSurface: () => {},
  });
}

const chat = (overrides = {}) => ({
  id: 'sess_reach',
  provider: 'anthropic',
  callerDisallowedTools: [],
  disallowedTools: [],
  messages: [
    { role: 'system', content: '# Tool Calls\nrules' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ],
  tools: [tool('read'), tool('load_tool')],
  deferredToolCatalog: [tool('read')],
  deferredProviderMode: 'native',
  ...overrides,
});

test('a coding Lead whose old agent denial lifts gets `agent` in the late pool, never the boot catalog', async () => {
  const session = chat({ disallowedTools: ['agent'], promptIdentity: { agent: 'lead' } });
  const bootCatalog = JSON.stringify(session.deferredToolCatalog);
  const refresh = refresher(session, { modelStandaloneTools: () => [tool('read'), tool('agent')] });
  assert.equal(await refresh.applyPendingAgentProfile(), true);
  assert.equal(JSON.stringify(session.deferredToolCatalog), bootCatalog);
  assert.deepEqual(
    session.deferredLateToolCatalog.map((t) => t.name),
    ['agent']
  );
  assert.deepEqual(
    session.pendingDeferredToolDelta.added.map((e) => e.name),
    ['agent']
  );
});

test('a project switching a connector off is announced at the next turn start', async () => {
  const project = join(dataRoot, 'proj');
  const session = chat({ cwd: project, deferredToolCatalog: [tool('read'), tool('mcp__gmail__send')] });
  const refresh = refresher(session);
  await refresh.reconcileTurnSettings();
  assert.deepEqual(session.agentConnectorTools, ['mcp__gmail__send'], 'the baseline');
  writeFileSync(
    join(dataRoot, 'project-connectors.json'),
    JSON.stringify({ projects: { [resolve(project)]: { off: ['gmail'] } } })
  );
  const result = await refresh.reconcileTurnSettings();
  assert.deepEqual(result.removed, ['mcp__gmail__send']);
  assert.deepEqual(session.pendingDeferredToolDelta.removed, ['mcp__gmail__send']);
  rmSync(join(dataRoot, 'project-connectors.json'));
});

test('a built-in tool a setting turned off mid-turn is refused at dispatch (git included)', async () => {
  let denied = [];
  const dispose = registerLiveFeatureGates('scope-reach', () => denied);
  try {
    assert.equal(settingDisabledTool('git', 'scope-reach'), null);
    denied = ['git', 'github', 'web_search', 'web_fetch', 'browser'];
    assert.equal(settingDisabledTool('git', 'scope-reach'), 'git');
    assert.equal(settingDisabledTool('github', 'scope-reach'), 'github');
    assert.equal(settingDisabledTool('local_fetch', 'scope-reach'), 'web_fetch');
    assert.equal(settingDisabledTool('browser', 'scope-reach'), null, 'bridge presence is not a setting');
    const out = dispatchToolCall(
      { name: 'git', args: { action: 'status' } },
      { cwd: dataRoot, sessionRef: { mcpScopeId: 'scope-reach' }, executeOpts: {}, toolOpts: {} }
    );
    assert.match(String(out), /tool "git" is disabled in settings/);
  } finally {
    dispose();
  }
  assert.equal(settingDisabledTool('git', 'scope-reach'), null);
});

test('a reused in-process worker takes the saved compaction settings and keeps its own', () => {
  writeFileSync(
    join(dataRoot, 'mixdog-config.json'),
    JSON.stringify({ agent: { compaction: { auto: false, mainBufferPercent: 20 } } })
  );
  const session = {
    id: 'sess_worker_reach',
    owner: 'agent',
    tools: [],
    disallowedTools: [],
    compaction: { auto: true, mainBufferPercent: 50, conversationThresholdTokens: 5 },
  };
  reconcileAgentSession(session);
  assert.equal(session.compaction.auto, false);
  assert.equal(session.compaction.mainBufferPercent, 20);
  assert.equal(session.compaction.conversationThresholdTokens, 5);
  rmSync(join(dataRoot, 'mixdog-config.json'));
});

test('a deferred tools delta names tools with at most an 80-character hint', () => {
  const session = {};
  mergePendingDeferredToolDelta(session, { added: [{ name: 'long', description: 'x '.repeat(200) }] });
  const [entry] = session.pendingDeferredToolDelta.added;
  assert.ok(entry.description.length <= DELTA_DESCRIPTION_MAX);
  assert.equal(DELTA_DESCRIPTION_MAX, 80);
});

test('an async context status read waits for the empty session reconcile; the sync one asks for a re-read', async () => {
  let stale = true;
  const order = [];
  const events = [];
  const boot = {
    rt: { session: null, route: { provider: 'demo' }, currentCwd: dataRoot, mode: 'full' },
    emptySessionStale: () => stale,
    reconcileEmptySession: async () => {
      order.push('reconcile');
      stale = false;
      return { rebuilt: true };
    },
    emitRuntimeNotification: (_text, meta) => events.push(meta),
  };
  wireContextStatus(boot);
  await boot.computeContextStatusSettled();
  order.push('status');
  assert.deepEqual(order, ['reconcile', 'status']);
  stale = true;
  boot.computeContextStatus();
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(events, [{ kind: 'setup-changed', action: 'context_status_refreshed' }]);
});
