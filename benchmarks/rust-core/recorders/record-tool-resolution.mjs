// Records the tool array Node sends to the provider for each session kind, by calling Node's own
// assembly code: `resolveSessionToolSurface` (hidden-tool exclusion, name sort, route rank, `todo`,
// allow/deny lists, agent owner binding), then `applyDeferredToolSurface` (a Lead's surface) or
// `applyAgentToolExposure` (a worker's), then `snapshotProviderRequestTools` (the request boundary's
// provider array). No position here is decided by this script.
//
//   node benchmarks/rust-core/recorders/record-tool-resolution.mjs --tree <dir with node_modules>
//
// Output: native/core/fixtures/tool-resolution/golden.json. `pool` is every definition the Rust
// replay registers; a case's `provider` array names its tools in wire order, each pointing at the
// definition it carries (`definitions`), so a definition that differs between cases (the Lead's and
// an agent's `git`/`task`, the edit dialect, the bridge pair) is recorded once per variant.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Import-time sweeps delete real user data: every user dir is a fresh temp dir first.
const sandbox = mkdtempSync(join(tmpdir(), 'tool-resolution-'));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) process.env[key] = sandbox;
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
process.env.TZ = 'UTC';
const { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, exactProductIdentity, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');

const { writeJsonCompact } = await import('./lib/tool-definitions.mjs');
const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'tool-resolution');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-tool-resolution.mjs';
const at = (path) => importFrom(tree, path);
const orch = 'src/runtime/agent/orchestrator/';
const { resolveSessionToolSurface } = await at(`${orch}session/manager/session-tool-surface.mjs`);
const { applyDeferredToolSurface, snapshotProviderRequestTools } = await at(`${orch}runtime-core/tool-catalog.mjs`);
const { applyAgentToolExposure } = await at(`${orch}session/loop/tool-exposure-migration.mjs`);
const { createToolSurface } = await at('src/session-runtime/tool-surface.mjs');
const { previewSessionTools } = await at(`${orch}session/manager/tool-resolution.mjs`);
const { collectStandaloneToolDefs, TOOL_BRIDGE_TOOLS } = await at(`${orch}runtime-core/tool-defs.mjs`);
const { setInternalToolsProvider } = await at(`${orch}internal-tools.mjs`);
const { getHiddenAgent } = await at(`${orch}internal-agents.mjs`);
const { BUILTIN_TOOLS, bindAgentOwner } = await at(`${orch}tools/builtin/builtin-tools.mjs`);
const { TODO_TOOL } = await at(`${orch}runtime-core/todo-tool-defs.mjs`);
const mcp = await at(`${orch}mcp/client.mjs`);
const { deferredSurfaceModeForLead, toolSpecForMode } = await at(`${orch}runtime-core/effort.mjs`);
const { HEADLESS_MODEL_TOOL_NAMES, HEARTBEAT_MODEL_TOOL_NAMES } = await at(`${orch}runtime-core/tool-profile.mjs`);
const { featureDisallowedToolsFor } = await at('src/session-runtime/builtin-features.mjs');
const pristine = JSON.parse(readFileSync(join(tree, 'src/runtime/shared/pristine-execution-contract.json'), 'utf8'));
const defs = async (path, key = 'TOOL_DEFS') => (await at(path))[key];

const { GOAL_TOOL_DEFS } = await at(`${orch}runtime-core/goal-tool-defs.mjs`);
const { AGENT_TOOL } = await at('src/session-runtime/services/agent-tool/tool-def.mjs');
// The product's own definitions, as `boot/tools.mjs` hands them to `collectStandaloneToolDefs`.
const { standaloneTools, internalToolDefs, agentToolNames } = collectStandaloneToolDefs({
  webSearchToolDefs: await at('src/runtime/web-search/tool-defs.mjs'),
  memoryToolDefs: await at('src/runtime/memory/tool-defs.mjs'),
  codeGraphToolDefs: await at(`${orch}tools/code-graph-tool-defs.mjs`),
  browserToolDefs: await defs('src/runtime/browser-bridge/tool-defs.mjs'),
  computerToolDefs: await defs('src/runtime/computer-bridge/tool-defs.mjs'),
  terminalToolDefs: await defs('src/runtime/terminal-bridge/tool-defs.mjs'),
  officeToolDefs: await defs('src/runtime/office/tool-defs.mjs'),
  mediaToolDefs: await defs('src/runtime/media/tool-defs.mjs'),
  tidyToolDefs: await defs('src/runtime/tidy/tool-defs.mjs'),
  visualizeToolDefs: await defs('src/runtime/visualize-bridge/tool-defs.mjs'),
  exploreToolDefs: await defs('src/runtime/explore/tool-defs.mjs'),
  setupToolDefs: await defs('src/session-runtime/setup-tool/tool-defs.mjs', 'SETUP_TOOL_DEFS'),
  askUserToolDefs: await defs(`${orch}runtime-core/ask-user-tool-defs.mjs`, 'ASK_USER_TOOL_DEFS'),
  handoffUserToolDefs: await defs(`${orch}runtime-core/ask-user-tool-defs.mjs`, 'HANDOFF_USER_TOOL_DEFS'),
  reactionToolDefs: await defs(`${orch}runtime-core/reaction-tool-defs.mjs`, 'REACTION_TOOL_DEFS'),
  goalTools: GOAL_TOOL_DEFS,
  agentTools: [AGENT_TOOL],
});
// The runtime registers its internal tools with the same provider the session reads them from.
setInternalToolsProvider({ executor: async () => '', tools: internalToolDefs });
// Two connected MCP servers, registered through the client's test seam.
const MCP = { alpha: ['search_docs', 'zeta', 'Beta'], beta: ['fetch', 'web_search_extra'] };
// Registered by the first case that has them: the registry has no unregister, so every case
// without MCP tools is recorded before it (checked in `record`).
let mcpRegistered = false;
let mcpTools = [];
const registerMcp = () => {
  for (const [server, tools] of Object.entries(MCP)) {
    mcp._registerMcpServerForTest(null, server, tools.map((name) => ({ name, description: `${server} ${name}`, inputSchema: { type: 'object', properties: {} } })));
  }
  mcpRegistered = true;
  mcpTools = JSON.parse(JSON.stringify(mcp.getMcpTools(null)));
};

const names = (list) => (Array.isArray(list) ? list : []).map((tool) => String(tool?.name ?? ''));
const json = (value) => JSON.stringify(value);
const definitions = {};
// A definition is recorded once per distinct body; the id is the tool name, then `name#2`, ...
const defId = (tool) => {
  const body = json(tool);
  for (let n = 1; ; n += 1) {
    const id = n === 1 ? tool.name : `${tool.name}#${n}`;
    if (definitions[id] === undefined) {
      definitions[id] = tool;
      return id;
    }
    if (json(definitions[id]) === body) return id;
  }
};

// The registered pool: both edit dialects, the standalone tools, the bridge pair, and `todo`.
const poolByName = new Map();
const dialects = [...previewSessionTools('full', [], { modelName: 'claude-opus-4-6' }), ...previewSessionTools('full', [], { modelName: 'gpt-5' })];
for (const tool of [...dialects, ...standaloneTools, ...TOOL_BRIDGE_TOOLS, TODO_TOOL]) {
  if (tool?.name && !poolByName.has(tool.name)) poolByName.set(tool.name, tool);
}

// The pool as registered, copied before any case runs: the surfaces mark the definitions they hold (`deferLoading`).
// `agent`: the definition a delegated agent's session holds for a tool (`bindAgentOwner`), when it has one.
const poolTools = [...poolByName.values()].map((tool) => {
  const agent = bindAgentOwner(tool);
  return JSON.parse(json({ name: tool.name, definition: tool, ...(agent !== tool ? { agent } : {}) }));
});

/** One recorded session: `kind` `lead` creates it as `materializeSession` does, `worker` as the agent runtime does. */
function record(name, input) {
  const {
    kind = 'lead', provider = 'anthropic', model = 'claude-opus-4-6', mode = 'full', agent = null, schemaAllowedTools = null,
    callerDisallowed = [], featureDenied = [], mcpConnected = false, sessionId = 'sess_recorder', tools = null, toolProfile = 'interactive',
  } = input;
  const worker = kind === 'worker';
  if (mcpConnected && !mcpRegistered) registerMcp();
  if (!mcpConnected && mcpRegistered) throw new Error(`${name}: record the cases without MCP tools first`);
  const mcpScopeId = null;
  // A Lead's session is created with `tools: toolSpecForMode(rt.mode)` (`session-create/session-options.mjs`); a worker's is `full`.
  const readonlyLead = kind === 'lead' && mode === 'readonly';
  const toolPreset = readonlyLead ? toolSpecForMode('readonly') : (tools ?? 'full');
  const opts = {
    id: sessionId,
    cwd: sandbox,
    mcpScopeId,
    skipSkills: true,
    ...(worker ? { owner: 'agent', agent: agent ?? 'worker-recorder' } : {}),
    ...(schemaAllowedTools ? { schemaAllowedTools } : {}),
    disallowedTools: [...callerDisallowed, ...featureDenied],
  };
  const surface = resolveSessionToolSurface(opts, { profile: null, toolPreset, modelName: model });
  const session = {
    id: sessionId, provider, model, tools: surface.tools, preset: toolPreset, toolSpec: surface.toolSpec, messages: [],
    cwd: sandbox, mcpScopeId, disallowedTools: surface.sessionDeny.map(String),
    // The allowlist the session persists is the one it honours (`honoredSchemaAllowlist`): a worker's caller allowlist binds only a hidden role.
    schemaAllowedTools: surface.schemaAllowedTools,
    ...(worker ? { owner: 'agent', agent: opts.agent } : {}),
  };
  const resolved = names(surface.toolsForRouting);
  const finalized = names(surface.tools);
  if (worker) {
    applyAgentToolExposure(session);
  } else {
    const route = { provider, model };
    const toolSurface = createToolSurface({
      mgr: { previewSessionTools }, mode: readonlyLead ? 'readonly' : 'lead', standaloneTools, agentToolNames,
      getSession: () => session, getRoute: () => route, getConfig: () => ({}), getToolProfile: () => toolProfile, cfgMod: { getPluginData: () => sandbox },
      delegatableAgentIds: () => [], dataDir: sandbox, getFeatureDisallowedTools: () => featureDenied,
    });
    const connected = mcpConnected ? mcp.getMcpTools(null) : [];
    applyDeferredToolSurface(
      session,
      deferredSurfaceModeForLead(readonlyLead ? 'readonly' : 'lead'),
      connected.length ? [...toolSurface.modelStandaloneTools(), ...connected] : toolSurface.modelStandaloneTools(),
      { provider }
    );
  }
  const sent = snapshotProviderRequestTools({ provider, tools: session.tools, nativeTools: [], messages: [], session });
  return {
    name,
    input: { kind, provider, model, mode: readonlyLead ? 'readonly' : mode, agent, schemaAllowedTools, callerDisallowed, featureDenied, mcpConnected, sessionId, toolProfile },
    // `getHiddenAgent(agent)`: the replay's role policy for a worker.
    hiddenAgent: worker && Boolean(getHiddenAgent(opts.agent)),
    toolSpec: surface.toolSpec,
    // What a stored session of this kind holds (the Rust worker's header is built from it).
    persisted: { schemaAllowedTools: session.schemaAllowedTools, disallowedTools: session.disallowedTools },
    exposure: session.toolExposureMode ?? null,
    resolved,
    finalized,
    surface: names(session.tools),
    provider: sent.map((tool) => ({ name: tool.name, definition: defId(JSON.parse(json(tool))), ...(tool.deferLoading ? { deferLoading: true } : {}) })),
  };
}
const cases = [];
const add = (name, input) => cases.push(record(name, input));

add('lead, anthropic native, claude', { provider: 'anthropic', model: 'claude-opus-4-6' });
add('lead, openai native, gpt', { provider: 'openai', model: 'gpt-5' });
add('lead, bridge route (xai)', { provider: 'xai', model: 'grok-4' });
add('lead, manifest route (gemini)', { provider: 'gemini', model: 'gemini-3-pro' });
add('lead readonly, native', { provider: 'anthropic', model: 'claude-opus-4-6', mode: 'readonly' });
add('lead readonly, bridge route', { provider: 'xai', model: 'grok-4', mode: 'readonly' });
add('lead in a bot home chat (react kept)', { provider: 'anthropic', model: 'claude-opus-4-6', sessionId: 'sess_home_recorder' });
add('lead, feature gates off (web, memory, git, explore), native', { provider: 'anthropic', model: 'claude-opus-4-6', featureDenied: ['web_search', 'web_fetch', 'memory', 'recall', 'git', 'github', 'explore'] });
add('lead, feature gates off (desktop bridges), bridge route', { provider: 'xai', model: 'grok-4', featureDenied: ['browser', 'browser_devtools', 'computer', 'terminal', 'office', 'media'] });
add('lead, caller denylist', { provider: 'anthropic', model: 'claude-opus-4-6', callerDisallowed: ['Skill', 'shell'] });
add('lead, caller allowlist', { provider: 'anthropic', model: 'claude-opus-4-6', schemaAllowedTools: ['Read', 'GREP', 'todo', 'shell', 'nope'] });
// A headless exec thread (`mixdog exec`) carries its runtime's profile as the session's schema allowlist; the features
// its config turns off are the harness's (web search on, memory off, git available), the profile's own denials added.
const headlessDenied = () => featureDisallowedToolsFor({ ...pristine.agentDefaults, modules: { webSearch: { enabled: true } }, memoryTools: { enabled: false } }, { toolProfile: 'headless', gitAvailable: true });
add('lead, headless profile, anthropic native', { provider: 'anthropic', model: 'claude-opus-4-6', toolProfile: 'headless', schemaAllowedTools: [...HEADLESS_MODEL_TOOL_NAMES], featureDenied: headlessDenied() });
add('lead, headless profile, openai native', { provider: 'openai', model: 'gpt-5', toolProfile: 'headless', schemaAllowedTools: [...HEADLESS_MODEL_TOOL_NAMES], featureDenied: headlessDenied() });
add('lead, headless profile, bridge route', { provider: 'xai', model: 'grok-4', toolProfile: 'headless', schemaAllowedTools: [...HEADLESS_MODEL_TOOL_NAMES], featureDenied: headlessDenied() });
add('lead, headless profile, manifest route', { provider: 'gemini', model: 'gemini-3-pro', toolProfile: 'headless', schemaAllowedTools: [...HEADLESS_MODEL_TOOL_NAMES], featureDenied: headlessDenied() });
add('lead, heartbeat profile, native', { provider: 'anthropic', model: 'claude-opus-4-6', toolProfile: 'heartbeat', schemaAllowedTools: [...HEARTBEAT_MODEL_TOOL_NAMES] });
add('worker, native, no allowlist', { kind: 'worker', provider: 'anthropic', model: 'claude-opus-4-6' });
add('worker, openai native, no allowlist', { kind: 'worker', provider: 'openai', model: 'gpt-5' });
add('worker, bridge route, no allowlist', { kind: 'worker', provider: 'xai', model: 'grok-4' });
add('worker, native, non-hidden allowlist (ignored)', { kind: 'worker', provider: 'anthropic', model: 'claude-opus-4-6', schemaAllowedTools: ['read', 'grep'] });
add('worker, bridge route, non-hidden allowlist (ignored)', { kind: 'worker', provider: 'xai', model: 'grok-4', schemaAllowedTools: ['read', 'grep'] });
add('hidden worker with allowlist, native', { kind: 'worker', agent: 'explore-agent', provider: 'anthropic', model: 'claude-opus-4-6', schemaAllowedTools: ['grep', 'read', 'glob', 'agent', 'todo'] });
add('hidden worker with allowlist, bridge route', { kind: 'worker', agent: 'explore-agent', provider: 'xai', model: 'grok-4', schemaAllowedTools: ['grep', 'read', 'glob', 'todo'] });
add('hidden worker with an empty allowlist', { kind: 'worker', agent: 'cycle1-agent', provider: 'anthropic', model: 'claude-opus-4-6', schemaAllowedTools: [] });
add('worker, feature gates off, native', { kind: 'worker', provider: 'anthropic', model: 'claude-opus-4-6', featureDenied: ['web_search', 'web_fetch', 'memory', 'recall', 'git', 'github'] });
add('worker, feature gates off, bridge route', { kind: 'worker', provider: 'xai', model: 'grok-4', featureDenied: ['web_search', 'web_fetch', 'memory', 'recall', 'git', 'github'] });
// MCP tools connected (registered by the first of these, so they come last).
add('lead with MCP tools, native', { provider: 'anthropic', model: 'claude-opus-4-6', mcpConnected: true });
add('lead with MCP tools, bridge route', { provider: 'xai', model: 'grok-4', mcpConnected: true });
add('lead with MCP tools, openai native, feature gates off', { provider: 'openai', model: 'gpt-5', mcpConnected: true, featureDenied: ['web_search', 'web_fetch', 'recall', 'memory'] });
// The specs that hold the internal and MCP tools without the built-ins: code_graph is among the internal ones.
add('lead, spec mcp, MCP tools', { provider: 'anthropic', model: 'claude-opus-4-6', mcpConnected: true, tools: 'mcp' });
add('lead, spec tools:mcp, MCP tools', { provider: 'anthropic', model: 'claude-opus-4-6', mcpConnected: true, tools: ['tools:mcp'] });
add('worker with MCP tools, native', { kind: 'worker', provider: 'anthropic', model: 'claude-opus-4-6', mcpConnected: true });
add('worker with MCP tools, bridge route', { kind: 'worker', provider: 'xai', model: 'grok-4', mcpConnected: true });
add('hidden worker with an MCP tool in its allowlist', { kind: 'worker', agent: 'explore-agent', provider: 'anthropic', model: 'claude-opus-4-6', schemaAllowedTools: ['read', 'mcp__alpha__zeta', 'todo'], mcpConnected: true });

await writeJsonCompact(tree, join(stage, 'golden.json'), {
  pool: {
    builtin: names(BUILTIN_TOOLS),
    tools: poolTools,
    mcpTools,
    standalone: names(standaloneTools),
    bridge: names(TOOL_BRIDGE_TOOLS),
    mcp: Object.entries(MCP).flatMap(([server, tools]) => tools.map((tool) => `mcp__${server}__${tool}`)),
  },
  definitions,
  cases,
});
writeSetManifest(stage, { set: 'tool-resolution', recorder, command: `node ${recorder} --tree <tree>`, identity: exactProductIdentity(tree, 'b6f10295a2f698afc85332467192de28500bd146') });
commitStage(stage, finalDir);
console.log(`tool resolution: ${cases.length} cases, ${Object.keys(definitions).length} definitions`);
