#!/usr/bin/env node
// Contract digests for a benchmark run.
//
// A preset fingerprint pins the dataset, suite, and routes — never the prompt
// surface. Two runs of one preset can therefore ship different rules and tool
// schemas under an identical fingerprint. These digests close that gap so a
// report says exactly which contract produced it.
//
// The tool catalog is hashed as the benchmark container sees it (linux), not
// as the host platform renders it.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const sha256 = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const BENCHMARK_DISABLED_TOOLS = Object.freeze(['web_search', 'web_fetch', 'memory', 'recall']);

function markdownFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...markdownFiles(full));
    else if (entry.name.endsWith('.md')) found.push(full);
  }
  return found;
}

function rulesDigest(repoRoot) {
  const dir = join(repoRoot, 'src', 'rules');
  const files = markdownFiles(dir)
    .map((path) => [relative(dir, path).split('\\').join('/'), readFileSync(path, 'utf8')])
    .sort(([left], [right]) => left.localeCompare(right));
  const payload = files.map(([name, body]) => `${name}\n${body}`).join('\n\0\n');
  return { hash: sha256(payload), files: files.length, bytes: Buffer.byteLength(payload) };
}

function optionValue(argv, name, fallback = '') {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? String(argv[index + 1]) : fallback;
}

function optionList(argv, name) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name && argv[index + 1]) {
      values.push(String(argv[index + 1]));
      index += 1;
    }
  }
  return values;
}

function parseRouteOption(value) {
  const match = String(value || '').match(/^([A-Za-z0-9_-]+)=([^/=]+)\/(.+)$/);
  if (!match) {
    throw new Error(`invalid --route ${value}; expected id=provider/model`);
  }
  return { id: match[1], provider: match[2], model: match[3] };
}

function routeSurfaceMode(routeId) {
  return routeId === 'lead' || routeId === 'leadFallback' ? 'lead' : 'full';
}

function workflowDocument(repoRoot, workflowId) {
  const source = readFileSync(
    join(repoRoot, 'src', 'workflows', workflowId, 'WORKFLOW.md'),
    'utf8',
  );
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const frontmatter = {};
  for (const line of String(match?.[1] || '').split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!field) continue;
    frontmatter[field[1]] = field[2].trim().replace(/^"(.*)"$/, '$1');
  }
  const body = String(match?.[2] ?? source).trim();
  const name = frontmatter.name || workflowId;
  const description = frontmatter.description || '';
  const firstBreak = body.indexOf('\n');
  const firstLine = (firstBreak === -1 ? body : body.slice(0, firstBreak)).trim();
  const bodyWithoutDuplicateTitle = firstBreak !== -1
    && firstLine.toLowerCase() === `# ${name.toLowerCase()}`
    ? body.slice(firstBreak + 1).replace(/^\s+/, '')
    : body;
  return {
    source,
    delegation: String(frontmatter.delegation || '').toLowerCase(),
    rendered: [
      `# Active Workflow: ${name}${description ? ` — ${description}` : ''}`,
      bodyWithoutDuplicateTitle,
    ].filter(Boolean).join('\n\n'),
  };
}

function benchmarkLeadMeta(builder, pluginRoot) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-tb-contract-'));
  try {
    writeFileSync(
      join(dataDir, 'mixdog-config.json'),
      `${JSON.stringify({
        outputStyle: 'simple',
        agent: { profile: { language: 'en' } },
      }, null, 2)}\n`,
      'utf8',
    );
    return builder.buildLeadMetaContent({ PLUGIN_ROOT: pluginRoot, DATA_DIR: dataDir });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function providerToolPayload(load, provider, activeTools, session) {
  const normalized = String(provider || '').trim().toLowerCase();
  if (normalized === 'openai' || normalized === 'openai-oauth') {
    const { toOpenAIResponsesTool } = await load(
      'src/runtime/agent/orchestrator/providers/openai-responses-payload.mjs',
    );
    return activeTools.map(toOpenAIResponsesTool);
  }
  if (normalized === 'anthropic' || normalized === 'anthropic-oauth') {
    const { snapshotProviderRequestTools } = await load(
      'src/session-runtime/provider-request-snapshot.mjs',
    );
    const { requestAnthropicTools } = await load(
      'src/runtime/agent/orchestrator/providers/lib/anthropic-request-utils.mjs',
    );
    const snapshot = snapshotProviderRequestTools({
      provider: normalized,
      tools: activeTools,
      messages: [],
      session,
    });
    return requestAnthropicTools(snapshot, [], {
      session,
      providerToolSnapshotAuthoritative: true,
      providerNativeToolPrefixCount: 0,
    }, normalized);
  }
  if (normalized === 'gemini') {
    const { toGeminiTools } = await load(
      'src/runtime/agent/orchestrator/providers/gemini-schema.mjs',
    );
    return [toGeminiTools(activeTools)];
  }
  if (normalized === 'grok-oauth' || normalized === 'xai' || normalized === 'grok') {
    const { normalizeGrokToolSchemas } = await load(
      'src/runtime/agent/orchestrator/providers/lib/grok-tool-schema.mjs',
    );
    return normalizeGrokToolSchemas(activeTools);
  }
  return activeTools;
}

function providerToolCount(provider, payload) {
  if (String(provider || '').toLowerCase() === 'gemini') {
    return payload?.[0]?.functionDeclarations?.length || 0;
  }
  return Array.isArray(payload) ? payload.length : 0;
}

async function routeToolContract(repoRoot, route) {
  // The container runs linux; hash the schema that ships there.
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  const load = (path) => import(pathToFileURL(join(repoRoot, path)).href);
  const { BUILTIN_TOOLS } = await load('src/runtime/agent/orchestrator/tools/builtin/builtin-tools.mjs');
  const { PATCH_TOOL_DEFS } = await load('src/runtime/agent/orchestrator/tools/patch-tool-defs.mjs');
  const { CODE_GRAPH_TOOL_DEFS } = await load('src/runtime/agent/orchestrator/tools/code-graph-tool-defs.mjs');
  // Benchmark trials run with MIXDOG_DISABLE_SKILLS=1 and MIXDOG_DISABLE_MCP=1,
  // so the Skill tool never reaches the model; hashing it would describe a
  // wider surface than the one that produced the score.
  const { TOOL_SEARCH_TOOL, CWD_TOOL } = await load('src/session-runtime/tool-defs.mjs');
  const { filterModelEditTools } = await load('src/runtime/shared/edit-tool-dialect.mjs');
  const { applyDeferredToolSurface } = await load('src/session-runtime/tool-catalog.mjs');
  const { buildDeferredToolManifest } = await load(
    'src/runtime/agent/orchestrator/context/collect.mjs',
  );
  const core = filterModelEditTools(
    [...BUILTIN_TOOLS, ...PATCH_TOOL_DEFS, ...CODE_GRAPH_TOOL_DEFS],
    route.model,
  );
  const session = {
    provider: route.provider,
    model: route.model,
    tools: core,
    messages: [],
  };
  applyDeferredToolSurface(
    session,
    routeSurfaceMode(route.id),
    [TOOL_SEARCH_TOOL, CWD_TOOL],
    { provider: route.provider, model: route.model },
  );
  const catalog = session.deferredToolCatalog || [];
  const activeTools = session.tools || [];
  const activeNames = new Set(activeTools.map((tool) => String(tool?.name || '')));
  const deferredManifest = buildDeferredToolManifest(
    catalog.filter((tool) => !activeNames.has(String(tool?.name || ''))),
  );
  const providerTools = await providerToolPayload(load, route.provider, activeTools, session);
  const catalogPayload = JSON.stringify(catalog);
  const activePayload = JSON.stringify(activeTools);
  const providerPayload = JSON.stringify({
    provider: route.provider,
    model: route.model,
    tools: providerTools,
  });
  const payload = JSON.stringify({
    provider: route.provider,
    model: route.model,
    providerMode: session.deferredProviderMode,
    catalog,
    activeTools,
    providerTools,
  });
  return {
    provider: route.provider,
    model: route.model,
    providerMode: session.deferredProviderMode,
    toolCatalogHash: sha256(catalogPayload),
    toolCatalogCount: catalog.length,
    toolCatalogBytes: Buffer.byteLength(catalogPayload),
    toolCatalogNames: catalog.map((tool) => String(tool?.name || '')).sort(),
    activeToolHash: sha256(activePayload),
    activeToolCount: activeTools.length,
    activeToolNames: [...activeNames].sort(),
    providerToolHash: sha256(providerPayload),
    providerToolCount: providerToolCount(route.provider, providerTools),
    providerToolBytes: Buffer.byteLength(providerPayload),
    deferredManifest,
    _payload: payload,
  };
}

// Source bytes and delivered prompt are different contracts: build-time
// metadata (tool markers, comments) changes the former without changing what
// the model reads. Hash both so a source edit that must be prompt-neutral can
// be proven so.
function promptSurfaceDigest(repoRoot, workflowId, routeContract) {
  const require = createRequire(import.meta.url);
  const builder = require(join(repoRoot, 'src', 'lib', 'rules-builder.cjs'));
  const PLUGIN_ROOT = join(repoRoot, 'src');
  const workflow = workflowDocument(repoRoot, workflowId);
  // The edit dialect this route never receives is gated out of the rules at
  // session build time, so the digest omits it here as well.
  const unusedEditTool = routeContract.activeToolNames?.includes('apply_patch')
    ? 'edit'
    : 'apply_patch';
  const shared = builder.buildSharedToolContent({
    PLUGIN_ROOT,
    omitTools: [...BENCHMARK_DISABLED_TOOLS, unusedEditTool],
  });
  const lead = builder.buildLeadRoleContent({
    PLUGIN_ROOT,
    DATA_DIR: '',
    includeLeadBrief: workflow.delegation !== 'none',
  });
  const meta = benchmarkLeadMeta(builder, PLUGIN_ROOT);
  const payload = [
    shared,
    meta,
    routeContract.deferredManifest,
    workflow.rendered,
    lead,
  ].join('\n\0\n');
  return {
    hash: sha256(payload),
    bytes: Buffer.byteLength(payload),
    _payload: payload,
  };
}

function publicRouteContract(contract, prompt) {
  const {
    _payload: _toolPayload,
    deferredManifest: _deferredManifest,
    ...toolContract
  } = contract;
  return {
    ...toolContract,
    promptSurfaceHash: prompt.hash,
    promptSurfaceBytes: prompt.bytes,
  };
}

export async function buildContractDigest(repoRoot = REPO_ROOT, options = {}) {
  const workflowId = String(options.workflow || 'headless').trim() || 'headless';
  const extraRoutes = Array.isArray(options.routes) ? options.routes : [];
  const routes = [
    {
      id: 'lead',
      provider: String(options.provider || '').trim(),
      model: String(options.model || '').trim(),
    },
    ...extraRoutes.map((route) => ({
      id: String(route?.id || '').trim(),
      provider: String(route?.provider || '').trim(),
      model: String(route?.model || '').trim(),
    })).filter((route) => route.id && route.id !== 'lead'),
  ];
  if (options.fallbackProvider || options.fallbackModel) {
    routes.push({
      id: 'leadFallback',
      provider: String(options.fallbackProvider || '').trim(),
      model: String(options.fallbackModel || '').trim(),
    });
  }
  const rules = rulesDigest(repoRoot);
  const routeContracts = {};
  const combinedToolPayloads = [];
  const combinedPromptPayloads = [];
  for (const route of routes) {
    const toolContract = await routeToolContract(repoRoot, route);
    const prompt = promptSurfaceDigest(repoRoot, workflowId, toolContract);
    routeContracts[route.id] = publicRouteContract(toolContract, prompt);
    combinedToolPayloads.push(`${route.id}\n${toolContract._payload}`);
    combinedPromptPayloads.push(`${route.id}\n${prompt._payload}`);
  }
  const primary = routeContracts.lead;
  const toolContractPayload = combinedToolPayloads.join('\n\0\n');
  const promptContractPayload = combinedPromptPayloads.join('\n\0\n');
  return {
    schemaVersion: 2,
    workflow: workflowId,
    disabledTools: [...BENCHMARK_DISABLED_TOOLS],
    rulesHash: rules.hash,
    rulesFiles: rules.files,
    rulesBytes: rules.bytes,
    promptSurfaceHash: sha256(promptContractPayload),
    promptSurfaceBytes: Buffer.byteLength(promptContractPayload),
    toolContractHash: sha256(toolContractPayload),
    toolContractBytes: Buffer.byteLength(toolContractPayload),
    routeContracts,
    // Primary-route aliases keep existing reports readable.
    toolCatalogHash: primary.toolCatalogHash,
    toolCount: primary.toolCatalogCount,
    toolSchemaBytes: primary.toolCatalogBytes,
    activeToolHash: primary.activeToolHash,
    activeToolCount: primary.activeToolCount,
    providerToolHash: primary.providerToolHash,
    providerToolCount: primary.providerToolCount,
    providerToolBytes: primary.providerToolBytes,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const rootIndex = process.argv.indexOf('--repo-root');
  const root = rootIndex >= 0 && process.argv[rootIndex + 1]
    ? resolve(process.argv[rootIndex + 1])
    : REPO_ROOT;
  const options = {
    provider: optionValue(process.argv, '--provider'),
    model: optionValue(process.argv, '--model'),
    workflow: optionValue(process.argv, '--workflow', 'headless'),
    fallbackProvider: optionValue(process.argv, '--fallback-provider'),
    fallbackModel: optionValue(process.argv, '--fallback-model'),
    routes: optionList(process.argv, '--route').map(parseRouteOption),
  };
  process.stdout.write(`${JSON.stringify(await buildContractDigest(root, options))}\n`);
}
