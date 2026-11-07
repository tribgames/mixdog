#!/usr/bin/env node
// Golden twin of the six agent and project-connector setup actions (`read_agent_settings`,
// `read_project_connectors`, `set_agent_permission`, `set_agent_connector`,
// `set_agent_connector_tool`, `set_project_connector`): what Node's real handlers
// (`setup-tool/agent-settings-actions.mjs`, with the widening card of `connector-widen-approval.mjs`)
// answer over the real connector API and human-gate store, one script of calls over a fresh data
// folder. A call that raises a widening card is given the person's answer by the script; each
// call records the card it raised and the files it left (definitions, grants, audit, project
// switches). The clock is frozen, so the twin holds exact bytes.
//
//   node benchmarks/rust-core/recorders/record-agent-settings-setup.mjs --tree <dir>
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree } from './lib/common.mjs';

const FIXED_NOW = 1_700_000_000_000;
Date.now = () => FIXED_NOW;

const sandbox = mkdtempSync(join(tmpdir(), 'agent-settings-setup-'));
for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'MIXDOG_HOME', 'MIXDOG_DATA_DIR', 'MIXDOG_CONFIG_DIR', 'MIXDOG_RUNTIME_ROOT', 'MIXDOG_USER_DATA_BACKUP_ROOT', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) {
  const directory = join(sandbox, key);
  mkdirSync(directory);
  process.env[key] = directory;
}
// The product reads the data folder from the environment too (gentConnectors at the widening card), so the
// world's data folder is the environment's.
const root = mkdtempSync(join(tmpdir(), 'agent-settings-setup-world-'));
const dirs = { shipped: join(root, 'shipped'), data: join(root, 'data'), project: join(root, 'project') };
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
process.env.MIXDOG_DATA_DIR = dirs.data;
const tree = resolveTree(parseArgs());
const { createWorkflowAgentsApi } = await importFrom(tree, 'src/session-runtime/workflow-agents-api.mjs');
const workflow = await importFrom(tree, 'src/runtime/agent/orchestrator/runtime-core/workflow.mjs');
const { normalizeAgentPermissionOrNone, readMarkdownDocument } = await importFrom(tree, 'src/runtime/shared/markdown-frontmatter.mjs');
const store = await importFrom(tree, 'src/runtime/agent/orchestrator/session/human-gate/store.mjs');
const { rememberServerConnector } = await importFrom(tree, 'src/runtime/agent/orchestrator/mcp/server-connectors.mjs');
const { AGENT_SETTINGS_HANDLERS } = await importFrom(tree, 'src/session-runtime/setup-tool/agent-settings-actions.mjs');

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
  listProjects: () => [{ path: dirs.project }],
});

// What the person does on a widening card. `meanwhile` changes the stored policy while the card waits.
const person = {
  deny: () => ({ approved: false, response: 'deny', device: 'desktop' }),
  needs_approval: () => ({ approved: true, response: 'approve', scope: 'needs_approval', device: 'phone' }),
  auto: () => ({ approved: true, response: 'approve', scope: 'auto', device: 'phone' }),
  once: () => ({ approved: true, response: 'approve', scope: 'once', device: 'phone' }),
  timeout: () => ({ approved: false, timedOut: true, response: 'deny', device: '' }),
  silent: () => undefined,
};
// A restriction (or a grant) lands while the card waits; then the person picks 	hen.
const meanwhile = (permission, then) => async (request) => {
  await api.setAgentConnectorToolPermission(request.agentId, request.args.name, request.args.tool, permission);
  return person[then]();
};
person['narrowed-then-auto'] = meanwhile('disabled', 'auto');
person['widened-then-needs_approval'] = meanwhile('auto', 'needs_approval');

const ALPHA = 'alpha';
const P = '<project>';
const seed = (payload) => ({ seed: 'save', payload });
const tool = (permission, agent = ALPHA, connector = 'gmail', toolName = 'send_email') => ({ seed: 'tool', agent, connector, tool: toolName, permission });
const enable = (enabled, agent = ALPHA, name = 'gmail') => ({ seed: 'enable', agent, name, enabled });
const run = (action, args, ask = null) => ({ action, args, ask });
const script = [
  seed({ name: 'Alpha', body: 'Be brief.' }),
  run('read_agent_settings', { agent: ALPHA }),
  run('read_agent_settings', { agent: ' ' }),
  run('read_agent_settings', {}),
  run('read_agent_settings', { agent: 'ghost' }),
  run('read_project_connectors', { projectPath: P }),
  run('read_project_connectors', { projectPath: `${P}/unknown` }),
  run('read_project_connectors', { projectPath: '' }),
  run('read_project_connectors', {}),
  // Permissions: taking authority away applies; giving it is the person's, in the desktop app.
  run('set_agent_permission', { agent: ALPHA, actionKind: 'comment', permissionMode: 'block' }),
  run('set_agent_permission', { agent: ALPHA, actionKind: 'comment', permissionMode: 'allow' }),
  run('set_agent_permission', { agent: ALPHA, actionKind: 'comment', permissionMode: 'ask' }),
  run('set_agent_permission', { agent: ALPHA, actionKind: 'email', permissionMode: 'allow' }),
  run('set_agent_permission', { agent: ALPHA, actionKind: 'nope', permissionMode: 'block' }),
  run('set_agent_permission', { agent: ALPHA, actionKind: 'email', permissionMode: 'maybe' }),
  run('set_agent_permission', { agent: '', actionKind: 'email', permissionMode: 'block' }),
  run('read_agent_settings', { agent: ALPHA }),
  // Connector switches.
  run('set_agent_connector', { agent: ALPHA, name: 'gmail', enabled: false }),
  run('set_agent_connector', { agent: ALPHA, name: 'gmail', enabled: true }),
  run('set_agent_connector', { agent: ALPHA, name: ' ', enabled: false }),
  run('set_agent_connector', { agent: ALPHA, name: 'gmail', enabled: 'yes' }),
  run('set_agent_connector', { agent: ALPHA, name: 'github', enabled: false }),
  run('set_agent_connector', { agent: 'ghost', name: 'github', enabled: false }),
  run('read_agent_settings', { agent: ALPHA }),
  // One tool's permission: a narrowing applies, a widening waits on the person's card.
  enable(true),
  enable(true, ALPHA, 'github'),
  tool('auto'),
  run('read_agent_settings', { agent: ALPHA }),
  run('set_agent_connector_tool', { agent: ALPHA, name: 'gmail', tool: 'send_email', permission: 'needs_approval' }),
  run('set_agent_connector_tool', { agent: ALPHA, name: 'gmail', tool: 'send_email', permission: 'disabled' }),
  run('set_agent_connector_tool', { agent: ALPHA, name: 'gmail', tool: 'send_email', permission: 'needs_approval' }, 'deny'),
  run('set_agent_connector_tool', { agent: ALPHA, name: 'gmail', tool: 'send_email', permission: 'needs_approval' }, 'timeout'),
  run('set_agent_connector_tool', { agent: ALPHA, name: 'gmail', tool: 'send_email', permission: 'needs_approval' }, 'silent'),
  run('set_agent_connector_tool', { agent: ALPHA, name: 'gmail', tool: 'send_email', permission: 'needs_approval' }, 'once'),
  run('set_agent_connector_tool', { agent: ALPHA, name: 'gmail', tool: 'send_email', permission: 'needs_approval' }),
  run('set_agent_connector_tool', { agent: ALPHA, name: 'gmail', tool: 'send_email', permission: 'auto' }, 'needs_approval'),
  run('set_agent_connector_tool', { agent: ALPHA, name: 'gmail', tool: 'send_email', permission: 'auto' }, 'auto'),
  run('set_agent_connector_tool', { agent: ALPHA, name: 'gmail', tool: 'send_email', permission: 'auto' }, 'deny'),
  tool('disabled'),
  run('set_agent_connector_tool', { agent: ALPHA, name: 'gmail', tool: 'send_email', permission: 'needs_approval' }, 'auto'),
  tool('needs_approval'),
  run('set_agent_connector_tool', { agent: ALPHA, name: 'gmail', tool: 'send_email', permission: 'auto' }, 'narrowed-then-auto'),
  tool('disabled'),
  run('set_agent_connector_tool', { agent: ALPHA, name: 'gmail', tool: 'send_email', permission: 'needs_approval' }, 'widened-then-needs_approval'),
  run('set_agent_connector_tool', { agent: ALPHA, name: 'gmail-2', tool: 'read_email', permission: 'auto' }, 'auto'),
  run('set_agent_connector_tool', { agent: ALPHA, name: 'gmail', tool: 'send_email', permission: 'bogus' }),
  run('set_agent_connector_tool', { agent: ALPHA, name: 'gmail', tool: ' ', permission: 'auto' }),
  run('set_agent_connector_tool', { agent: ALPHA, name: ' ', tool: 'send_email', permission: 'auto' }),
  run('set_agent_connector_tool', { agent: ALPHA, name: 'gmail', tool: 'send_email' }),
  run('set_agent_connector_tool', { agent: ALPHA, name: 'github', tool: 'create_issue', permission: 'auto' }, 'auto'),
  run('set_agent_connector_tool', { agent: 'ghost', name: 'gmail', tool: 'send_email', permission: 'auto' }, 'auto'),
  run('read_agent_settings', { agent: ALPHA }),
  // A connector that is switched off reads disabled whatever its tools are set to.
  enable(false),
  tool('auto'),
  run('set_agent_connector_tool', { agent: ALPHA, name: 'gmail', tool: 'send_email', permission: 'needs_approval' }, 'needs_approval'),
  run('read_agent_settings', { agent: ALPHA }),
  // The project's switches.
  run('set_project_connector', { projectPath: P, name: 'gmail', enabled: false }),
  run('set_project_connector', { projectPath: P, name: 'gmail', enabled: true }),
  run('set_project_connector', { projectPath: P, name: 'github', enabled: false }),
  run('set_project_connector', { projectPath: P, name: 'github', enabled: false }),
  run('set_project_connector', { projectPath: `${P}/unknown`, name: 'gmail', enabled: false }),
  run('set_project_connector', { projectPath: '', name: 'gmail', enabled: false }),
  run('set_project_connector', { projectPath: P, name: ' ', enabled: false }),
  run('set_project_connector', { projectPath: P, name: 'gmail', enabled: 'x' }),
  run('set_project_connector', { projectPath: P, name: 'gmail' }),
  run('read_project_connectors', { projectPath: P }),
];

// The files a call leaves: definitions, grants and audit, and the project switches.
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
      if (!/^agents\/[^/]+\/(AGENT\.md|agent\.json)(\.bak|\.mixdog-tmp-[0-9a-f]{16})?$/.test(rel) && !rel.startsWith('human-gate/') && rel !== 'project-connectors.json') continue;
      files[rel] = readFileSync(file, 'utf8');
    }
  };
  walk(dir);
  return files;
}

// Paths also appear JSON-escaped inside the recorded file texts.
const escaped = (path) => JSON.stringify(path).slice(1, -1);
const mask = (value) =>
  JSON.parse(
    JSON.stringify(value ?? null, (_k, v) =>
      typeof v === 'string' ? v.split(dirs.data).join('<data>').split(dirs.project).join(P).split(escaped(dirs.data)).join('<data>').split(escaped(dirs.project)).join(P) : v
    )
  );
const fill = (value) => JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'string' ? v.split(P).join(dirs.project) : v)));

const steps = [];
for (const step of script) {
  if (step.seed === 'save') {
    await api.saveAgentDefinition(step.payload, {});
    steps.push({ seed: 'save', payload: step.payload });
    continue;
  }
  if (step.seed === 'enable') {
    await api.setAgentConnectorEnabled(step.agent, step.name, step.enabled);
    steps.push({ seed: 'enable', agent: step.agent, name: step.name, enabled: step.enabled });
    continue;
  }
  if (step.seed === 'tool') {
    await api.setAgentConnectorToolPermission(step.agent, step.connector, step.tool, step.permission);
    steps.push({ seed: 'tool', agent: step.agent, connector: step.connector, tool: step.tool, permission: step.permission });
    continue;
  }
  const asked = [];
  const answer = step.ask ? person[step.ask] : null;
  const context = answer
    ? {
        requestApproval: async (request) => {
          asked.push(mask(request));
          return answer(request);
        },
      }
    : {};
  let outcome;
  try {
    outcome = { ok: mask(await AGENT_SETTINGS_HANDLERS[step.action](api, fill(step.args), context)) };
  } catch (error) {
    outcome = { error: mask(String(error?.message ?? error)) };
  }
  steps.push({
    action: step.action,
    args: step.args,
    ask: step.ask,
    ...outcome,
    asked,
    files: mask(snapshot(dirs.data)),
  });
}

writeFileSync(
  `${FIXTURES_ROOT}/desktop/settings/agent-settings-setup-twin.json`,
  `${JSON.stringify({ domain: 'agent-settings-setup-twin', now: FIXED_NOW, recorder: 'benchmarks/rust-core/recorders/record-agent-settings-setup.mjs', servers: SERVERS, tools: TOOLS, steps }, null, 1)}\n`
);
console.log(`recorded ${steps.length} steps`);
rmSync(root, { recursive: true, force: true });
rmSync(sandbox, { recursive: true, force: true });
process.exit(0);
