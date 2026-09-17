import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createWorkflowHelpers } from './workflow.mjs';
import { createWorkflowAgentsApi } from './workflow-agents-api.mjs';
import { createToolSurface } from './tool-surface.mjs';
import { createToolPolicyRefresh } from './tool-policy-refresh.mjs';
import { orchestrationInstructions } from './orchestration.mjs';
import { ORCHESTRATION_MODES, sessionOrchestrationMode } from '../runtime/shared/orchestration.mjs';
import { readMarkdownDocument, normalizeAgentPermissionOrNone } from '../runtime/shared/markdown-frontmatter.mjs';
import { _sessionForDisk } from '../runtime/agent/orchestrator/session/store/serialize.mjs';

function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-orchestration-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const helpers = createWorkflowHelpers({
    rootDir: join(process.cwd(), 'src'), dataDir, readMarkdownDocument, normalizeAgentPermissionOrNone,
  });
  return { dataDir, helpers };
}

test('all modes share Default while only active modes inject instructions and agents', (t) => {
  const { dataDir, helpers } = fixture(t);
  assert.deepEqual(helpers.listWorkflowPacks(dataDir).map((pack) => pack.id), ['default']);
  const body = helpers.loadWorkflowPack(dataDir, 'default').body;
  assert.doesNotMatch(body, /Delegate maximally|Dispatch all ready/);
  assert.match(body, /user approves the latest plan/);
  // Reviewer fallback rides with the orchestration instructions, so mode none never sees it.
  assert.doesNotMatch(body, /Lead alone reviews/);
  const expected = {
    focused: /Lead executes the main scope directly/,
    balanced: /coherent feature or module/,
    swarm: /Delegate maximally/,
  };
  for (const mode of ORCHESTRATION_MODES) {
    const result = helpers.activeWorkflowContext({ workflow: { active: 'default' }, orchestrationMode: mode }, dataDir);
    assert.equal(result.summary.name, 'Default');
    assert.equal(result.orchestrationMode, mode);
    assert.equal(result.summary.delegatesAgents, mode !== 'none');
    assert.equal(result.context.includes('# Available Agents'), mode !== 'none');
    if (mode === 'none') {
      assert.equal(orchestrationInstructions(mode), '');
      assert.doesNotMatch(result.context, /# Orchestration Mode:|Lead alone reviews/);
    } else {
      assert.match(result.context, expected[mode]);
      assert.match(result.context, /Dispatch all ready independent scopes in one turn/);
      assert.match(result.context, /Lead alone reviews/);
    }
  }
});

test('workflow frontmatter no longer controls delegation; agent availability remains independent', (t) => {
  const { dataDir, helpers } = fixture(t);
  const dir = join(dataDir, 'workflows', 'custom');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'WORKFLOW.md'), '---\nid: custom\nname: Custom\ndelegation: none\n---\nCustom approval rule.');
  const config = { workflow: { active: 'custom' }, orchestrationMode: 'balanced' };
  const active = helpers.activeWorkflowContext(config, dataDir);
  assert.equal(active.summary.delegatesAgents, true);
  assert.match(active.context, /Custom approval rule/);
  const disabledAgents = helpers.listCustomAgentIds(dataDir);
  const empty = helpers.activeWorkflowContext({ ...config, disabledAgents }, dataDir);
  assert.equal(empty.summary.delegatesAgents, false);
  assert.match(empty.context, /# Orchestration Mode: Balanced/);
  assert.doesNotMatch(empty.context, /# Available Agents/);
});

test('mode API validates, persists, and refreshes without changing the workflow or agent configuration', async (t) => {
  const { dataDir, helpers } = fixture(t);
  let config = { workflow: { active: 'default' }, orchestrationMode: 'none', agents: { worker: { model: 'test' } } };
  let refreshes = 0;
  const api = createWorkflowAgentsApi({
    ...helpers, getConfig: () => config, displayConfig: () => config,
    cfgMod: { getPluginData: () => dataDir }, STANDALONE_DATA_DIR: dataDir,
    saveConfigAndAdopt: (value) => { config = value; },
    refreshEmptySessionToolPolicy: async () => { refreshes++; return { appliedToCurrentSession: true }; },
    invalidateContextStatusCache() {},
  });
  for (const mode of ORCHESTRATION_MODES) {
    const result = await api.setOrchestrationMode(mode);
    assert.equal(api.getOrchestrationMode(), mode);
    assert.equal(result.appliedToCurrentSession, true);
    assert.deepEqual(config.workflow, { active: 'default' });
    assert.deepEqual(config.agents, { worker: { model: 'test' } });
  }
  assert.equal(refreshes, 4);
  await assert.rejects(api.setOrchestrationMode('invalid'), /orchestration mode must be one of/);
  assert.equal(api.getOrchestrationMode(), 'swarm');
  await api.saveWorkflowPack({ id: 'custom', name: 'Custom', body: 'Approval rule.', delegation: 'none', agents: 'worker' });
  const saved = readFileSync(join(dataDir, 'workflows', 'custom', 'WORKFLOW.md'), 'utf8');
  assert.doesNotMatch(saved, /delegation:|agents:/);
  assert.equal(Object.hasOwn(api.getWorkflowPack('custom'), 'delegatesAgents'), false);
  assert.equal(Object.hasOwn(api.listWorkflows()[0], 'delegatesAgents'), false);
});

test('mode changes refresh an empty session, remove stale tools, and survive session serialization', async (t) => {
  const { dataDir, helpers } = fixture(t);
  let config = { workflow: { active: 'default' }, orchestrationMode: 'none' };
  const session = {
    id: 'orchestration-test', workflow: { id: 'default', delegatesAgents: false }, orchestrationMode: 'none',
    messages: [
      { role: 'system', content: '# Tool Use\nRules' },
      { role: 'system', content: '# Active Workflow: Default', cacheTier: 'tier3' },
    ],
    tools: [{ name: 'read' }], deferredToolCatalog: [],
  };
  const tools = [{ name: 'read' }, { name: 'agent' }];
  const surface = createToolSurface({
    mgr: { previewSessionTools: () => tools }, mode: 'full', standaloneTools: tools,
    agentToolNames: new Set(['agent']), getSession: () => session, getRoute: () => ({ provider: 'openai-oauth' }),
    getConfig: () => config, cfgMod: { getPluginData: () => dataDir }, dataDir,
    delegatableAgentIds: helpers.delegatableAgentIds,
  });
  const refresh = createToolPolicyRefresh({
    getSession: () => session, getRoute: () => ({ provider: 'openai-oauth' }), getMode: () => 'full',
    getConfig: () => config, getDataDir: () => dataDir, modelStandaloneTools: surface.modelStandaloneTools,
    featureDisallowedTools: () => [], memoryToolsEnabled: () => false,
    activeWorkflowContext: helpers.activeWorkflowContext,
  });
  for (const mode of ['focused', 'balanced', 'swarm', 'none']) {
    config = { ...config, orchestrationMode: mode };
    await refresh.refreshEmptySessionToolPolicy();
    assert.equal(session.orchestrationMode, mode);
    assert.equal(surface.modelStandaloneTools().some((tool) => tool.name === 'agent'), mode !== 'none');
    assert.equal(session.messages[1].content.includes('# Orchestration Mode:'), mode !== 'none');
    assert.equal(_sessionForDisk(session).orchestrationMode, mode);
  }
  session.messages.push({ role: 'user', content: 'keep this conversation frozen' });
  config = { ...config, orchestrationMode: 'swarm' };
  assert.equal((await refresh.refreshEmptySessionToolPolicy()).appliedToCurrentSession, false);
  assert.equal(session.orchestrationMode, 'none');
  assert.equal(sessionOrchestrationMode({ workflow: { id: 'solo', delegatesAgents: false } }), 'none');
  assert.equal(sessionOrchestrationMode({ workflow: { id: 'default', delegatesAgents: true } }), 'swarm');
});
