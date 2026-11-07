// Records Node's pre-session Lead tool surface (`createToolSurface().activeToolSurface()` with no
// session: `buildPreSessionSurface`) over the real tool-resolution, deferred-catalog and
// standalone-tool code, for a set of modes, routes and feature gates. The Rust `LeadSurfaceHost::preview`
// (mixdog-core `run_host/surface_host.rs`) must list, expose and defer the same tools. `pool` holds
// every tool definition the Rust test registers as its tool pool.
//
//   node benchmarks/rust-core/recorders/record-surface-preview.mjs --tree <dir with node_modules>
//
// Output: native/core/fixtures/surface-host/golden.json.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Import-time sweeps delete real user data: every user dir is a fresh temp dir first.
const sandbox = mkdtempSync(join(tmpdir(), 'surface-host-'));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) process.env[key] = sandbox;
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
process.env.TZ = 'UTC';
const { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'surface-host');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-surface-preview.mjs';
const at = (path) => importFrom(tree, path);
const { createToolSurface } = await at('src/session-runtime/tool-surface.mjs');
const { previewSessionTools } = await at('src/runtime/agent/orchestrator/session/manager/tool-resolution.mjs');
const { collectStandaloneToolDefs, TOOL_BRIDGE_TOOLS } = await at('src/runtime/agent/orchestrator/runtime-core/tool-defs.mjs');
const { setInternalToolsProvider } = await at('src/runtime/agent/orchestrator/internal-tools.mjs');
const defs = async (path, key = 'TOOL_DEFS') => (await at(path))[key];
const { GOAL_TOOL_DEFS } = await at('src/runtime/agent/orchestrator/runtime-core/goal-tool-defs.mjs');
const { AGENT_TOOL } = await at('src/session-runtime/services/agent-tool/tool-def.mjs');

const { standaloneTools, internalToolDefs, agentToolNames } = collectStandaloneToolDefs({
  webSearchToolDefs: await at('src/runtime/web-search/tool-defs.mjs'),
  memoryToolDefs: await at('src/runtime/memory/tool-defs.mjs'),
  codeGraphToolDefs: await at('src/runtime/agent/orchestrator/tools/code-graph-tool-defs.mjs'),
  browserToolDefs: await defs('src/runtime/browser-bridge/tool-defs.mjs'),
  computerToolDefs: await defs('src/runtime/computer-bridge/tool-defs.mjs'),
  terminalToolDefs: await defs('src/runtime/terminal-bridge/tool-defs.mjs'),
  officeToolDefs: await defs('src/runtime/office/tool-defs.mjs'),
  mediaToolDefs: await defs('src/runtime/media/tool-defs.mjs'),
  tidyToolDefs: await defs('src/runtime/tidy/tool-defs.mjs'),
  visualizeToolDefs: await defs('src/runtime/visualize-bridge/tool-defs.mjs'),
  exploreToolDefs: await defs('src/runtime/explore/tool-defs.mjs'),
  setupToolDefs: await defs('src/session-runtime/setup-tool/tool-defs.mjs', 'SETUP_TOOL_DEFS'),
  askUserToolDefs: await defs('src/runtime/agent/orchestrator/runtime-core/ask-user-tool-defs.mjs', 'ASK_USER_TOOL_DEFS'),
  handoffUserToolDefs: await defs('src/runtime/agent/orchestrator/runtime-core/ask-user-tool-defs.mjs', 'HANDOFF_USER_TOOL_DEFS'),
  reactionToolDefs: await defs('src/runtime/agent/orchestrator/runtime-core/reaction-tool-defs.mjs', 'REACTION_TOOL_DEFS'),
  goalTools: GOAL_TOOL_DEFS,
  agentTools: [AGENT_TOOL],
});
// The runtime registers its internal tools with the same provider the session reads them from.
setInternalToolsProvider({ executor: async () => '', tools: internalToolDefs });

const byName = new Map();
// Both edit dialects are registered (`edit` for the Claude family, `apply_patch` for the GPT family).
const dialects = [...previewSessionTools('full', [], { modelName: 'claude-opus-4-6' }), ...previewSessionTools('full', [], { modelName: 'gpt-5' })];
for (const tool of [...dialects, ...standaloneTools, ...TOOL_BRIDGE_TOOLS]) {
  if (tool?.name && !byName.has(tool.name)) byName.set(tool.name, tool);
}
const pool = [...byName.values()];

const names = (list) => (Array.isArray(list) ? list : []).map((tool) => (typeof tool === 'string' ? tool : String(tool?.name ?? '')));
const SCENARIOS = [
  ['full, native provider, no gate closed', 'full', { provider: 'anthropic', model: 'claude-opus-4-6' }, []],
  ['full, native provider, web and memory gates closed', 'full', { provider: 'anthropic', model: 'claude-opus-4-6' }, ['web_search', 'web_fetch', 'memory', 'recall']],
  ['full, openai route, git and explore closed', 'full', { provider: 'openai', model: 'gpt-5' }, ['git', 'github', 'explore']],
  ['full, gemini route', 'full', { provider: 'gemini', model: 'gemini-3-pro' }, []],
  ['readonly, native provider', 'readonly', { provider: 'anthropic', model: 'claude-opus-4-6' }, []],
  ['readonly, openai route, every bridge feature closed', 'readonly', { provider: 'openai', model: 'gpt-5' }, ['browser', 'browser_devtools', 'computer', 'terminal', 'office', 'media']],
  ['lead mode, native provider', 'lead', { provider: 'anthropic', model: 'claude-opus-4-6' }, []],
];
const cases = SCENARIOS.map(([name, mode, route, featureDenied]) => {
  const config = {};
  const surface = createToolSurface({
    mgr: { previewSessionTools },
    mode,
    standaloneTools,
    agentToolNames,
    getSession: () => null,
    getRoute: () => route,
    getConfig: () => config,
    cfgMod: { getPluginData: () => sandbox },
    delegatableAgentIds: () => [],
    dataDir: sandbox,
    getFeatureDisallowedTools: () => featureDenied,
  }).activeToolSurface();
  // `getTools()` of `wireSkills`: each name once, tools, then the deferred catalogs.
  const listed = [...new Map([...(surface.tools || []), ...(surface.deferredToolCatalog || []), ...(surface.deferredLateToolCatalog || [])].map((tool) => [tool.name, tool])).keys()];
  return {
    name,
    mode,
    route,
    featureDenied,
    expect: {
      tools: names(surface.tools),
      catalog: (surface.deferredToolCatalog || []).map((tool) => ({ name: tool.name, description: tool.description ?? '', agentHidden: Boolean(tool.annotations?.agentHidden) })),
      callable: names(surface.deferredCallableTools),
      discovered: names(surface.deferredDiscoveredTools),
      listed,
    },
  };
});
writeJson(join(stage, 'golden.json'), { pool, standalone: names(standaloneTools), agentTools: [...agentToolNames], cases });
writeSetManifest(stage, { set: 'surface-host', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
