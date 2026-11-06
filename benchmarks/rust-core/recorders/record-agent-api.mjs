#!/usr/bin/env node
// Golden twin of the `agent/` definition and permission methods the profile calls (capability
// names as in the host): what Node's real editor (workflow-agents-api/agent-editor.mjs), connector
// switches (agent-connectors.mjs) and human-gate store (store.mjs) answer, one deterministic
// script of calls over a fresh data folder. After each call that edits a live agent's files or
// the grants/audit, those files are recorded too (timestamps masked).
//
//   node benchmarks/rust-core/recorders/record-agent-api.mjs --tree <dir>
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree } from './lib/common.mjs';

// The grant and audit stamps are `Date.now()`: a fixed clock, so the twin holds the exact bytes.
const FIXED_NOW = 1_700_000_000_000;
Date.now = () => FIXED_NOW;

const sandbox = mkdtempSync(join(tmpdir(), 'agent-api-'));
process.env.MIXDOG_DATA_DIR = sandbox;
process.env.MIXDOG_HOME = sandbox;
const tree = resolveTree(parseArgs());
const { createWorkflowAgentsApi } = await importFrom(tree, 'src/session-runtime/workflow-agents-api.mjs');
const workflow = await importFrom(tree, 'src/runtime/agent/orchestrator/runtime-core/workflow.mjs');
const { normalizeAgentPermissionOrNone, readMarkdownDocument } = await importFrom(tree, 'src/runtime/shared/markdown-frontmatter.mjs');
const store = await importFrom(tree, 'src/runtime/agent/orchestrator/session/human-gate/store.mjs');
const { rememberServerConnector } = await importFrom(tree, 'src/runtime/agent/orchestrator/mcp/server-connectors.mjs');

const root = mkdtempSync(join(tmpdir(), 'agent-api-world-'));
const dirs = { shipped: join(root, 'shipped'), data: join(root, 'data') };
mkdirSync(dirs.shipped, { recursive: true });
mkdirSync(dirs.data, { recursive: true });
workflow.clearAgentDefinitionCache();
store.setHumanGateStore(store.createHumanGateStore(join(dirs.data, 'human-gate')));
rememberServerConnector('gmail', { connector: 'gmail' });
rememberServerConnector('gmail-2', { connector: 'gmail' });

const SERVERS = ['gmail', 'gmail-2', 'github'];
const TOOLS = [
  ['gmail', 'send_email'],
  ['gmail', 'read_email'],
  ['github', 'create_issue'],
];
const state = { config: { workflow: { active: 'default' } } };
const helpers = workflow.createWorkflowHelpers({ rootDir: dirs.shipped, dataDir: dirs.data, readMarkdownDocument, normalizeAgentPermissionOrNone });
const { agentRouteFromConfig } = workflow.createWorkflowRouteHelpers({ findPreset: () => null });
const api = createWorkflowAgentsApi({
  ...helpers,
  rootDir: dirs.shipped,
  getConfig: () => state.config,
  displayConfig: () => state.config,
  cfgMod: { getPluginData: () => dirs.data },
  STANDALONE_DATA_DIR: dirs.data,
  resolveRoute: (_config, requested) => ({ ...requested }),
  agentRouteFromConfig,
  saveConfigAndAdopt: (value) => {
    state.config = value;
  },
  setAgentRoute: async () => {},
  lookupModelMeta: async () => ({}),
  ensureProvidersReady: async () => {},
  refreshEmptySessionToolPolicy: async () => ({ appliedToCurrentSession: true }),
  invalidateContextStatusCache() {},
  mcpStatus: () => ({ servers: SERVERS.map((name) => ({ name })) }),
  getMcpTools: () => TOOLS.map(([server, tool]) => ({ name: `mcp__${server}__${tool}` })),
});

const chunk = (type, data) => Buffer.concat([Buffer.from([0, 0, 0, data.length]), Buffer.from(type), data, Buffer.alloc(4)]);
function png(width, height) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IEND', Buffer.alloc(0))]);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

// Not API calls: the state a test needs that the API cannot make. A legacy allow list is only ever
// on disk (a save refuses one), and a read-only manifest is how a write is made to fail.
const manifestOf = (agentId) => join(dirs.data, 'agents', agentId, 'agent.json');
const SEEDS = {
  seedManifest: ({ agentId, manifest }) => {
    writeFileSync(manifestOf(agentId), `${JSON.stringify(manifest, null, 2)}\n`);
    return null;
  },
  setManifestReadOnly: ({ agentId, readOnly }) => {
    chmodSync(manifestOf(agentId), readOnly ? 0o444 : 0o666);
    return null;
  },
};

const CALLS = {
  ...SEEDS,
  agentDefinitionPresence: ({ agentIds }) => api.agentDefinitionPresence(agentIds),
  archivedAgentIdentities: ({ agentIds }) => api.archivedAgentIdentities(agentIds),
  getAgentDefinition: ({ agentId }) => api.getAgentDefinition(agentId),
  getAgentAvatarImage: ({ agentId }) => api.getAgentAvatarImage(agentId),
  saveAgentDefinition: ({ payload, options }) => api.saveAgentDefinition(payload, options),
  deleteAgentDefinition: ({ agentId }) => api.deleteAgentDefinition(agentId),
  restoreAgentDefinition: ({ agentId }) => api.restoreAgentDefinition(agentId),
  purgeAgentDefinition: ({ agentId }) => api.purgeAgentDefinition(agentId),
  getAgentConnectors: ({ agentId }) => api.getAgentConnectors(agentId),
  getAgentAlwaysAllowedTools: ({ agentId }) => api.getAgentAlwaysAllowedTools(agentId),
  getAgentConnectorTools: ({ agentId }) => api.getAgentConnectorTools(agentId),
  getAgentPermissions: ({ agentId }) => store.agentPermissions(agentId),
  setAgentConnectors: ({ agentId, connectors, options }) => api.setAgentConnectors(agentId, connectors, options),
  setAgentConnectorEnabled: ({ agentId, connectorId, enabled, options }) => api.setAgentConnectorEnabled(agentId, connectorId, enabled, options),
  setAgentConnectorToolPermission: ({ agentId, connectorId, toolName, permission, options }) =>
    api.setAgentConnectorToolPermission(agentId, connectorId, toolName, permission, options),
  setAgentPermission: ({ agentId, action, mode, options }) => store.setAgentPermission(agentId, action, mode, options),
  recordAgentApprovalAudit: ({ agentId, action, decision }) => store.recordAgentApprovalAudit(agentId, action, decision),
};

const call = (method, params = {}, files = false) => ({ method, params, files });
const script = [
  call('agentDefinitionPresence', { agentIds: ['ghost', 'alpha'] }),
  call('saveAgentDefinition', { payload: { name: 'Alpha', body: 'Be brief.' } }, true),
  call('saveAgentDefinition', { payload: { name: 'Beta', body: 'Second.', description: 'the other' } }, true),
  call('agentDefinitionPresence', { agentIds: ['alpha', 'beta', 'ghost'] }),
  call('getAgentDefinition', { agentId: 'alpha' }),
  call('getAgentDefinition', { agentId: 'ghost' }),
  call('getAgentAvatarImage', { agentId: 'alpha' }),
  call('saveAgentDefinition', { payload: { id: 'alpha', name: 'Alpha', body: 'Be brief.', avatar: { kind: 'custom', states: { idle: { data: png(16, 16) } } } } }, true),
  call('getAgentAvatarImage', { agentId: 'alpha' }),
  call('getAgentAvatarImage', { agentId: 'ghost' }),
  call('getAgentConnectors', { agentId: 'alpha' }),
  call('getAgentConnectorTools', { agentId: 'alpha' }),
  call('setAgentConnectorEnabled', { agentId: 'alpha', connectorId: 'gmail', enabled: false }, true),
  call('setAgentConnectorEnabled', { agentId: 'alpha', connectorId: 'gmail', enabled: true, options: { noWiden: true } }, true),
  call('setAgentConnectorEnabled', { agentId: 'alpha', connectorId: ' ', enabled: true }, true),
  call('setAgentConnectorEnabled', { agentId: 'alpha', connectorId: 'github', enabled: false, options: { noWiden: true } }, true),
  call('getAgentConnectors', { agentId: 'alpha' }),
  call('setAgentConnectorToolPermission', { agentId: 'alpha', connectorId: 'gmail', toolName: 'send_email', permission: 'auto' }, true),
  call('setAgentConnectorToolPermission', { agentId: 'alpha', connectorId: 'gmail-2', toolName: 'read_email', permission: 'needs_approval' }, true),
  call('setAgentConnectorToolPermission', { agentId: 'alpha', connectorId: 'gmail-2', toolName: 'send_email', permission: 'disabled' }, true),
  call('setAgentConnectorToolPermission', { agentId: 'alpha', connectorId: 'gmail', toolName: 'read_email', permission: 'bogus' }, true),
  call('setAgentConnectorToolPermission', { agentId: 'alpha', connectorId: 'gmail', toolName: '  ', permission: 'auto' }, true),
  call('setAgentConnectorToolPermission', { agentId: 'alpha', connectorId: 'github', toolName: 'create_issue', permission: 'auto', options: { noWiden: true } }, true),
  call('getAgentAlwaysAllowedTools', { agentId: 'alpha' }),
  call('getAgentConnectorTools', { agentId: 'alpha' }),
  call('setAgentConnectorToolPermission', { agentId: 'alpha', connectorId: 'gmail', toolName: 'send_email', permission: null }, true),
  call('getAgentAlwaysAllowedTools', { agentId: 'alpha' }),
  call('setAgentConnectors', { agentId: 'alpha', connectors: { off: ['github', ' x '], tools: { gmail: { send_email: 'auto' } } } }, true),
  call('setAgentConnectors', { agentId: 'alpha', connectors: { off: [] }, options: { noWiden: true } }, true),
  call('setAgentConnectors', { agentId: 'alpha', connectors: { off: 'z' } }, true),
  call('getAgentConnectors', { agentId: 'alpha' }),
  call('setAgentConnectors', { agentId: 'alpha', connectors: null }, true),
  call('getAgentConnectors', { agentId: 'ghost' }),
  call('getAgentPermissions', { agentId: 'alpha' }),
  call('getAgentPermissions', { agentId: '*' }),
  call('getAgentPermissions', { agentId: '  ' }),
  call('setAgentPermission', { agentId: 'alpha', action: 'comment', mode: 'allow' }, true),
  call('setAgentPermission', { agentId: 'alpha', action: 'email', mode: 'block' }, true),
  call('setAgentPermission', { agentId: 'alpha', action: 'comment', mode: 'ask', options: { noWiden: true } }, true),
  call('setAgentPermission', { agentId: 'alpha', action: 'email', mode: 'allow', options: { noWiden: true } }, true),
  call('setAgentPermission', { agentId: 'alpha', action: 'payment', mode: 'allow' }, true),
  call('setAgentPermission', { agentId: 'alpha', action: 'tool:shell', mode: 'allow' }, true),
  call('setAgentPermission', { agentId: 'alpha', action: 'tool:shell', mode: 'block' }, true),
  call('setAgentPermission', { agentId: 'alpha', action: 'nope', mode: 'ask' }, true),
  call('setAgentPermission', { agentId: 'alpha', action: 'comment', mode: 'maybe' }, true),
  call('setAgentPermission', { agentId: 'alpha', action: 'comment', mode: 'allow', options: { noWiden: 'yes' } }, true),
  call('getAgentPermissions', { agentId: 'alpha' }),
  call('getAgentPermissions', { agentId: 'beta' }),
  call('recordAgentApprovalAudit', { agentId: 'alpha', action: 'form', decision: 'granted' }, true),
  call('recordAgentApprovalAudit', { agentId: 'alpha', action: 'form', decision: 'dev-allow-all' }, true),
  call('recordAgentApprovalAudit', { agentId: 'alpha', action: 'form', decision: 'whatever' }, true),
  call('recordAgentApprovalAudit', { agentId: 'alpha', action: 'nope', decision: 'approve' }, true),
  call('recordAgentApprovalAudit', { agentId: '*', action: 'form', decision: 'approve' }, true),
  // Error paths. Each answers the first check that fails, in Node's order.
  call('setAgentConnectorEnabled', { agentId: 'alpha', connectorId: 'gmail', enabled: 'yes' }, true),
  call('setAgentConnectorEnabled', { agentId: 'alpha', connectorId: 'gmail', enabled: null }, true),
  call('setAgentConnectorEnabled', { agentId: 'alpha', connectorId: 'gmail', enabled: 1 }, true),
  call('setAgentConnectorEnabled', { agentId: 'alpha', connectorId: 'gmail' }, true),
  call('setAgentConnectorEnabled', { agentId: 'alpha', connectorId: ' ', enabled: 'yes' }, true),
  call('setAgentConnectorEnabled', { agentId: 'alpha', connectorId: 5, enabled: 'yes' }, true),
  call('setAgentConnectorEnabled', { agentId: 'alpha', enabled: 'yes' }, true),
  call('setAgentConnectorEnabled', { agentId: 'ghost', connectorId: 'gmail', enabled: 'yes' }, true),
  call('setAgentConnectorEnabled', { agentId: 'ghost', connectorId: 'gmail', enabled: true }, true),
  call('setAgentConnectorEnabled', { agentId: 'ghost', connectorId: '', enabled: true }, true),
  call('setAgentConnectorToolPermission', { agentId: 'ghost', connectorId: '', toolName: '', permission: 'bogus' }, true),
  call('setAgentConnectorToolPermission', { agentId: 'alpha', connectorId: '', toolName: '', permission: 'bogus' }, true),
  call('setAgentConnectorToolPermission', { agentId: 'alpha', connectorId: '', toolName: '', permission: 'auto' }, true),
  call('setAgentConnectorToolPermission', { agentId: 'alpha', connectorId: 'gmail', toolName: '', permission: 'auto' }, true),
  call('setAgentConnectorToolPermission', { agentId: 'alpha', connectorId: 'gmail', toolName: 'send_email', permission: 3 }, true),
  call('setAgentConnectorToolPermission', { agentId: 'ghost', connectorId: 'gmail', toolName: 'send_email', permission: 'auto' }, true),
  call('setAgentConnectors', { agentId: 'ghost', connectors: { off: ['gmail'] } }, true),
  call('setAgentConnectors', { agentId: 'alpha', connectors: { off: ['gmail'] }, options: { noWiden: true } }, true),
  call('setAgentConnectors', { agentId: 'alpha', connectors: 'text', options: { noWiden: true } }, true),
  call('getAgentConnectors', { agentId: '' }),
  call('getAgentConnectors', { agentId: '*' }),
  call('getAgentConnectorTools', { agentId: 'ghost' }),
  call('getAgentAlwaysAllowedTools', { agentId: 'ghost' }),
  // A legacy allow list, edited while a connector is installed that it never named.
  call('saveAgentDefinition', { payload: { name: 'Legacy', body: 'Old.', connectors: ['gmail'] } }, true),
  call('saveAgentDefinition', { payload: { name: 'Legacy', body: 'Old.' } }, true),
  call('seedManifest', { agentId: 'legacy', manifest: { connectors: ['gmail'] } }, true),
  call('getAgentConnectors', { agentId: 'legacy' }),
  call('setAgentConnectorEnabled', { agentId: 'legacy', connectorId: 'gmail', enabled: true }, true),
  call('getAgentConnectors', { agentId: 'legacy' }),
  call('seedManifest', { agentId: 'legacy', manifest: { connectors: ['gmail'] } }, true),
  call('setAgentConnectorToolPermission', { agentId: 'legacy', connectorId: 'gmail', toolName: 'send_email', permission: 'auto' }, true),
  call('getAgentConnectors', { agentId: 'legacy' }),
  // A write that fails: the manifest is read-only.
  call('saveAgentDefinition', { payload: { name: 'Locked', body: 'Fixed.' } }, true),
  call('setManifestReadOnly', { agentId: 'locked', readOnly: true }),
  call('setAgentConnectors', { agentId: 'locked', connectors: { off: ['gmail'] } }, true),
  call('setAgentConnectorEnabled', { agentId: 'locked', connectorId: 'gmail', enabled: false }, true),
  call('deleteAgentDefinition', { agentId: 'locked' }, true),
  call('setManifestReadOnly', { agentId: 'locked', readOnly: false }),
  call('deleteAgentDefinition', { agentId: 'locked' }, true),
  call('purgeAgentDefinition', { agentId: 'locked' }, true),
  // A save that fails, and a delete that fails.
  call('saveAgentDefinition', { payload: { name: 'Empty', body: '   ' } }, true),
  call('saveAgentDefinition', { payload: { name: 'Empty' } }, true),
  call('saveAgentDefinition', { payload: { body: 'No name.' } }, true),
  call('saveAgentDefinition', { payload: { id: 'alpha', name: 'Alpha', body: 'Again.', expectedRevision: 'stale' } }, true),
  call('saveAgentDefinition', { payload: { id: 'ghost', name: 'Alpha', body: 'x', expectedRevision: 'stale' } }, true),
  call('saveAgentDefinition', { payload: { id: 'alpha', body: 'Bad.', connectors: 'text' }, options: { noWiden: true } }, true),
  call('deleteAgentDefinition', { agentId: 'ghost' }, true),
  call('deleteAgentDefinition', { agentId: '' }, true),
  call('deleteAgentDefinition', { agentId: 'maintainer' }, true),
  call('restoreAgentDefinition', { agentId: 'alpha' }, true),
  call('restoreAgentDefinition', { agentId: '' }, true),
  call('purgeAgentDefinition', { agentId: '' }, true),
  call('purgeAgentDefinition', { agentId: 'alpha' }, true),
  call('getAgentDefinition', { agentId: '' }),
  call('getAgentAvatarImage', { agentId: '' }),
  call('deleteAgentDefinition', { agentId: 'beta' }),
  call('agentDefinitionPresence', { agentIds: ['alpha', 'beta', 'ghost'] }),
  call('archivedAgentIdentities', { agentIds: ['beta', 'alpha', 'ghost'] }),
  call('restoreAgentDefinition', { agentId: 'beta' }),
  call('agentDefinitionPresence', { agentIds: ['beta'] }),
  call('restoreAgentDefinition', { agentId: 'ghost' }),
  call('purgeAgentDefinition', { agentId: 'beta' }),
  call('deleteAgentDefinition', { agentId: 'beta' }),
  call('purgeAgentDefinition', { agentId: 'beta' }),
  call('agentDefinitionPresence', { agentIds: ['beta', 'alpha'] }),
  call('archivedAgentIdentities', { agentIds: ['beta'] }),
  call('purgeAgentDefinition', { agentId: 'ghost' }),
];

// The files an edit leaves: definitions and the permission files, in a stable order.
function snapshot(dir) {
  const files = {};
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const file = join(current, name);
      if (statSync(file).isDirectory()) {
        walk(file);
        continue;
      }
      const rel = relative(dir, file).split('\\').join('/');
      if (!/^agents\/[^/]+\/(AGENT\.md|agent\.json)$/.test(rel) && !rel.startsWith('human-gate/')) continue;
      files[rel] = readFileSync(file, 'utf8');
    }
  };
  walk(dir);
  return files;
}

const mask = (value) => JSON.parse(JSON.stringify(value ?? null, (_k, v) => (typeof v === 'string' ? v.split(dirs.data).join('<data>') : v)));

const steps = [];
for (const { method, params, files } of script) {
  let outcome;
  try {
    outcome = { ok: mask(await CALLS[method](params)) };
  } catch (error) {
    outcome = { error: mask(String(error?.message ?? error)) };
  }
  steps.push({ method, params, ...outcome, ...(files ? { files: snapshot(dirs.data) } : {}) });
}

writeFileSync(
  `${FIXTURES_ROOT}/desktop/settings/agent-api-twin.json`,
  `${JSON.stringify({ domain: 'agent-api-twin', now: FIXED_NOW,recorder: 'benchmarks/rust-core/recorders/record-agent-api.mjs', servers: SERVERS, tools: TOOLS, steps }, null, 1)}\n`
);
console.log(`recorded ${steps.length} calls`);
rmSync(root, { recursive: true, force: true });
rmSync(sandbox, { recursive: true, force: true });
process.exit(0);
