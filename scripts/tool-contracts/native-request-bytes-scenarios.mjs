// Native (anthropic*, openai*) request bytes the bridge work must never touch.
// `nativeRequestScenarios(root, catalog)` drives one checkout's runtime modules
// (`root` = that checkout) through the native-visible paths: the first request
// (tool definitions, wire tools, system prompt with the BP2 roster and MCP
// instructions), load_tool results and the next request, the late-MCP delta
// notice, the first-turn MCP fold, skill loading, deny texts and a provider
// switch. The catalog is an input, so other tool-definition edits stay out of
// the comparison; load_tool always comes from the checkout under test.
//
// Regenerate the HEAD fixture from a HEAD checkout (with node_modules
// reachable from it):
//   node scripts/tool-contracts/native-request-bytes-scenarios.mjs <head-root> <out.json>
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ORCH = 'src/runtime/agent/orchestrator';
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Large tool arrays: names in order plus one hash per definition.
const toolDigest = (tools) => (tools || []).map((tool) => [tool?.name ?? tool?.type ?? null, hash(tool)]);
const systemTexts = (messages) =>
  (messages || []).filter((message) => message?.role === 'system').map((message) => message.content);
// Tool groups other in-flight changes own; the comparison covers the bridge work.
const EXCLUDED = new Set(['ask_user']);

const MCP_INSTRUCTIONS = { github: 'Prefer list_issues before create_issue.' };
const mcpTool = (name, description, readOnly) => ({
  name,
  description,
  inputSchema: { type: 'object', properties: { repo: { type: 'string' } }, required: ['repo'] },
  annotations: { readOnlyHint: readOnly },
});
const MCP_TOOLS = [
  mcpTool('mcp__github__list_issues', 'List repository issues.', true),
  mcpTool('mcp__github__create_issue', 'Open an issue.', false),
];
const LATE_TOOL = mcpTool('mcp__late__lookup', 'Look something up.', true);

/** The realistic built-in catalog of the checkout at `root` (generation only). */
export async function realisticCatalog(root) {
  const load = (rel) => import(pathToFileURL(join(root, rel)).href);
  const [{ previewSessionTools }, { collectStandaloneToolDefs }, web, memory, browser, computer, office, media, graph] =
    await Promise.all([
      load(`${ORCH}/session/manager/tool-resolution.mjs`),
      load(`${ORCH}/runtime-core/tool-defs.mjs`),
      load('src/runtime/web-search/tool-defs.mjs'),
      load('src/runtime/memory/tool-defs.mjs'),
      load('src/runtime/browser-bridge/tool-defs.mjs'),
      load('src/runtime/computer-bridge/tool-defs.mjs'),
      load('src/runtime/office/tool-defs.mjs'),
      load('src/runtime/media/tool-defs.mjs'),
      load(`${ORCH}/tools/code-graph-tool-defs.mjs`),
    ]);
  const { standaloneTools } = collectStandaloneToolDefs({
    webSearchToolDefs: { TOOL_DEFS: web.TOOL_DEFS },
    memoryToolDefs: { TOOL_DEFS: memory.TOOL_DEFS },
    codeGraphToolDefs: { CODE_GRAPH_TOOL_DEFS: graph.CODE_GRAPH_TOOL_DEFS },
    browserToolDefs: browser.TOOL_DEFS,
    computerToolDefs: computer.TOOL_DEFS,
    officeToolDefs: office.TOOL_DEFS,
    mediaToolDefs: media.TOOL_DEFS,
  });
  const keep = (tools) => JSON.parse(JSON.stringify(tools.filter((tool) => !EXCLUDED.has(tool?.name))));
  return { builtins: keep(previewSessionTools('full', [], {})), standalone: keep(standaloneTools) };
}

export async function nativeRequestScenarios(root, catalog) {
  const load = (rel) => import(pathToFileURL(join(root, rel)).href);
  const [defs, toolCatalog, delta, skills, skillCatalog, callThrough, deny, openai, anthropic] = await Promise.all([
    load(`${ORCH}/runtime-core/tool-defs.mjs`),
    load(`${ORCH}/runtime-core/tool-catalog.mjs`),
    load(`${ORCH}/runtime-core/deferred-tool-delta.mjs`),
    load(`${ORCH}/runtime-core/skill-tool-loading.mjs`),
    load(`${ORCH}/context/skill-catalog.mjs`),
    load(`${ORCH}/session/loop/deferred-call-through.mjs`),
    load(`${ORCH}/session/loop/pre-dispatch-deny.mjs`),
    load(`${ORCH}/providers/openai-responses-payload.mjs`),
    load(`${ORCH}/providers/anthropic-messages.mjs`),
  ]);
  // The checkout's own load_tool, never the fixture's copy.
  const withLoader = (tools) =>
    tools.map((tool) => (tool.name === defs.TOOL_SEARCH_TOOL.name ? defs.TOOL_SEARCH_TOOL : structuredClone(tool)));
  const builtins = () => withLoader(catalog.builtins);
  const standalone = () => withLoader(catalog.standalone);

  const newSession = (provider, mode = 'lead', extra = {}) => {
    const session = {
      id: `native-bytes-${provider}-${mode}`,
      provider,
      model: provider.startsWith('openai') ? 'gpt-5.6-sol' : 'claude-opus-4-7',
      toolSpec: mode === 'readonly' ? 'readonly' : 'full',
      tools: builtins(),
      mcpServerInstructions: { ...MCP_INSTRUCTIONS },
      messages: [
        { role: 'system', content: '# Base rules' },
        { role: 'system', content: '# Profile' },
        { role: 'system', content: '# Session', cacheTier: 'tier3' },
      ],
      ...extra,
    };
    toolCatalog.applyDeferredToolSurface(session, mode, [...standalone(), ...structuredClone(MCP_TOOLS)], { provider });
    return session;
  };
  const request = (session) => {
    const tools = toolCatalog.snapshotProviderRequestTools({
      provider: session.provider,
      tools: session.tools,
      session,
      messages: session.messages,
    });
    const chat = [{ role: 'user', content: 'go' }];
    const wire = session.provider.startsWith('openai')
      ? tools.map((tool) => openai.toOpenAIResponsesTool(tool))
      : anthropic.requestAnthropicTools(tools, chat, {});
    const system = session.provider.startsWith('openai')
      ? null
      : anthropic.buildSystemBlocks(
          session.messages.filter((message) => message.role === 'system'),
          { type: 'ephemeral', ttl: '1h' },
          { type: 'ephemeral', ttl: '1h' }
        );
    return {
      system: systemTexts(session.messages),
      tools: toolDigest(tools),
      wireTools: toolDigest(wire),
      anthropicSystem: system,
      state: {
        selected: session.deferredSelectedTools ?? null,
        callable: session.deferredCallableTools ?? null,
        discovered: session.deferredDiscoveredTools ?? null,
        announced: session.deferredAnnouncedTools ?? null,
      },
    };
  };
  const loadTool = (session, args) =>
    toolCatalog.renderToolSearch(args, session, session.deferredSurfaceMode || 'lead');

  const out = {};
  for (const provider of ['anthropic-oauth', 'openai-oauth']) {
    const lead = newSession(provider);
    const scenario = { first: request(lead) };
    scenario.loadToolResults = {
      load: loadTool(lead, { names: ['web_fetch', 'mcp__github__list_issues'] }),
      again: loadTool(lead, { names: ['web_fetch'] }),
      missing: loadTool(lead, { names: ['nope_tool'] }),
      empty: loadTool(lead, {}),
      query: loadTool(lead, { query: 'fetch a page' }),
    };
    scenario.afterLoad = request(lead);

    // Late MCP: the baseline snapshot, then a connect and a disconnect.
    toolCatalog.reconcileDeferredMcpToolCatalog(lead, structuredClone(MCP_TOOLS));
    toolCatalog.reconcileDeferredMcpToolCatalog(lead, [...structuredClone(MCP_TOOLS), structuredClone(LATE_TOOL)]);
    const connected = delta.snapshotPendingDeferredToolDelta(lead);
    toolCatalog.reconcileDeferredMcpToolCatalog(lead, structuredClone(MCP_TOOLS.slice(0, 1)));
    scenario.lateMcp = {
      connected: connected && { content: connected.content, added: connected.added, removed: connected.removed },
      afterDisconnect: delta.snapshotPendingDeferredToolDelta(lead)?.content ?? null,
      request: request(lead),
    };

    // First turn: a server that finished its handshake folds into the roster.
    const fresh = newSession(provider);
    toolCatalog.refreshInitialDeferredMcpSurface(fresh, [...structuredClone(MCP_TOOLS), structuredClone(LATE_TOOL)]);
    scenario.firstTurnFold = request(fresh);

    const skillSession = newSession(provider);
    const loaded = skills.loadSkillToolDependencies(
      skillCatalog.buildSkillToolEnvelope('deck', '# Deck', '/skills/deck', {
        toolDependencies: [
          { type: 'tool', value: 'office' },
          { type: 'tool', value: 'nope_tool' },
        ],
      }),
      skillSession,
      'lead'
    );
    scenario.skillLoading = { result: hash(loaded), text: loaded?.result ?? null, request: request(skillSession) };

    const unresolved = newSession(provider, 'lead', { toolSpec: null });
    const allowlisted = newSession(provider, 'lead', { schemaAllowedTools: ['read'] });
    const denied = newSession(provider, 'lead', { disallowedTools: ['grep', 'office'] });
    scenario.denials = {
      unresolvedMode: callThrough.prepareDeferredToolCallThrough(unresolved, 'office')?.deny ?? null,
      allowlist: deny.preDispatchDenyForSession(allowlisted, { name: 'shell', arguments: {} }),
      loadToolAllowlist: deny.preDispatchDenyForSession(allowlisted, { name: 'load_tool', arguments: {} }),
      disallowed: deny.preDispatchDenyForSession(denied, { name: 'grep', arguments: {} }),
      allowed: deny.preDispatchDenyForSession(denied, { name: 'read', arguments: {} }),
      deniedLoad: loadTool(denied, { names: ['office', 'web_fetch'] }),
    };
    scenario.allowlisted = request(allowlisted);
    scenario.denied = request(denied);

    scenario.readonly = request(newSession(provider, 'readonly'));

    // Provider switches: within the family, then to the other native family.
    const switched = newSession(provider);
    loadTool(switched, { names: ['web_fetch'] });
    const sameFamily = provider === 'anthropic-oauth' ? 'anthropic' : 'openai';
    const otherFamily = provider === 'anthropic-oauth' ? 'openai-oauth' : 'anthropic-oauth';
    switched.provider = sameFamily;
    toolCatalog.rebuildDeferredToolSurfaceForProvider(switched, sameFamily);
    scenario.switchSameFamily = request(switched);
    switched.provider = otherFamily;
    toolCatalog.rebuildDeferredToolSurfaceForProvider(switched, otherFamily);
    scenario.switchOtherFamily = request(switched);
    out[provider] = scenario;
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, outFile] = process.argv.slice(2);
  const catalog = await realisticCatalog(resolve(root));
  const expected = await nativeRequestScenarios(resolve(root), catalog);
  writeFileSync(outFile, `${JSON.stringify({ catalog, expected }, null, 1)}\n`);
}
