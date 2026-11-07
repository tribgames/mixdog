// Records Node's `stageConnectorAvailability` (`runtime-core/tool-availability.mjs`): the connector
// tools a session's agent policy and its project's switches let it run, compared with the set the
// session last held. Each scenario is a sequence of steps over one session; before a step the
// policy files (`agents/<id>/agent.json`, `<data>/project-connectors.json`) are written, and the
// recorded answers of Node's `agentMcpToolPermission` / `projectMcpToolDisabled` for the session's
// known MCP tools are the inputs the Rust port gets through its `ConnectorPermissions`.
//
//   node benchmarks/rust-core/recorders/record-connector-availability.mjs --tree <dir with node_modules>
//
// Output: native/core/fixtures/connector-availability/golden.json.
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Import-time sweeps delete real user data: every user dir is a fresh temp dir first.
const sandbox = mkdtempSync(join(tmpdir(), 'connector-availability-'));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) process.env[key] = sandbox;
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
process.env.TZ = 'UTC';
const NOW = 1_700_000_000_000;
Date.now = () => NOW;
const { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');

const { nodeRealTool, writeJsonCompact } = await import('./lib/tool-definitions.mjs');
const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'connector-availability');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-connector-availability.mjs';
const o = 'src/runtime/agent/orchestrator/';
const { stageConnectorAvailability } = await importFrom(tree, `${o}runtime-core/tool-availability.mjs`);
const { agentMcpToolPermission, projectMcpToolDisabled, connectorPolicyAgentOf } = await importFrom(tree, `${o}mcp/agent-connectors.mjs`);

const data = sandbox;
const project = join(sandbox, 'work', 'app');
mkdirSync(project, { recursive: true });
let tick = 0;
// The files are stat-cached by mtime and size: every write moves the mtime forward.
const put = (path, value) => {
  if (value === undefined) return;
  mkdirSync(join(path, '..'), { recursive: true });
  if (value === null) rmSync(path, { force: true });
  else {
    writeFileSync(path, JSON.stringify(value));
    tick += 5;
    utimesSync(path, new Date(1_600_000_000_000 + tick * 1000), new Date(1_600_000_000_000 + tick * 1000));
  }
};
const writePolicies = (agent, step) => {
  put(join(data, 'agents', agent, 'agent.json'), step.agentPolicy === undefined ? undefined : step.agentPolicy === null ? null : { connectors: step.agentPolicy });
  put(join(data, 'project-connectors.json'), step.project === undefined ? undefined : step.project === null ? null : { projects: Object.fromEntries(Object.entries(step.project).map(([root, off]) => [root === '$PROJECT' ? project : root, { off }])) });
};

// `read` is the product's definition; a connector's tools (`mcp__`) are the recorder's inputs.
const real = await nodeRealTool(tree);
const doc = (name, description = `${name} tool`) =>
  name.startsWith('mcp__') ? { name, description, inputSchema: { type: 'object', properties: {} }, annotations: {} } : real(name);
const base = (extra = {}) => ({
  id: 'sess_a',
  agent: 'worker',
  cwd: project,
  tools: [doc('read'), doc('mcp__alpha__list'), doc('mcp__alpha__send'), doc('mcp__beta__ping')],
  deferredToolCatalog: [doc('read'), doc('mcp__alpha__list'), doc('mcp__alpha__send'), doc('mcp__beta__ping'), doc('mcp__gamma__get')],
  ...extra,
});

const SCENARIOS = [
  ['the first call records the baseline, an unchanged set is silent', base(), [{}, {}]],
  ['an agent policy switches a connector off and on again', base(), [{}, { agentPolicy: { off: ['alpha'] } }, { agentPolicy: { off: ['alpha'] } }, { agentPolicy: null }]],
  ['a per-tool override disables one tool', base(), [{}, { agentPolicy: { off: [], tools: { alpha: { send: 'disabled' } } } }, { agentPolicy: { off: [], tools: { alpha: { send: 'needs_approval' } } } }]],
  ['a project switches a connector off', base(), [{}, { project: { $PROJECT: ['beta'] } }, { project: { '/elsewhere': ['beta'] } }]],
  ['both policies move in one call', base(), [{}, { agentPolicy: { off: ['alpha'] }, project: { $PROJECT: ['gamma'] } }, { agentPolicy: null, project: null }]],
  ['a tool the session gains appears in the next call, with its description', base(), [{}, { gain: [doc('mcp__delta__new', 'a late connector tool')] }]],
  ['a session without a tool list', { id: 'sess_none', agent: 'worker', cwd: project }, [{}, { agentPolicy: { off: ['alpha'] } }]],
  ['a session with no connector tool', base({ tools: [doc('read')], deferredToolCatalog: [doc('read')] }), [{}, { agentPolicy: { off: ['alpha'] } }]],
  ['a coding Lead has no policy of its own', base({ agent: 'lead' }), [{}, { agentPolicy: { off: ['alpha'] } }]],
  ['a previous set that is not a list is a new baseline', base({ agentConnectorTools: 'oops' }), [{}, { agentPolicy: { off: ['alpha'] } }]],
];

const cases = SCENARIOS.map(([name, start, steps]) => {
  const session = structuredClone(start);
  writePolicies(start.agent, { agentPolicy: null, project: null });
  const agentId = connectorPolicyAgentOf(session) || session.agent;
  const out = steps.map((step) => {
    writePolicies(start.agent, step);
    for (const tool of step.gain || []) session.deferredToolCatalog = [...(session.deferredToolCatalog || []), tool];
    const known = [...new Set(['tools', 'deferredToolCatalog', 'deferredLateToolCatalog'].flatMap((key) => (session[key] || []).map((t) => t.name)))];
    const before = structuredClone(session);
    const result = stageConnectorAvailability(session);
    return {
      gain: step.gain || [],
      policyAgent: connectorPolicyAgentOf(before),
      agentDisabled: known.filter((n) => agentMcpToolPermission(connectorPolicyAgentOf(before), n) === 'disabled'),
      projectDisabled: known.filter((n) => projectMcpToolDisabled(before, n, data)),
      before,
      result,
      after: structuredClone(session),
    };
  });
  void agentId;
  return { name, start, steps: out };
});
await writeJsonCompact(tree, join(stage, 'golden.json'), { now: NOW, cases });
writeSetManifest(stage, { set: 'connector-availability', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
