// Host surface of per-agent connectors against a real data directory: the
// field round-trips through the agent editor without touching other keys, the
// global listing reports sign-in state, and tool permissions are set per agent.
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test from 'node:test';
import { createWorkflowAgentsApi } from './workflow-agents-api.mjs';
import {
  createWorkflowHelpers,
  createWorkflowRouteHelpers,
} from '../runtime/agent/orchestrator/runtime-core/workflow.mjs';
import { readMarkdownDocument, normalizeAgentPermissionOrNone } from '../runtime/shared/markdown-frontmatter.mjs';
import { agentConnectors, connectorToolPermission } from '../runtime/agent/orchestrator/mcp/agent-connectors.mjs';
import { rememberServerConnector } from '../runtime/agent/orchestrator/mcp/server-connectors.mjs';

const agentMcpToolPermission = (id, tool, dataDir) => connectorToolPermission(agentConnectors(id, dataDir), tool);

const SERVERS = [
  {
    name: 'github',
    enabled: true,
    status: 'connected',
    connected: true,
    transport: 'http',
    toolCount: 2,
    source: 'config',
    oauth: { signedIn: true },
  },
  {
    name: 'notion',
    enabled: true,
    status: 'sign-in required',
    authRequired: true,
    connected: false,
    transport: 'http',
    toolCount: 0,
    source: 'config',
    oauth: { signedIn: false },
  },
];
const TOOLS = [
  { name: 'mcp__github__list_issues', description: 'List.', annotations: { readOnlyHint: true } },
  { name: 'mcp__github__create_issue', description: 'Create.' },
  { name: 'mcp__notion__search', description: 'Search.' },
];

function fixture(t, { projects = [], catalog = null, tools = TOOLS } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-agent-connectors-api-'));
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
    getMcpTools: () => tools,
    listProjects: () => projects,
    resolveConfiguredMcpCatalog: () =>
      catalog || { servers: Object.fromEntries(SERVERS.map((row) => [row.name, {}])), warnings: [] },
  });
  return { dataDir, api, state };
}

const manifestOf = (dataDir, id) => JSON.parse(readFileSync(join(dataDir, 'agents', id, 'agent.json'), 'utf8'));

const ALL_ON = [
  { id: 'github', enabled: true },
  { id: 'notion', enabled: true },
];

test('the connector policy round-trips through the editor and keeps every other key', async (t) => {
  const { dataDir, api } = fixture(t);
  const created = await api.saveAgentDefinition({
    name: 'Triager',
    body: 'Triage.',
    avatar: { kind: 'mascot', variant: 'floppy-calm-plain', color: '#e6e6e6' },
    persona: 'Dry wit.',
  });
  assert.deepEqual(api.getAgentConnectors(created.id), ALL_ON, 'no policy: every installed connector is on');
  const manifestFile = join(dataDir, 'agents', created.id, 'agent.json');
  const before = JSON.parse(readFileSync(manifestFile, 'utf8'));
  writeFileSync(manifestFile, `${JSON.stringify({ ...before, team: 'infra' })}\n`);

  const policy = { off: ['notion'], tools: { github: { create_issue: 'needs_approval' } } };
  assert.deepEqual(await api.setAgentConnectors(created.id, policy), policy);
  const after = manifestOf(dataDir, created.id);
  assert.deepEqual(after.connectors, policy);
  assert.deepEqual({ ...after, connectors: undefined }, { ...before, team: 'infra', connectors: undefined });
  assert.equal(readFileSync(join(dataDir, 'agents', created.id, 'PERSONA.md'), 'utf8').trim(), 'Dry wit.');
  assert.deepEqual(agentConnectors(created.id, dataDir)?.off, ['notion'], 'the runtime reads what the editor wrote');

  // A later definition save keeps the policy; null removes just the field.
  await api.saveAgentDefinition({ id: created.id, name: 'Triager', body: 'Triage more.' });
  assert.deepEqual(api.getAgentConnectors(created.id), [
    { id: 'github', enabled: true },
    { id: 'notion', enabled: false },
  ]);
  assert.equal(await api.setAgentConnectors(created.id, null), null);
  assert.equal('connectors' in manifestOf(dataDir, created.id), false);
  assert.equal(manifestOf(dataDir, created.id).team, 'infra');
  // An allow list or any other shape is refused, never saved as "every connector".
  await assert.rejects(api.setAgentConnectors(created.id, 'github'), /connectors must be/);
  await assert.rejects(api.setAgentConnectors(created.id, [{ id: 'github', enabled: true }]), /connectors must be/);
  await assert.rejects(api.saveAgentDefinition({ id: created.id, body: 'x', connectors: { id: 'a' } }), /connectors/);
  await assert.rejects(api.setAgentConnectors('nobody', null), /not found/);
});

test('Mixy keeps every connector until its own agent.json switches one off, and its other keys survive', async (t) => {
  const { dataDir, api } = fixture(t);
  assert.deepEqual(api.getAgentConnectors('lead'), ALL_ON);
  const dir = join(dataDir, 'agents', 'lead');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'agent.json'), JSON.stringify({ avatar: { kind: 'mascot' } }));
  assert.deepEqual(await api.setAgentConnectorEnabled('lead', 'notion', false), [
    { id: 'github', enabled: true },
    { id: 'notion', enabled: false },
  ]);
  assert.deepEqual(manifestOf(dataDir, 'lead'), { avatar: { kind: 'mascot' }, connectors: { off: ['notion'] } });
  assert.equal(existsSync(join(dir, 'AGENT.md')), false);
  assert.deepEqual(await api.setAgentConnectorEnabled('lead', 'notion', true), ALL_ON);
  assert.deepEqual(manifestOf(dataDir, 'lead'), { avatar: { kind: 'mascot' } }, 'nothing off: no field');
});

test("with the bot store active, the policy Mixy's profile saves is the one her runtime reads", async (t) => {
  const { dataDir, api } = fixture(t);
  mkdirSync(join(dataDir, 'bots', 'mixy'), { recursive: true });
  writeFileSync(join(dataDir, 'bots', 'migration.json'), JSON.stringify({ version: 1, bots: [] }));
  assert.deepEqual(await api.setAgentConnectorEnabled('lead', 'notion', false), [
    { id: 'github', enabled: true },
    { id: 'notion', enabled: false },
  ]);
  assert.deepEqual(JSON.parse(readFileSync(join(dataDir, 'bots', 'mixy', 'agent.json'), 'utf8')).connectors, {
    off: ['notion'],
  });
  assert.equal(existsSync(join(dataDir, 'agents', 'lead', 'agent.json')), false, 'nothing lands in agents/lead');
  assert.deepEqual(agentConnectors('lead', dataDir)?.off, ['notion'], 'the runtime reads what the profile wrote');
  assert.equal(agentMcpToolPermission('lead', 'mcp__notion__search', dataDir), 'disabled');
  await api.setAgentConnectorToolPermission('lead', 'github', 'create_issue', 'needs_approval');
  assert.equal(agentMcpToolPermission('lead', 'mcp__github__create_issue', dataDir), 'needs_approval');
});

test('a policy save into a read-only agent.json fails at once, off the event loop, and changes nothing', async (t) => {
  const { dataDir, api } = fixture(t);
  const { id } = await api.saveAgentDefinition({ name: 'Mailer', body: 'Mail.', kind: 'bot' });
  const dir = join(dataDir, 'agents', id);
  const file = join(dir, 'agent.json');
  const before = readFileSync(file, 'utf8');
  chmodSync(file, 0o444);
  // The atomic write's rename onto a read-only file used to be retried for ~5 s,
  // blocking the loop: count rename attempts (each retry is one) instead of timing.
  let renames = 0;
  const renameSync = fs.renameSync;
  const renameAsync = fsPromises.rename;
  fs.renameSync = (...args) => {
    renames += 1;
    return renameSync(...args);
  };
  fsPromises.rename = (...args) => {
    renames += 1;
    return renameAsync(...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(api.setAgentConnectorToolPermission(id, 'github', 'create_issue', 'auto'), /not writable/);
    await assert.rejects(api.setAgentConnectorEnabled(id, 'notion', false), /not writable/);
  } finally {
    fs.renameSync = renameSync;
    fsPromises.rename = renameAsync;
    syncBuiltinESMExports();
    chmodSync(file, 0o666);
  }
  assert.equal(renames, 0, 'an unwritable target is refused before any rename, so nothing is retried');
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.deepEqual(
    readdirSync(dir).filter((name) => name.includes('mixdog-tmp')),
    [],
    'no temp file is left behind'
  );
  // Writable again: the same save lands.
  await api.setAgentConnectorToolPermission(id, 'github', 'create_issue', 'auto');
  assert.equal(manifestOf(dataDir, id).connectors.tools.github.create_issue, 'auto');
});

test('switches show what the runtime enforces: a broken policy is all off, and an edit never widens it', async (t) => {
  const { dataDir, api } = fixture(t);
  const { id } = await api.saveAgentDefinition({ name: 'Broken', body: 'x' });
  const file = join(dataDir, 'agents', id, 'agent.json');
  writeFileSync(file, JSON.stringify({ ...manifestOf(dataDir, id), connectors: { id: 'github', enabled: true } }));
  assert.deepEqual(api.getAgentConnectors(id), [
    { id: 'github', enabled: false },
    { id: 'notion', enabled: false },
  ]);
  // Switching one on keeps every other connector off.
  assert.deepEqual(await api.setAgentConnectorEnabled(id, 'github', true), [
    { id: 'github', enabled: true },
    { id: 'notion', enabled: false },
  ]);
  assert.deepEqual(manifestOf(dataDir, id).connectors, { off: ['notion'] });
});

test('listConnectors reports the global servers with their sign-in state; tools carry annotations', (t) => {
  const { api } = fixture(t);
  const rows = api.listConnectors();
  assert.deepEqual(
    rows.map((row) => [row.id, row.status, row.authRequired, row.signedIn, row.toolCount]),
    [
      ['github', 'connected', false, true, 2],
      ['notion', 'sign-in required', true, false, 0],
    ]
  );
  assert.deepEqual(api.listConnectorTools('github'), [
    { name: 'list_issues', description: 'List.', annotations: { readOnlyHint: true }, readOnly: true },
    { name: 'create_issue', description: 'Create.', annotations: {}, readOnly: null },
  ]);
  assert.deepEqual(api.listConnectorTools('absent'), []);
});

test('an existing per-tool override keeps working and never narrows the other connectors', async (t) => {
  const { dataDir, api } = fixture(t);
  const { id } = await api.saveAgentDefinition({ name: 'Scribe', body: 'Write.' });
  assert.deepEqual(await api.setAgentConnectorToolPermission(id, 'github', 'create_issue', 'disabled'), {
    off: [],
    tools: { github: { create_issue: 'disabled' } },
  });
  assert.deepEqual(api.getAgentConnectors(id), ALL_ON);
  assert.equal(agentMcpToolPermission(id, 'mcp__github__list_issues', dataDir), 'auto', 'other tools stay auto');
  assert.equal(await api.setAgentConnectorToolPermission(id, 'github', 'create_issue', null), null, 'back to auto');
  await assert.rejects(api.setAgentConnectorToolPermission(id, 'github', 't', 'sometimes'), /permission must be/);
  assert.equal('connectors' in manifestOf(dataDir, id), false);
});

test('getAgentConnectorTools gives each tool its own effective permission and whether the bot set it', async (t) => {
  // A catalog connector's high-risk tool asks by default.
  rememberServerConnector('github', { connector: 'gmail' });
  t.after(() => rememberServerConnector('github', {}));
  const { api } = fixture(t, { tools: [...TOOLS, { name: 'mcp__github__send_email' }] });
  const { id } = await api.saveAgentDefinition({ name: 'Scribe', body: 'Write.' });
  const of = (connector) =>
    Object.fromEntries(
      api.getAgentConnectorTools(id).flatMap((row) => (row.connector === connector ? [[row.tool, [row.permission, row.explicit]]] : []))
    );
  assert.deepEqual(of('github'), {
    list_issues: ['auto', false],
    create_issue: ['auto', false],
    send_email: ['needs_approval', false],
  });
  await api.setAgentConnectorToolPermission(id, 'github', 'create_issue', 'disabled');
  await api.setAgentConnectorToolPermission(id, 'github', 'send_email', 'auto');
  await api.setAgentConnectorToolPermission(id, 'notion', 'gone', 'needs_approval');
  await api.setAgentConnectorEnabled(id, 'github', false);
  assert.deepEqual(of('github'), {
    list_issues: ['auto', false],
    create_issue: ['disabled', true],
    send_email: ['auto', true],
  });
  assert.deepEqual(of('notion'), { search: ['auto', false], gone: ['needs_approval', true] }, 'an override stays listed');
});

test('legacy allow lists and MCP project scopes migrate to the equivalent switched-off lists, once', async (t) => {
  const projectA = join(tmpdir(), 'proj-a');
  const projectB = join(tmpdir(), 'proj-b');
  const { dataDir, api, state } = fixture(t, { projects: [{ path: projectA }, { path: projectB }] });
  const { id } = await api.saveAgentDefinition({ name: 'Old', body: 'x' });
  const file = join(dataDir, 'agents', id, 'agent.json');
  writeFileSync(
    file,
    JSON.stringify({
      ...manifestOf(dataDir, id),
      connectors: [{ id: 'github', enabled: true, tools: { create_issue: 'needs_approval' } }],
    })
  );
  const plain = await api.saveAgentDefinition({ name: 'Plain', body: 'x' });
  state.config = { ...state.config, extensionScopes: { mcp: { notion: [projectA] } } };
  const result = api.migrateConnectorPolicies();
  assert.deepEqual(result, { skipped: false, agents: [id], scopes: ['notion'] });
  assert.deepEqual(manifestOf(dataDir, id).connectors, {
    off: ['notion'],
    tools: { github: { create_issue: 'needs_approval' } },
  });
  assert.equal('connectors' in manifestOf(dataDir, plain.id), false, 'no policy stays all on');
  assert.deepEqual(api.getProjectConnectors(projectA), ALL_ON);
  assert.deepEqual(api.getProjectConnectors(projectB), [
    { id: 'github', enabled: true },
    { id: 'notion', enabled: false },
  ]);
  assert.deepEqual(state.config.extensionScopes.mcp, {}, 'the "only in" scope is gone');
  assert.deepEqual(api.migrateConnectorPolicies(), { skipped: false, agents: [], scopes: [] }, 'idempotent');
});

test('migration waits while the plugin registry is unavailable', async (t) => {
  const { dataDir, api } = fixture(t, {
    catalog: { servers: {}, warnings: [{ message: 'plugin MCP servers unavailable: boom' }] },
  });
  const { id } = await api.saveAgentDefinition({ name: 'Old', body: 'x' });
  const file = join(dataDir, 'agents', id, 'agent.json');
  const legacy = [{ id: 'github', enabled: true }];
  writeFileSync(file, JSON.stringify({ ...manifestOf(dataDir, id), connectors: legacy }));
  assert.equal(api.migrateConnectorPolicies().skipped, true);
  assert.deepEqual(manifestOf(dataDir, id).connectors, legacy);
});

test('a project switches connectors off by its registered path; others stay on', (t) => {
  const project = join(tmpdir(), 'proj-c');
  const { dataDir, api } = fixture(t, { projects: [{ path: project }] });
  assert.deepEqual(api.getProjectConnectors(project), ALL_ON);
  assert.deepEqual(api.setProjectConnectorEnabled(`${project}${sep}`, 'github', false), [
    { id: 'github', enabled: false },
    { id: 'notion', enabled: true },
  ]);
  const saved = JSON.parse(readFileSync(join(dataDir, 'project-connectors.json'), 'utf8'));
  assert.deepEqual(saved, { projects: { [project]: { off: ['github'] } } });
  assert.deepEqual(api.setProjectConnectorEnabled(project, 'github', true), ALL_ON);
  assert.throws(() => api.getProjectConnectors(join(tmpdir(), 'unknown')), /not registered/);
  writeFileSync(join(dataDir, 'project-connectors.json'), '{ broken');
  assert.deepEqual(api.getProjectConnectors(project), [
    { id: 'github', enabled: false },
    { id: 'notion', enabled: false },
  ]);
  assert.throws(() => api.setProjectConnectorEnabled(project, 'github', true), /cannot be read/);
});
