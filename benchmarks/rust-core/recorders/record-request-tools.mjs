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
const { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'request-tools');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-request-tools.mjs';
const U = (rel) => importFrom(tree, `src/${rel}`);
const { prepareProviderRequest } = await U('runtime/agent/orchestrator/session/loop/request-boundary.mjs');
const { snapshotProviderRequestTools } = await U('runtime/agent/orchestrator/runtime-core/tool-catalog.mjs');

const json = (value) => JSON.parse(JSON.stringify(value));
const doc = (name, description = `${name} tool`) => ({ name, description, inputSchema: { type: 'object', properties: {} } });
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

const fresh = (tools, names) => ({
  id: 'sess_request_tools',
  owner: 'agent',
  provider: 'openrouter',
  model: 'fixture-model',
  contextWindow: 1_000_000,
  tools: json(tools),
  ...(names ? { deferredMcpToolNames: names } : {}),
  messages: [{ role: 'system', content: 'System rules.' }, { role: 'user', content: 'current request' }],
});

// [name, session, [change...]]: a change is `{ tools?, names? }` (`names: null` removes the connected snapshot).
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
];
const CASES = [];
for (const [name, before, changes] of SCENARIOS) {
  const session = json(before);
  let fixed = null;
  const steps = [];
  for (const change of [{}, ...changes]) {
    if (change.tools) session.tools = json(change.tools);
    if ('names' in change) {
      if (change.names === null) delete session.deferredMcpToolNames;
      else session.deferredMcpToolNames = change.names;
    }
    const candidate = json(snapshotProviderRequestTools({ provider: session.provider, tools: session.tools, nativeTools: [], messages: session.messages, session }));
    const result = await request(session, fixed);
    fixed = result.fixedProviderToolSurface;
    steps.push({ tools: json(session.tools), names: session.deferredMcpToolNames ?? null, candidate, sent: json(result.sendTools) });
  }
  CASES.push({ name, steps });
}

writeJson(join(stage, 'golden.json'), { cases: CASES });
writeSetManifest(stage, { set: 'request-tools', recorder, command: `node ${recorder} --tree <tree>`, identityTree: tree });
commitStage(stage, finalDir);
console.log(`request tools: ${CASES.length} cases`);