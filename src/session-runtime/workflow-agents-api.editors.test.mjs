// Characterization of the agent / workflow editor surfaces of the
// workflow-agents API against a real data directory: catalog listing, custom
// agent create/update/delete (including starter tombstones and fixed-role
// overrides), and workflow pack create/save/delete with active fallback.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createWorkflowAgentsApi } from './workflow-agents-api.mjs';
import {
  AGENT_DELETED_MARKER,
  FIXED_AGENT_SLOTS,
  createWorkflowHelpers,
  createWorkflowRouteHelpers,
  workflowIdFromName,
} from './workflow.mjs';
import { readMarkdownDocument, normalizeAgentPermissionOrNone } from '../runtime/shared/markdown-frontmatter.mjs';

const MAIN = { provider: 'openai', model: 'main-model' };

function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-workflow-agents-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const helpers = createWorkflowHelpers({
    rootDir: join(process.cwd(), 'src'),
    dataDir,
    readMarkdownDocument,
    normalizeAgentPermissionOrNone,
  });
  const routeHelpers = createWorkflowRouteHelpers({ findPreset: () => null });
  const state = { config: { workflow: { active: 'default' } }, refreshes: 0 };
  const api = createWorkflowAgentsApi({
    ...helpers,
    getConfig: () => state.config,
    displayConfig: () => state.config,
    cfgMod: { getPluginData: () => dataDir },
    STANDALONE_DATA_DIR: dataDir,
    resolveRoute: (_config, requested) => (Object.keys(requested).length ? { ...requested } : { ...MAIN }),
    agentRouteFromConfig: routeHelpers.agentRouteFromConfig,
    saveConfigAndAdopt: (value) => {
      state.config = value;
    },
    lookupModelMeta: async () => ({}),
    ensureProvidersReady: async () => {},
    refreshEmptySessionToolPolicy: async () => {
      state.refreshes += 1;
      return { appliedToCurrentSession: true };
    },
    invalidateContextStatusCache() {},
  });
  return { dataDir, helpers, state, api };
}

test('listAgents reports the fixed roles first with the effective Main route, then every custom agent', (t) => {
  const { dataDir, helpers, api } = fixture(t);
  const agents = api.listAgents();
  const fixed = agents.slice(0, FIXED_AGENT_SLOTS.length);
  assert.deepEqual(
    fixed.map((agent) => [agent.id, agent.locked, agent.userOverride, agent.disabled]),
    FIXED_AGENT_SLOTS.map((agent) => [agent.id, true, false, false])
  );
  assert.deepEqual(fixed[0].route, { ...MAIN });
  const customIds = helpers.listCustomAgentIds(dataDir);
  assert.ok(customIds.length > 0, 'starter agents ship as custom agents');
  assert.deepEqual(
    agents.slice(FIXED_AGENT_SLOTS.length).map((agent) => agent.id),
    customIds
  );
  for (const agent of agents.slice(FIXED_AGENT_SLOTS.length)) {
    assert.equal(agent.custom, true);
    assert.equal(agent.userOverride, false);
    assert.equal(agent.label, agent.definition?.name || agent.id);
  }
});

test('saveAgentDefinition creates a custom agent (id from name, AGENT.md + manifest, optional route) and delete removes it everywhere', async (t) => {
  const { dataDir, state, api } = fixture(t);
  const created = await api.saveAgentDefinition({
    name: 'Release  Captain',
    description: 'Ships\nreleases',
    body: 'Cut releases carefully.',
    route: { provider: 'anthropic', model: 'claude' },
  });
  assert.equal(created.custom, true);
  assert.equal(created.userOverride, true);
  assert.equal(created.name, 'Release Captain');
  assert.equal(created.description, 'Ships releases');
  assert.equal(created.body, 'Cut releases carefully.');
  assert.equal(created.disabled, false);
  const savedRoute = { provider: 'anthropic', model: 'claude', fast: false, modelParameters: {} };
  assert.deepEqual(created.route, savedRoute);
  const dir = join(dataDir, 'agents', created.id);
  assert.match(
    readFileSync(join(dir, 'AGENT.md'), 'utf8'),
    /^---\nname: Release Captain\ndescription: Ships releases\n---\n/
  );
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'agent.json'), 'utf8')), {
    name: 'Release Captain',
    description: 'Ships releases',
  });
  assert.deepEqual(state.config.agents[created.id], savedRoute);
  assert.ok(api.listAgents().some((agent) => agent.id === created.id && agent.custom));

  const renamed = await api.saveAgentDefinition({ id: created.id, name: 'Captain', body: 'Updated.' });
  assert.equal(renamed.id, created.id);
  assert.equal(renamed.name, 'Captain');
  assert.equal(renamed.body, 'Updated.');
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(join(dir, 'agent.json'), 'utf8')), 'description'), false);

  assert.deepEqual(await api.deleteAgentDefinition(created.id), {
    id: created.id,
    deleted: true,
    revertedToBuiltIn: false,
  });
  assert.equal(existsSync(dir), false);
  assert.equal(Object.hasOwn(state.config.agents || {}, created.id), false);
  assert.throws(() => api.getAgentDefinition(created.id), /not found/);
});

test('agent editor validation: empty body, bad id, missing name, hidden roles', async (t) => {
  const { api } = fixture(t);
  await assert.rejects(api.saveAgentDefinition({ name: 'x' }), /AGENT.md body must not be empty/);
  await assert.rejects(api.saveAgentDefinition({ id: '///', body: 'b' }), /agent id must contain letters\/numbers/);
  await assert.rejects(api.saveAgentDefinition({ body: 'b' }), /agent name must not be empty/);
  assert.throws(() => api.getAgentDefinition('   '), /unknown agent/);
  await assert.rejects(api.deleteAgentDefinition('does-not-exist'), /not found/);
});

test('deleting a shipped starter agent leaves a tombstone; a fixed role needs an override to reset and then reverts', async (t) => {
  const { dataDir, helpers, api } = fixture(t);
  const starter = helpers.listCustomAgentIds(dataDir)[0];
  const result = await api.deleteAgentDefinition(starter);
  assert.deepEqual(result, { id: starter, deleted: true, revertedToBuiltIn: false });
  assert.equal(existsSync(join(dataDir, 'agents', starter, AGENT_DELETED_MARKER)), true);
  assert.equal(helpers.loadAgentDefinition(dataDir, starter), null);
  assert.equal(helpers.listCustomAgentIds(dataDir).includes(starter), false);

  const fixed = FIXED_AGENT_SLOTS[0].id;
  await assert.rejects(api.deleteAgentDefinition(fixed), /has no user override to reset/);
  const override = await api.saveAgentDefinition({ id: fixed, body: 'Custom maintainer prompt.' });
  assert.equal(override.custom, false);
  assert.equal(override.userOverride, true);
  assert.equal(api.listAgents().find((agent) => agent.id === fixed).userOverride, true);
  assert.deepEqual(await api.deleteAgentDefinition(fixed), { id: fixed, deleted: true, revertedToBuiltIn: true });
  assert.equal(api.getAgentDefinition(fixed).userOverride, false);
});

test('workflow packs: create derives a free id, save/list/set round-trip, delete falls the active workflow back to Default', async (t) => {
  const { dataDir, state, api } = fixture(t);
  const first = await api.createWorkflow({ name: 'Review  Flow', description: 'Two\nlines', body: 'Review first.' });
  assert.equal(first.id, workflowIdFromName('Review Flow'));
  assert.deepEqual(first, {
    id: first.id,
    name: 'Review Flow',
    description: 'Two lines',
    source: first.source,
    body: 'Review first.',
    userOverride: true,
  });
  const second = await api.createWorkflow({ name: 'Review Flow', body: 'Again.' });
  assert.notEqual(second.id, first.id, 'a taken id yields the next available one');
  await assert.rejects(api.createWorkflow({ id: first.id, name: 'Dup', body: 'x' }), /already exists/);
  await assert.rejects(api.createWorkflow({ name: '   ', body: 'x' }), /workflow name must not be empty/);
  await assert.rejects(api.saveWorkflowPack({ id: first.id, body: '  ' }), /WORKFLOW.md body must not be empty/);

  assert.deepEqual(
    api.listWorkflows().map((workflow) => [workflow.id, workflow.active]),
    [
      ['default', true],
      [first.id, false],
      [second.id, false],
    ]
  );
  const applied = await api.setWorkflow(first.id);
  assert.equal(applied.appliedToCurrentSession, true);
  assert.equal(state.config.workflow.active, first.id);
  assert.equal(state.refreshes, 1);
  await assert.rejects(api.setWorkflow('nope'), /workflow "nope" not found/);

  assert.deepEqual(await api.deleteWorkflow(first.id), { id: first.id, deleted: true, revertedToBuiltIn: false });
  assert.equal(state.config.workflow.active, 'default', 'a removed active pack falls back to Default');
  assert.equal(existsSync(join(dataDir, 'workflows', first.id)), false);
  assert.throws(() => api.getWorkflowPack(first.id), /not found/);
  await assert.rejects(api.deleteWorkflow(first.id), /not found/);
  assert.throws(() => api.getWorkflowPack(''), /unknown workflow/);
});

test('a built-in workflow cannot be deleted until a user override exists; deleting the override reverts it', async (t) => {
  const { dataDir, api } = fixture(t);
  await assert.rejects(api.deleteWorkflow('default'), /built-in and cannot be deleted/);
  const builtIn = api.getWorkflowPack('default');
  assert.equal(builtIn.userOverride, false);
  const saved = await api.saveWorkflowPack({ id: 'default', body: 'Overridden default.' });
  assert.equal(saved.userOverride, true);
  assert.equal(saved.name, 'default', 'a missing name falls back to the id');
  assert.match(
    readFileSync(join(dataDir, 'workflows', 'default', 'WORKFLOW.md'), 'utf8'),
    /^---\nid: default\nname: default\n---\n/
  );
  assert.deepEqual(await api.deleteWorkflow('default'), { id: 'default', deleted: true, revertedToBuiltIn: true });
  assert.equal(api.getWorkflowPack('default').body, builtIn.body);
});
