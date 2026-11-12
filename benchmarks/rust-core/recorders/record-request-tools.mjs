// Records Node's request-tool adoption (`session/loop/request-boundary.mjs`: `prepareProviderRequest` with its
// `adoptDynamicToolChanges`): the first request freezes the tool surface; later requests keep its eager prefix and
// adopt additions, schema updates and removals of MCP (`mcp__`) definitions. Each case holds the session's tools and
// connected names per request, the candidate snapshot (`snapshotProviderRequestTools`) and the surface sent.
//
//   node benchmarks/rust-core/recorders/record-request-tools.mjs --tree <dir with node_modules>
//
// Output: native/core/fixtures/request-tools/golden.json.
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Import-time sweeps delete real user data: every user dir is a fresh temp dir first.
const sandbox = mkdtempSync(join(tmpdir(), 'request-tools-'));
for (const key of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[key] = join(sandbox, key.toLowerCase());
  mkdirSync(process.env[key], { recursive: true });
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
process.env.TZ = 'UTC';
const { FIXTURES_ROOT, commitStage, importFrom, nodeTreeIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');

const { nodeRealTool, writeJsonCompact } = await import('./lib/tool-definitions.mjs');
// --patch <file>[,<file>…]: the tree is the reference commit with those Node changes applied; the manifest names them.
const BASE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const args = parseArgs();
const tree = resolveTree(args);
const patched = args.get('patch');
const finalDir = join(FIXTURES_ROOT, 'request-tools');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-request-tools.mjs';
const U = (rel) => importFrom(tree, `src/${rel}`);
const { prepareProviderRequest } = await U('runtime/agent/orchestrator/session/loop/request-boundary.mjs');
const { snapshotProviderRequestTools } = await U('runtime/agent/orchestrator/runtime-core/tool-catalog.mjs');

const json = (value) => JSON.parse(JSON.stringify(value));
// The runtime's own tools are the product's definitions (`description` overrides one where a case needs a changed
// definition); a connected server's tools (`mcp__`) are the recorder's inputs.
const real = await nodeRealTool(tree);
const doc = (name, description = `${name} tool`) =>
  name.startsWith('mcp__') ? { name, description, inputSchema: { type: 'object', properties: {} } } : { ...real(name), ...(description === `${name} tool` ? {} : { description }) };
const read = doc('read');
const shell = doc('shell');
const alpha = doc('mcp__alpha__list', 'List the things.');
const alphaGet = doc('mcp__alpha__get', 'Get one thing.');
const beta = doc('mcp__beta__ping', 'Ping beta.');

// One request of a session: `change` edits the session first (tools, connected names), as a turn's reconcile does.
const request = (session, fixed) =>
  prepareProviderRequest({
    provider: session.provider,
    messages: session.messages,
    model: session.model,
    baseSendTools: session.tools,
    sessionRef: session,
    sessionId: session.id,
    cwd: process.cwd(),
    opts: {},
    signal: null,
    crossTurnCalls: new Map(),
    loopUsageMetricsTurnId: () => 'turn',
    loopUsageMetricsEpoch: () => 0,
    iterations: 1,
    lastUsage: null,
    firstTurnUsage: null,
    providerState: null,
    reactiveOverflowRetryPending: false,
    fixedProviderToolSurface: fixed,
  });

const referenced = (provider, toolReferences) => ({ role: 'tool', toolCallId: `call_${toolReferences[0]}`, content: 'ok', nativeToolSearch: { provider, toolReferences } });
const NATIVE = {
  provider: 'anthropic-oauth',
  deferredNativeTools: true,
  deferredProviderMode: 'native',
  deferredToolCatalog: [doc('office'), doc('memory'), doc('github'), doc('mcp__alpha__get', 'Get one thing.')],
  deferredLateToolCatalog: [],
};
const fresh = (tools, names, extra = {}) => ({
  id: 'sess_request_tools',
  owner: 'agent',
  provider: 'openrouter',
  model: 'fixture-model',
  contextWindow: 1_000_000,
  tools: json(tools),
  ...(names ? { deferredMcpToolNames: names } : {}),
  ...extra,
  messages: [{ role: 'system', content: 'System rules.' }, { role: 'user', content: 'current request' }],
});

// [name, session, [change...]]: a change is `{ tools?, names?, ...fields }` (`names: null` removes the connected snapshot;
// the other fields are assigned onto the session).
const SCENARIOS = [
  ['an unchanged session keeps its surface', fresh([read, shell, alpha], ['mcp__alpha__list']), [{}, {}]],
  ['a changed MCP schema replaces the definition in place', fresh([read, alpha, shell, beta], ['mcp__alpha__list', 'mcp__beta__ping']), [{ tools: [read, { ...alpha, description: 'Fresher.' }, shell, beta] }]],
  ['a disconnected MCP tool leaves the surface', fresh([read, alpha, shell, beta], ['mcp__alpha__list', 'mcp__beta__ping']), [{ names: ['mcp__beta__ping'] }, { names: [] }]],
  ['a new MCP tool is appended after the surface', fresh([read, alpha, shell], ['mcp__alpha__list']), [{ tools: [read, alpha, shell, alphaGet, beta], names: ['mcp__alpha__list', 'mcp__alpha__get', 'mcp__beta__ping'] }]],
  ['an eager tool change is not adopted', fresh([read, shell, alpha], ['mcp__alpha__list']), [{ tools: [{ ...read, description: 'Changed.' }, shell, alpha] }, { tools: [read, shell, alpha, doc('web_search')] }]],
  ['a reordered session keeps the sent order', fresh([read, alpha, shell, beta], ['mcp__alpha__list', 'mcp__beta__ping']), [{ tools: [beta, shell, alpha, read] }]],
  ['a removed and a re-added tool take the end', fresh([read, alpha, shell, beta], ['mcp__alpha__list', 'mcp__beta__ping']), [{ names: ['mcp__beta__ping'] }, { names: ['mcp__alpha__list', 'mcp__beta__ping'] }]],
  ['without a connected snapshot every MCP tool is available', fresh([read, alpha, beta]), [{ tools: [read, alpha, beta, alphaGet] }, { names: ['mcp__beta__ping'] }]],
  ['a name listed twice is sent once, the first definition', fresh([read, alpha, { ...alpha, description: 'Twin.' }, shell], ['mcp__alpha__list']), [{ tools: [read, shell, { ...alpha, description: 'Twin first.' }, alpha] }]],
  ['everything changes at once', fresh([read, alpha, shell, beta], ['mcp__alpha__list', 'mcp__beta__ping']), [{ tools: [shell, doc('mcp__gamma__run'), { ...beta, description: 'New beta.' }, read], names: ['mcp__gamma__run', 'mcp__beta__ping'] }]],
  ['a deferred catalog tool joins a native session once it is discovered', fresh([read, shell, alpha], ['mcp__alpha__list'], NATIVE), [{ deferredDiscoveredTools: ['office'] }, { deferredDiscoveredTools: ['office', 'mcp__alpha__get', 'ghost'] }, { deferredDiscoveredTools: [] }], 'snapshot'],
  ['a tool the transcript referenced joins a native session', fresh([read, shell], null, NATIVE), [{ messages: [...fresh([]).messages, referenced('anthropic-oauth', ['memory'])] }, { messages: [...fresh([]).messages, referenced('openai', ['memory']), referenced('anthropic', ['github'])] }], 'snapshot'],
  ['the anchor keeps tool-search mode in a native session without a discovery', fresh([read, shell, alpha], ['mcp__alpha__list'], { ...NATIVE, deferredToolCatalog: [alphaGet, doc('office'), doc('memory')] }), [{}, { deferredToolCatalog: [alphaGet] }, { tools: [read, doc('office'), alpha] }], 'snapshot'],
  ['a native session on a gateway route or off Anthropic adds nothing', fresh([read, shell], null, { ...NATIVE, deferredDiscoveredTools: ['office'] }), [{ provider: 'openai' }, { provider: 'openrouter', wireRoute: { family: 'anthropic' } }, { provider: 'anthropic', deferredNativeTools: false }], 'snapshot'],
  ['the late catalog supplies a discovered tool and a later entry wins', fresh([read, shell], null, { ...NATIVE, deferredDiscoveredTools: ['office', 'github'] }), [{ deferredLateToolCatalog: [doc('office', 'Late office.'), doc('github')] }], 'snapshot'],
];
const CASES = [];
for (const [name, before, changes, only] of SCENARIOS) {
  const session = json(before);
  let fixed = null;
  const steps = [];
  for (const change of [{}, ...changes]) {
    const { tools: changedTools, names: changedNames, ...fields } = change;
    Object.assign(session, json(fields));
    if (changedTools) session.tools = json(changedTools);
    if ('names' in change) {
      if (change.names === null) delete session.deferredMcpToolNames;
      else session.deferredMcpToolNames = change.names;
    }
    const candidate = json(snapshotProviderRequestTools({ provider: session.provider, tools: session.tools, nativeTools: [], messages: session.messages, session }));
    // A `snapshot` scenario asks for the candidate alone: a request boundary would also migrate and refresh the session.
    const result = only === 'snapshot' ? null : await request(session, fixed);
    fixed = result ? result.fixedProviderToolSurface : null;
    const { tools: _tools, messages: _messages, ...header } = json(session);
    steps.push({ header, messages: json(session.messages), tools: json(session.tools), names: session.deferredMcpToolNames ?? null, candidate, sent: result ? json(result.sendTools) : null });
  }
  CASES.push({ name, steps });
}

await writeJsonCompact(tree, join(stage, 'golden.json'), { cases: CASES });
writeSetManifest(stage, { set: 'request-tools', recorder, command: `node ${recorder} --tree <tree>` + (patched ? ` --patch ${patched}` : ''), ...(patched ? { identity: nodeTreeIdentity(args, tree, BASE_COMMIT) } : { identityTree: tree }) });
commitStage(stage, finalDir);
console.log(`request tools: ${CASES.length} cases`);
