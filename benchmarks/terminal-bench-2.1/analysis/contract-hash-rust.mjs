#!/usr/bin/env node
// Contract digests for a benchmark run, read from the Rust core (`mixdogd`): the K1 replacement of
// contract-hash.mjs, which loaded Node's provider request builders and tool schemas.
//
// A preset fingerprint pins the dataset, suite, and routes, never the prompt surface. These digests say
// which contract produced a report. Each route is a thread started the way `mixdogd exec` starts it
// (headless profile, web search on, memory off, no delegation); `tools/toolsStatus` with `snapshot` then
// returns what that thread's first send would put on the wire: the session's tool catalog and active
// tools, the request's system texts and tools, and the body the route's codec encodes. The hashes are of
// those, so they pin the request body the Rust provider crates (mixdog-ai) build. The digest has Node's
// shape plus `source: 'mixdogd'`; its hashes are the Rust core's own and are not comparable with a
// Node-sourced digest of the same route.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyAuthArtifacts, defaultUserDataDir } from '../../../scripts/lib/bench-sandbox.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const sha256 = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function markdownFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...markdownFiles(full));
    else if (entry.name.endsWith('.md')) found.push(full);
  }
  return found;
}

export function rulesDigest(repoRoot) {
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
  if (!match) throw new Error(`invalid --route ${value}; expected id=provider/model`);
  return { id: match[1], provider: match[2], model: match[3] };
}

/** The tools array of a request body, wherever the route's codec puts it (Gemini nests the request). */
export function wireTools(body) {
  if (!body || typeof body !== 'object') return [];
  const holder = Array.isArray(body.tools) ? body : body.request && Array.isArray(body.request.tools) ? body.request : body;
  return Array.isArray(holder.tools) ? holder.tools : [];
}

function providerToolCount(provider, tools) {
  if (String(provider || '').toLowerCase() === 'gemini') return tools?.[0]?.functionDeclarations?.length || 0;
  return Array.isArray(tools) ? tools.length : 0;
}

const names = (docs) => docs.map((tool) => String(tool?.name || ''));

/** One route's contract from the snapshot `tools/toolsStatus` returned for it. */
export function routeContractFromSnapshot(route, snapshot) {
  const catalog = snapshot.catalog || [];
  const activeTools = snapshot.active || [];
  const providerTools = wireTools(snapshot.body);
  const catalogPayload = JSON.stringify(catalog);
  const activePayload = JSON.stringify(activeTools);
  const providerPayload = JSON.stringify({ provider: route.provider, model: route.model, tools: providerTools });
  const prompt = (snapshot.system || []).join('\n\0\n');
  return {
    provider: route.provider,
    model: route.model,
    disabledTools: [...(snapshot.disallowedTools || [])],
    providerMode: snapshot.providerMode ?? undefined,
    toolCatalogHash: sha256(catalogPayload),
    toolCatalogCount: catalog.length,
    toolCatalogBytes: Buffer.byteLength(catalogPayload),
    toolCatalogNames: names(catalog).sort(),
    activeToolHash: sha256(activePayload),
    activeToolCount: activeTools.length,
    activeToolNames: names(activeTools).sort(),
    providerToolHash: sha256(providerPayload),
    providerToolCount: providerToolCount(route.provider, providerTools),
    providerToolBytes: Buffer.byteLength(providerPayload),
    promptSurfaceHash: sha256(prompt),
    promptSurfaceBytes: Buffer.byteLength(prompt),
    _toolPayload: JSON.stringify({ provider: route.provider, model: route.model, providerMode: snapshot.providerMode, catalog, activeTools, providerTools }),
    _promptPayload: prompt,
  };
}

/** The digest of `routes` (`[{ id, provider, model, snapshot }]`, the lead first), in contract-hash.mjs's shape. */
export function digestFromSnapshots(repoRoot, workflow, routes) {
  const rules = rulesDigest(repoRoot);
  const routeContracts = {};
  const toolPayloads = [];
  const promptPayloads = [];
  for (const route of routes) {
    const { _toolPayload, _promptPayload, ...contract } = routeContractFromSnapshot(route, route.snapshot);
    routeContracts[route.id] = contract;
    toolPayloads.push(`${route.id}\n${_toolPayload}`);
    promptPayloads.push(`${route.id}\n${_promptPayload}`);
  }
  const primary = routeContracts.lead;
  const toolContractPayload = toolPayloads.join('\n\0\n');
  const promptContractPayload = promptPayloads.join('\n\0\n');
  return {
    schemaVersion: 2,
    source: 'mixdogd',
    workflow,
    disabledTools: primary.disabledTools,
    rulesHash: rules.hash,
    rulesFiles: rules.files,
    rulesBytes: rules.bytes,
    promptSurfaceHash: sha256(promptContractPayload),
    promptSurfaceBytes: Buffer.byteLength(promptContractPayload),
    toolContractHash: sha256(toolContractPayload),
    toolContractBytes: Buffer.byteLength(toolContractPayload),
    routeContracts,
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

/** The `thread/start` params of `mixdogd exec` (exec/run.rs `thread_start_params`) with the harness's flags (`--web-search`). */
export function execThreadParams(route, cwd, workflow) {
  return {
    kind: 'task',
    projectPath: cwd,
    draft: { projectPath: cwd, route: { provider: route.provider, model: route.model }, workflowId: workflow, orchestrationMode: 'none' },
    session: { toolProfile: 'headless', toolMode: 'full', approvalMode: 'implicit', disallowDelegation: true, autoWakeCompletions: false, webSearch: true, memory: false },
  };
}

/** The snapshot of one route on a running core. */
export async function snapshotRoute(core, route, workflow) {
  const started = await core.call('thread/start', execThreadParams(route, core.paths.workspace, workflow));
  const threadId = started?.thread?.id;
  if (!threadId) throw new Error(`thread/start answered without a thread: ${JSON.stringify(started).slice(0, 300)}`);
  const status = await core.call('tools/toolsStatus', { threadId, snapshot: true });
  if (!status?.requestSnapshot) throw new Error(`tools/toolsStatus answered without requestSnapshot: ${JSON.stringify(status).slice(0, 300)}`);
  return status.requestSnapshot;
}

/** Starts an isolated core, and returns every route (the lead first) with the snapshot of its first send. */
export async function collectRouteSnapshots({ bin, workflow = 'headless', provider, model, routes = [], fallbackProvider = '', fallbackModel = '', authDir = defaultUserDataDir() }) {
  const all = [
    { id: 'lead', provider, model },
    ...routes.filter((route) => route.id && route.id !== 'lead'),
    ...(fallbackProvider || fallbackModel ? [{ id: 'leadFallback', provider: fallbackProvider, model: fallbackModel }] : []),
  ];
  const { startCore } = await import('../../../scripts/rust-core/lib/core-session.mjs');
  const root = mkdtempSync(join(tmpdir(), 'mixdog-tb-contract-'));
  let core;
  try {
    core = await startCore({
      bin,
      root,
      config: { outputStyle: 'simple', agent: { profile: { language: 'en' } } },
      prepare: (paths) => {
        for (const route of all) copyAuthArtifacts(authDir, paths.dataDir, route.provider);
      },
    });
    for (const route of all) route.snapshot = await snapshotRoute(core, route, workflow);
    return all;
  } finally {
    await core?.stop().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

export async function buildContractDigest({ repoRoot = REPO_ROOT, workflow = 'headless', ...options }) {
  return digestFromSnapshots(repoRoot, workflow, await collectRouteSnapshots({ workflow, ...options }));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv;
  const bin = optionValue(argv, '--mixdogd', process.env.MIXDOGD_BIN || '');
  if (!bin) throw new Error('pass --mixdogd <path to the mixdogd binary> or set MIXDOGD_BIN');
  const digest = await buildContractDigest({
    bin: resolve(bin),
    provider: optionValue(argv, '--provider'),
    model: optionValue(argv, '--model'),
    workflow: optionValue(argv, '--workflow', 'headless'),
    fallbackProvider: optionValue(argv, '--fallback-provider'),
    fallbackModel: optionValue(argv, '--fallback-model'),
    routes: optionList(argv, '--route').map(parseRouteOption),
    authDir: optionValue(argv, '--auth-dir', defaultUserDataDir()),
    repoRoot: optionValue(argv, '--repo-root') ? resolve(optionValue(argv, '--repo-root')) : REPO_ROOT,
  });
  process.stdout.write(`${JSON.stringify(digest)}\n`);
}
