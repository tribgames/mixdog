// A remote client may narrow what a bot runs without asking, never widen it. The
// runtime writers judge `options.noWiden` (added only by the desktop's remote
// method table) against the CURRENT state in the same synchronous stretch /
// file lock as the write, so a restriction the owner adds meanwhile survives.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createWorkflowAgentsApi } from './workflow-agents-api.mjs';
import {
  createWorkflowHelpers,
  createWorkflowRouteHelpers,
} from '../runtime/agent/orchestrator/runtime-core/workflow.mjs';
import { readMarkdownDocument, normalizeAgentPermissionOrNone } from '../runtime/shared/markdown-frontmatter.mjs';
import {
  createHumanGateStore,
  setAgentPermission,
  setHumanGateStore,
} from '../runtime/agent/orchestrator/session/human-gate/store.mjs';

const SERVERS = ['github', 'notion'].map((name) => ({
  name,
  enabled: true,
  status: 'connected',
  connected: true,
  transport: 'http',
  toolCount: 1,
  source: 'config',
}));
const NO_WIDEN = { noWiden: true };
const WIDEN = /widen/;

function fixture(t, { projects = [] } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-no-widen-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const helpers = createWorkflowHelpers({
    rootDir: join(process.cwd(), 'src'),
    dataDir,
    readMarkdownDocument,
    normalizeAgentPermissionOrNone,
  });
  const routeHelpers = createWorkflowRouteHelpers({ findPreset: () => null });
  const state = { config: { workflow: { active: 'default' } } };
  const api = createWorkflowAgentsApi({
    ...helpers,
    getConfig: () => state.config,
    displayConfig: () => state.config,
    cfgMod: { getPluginData: () => dataDir },
    STANDALONE_DATA_DIR: dataDir,
    resolveRoute: () => ({ provider: 'openai', model: 'main-model' }),
    agentRouteFromConfig: routeHelpers.agentRouteFromConfig,
    saveConfigAndAdopt: (value) => {
      state.config = value;
    },
    lookupModelMeta: async () => ({}),
    ensureProvidersReady: async () => {},
    invalidateContextStatusCache() {},
    mcpStatus: () => ({ servers: SERVERS }),
    getMcpTools: () => [],
    listProjects: () => projects,
    resolveConfiguredMcpCatalog: () => ({ servers: { github: {}, notion: {} }, warnings: [] }),
  });
  return { dataDir, api };
}

const stored = (dataDir, id) => JSON.parse(readFileSync(join(dataDir, 'agents', id, 'agent.json'), 'utf8')).connectors;

async function botWith(api, connectors) {
  const { id } = await api.saveAgentDefinition({ name: 'Scribe', body: 'Write.' });
  await api.setAgentConnectors(id, connectors);
  return id;
}

test('a remote call cannot switch a connector back on, but can switch one off', async (t) => {
  const { dataDir, api } = fixture(t);
  const id = await botWith(api, { off: ['github'], tools: { notion: { search: 'needs_approval' } } });
  await assert.rejects(api.setAgentConnectorEnabled(id, 'github', true, NO_WIDEN), WIDEN);
  assert.deepEqual(stored(dataDir, id).off, ['github'], 'unchanged');
  // The desktop itself can still do it; and narrowing is open to the remote client.
  await api.setAgentConnectorEnabled(id, 'notion', false, NO_WIDEN);
  assert.deepEqual(stored(dataDir, id).off, ['github', 'notion']);
  await api.setAgentConnectorEnabled(id, 'github', true);
  assert.deepEqual(stored(dataDir, id).off, ['notion']);
});

test('a remote project switch cannot enable a connector the project turned off', async (t) => {
  const project = mkdtempSync(join(tmpdir(), 'mixdog-no-widen-project-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const { api } = fixture(t, { projects: [{ path: project }] });
  api.setProjectConnectorEnabled(project, 'github', false);
  assert.throws(() => api.setProjectConnectorEnabled(project, 'github', true, NO_WIDEN), WIDEN);
  assert.deepEqual(api.getProjectConnectors(project), [
    { id: 'github', enabled: false },
    { id: 'notion', enabled: true },
  ]);
  api.setProjectConnectorEnabled(project, 'notion', false, NO_WIDEN);
  api.setProjectConnectorEnabled(project, 'github', true);
  assert.deepEqual(api.getProjectConnectors(project), [
    { id: 'github', enabled: true },
    { id: 'notion', enabled: false },
  ]);
});

test('removing an override, replacing the policy, or connectors: null widens, and is refused remotely', async (t) => {
  const { dataDir, api } = fixture(t);
  const policy = { off: [], tools: { github: { create_issue: 'needs_approval', drop: 'disabled' } } };
  const id = await botWith(api, policy);
  for (const attempt of [
    () => api.setAgentConnectorToolPermission(id, 'github', 'create_issue', null, NO_WIDEN),
    () => api.setAgentConnectorToolPermission(id, 'github', 'create_issue', 'auto', NO_WIDEN),
    () => api.setAgentConnectorToolPermission(id, 'github', 'drop', 'needs_approval', NO_WIDEN),
    () => api.setAgentConnectors(id, null, NO_WIDEN),
    () => api.setAgentConnectors(id, { off: [], tools: {} }, NO_WIDEN),
    () => api.saveAgentDefinition({ id, body: 'Write.', connectors: null }, NO_WIDEN),
    () => api.saveAgentDefinition({ id, body: 'Write.', connectors: { off: [] } }, NO_WIDEN),
  ]) {
    await assert.rejects(attempt(), WIDEN, String(attempt));
  }
  assert.deepEqual(stored(dataDir, id), policy, 'nothing was written');
  // Narrowing, an unchanged policy and a save that does not carry connectors pass.
  await api.setAgentConnectorToolPermission(id, 'github', 'create_issue', 'disabled', NO_WIDEN);
  await api.setAgentConnectors(
    id,
    { off: ['notion'], tools: { github: { create_issue: 'disabled', drop: 'disabled' } } },
    NO_WIDEN
  );
  await api.saveAgentDefinition({ id, body: 'Write more.' }, NO_WIDEN);
  assert.deepEqual(stored(dataDir, id).off, ['notion']);
});

test("a restriction the owner adds between the remote client's read and its write is not overwritten", async (t) => {
  const { dataDir, api } = fixture(t);
  const open = { off: [], tools: { github: { create_issue: 'auto' } } };
  const id = await botWith(api, open);
  // The remote client read `open` and prepares to put it back. The owner revokes first...
  await api.setAgentConnectorToolPermission(id, 'github', 'create_issue', 'needs_approval');
  await assert.rejects(api.setAgentConnectors(id, open, NO_WIDEN), WIDEN);
  await assert.rejects(api.saveAgentDefinition({ id, body: 'Write.', connectors: open }, NO_WIDEN), WIDEN);
  assert.equal(stored(dataDir, id).tools.github.create_issue, 'needs_approval');
  // ...and in either order of two calls started together the revocation is what remains.
  await api.setAgentConnectors(id, open);
  await Promise.all([
    api.setAgentConnectors(id, open, NO_WIDEN).catch(() => {}),
    api.setAgentConnectorToolPermission(id, 'github', 'create_issue', 'needs_approval'),
  ]);
  assert.equal(stored(dataDir, id).tools.github.create_issue, 'needs_approval');
  await api.setAgentConnectors(id, open);
  await Promise.all([
    api.setAgentConnectorToolPermission(id, 'github', 'create_issue', 'needs_approval'),
    api.setAgentConnectors(id, open, NO_WIDEN).catch(() => {}),
  ]);
  assert.equal(stored(dataDir, id).tools.github.create_issue, 'needs_approval');
});

test('a remote permission change cannot lift a block or add an allow, even racing the owner', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-no-widen-store-'));
  const store = createHumanGateStore(dir);
  setHumanGateStore(store);
  t.after(() => {
    setHumanGateStore(null);
    rmSync(dir, { recursive: true, force: true });
  });
  const mode = () => store.modeFor({ agentId: 'scribe', action: 'browser_post' });
  await assert.rejects(setAgentPermission('scribe', 'browser_post', 'allow', NO_WIDEN), WIDEN);
  assert.equal(await mode(), 'ask');
  await setAgentPermission('scribe', 'browser_post', 'block', NO_WIDEN);
  assert.equal(await mode(), 'block');
  await assert.rejects(setAgentPermission('scribe', 'browser_post', 'ask', NO_WIDEN), WIDEN);
  assert.equal(await mode(), 'block', 'the block stands');
  // The owner can lift it; a remote client can then only narrow again.
  await setAgentPermission('scribe', 'browser_post', 'allow');
  await setAgentPermission('scribe', 'browser_post', 'ask', NO_WIDEN);
  assert.equal(await mode(), 'ask');
  // Remote `ask` computed while allowed, owner blocks meanwhile: the block is what remains, in both orders.
  for (const order of ['remote-first', 'owner-first']) {
    await setAgentPermission('scribe', 'browser_post', 'allow');
    const remote = () => setAgentPermission('scribe', 'browser_post', 'ask', NO_WIDEN).catch(() => {});
    const owner = () => setAgentPermission('scribe', 'browser_post', 'block');
    await Promise.all(order === 'remote-first' ? [remote(), owner()] : [owner(), remote()]);
    assert.equal(await mode(), 'block', order);
  }
  // A file-upload allow widens exactly like the others.
  const upload = () => store.modeFor({ agentId: 'scribe', action: 'browser_upload' });
  await assert.rejects(setAgentPermission('scribe', 'browser_upload', 'allow', NO_WIDEN), WIDEN);
  assert.equal(await upload(), 'ask');
  await setAgentPermission('scribe', 'browser_upload', 'block', NO_WIDEN);
  await assert.rejects(setAgentPermission('scribe', 'browser_upload', 'ask', NO_WIDEN), WIDEN);
  assert.equal(await upload(), 'block');
  await setAgentPermission('scribe', 'browser_upload', 'allow');
  await setAgentPermission('scribe', 'browser_upload', 'ask', NO_WIDEN);
  assert.equal(await upload(), 'ask');
});
