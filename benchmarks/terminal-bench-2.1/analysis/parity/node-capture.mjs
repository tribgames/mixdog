#!/usr/bin/env node
// Offline capture of what the Node core puts in a provider request for the benchmark's headless thread, one route
// per provider kind contract-hash.mjs covers (openai-oauth, anthropic-oauth, gemini, grok-oauth). It follows
// contract-hash.mjs `routeToolContract` / `providerToolPayload` step for step (headless profile, web search on, memory off,
// lead surface) and prints the payloads themselves, not their hashes, so they can be diffed against the Rust
// core's `tools/toolsStatus` snapshot. No network, no credentials.
// Usage: node node-capture.mjs --repo-root <tree> --out <file.json>
import { writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROUTES = [
  { provider: 'openai-oauth', model: 'gpt-6.1-sol' },
  { provider: 'anthropic-oauth', model: 'claude-opus-5-5' },
  { provider: 'gemini', model: 'gemini-3.8-flash' },
  { provider: 'grok-oauth', model: 'grok-4.7' },
];

export async function captureRoute(repoRoot, route) {
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  const load = (path) => import(pathToFileURL(join(repoRoot, path)).href);
  const { BUILTIN_TOOLS } = await load('src/runtime/agent/orchestrator/tools/builtin/builtin-tools.mjs');
  const { PATCH_TOOL_DEFS } = await load('src/runtime/agent/orchestrator/tools/patch-tool-defs.mjs');
  const { CODE_GRAPH_TOOL_DEFS } = await load('src/runtime/agent/orchestrator/tools/code-graph-tool-defs.mjs');
  const { TOOL_SEARCH_TOOL, CWD_TOOL } = await load('src/session-runtime/tool-defs.mjs');
  const { filterModelEditTools } = await load('src/runtime/shared/edit-tool-dialect.mjs');
  const { applyDeferredToolSurface } = await load('src/session-runtime/tool-catalog.mjs');
  const { featureDisallowedToolsFor } = await load('src/session-runtime/builtin-features.mjs');
  const { filterModelToolsForProfile, disallowedModelToolNamesForProfile } = await load('src/runtime/agent/orchestrator/runtime-core/tool-profile.mjs');
  const pristine = JSON.parse(readFileSync(join(repoRoot, 'src/runtime/shared/pristine-execution-contract.json'), 'utf8'));
  const allTools = [...BUILTIN_TOOLS, ...PATCH_TOOL_DEFS, ...CODE_GRAPH_TOOL_DEFS, TOOL_SEARCH_TOOL, CWD_TOOL];
  const disabled = [...new Set([
    ...featureDisallowedToolsFor(
      { ...pristine.agentDefaults, modules: { webSearch: { enabled: true } }, memoryTools: { enabled: false } },
      { toolProfile: 'headless', gitAvailable: true },
    ),
    ...disallowedModelToolNamesForProfile(allTools, 'headless'),
  ])];
  const allowed = (tools) => filterModelToolsForProfile(tools, 'headless').filter((tool) => !disabled.includes(tool.name));
  const core = filterModelEditTools(allowed([...BUILTIN_TOOLS, ...PATCH_TOOL_DEFS, ...CODE_GRAPH_TOOL_DEFS]), route.model);
  const session = { provider: route.provider, model: route.model, tools: core, messages: [] };
  applyDeferredToolSurface(session, 'lead', allowed([TOOL_SEARCH_TOOL, CWD_TOOL]), { provider: route.provider, model: route.model });
  const active = session.tools || [];
  return {
    ...route,
    providerMode: session.deferredProviderMode,
    catalog: session.deferredToolCatalog || [],
    active,
    providerTools: await providerToolPayload(load, route.provider, active, session),
  };
}

// contract-hash.mjs `providerToolPayload`, unchanged.
async function providerToolPayload(load, provider, activeTools, session) {
  if (provider === 'openai-oauth') {
    const { toOpenAIResponsesTool } = await load('src/runtime/agent/orchestrator/providers/openai-responses-payload.mjs');
    return activeTools.map(toOpenAIResponsesTool);
  }
  if (provider === 'anthropic-oauth') {
    const { snapshotProviderRequestTools } = await load('src/runtime/agent/orchestrator/runtime-core/provider-request-snapshot.mjs');
    const { requestAnthropicTools } = await load('src/runtime/agent/orchestrator/providers/lib/anthropic-request-utils.mjs');
    const snapshot = snapshotProviderRequestTools({ provider, tools: activeTools, messages: [], session });
    return requestAnthropicTools(snapshot, [], { session, providerToolSnapshotAuthoritative: true, providerNativeToolPrefixCount: 0 }, provider);
  }
  if (provider === 'gemini') {
    const { toGeminiTools } = await load('src/runtime/agent/orchestrator/providers/gemini-schema.mjs');
    return [toGeminiTools(activeTools)];
  }
  const { normalizeGrokToolSchemas } = await load('src/runtime/agent/orchestrator/providers/lib/grok-tool-schema.mjs');
  return normalizeGrokToolSchemas(activeTools);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
  const root = resolve(arg('--repo-root'));
  const out = [];
  for (const route of ROUTES) out.push(await captureRoute(root, route));
  writeFileSync(resolve(arg('--out')), `${JSON.stringify(out, null, 2)}\n`);
}
