#!/usr/bin/env node
// Golden twin of the turn's tool pool plug-ins, from the real Node code:
//
//   caller-facts.json — `scheduleCallerScope` (session-runtime/services/schedule-access.mjs), the
//     unattended-run marks (held-requests.mjs) and `isHeartbeatSession` (routine-trigger.mjs) over
//     session records of every provenance: what `CallerFacts` answers.
//   tool-list.json — the tool list a turn sees (session-runtime/tool-surface.mjs
//     `modelStandaloneTools` / `disallowedTools`, over the product's own standalone tool
//     definitions) for a main session, a delegated sub-agent, workflows that do and do not
//     delegate, and the headless and heartbeat profiles.
//   dispatch.json — `call_tool` projection outcomes (session/loop/tool-call-resolution.mjs).
//
//   node benchmarks/rust-core/recorders/record-tool-pool.mjs --tree <dir with node_modules>
import { mkdirSync, mkdtempSync } from 'node:fs';
import { recorderProvenance } from './lib/provenance.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// Every user directory points into a fresh temp dir before any Mixdog module is imported: import-time
// sweeps and backups would otherwise act on the real ones.
const home = mkdtempSync(join(tmpdir(), 'tool-pool-'));
for (const name of ['MIXDOG_HOME', 'MIXDOG_DATA_DIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[name] = join(home, name.toLowerCase());
  mkdirSync(process.env[name], { recursive: true });
}

const { FIXTURES_ROOT, commitStage, stageSet, importFrom, nodeTreeIdentity, parseArgs, resolveTree, writeJson, writeSetManifest } = await import('./lib/common.mjs');

const args = parseArgs();
const { nodeRealTool, writeJsonCompact } = await import('./lib/tool-definitions.mjs');
// `--patch <file>[,<file>…]`: the tree is the reference commit with those Node changes applied; the manifest names them.
const BASE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const tree = resolveTree(args);
const patched = args.get('patch');
const U = (rel) => importFrom(tree, `src/${rel}`);

const access = await U('session-runtime/services/schedule-access.mjs');
const held = await U('session-runtime/held-requests.mjs');
const routine = await U('runtime/shared/routine-trigger.mjs');

const OUT = join(FIXTURES_ROOT, 'tool-pool');
const stage = stageSet(OUT);

// --- caller-facts.json ---------------------------------------------------------------------------
const SESSIONS = [
  ['an ordinary lead session', { id: 'sess_abc', sourceType: 'lead' }],
  ['a session with no source type', { id: 'sess_abc' }],
  ['a cli session', { id: 'sess_abc', sourceType: 'CLI' }],
  ['an exec run', { id: 'sess_abc', sourceType: 'exec' }],
  ['a task session of another source', { id: 'sess_abc', sourceType: 'task' }],
  ['a delegated worker', { id: 'sess_abc', sourceType: 'lead', owner: 'agent' }],
  ['a worker by its owner spelling', { id: 'sess_abc', sourceType: 'lead', owner: ' Agent ' }],
  ['an agent-only session that is no worker', { id: 'sess_abc', sourceType: 'lead', visibility: 'agent-only' }],
  ['a child session', { id: 'sess_abc', sourceType: 'lead', parentSessionId: 'sess_parent' }],
  ['a session owned by another', { id: 'sess_abc', sourceType: 'lead', ownerSessionId: 'sess_other' }],
  ['a session owned by itself', { id: 'sess_abc', sourceType: 'lead', ownerSessionId: 'sess_abc' }],
  ['a session with a zero parent', { id: 'sess_abc', sourceType: 'lead', parentSessionId: 0 }],
  ['Mixy home', { id: 'sess_home_lead', sourceType: 'exec' }],
  ['a contact home', { id: 'sess_home_ann', sourceType: 'exec' }],
  ['a contact home with a dotted id', { id: 'sess_home_ann_b', sourceType: 'exec' }],
  ['a room member seat', { id: 'sess_rmem_abcdef_ann', sourceType: 'exec' }],
  ['a room log', { id: 'sess_room_abcdef', sourceType: 'lead' }],
  ['no id', { sourceType: 'lead' }],
];
// Marks: `heartbeat` marks the session; `run` is `markUnattendedRun`'s argument.
const MARKS = [
  [null, null],
  [true, null],
  [null, { kind: 'schedule', agentId: 'ann' }],
  [null, { kind: 'webhook', agentId: 'ann' }],
  [null, { kind: 'webhook', agentId: '' }],
  [null, { kind: 'other', agentId: 'bob' }],
];
const callerCases = [];
for (const [label, record] of SESSIONS) {
  for (const [heartbeat, run] of MARKS) {
    if (heartbeat) routine.markHeartbeatSession(record.id);
    const unmark = run && record.id ? held.markUnattendedRun(record.id, run) : () => {};
    const scope = access.scheduleCallerScope(record);
    callerCases.push({
      name: `${label}${heartbeat ? ', heartbeat-marked' : ''}${run ? `, ${run.kind} run of "${run.agentId}"` : ''}`,
      record,
      heartbeat: heartbeat === true && Boolean(record.id),
      run: run && record.id ? { kind: run.kind, agentId: run.agentId } : null,
      isHeartbeat: routine.isHeartbeatSession(record.id),
      scope,
      unattended: scope.unattended === true,
    });
    unmark();
    if (heartbeat) routine.markHeartbeatSession(record.id, true);
  }
}
writeJson(join(stage, 'caller-facts.json'), { cases: callerCases });
console.log(`caller facts: ${callerCases.length} cases`);

// --- tool-list.json ------------------------------------------------------------------------------
const defsOf = async (rel, key = 'TOOL_DEFS') => (await U(rel))[key];
const standaloneDefs = (await U('runtime/agent/orchestrator/runtime-core/tool-defs.mjs')).collectStandaloneToolDefs({
  webSearchToolDefs: await U('runtime/web-search/tool-defs.mjs'),
  memoryToolDefs: await U('runtime/memory/tool-defs.mjs'),
  codeGraphToolDefs: await U('runtime/agent/orchestrator/tools/code-graph-tool-defs.mjs'),
  browserToolDefs: await defsOf('runtime/browser-bridge/tool-defs.mjs'),
  computerToolDefs: await defsOf('runtime/computer-bridge/tool-defs.mjs'),
  terminalToolDefs: await defsOf('runtime/terminal-bridge/tool-defs.mjs'),
  officeToolDefs: await defsOf('runtime/office/tool-defs.mjs'),
  mediaToolDefs: await defsOf('runtime/media/tool-defs.mjs'),
  tidyToolDefs: await defsOf('runtime/tidy/tool-defs.mjs'),
  visualizeToolDefs: await defsOf('runtime/visualize-bridge/tool-defs.mjs'),
  exploreToolDefs: await defsOf('runtime/explore/tool-defs.mjs'),
  setupToolDefs: await defsOf('session-runtime/setup-tool/tool-defs.mjs', 'SETUP_TOOL_DEFS'),
  askUserToolDefs: await defsOf('runtime/agent/orchestrator/runtime-core/ask-user-tool-defs.mjs', 'ASK_USER_TOOL_DEFS'),
  handoffUserToolDefs: await defsOf('runtime/agent/orchestrator/runtime-core/ask-user-tool-defs.mjs', 'HANDOFF_USER_TOOL_DEFS'),
  reactionToolDefs: await defsOf('runtime/agent/orchestrator/runtime-core/reaction-tool-defs.mjs', 'REACTION_TOOL_DEFS'),
  goalTools: await defsOf('runtime/agent/orchestrator/runtime-core/goal-tool-defs.mjs', 'GOAL_TOOL_DEFS'),
  agentTools: [(await U('session-runtime/services/agent-tool/tool-def.mjs')).AGENT_TOOL],
  skillToolEnabled: true,
});
const { createToolSurface } = await U('session-runtime/tool-surface.mjs');
const profile = await U('runtime/agent/orchestrator/runtime-core/tool-profile.mjs');
const names = (tools) => tools.map((t) => t.name);

const SURFACE_CASES = [
  ['a main session', { session: { id: 'sess_main' } }],
  ['a main session on the interactive profile with a delegating workflow', { session: { id: 'sess_main', workflow: { id: 'swarm', delegatesAgents: true, agentsConfigured: true, agents: ['worker'] } } }],
  ['a delegated sub-agent', { session: { id: 'sess_agent', owner: 'agent' } }],
  ['an agent-only session', { session: { id: 'sess_agent', visibility: 'agent-only' } }],
  ['a workflow with no agents configured', { session: { id: 'sess_main', workflow: { id: 'solo', agentsConfigured: true, agents: [] } } }],
  ['a workflow switched to mid-conversation, none left to delegate to', { session: { id: 'sess_main', workflow: { id: 'swarm', agentsConfigured: true, agents: ['w'] }, workflowOverlay: { prompt: { id: 'solo', agentsConfigured: true, agents: [] } } } }],
  ['a bot chat whose workflow does not delegate', { session: { id: 'sess_home_ann', workflow: { id: 'bot', delegatesAgents: false } } }],
  ['a coding session whose workflow does not delegate', { session: { id: 'sess_main', workflow: { id: 'solo', delegatesAgents: false } } }],
  ['a stored agent-mode mark', { session: { id: 'sess_x', sessionMode: 'agent', workflow: { delegatesAgents: false } } }],
  ['no session yet', { session: null, delegatable: 0 }],
  ['an agent-mode record with no id and no agents to delegate to', { session: { sessionMode: 'agent' }, delegatable: 0 }],
  ['an agent-mode record with no id and agents to delegate to', { session: { sessionMode: 'agent' }, delegatable: 2 }],
  ['a main session on the headless profile', { session: { id: 'sess_main' }, profile: 'headless' }],
  ['a main session on the heartbeat profile', { session: { id: 'sess_main' }, profile: 'heartbeat' }],
  ['web search switched off', { session: { id: 'sess_main' }, features: ['web_search', 'web_fetch'] }],
  ['a sub-agent with memory switched off', { session: { id: 'sess_agent', owner: 'agent' }, features: ['memory', 'recall'] }],
];
const surfaceCases = [];
for (const [name, c] of SURFACE_CASES) {
  const session = c.session ? { ...c.session } : null;
  const surface = createToolSurface({
    mgr: {},
    mode: 'lead',
    standaloneTools: standaloneDefs.standaloneTools,
    agentToolNames: standaloneDefs.agentToolNames,
    getSession: () => session,
    getRoute: () => ({ provider: 'anthropic', model: 'claude-sonnet-4' }),
    getConfig: () => ({}),
    getToolProfile: () => c.profile ?? 'interactive',
    cfgMod: { getPluginData: () => '' },
    delegatableAgentIds: () => Array.from({ length: c.delegatable ?? 1 }),
    dataDir: '',
    getFeatureDisallowedTools: () => c.features ?? [],
  });
  const tools = names(surface.modelStandaloneTools());
  surfaceCases.push({
    name,
    session: c.session,
    profile: c.profile ?? 'interactive',
    allowedByProfile: profile.modelToolSchemaAllowlist(c.profile ?? 'interactive'),
    features: c.features ?? [],
    delegatable: c.delegatable ?? 1,
    tools,
  });
}
await writeJsonCompact(tree, join(stage, 'tool-list.json'), {
  standalone: names(standaloneDefs.standaloneTools),
  agentTools: [...standaloneDefs.agentToolNames],
  cases: surfaceCases,
});
console.log(`tool list: ${surfaceCases.length} cases over ${standaloneDefs.standaloneTools.length} standalone tools`);

// --- dispatch.json -------------------------------------------------------------------------------
// (1) what a call_tool becomes before it is executed (the bridge projection), over one session;
// (2) the model text of a PreToolUse ask the user answers no, or nobody can answer.
const resolution = await U('runtime/agent/orchestrator/session/loop/tool-call-resolution.mjs');
const helpers = await U('runtime/agent/orchestrator/session/loop/tool-helpers.mjs');
// The runtime's own tools are the product's definitions (`Shell` / `WebSearch` are case variants of theirs); a
// connector's tools (`mcp__`) are the recorder's inputs.
const real = await nodeRealTool(tree);
const doc = (name) =>
  name.startsWith('mcp__')
    ? { name, description: `${name} tool`, inputSchema: { type: 'object', properties: {} }, annotations: {} }
    : { ...real({ Shell: 'shell', WebSearch: 'web_search' }[name] ?? name), name };
const bridgeSession = {
  toolExposureMode: 'bridge-v1',
  tools: [doc('read'), doc('load_tool'), doc('call_tool'), doc('Shell')],
  deferredToolCatalog: [doc('web_fetch'), doc('WebSearch'), doc('mcp__alpha__zeta'), doc('mcp__alpha__gone')],
  deferredMcpToolNames: ['mcp__alpha__zeta'],
  schemaAllowedTools: null,
  disallowedTools: [],
};
const CALLS = [
  ['a deferred tool', { name: 'web_fetch', arguments: { url: 'x' } }],
  ['a deferred tool by another case', { name: 'WEB_FETCH', arguments: { url: 'x' } }],
  ['a name with spaces around it', { name: '  web_fetch  ', arguments: {} }],
  ['an available connector tool', { name: 'mcp__alpha__zeta', arguments: { q: 1 } }],
  ['a connector tool the server dropped', { name: 'mcp__alpha__gone', arguments: {} }],
  ['an eager tool', { name: 'read', arguments: {} }],
  ['an eager tool by another case', { name: 'SHELL', arguments: {} }],
  ['an unknown tool', { name: 'nope', arguments: {} }],
  ['the discovery tool', { name: 'load_tool', arguments: {} }],
  ['call_tool itself', { name: 'call_tool', arguments: {} }],
  ['an empty name', { name: '', arguments: {} }],
  ['a name past the limit', { name: 'x'.repeat(257), arguments: {} }],
  ['no arguments object', { name: 'web_fetch' }],
  ['arguments as an array', { name: 'web_fetch', arguments: [] }],
  ['an extra key', { name: 'web_fetch', arguments: {}, more: 1 }],
  ['two extra keys', { name: 'web_fetch', arguments: {}, a: 1, b: 2 }],
];
const projections = CALLS.map(([label, args]) => {
  const wire = { id: 'call_1', name: 'call_tool', arguments: args };
  const out = resolution.resolveExecutionToolCall(wire, bridgeSession);
  return {
    name: label,
    session: 'bridge',
    wire: args,
    ...(out.bridgeError ? { error: out.bridgeError } : { target: out.name, arguments: out.arguments }),
  };
});
// A non-object `arguments` of call_tool itself.
for (const [label, args] of [['arguments that are no object', 'x'], ['null arguments', null]]) {
  const out = resolution.resolveExecutionToolCall({ id: 'call_1', name: 'call_tool', arguments: args }, bridgeSession);
  projections.push({ name: label, session: 'bridge', wire: args, ...(out.bridgeError ? { error: out.bridgeError } : { target: out.name }) });
}
// A connector tool set to ask: the ask the pipeline puts (before-hook.mjs `applyConnectorApproval`).
const { CONNECTOR_APPROVAL_REASON } = await U('runtime/agent/orchestrator/session/loop/tool-exec/before-hook.mjs');
const ASKS = [
  ['approved', { approved: true }],
  ['denied with a reason', { approved: false, reason: 'no thanks.' }],
  ['denied with a reason ending in dots and spaces', { approved: false, reason: 'not now. . ' }],
  ['denied with no reason', { approved: false }],
  ['denied with a blank reason', { approved: false, reason: '   ' }],
];
const asks = [];
for (const [label, answer] of ASKS) {
  const out = await helpers.resolvePreToolAskApproval({
    toolName: 'mcp__mail__send',
    args: {},
    cwd: '/work',
    sessionId: 'sess_main',
    toolCallId: 'call_1',
    askReason: CONNECTOR_APPROVAL_REASON,
    toolApprovalHook: async () => answer,
  });
  asks.push({ name: label, answer, ...(out.denial ? { denial: out.denial } : { approved: true }) });
}
const noUi = await helpers.resolvePreToolAskApproval({ toolName: 'mcp__mail__send', args: {}, cwd: '/work', sessionId: 'sess_main', askReason: CONNECTOR_APPROVAL_REASON, toolApprovalHook: undefined });
asks.push({ name: 'nobody can answer', answer: null, denial: noUi.denial });
await writeJsonCompact(tree, join(stage, 'dispatch.json'), {
  askTool: 'mcp__mail__send',
  bridgeSession: { eager: names(bridgeSession.tools), deferred: names(bridgeSession.deferredToolCatalog), availableConnectors: bridgeSession.deferredMcpToolNames },
  projections,
  asks,
});
console.log(`dispatch: ${projections.length} projections, ${asks.length} asks`);

// --- explore-route.json --------------------------------------------------------------------------
// The route the `explore` tool runs on: `resolveMaintenanceRoute({ agent: 'explore-agent', config,
// includeDefault: false })` (runtime/explore/tool.mjs) over agent configs.
const { resolveMaintenanceRoute } = await U('runtime/agent/orchestrator/agent-runtime/maintenance-route.mjs');
const full = { provider: 'openai-oauth', model: 'gpt-5' };
const EXPLORE_CONFIGS = [
  ['no agents', {}],
  ['a complete route', { agents: { explore: full } }],
  ['a route with effort, fast and parameters', { agents: { explore: { ...full, effort: ' high ', fast: true, modelParameters: { temperature: 0 } } } }],
  ['a blank effort and a fast that is not true', { agents: { explore: { ...full, effort: '  ', fast: 'yes' } } }],
  ['a padded provider and model', { agents: { explore: { provider: '  p  ', model: ' m ' } } }],
  ['a route without a model', { agents: { explore: { provider: 'openai-oauth' } } }],
  ['a route without a provider', { agents: { explore: { model: 'gpt-5' } } }],
  ['a disabled explore with a route', { agents: { explore: full }, disabledAgents: ['explore'] }],
  ['the default model is not a fallback', { default: full }],
  ['a preset name', { agents: { explore: 'preset-name' } }],
  ['an array', { agents: { explore: [full] } }],
  ['a falsy route', { agents: { explore: 0 } }],
];
const exploreRoutes = EXPLORE_CONFIGS.map(([name, config]) => {
  const route = resolveMaintenanceRoute({ agent: 'explore-agent', config, includeDefault: false });
  return { name, config, route: route === undefined ? null : route };
});
writeJson(join(stage, 'explore-route.json'), { routes: exploreRoutes });
console.log(`explore-route: ${exploreRoutes.length} configs`);
// --- catalog.json --------------------------------------------------------------------------------
// The session catalog behind `load_tool` / `call_tool` (runtime-core/tool-bridge.mjs
// `describeBridgeTools` and `resolveBridgeTarget`): what is available, blocked or missing, the
// keyword matches, the MCP instructions a page carries, and how a call_tool name resolves.
const bridge = await U('runtime/agent/orchestrator/runtime-core/tool-bridge.mjs');
const catalog = await U('runtime/agent/orchestrator/runtime-core/tool-catalog.mjs');
const tdoc = (name, description, extra = {}) => ({ name, description, inputSchema: { type: 'object', properties: {} }, ...extra });
const catalogSession = (extra = {}) => ({
  tools: [
    real('read'),
    real('edit'),
    real('load_tool'),
    real('call_tool'),
  ],
  deferredToolCatalog: [
    tdoc('mcp__mail__send', 'Send a mail message', { annotations: { destructiveHint: true } }),
    tdoc('mcp__mail__list', 'List mail folders', { annotations: { readOnlyHint: true } }),
    tdoc('mcp__cal__add', 'Add a calendar event'),
    real('web_fetch'),
    real('web_search'),
    real('shell'),
    tdoc('hidden_tool', 'Denied here'),
  ],
  deferredMcpToolNames: ['mcp__mail__send', 'mcp__mail__list'],
  disallowedTools: ['hidden_tool'],
  mcpServerInstructions: { mail: 'Use <b>mail</b> only when asked.' },
  toolExposureMode: 'bridge-v1',
  ...extra,
});
const CATALOG_SESSIONS = [
  ['an open session', catalogSession(), 'full'],
  ['a read-only session', catalogSession({ deferredSurfaceMode: 'readonly' }), 'readonly'],
  ['an eager tool the route cannot send', catalogSession({ provider: 'openai-oauth', model: 'gpt-5', tools: [...catalogSession().tools, tdoc('broken', 'Has a string schema root', { inputSchema: { type: 'string' } })] }), 'full'],
  ['a session told this very text', catalogSession({ mcpInstructionsAnnounced: ['mail'], mcpInstructionHashes: { mail: createHash('sha256').update('Use bmail/b only when asked.').digest('hex').slice(0, 16) } }), 'full'],
  ['a session that was told the mail instructions', catalogSession({ mcpInstructionsAnnounced: ['mail'], mcpInstructionHashes: { mail: null } }), 'full'],
];
const DESCRIBE_NAMES = [
  ['read'], ['mcp__mail__send'], ['MCP__MAIL__SEND'], ['filesystem'], ['mcp__mail'], ['send'], ['nope'],
  ['broken'], ['hidden_tool'], ['mcp__cal__add'], ['shell'], ['web'], ['read', 'mcp__mail__list', 'nope'],
];
const RESOLVE_NAMES = ['broken', 'read', 'READ', 'mcp__mail__send', 'MCP__MAIL__SEND', 'mcp__cal__add', 'nope', 'hidden_tool', 'shell', 'web_fetch'];
const catalogCases = CATALOG_SESSIONS.map(([name, session, mode]) => ({
  name,
  session,
  describe: DESCRIBE_NAMES.map((names) => {
    // The real load_tool path: it also tells the session which MCP servers' text it sent.
    const out = catalog.renderToolSearch({ names }, structuredClone(session), mode);
    return { names, result: out };
  }),
  resolve: RESOLVE_NAMES.map((n) => {
    const out = bridge.resolveBridgeTarget(structuredClone(session), n);
    return { name: n, result: out.error ? { error: out.error } : { name: out.name } };
  }),
}));
// One session across several pages: load_tool tells it each server's text once (renderToolSearch
// records `mcpInstructionsAnnounced` / `mcpInstructionHashes` on the live session), and again
// when the text changed.
const sequenceSession = catalogSession();
const sequenceStart = structuredClone(sequenceSession);
const sequenceSteps = [
  { names: ['mcp__mail__send'] },
  { names: ['mcp__mail__send'] },
  { names: ['mcp__mail__list'] },
  { names: ['read'] },
  { names: ['mcp__cal__add'] },
  { names: ['mcp__mail__send'], change: { mcpServerInstructions: { mail: 'Changed text.' } } },
  { names: ['mcp__mail__send'] },
].map((step) => {
  if (step.change) Object.assign(sequenceSession, step.change);
  const result = catalog.renderToolSearch({ names: step.names }, sequenceSession, 'full');
  return {
    ...step,
    result,
    announced: structuredClone(sequenceSession.mcpInstructionsAnnounced ?? null),
    hashes: structuredClone(sequenceSession.mcpInstructionHashes ?? null),
  };
});
await writeJsonCompact(tree, join(stage, 'catalog.json'), { cases: catalogCases, sequence: { session: sequenceStart, steps: sequenceSteps } });
console.log(`catalog: ${catalogCases.length} sessions`);
// --- route-schema.json ---------------------------------------------------------------------------
// Why a tool is left out of every request on a session's route (provider-tool-exclusions.mjs
// `routeToolExclusionReason`): the schema rule of the route's wire family, run on the tool before
// it was ever sent. Recorded for every family; the Rust side ports the OpenAI family.
const exclusions = await U('runtime/agent/orchestrator/session/loop/provider-tool-exclusions.mjs');
const ROUTE_SESSIONS = [
  ['openai-oauth', { provider: 'openai-oauth', model: 'gpt-5' }],
  ['openai', { provider: 'openai', model: 'gpt-5' }],
  ['a compatible chat route', { provider: 'openrouter', model: 'vendor/model' }],
  ['a messages wire on a compatible route', { provider: 'openrouter', model: 'vendor/model', wireRoute: { wire: 'messages' } }],
  ['anthropic', { provider: 'anthropic', model: 'claude-sonnet-4' }],
  ['gemini', { provider: 'gemini', model: 'gemini-2.5-pro' }],
  ['antigravity claude', { provider: 'antigravity-oauth', model: 'claude-opus-4' }],
];
const object = (properties) => ({ type: 'object', properties });
const ROUTE_TOOLS = [
  { name: 'plain', inputSchema: object({ path: { type: 'string' } }) },
  { name: 'no_schema', inputSchema: null },
  { name: 'string_root', inputSchema: { type: 'string' } },
  { name: 'array_root', inputSchema: { type: 'array', items: { type: 'string' } } },
  { name: 'unknown_type', inputSchema: object({ a: { type: 'bogus' } }) },
  { name: 'bad_ref', inputSchema: object({ a: { $ref: '#/definitions/missing' } }) },
  { name: 'draft07', inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', definitions: { n: { type: 'number', minimum: 0, exclusiveMinimum: true } }, properties: { n: { $ref: '#/definitions/n' } } } },
  { name: 'root_combinator', inputSchema: { anyOf: [object({ a: { type: 'string' } }), object({ b: { type: 'string' } })] } },
  { name: 'no_type', inputSchema: { properties: { a: { type: 'string' } } } },
  { name: 'freeform', inputSchema: { type: 'string' }, freeform: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' } },
  { name: 'not_an_object_schema', inputSchema: 'oops' },
];
const routeSchema = ROUTE_SESSIONS.map(([name, session]) => ({
  name,
  session,
  tools: ROUTE_TOOLS.map((tool) => ({ name: tool.name, reason: exclusions.routeToolExclusionReason(structuredClone(session), structuredClone(tool)) })),
}));
await writeJsonCompact(tree, join(stage, 'route-schema.json'), { tools: ROUTE_TOOLS, sessions: routeSchema });
console.log(`route-schema: ${routeSchema.length} sessions x ${ROUTE_TOOLS.length} tools`);
commitStage(stage, OUT);
writeSetManifest(OUT, {
  set: 'tool-pool',
  recorder: 'benchmarks/rust-core/recorders/record-tool-pool.mjs',
  command: 'node benchmarks/rust-core/recorders/record-tool-pool.mjs --tree <dir with node_modules>' + (patched ? ` --patch ${patched}` : ''),
  ...(patched ? { identity: nodeTreeIdentity(args, tree, BASE_COMMIT) } : {}),
  extra: { ...recorderProvenance(import.meta.url) },
});
