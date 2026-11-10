#!/usr/bin/env node
// What a model's `call_tool` does on a bridge session, through Node's real loop: a real `askSession` turn (the loop, the tool batch,
// `resolveExecutionToolCalls`, the pre-dispatch deny, `executeTool`, the PreToolUse ask, `resolvePreToolAskApproval`) over a bridge
// session (`toolExposureMode: 'bridge-v1'`, built by `applyDeferredToolSurface` on a non-native provider, as the session runtime
// builds a Lead's), against a scripted provider whose `send` returns the scenario's replies. The deferred tools are the session's own
// scoped internal tools and one connected MCP server; their executors only record what they were called with.
//
// What is recorded per scenario is everything a client or the model can observe: the tool list and the deferred catalog the session
// holds, the tool events the loop raises (`onToolCall` with the wire calls, `onToolResult`), the cards the approval hook is shown, the
// PreToolUse / PostToolUse hook calls, what the executors were called with, the messages the model is sent at each request (its own
// wire calls and the results), and the stored transcript at the end.
//
//   node benchmarks/rust-core/recorders/record-call-tool.mjs --tree <exact export of b6f10295a with node_modules>
//   node benchmarks/rust-core/recorders/record-call-tool.mjs --tree <...> --only <name fragment>
//
// Output: native/core/fixtures/call-tool/golden.json (+ MANIFEST.json). The `script` of each scenario is the recorder's input.
// A whole recording records every scenario twice, each time in a process and a sandbox of its own (`--raw <file>`, the raw recording),
// and keeps the first only if the two differ in nothing but what the declared normalisations replace, each normalisation shown needed by
// a field that differed (`compareRuns`); the manifest lists those fields. `--only` records the scenarios whose name holds the fragment once
// and puts them into golden.json in their place, leaving the others and the manifest as they were (for working on one scenario).
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { endSandbox } from './sandbox-janitor.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-call-tool.mjs';

const argOf = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? null : process.argv[at + 1];
};
const RAW_OUT = argOf('raw');
const ONLY = argOf('only');
// Every sandbox of a recording lives in this one folder. The run a person starts empties it first: a sandbox a failed run could not
// remove (a process still holding it) stays here until then, and that run's failure names it.
const SANDBOX_ROOT = join(process.env.MIXDOG_RECORDER_SCRATCH ?? tmpdir(), 'rec-call-tool');
if (!RAW_OUT) {
  try {
    rmSync(SANDBOX_ROOT, { recursive: true, force: true });
  } catch (error) {
    throw new Error(`cannot remove ${SANDBOX_ROOT}, which an earlier recording left (a process may still hold it): ${error.message}`);
  }
  mkdirSync(SANDBOX_ROOT, { recursive: true });
}

// ---- what may differ between two recordings of the same turns ----------------------------------------------------------------
// The run itself, never behaviour: each such value is replaced by a fixed placeholder, every rule is declared in the manifest
// (`normalisations`), and `compareRuns` shows each one needed by the fields that differed between two raw runs.
const SANDBOX_PLACEHOLDER = '<SANDBOX>';
const CLOCK_KEYS = new Set([
  'createdAt', 'ts', 'at', 'elapsedMs', 'duration', 'tool_ms', 'started_at_ms', 'completed_at_ms', 'requestMs',
  'dispatchStartedAt', 'executionStartedAt', 'executionCompletedAt', 'postprocessStartedAt', 'resultCompletedAt',
  'dispatch_wait_ms', 'execution_ms', 'result_collection_wait_ms', 'postprocess_ms', 'total_ms',
]);
// Ids the run generates: each becomes `<PREFIX-n>`, n by first appearance within the scenario.
const ID_PREFIX = { batch_id: 'BATCH', messageId: 'MESSAGE' };
const BATCH_ID_KEYS = new Set(Object.keys(ID_PREFIX));
const sandboxForms = (sandbox) => [sandbox, sandbox.replaceAll('\\', '/')];
const withoutSandbox = (text, sandbox) => sandboxForms(sandbox).reduce((out, form) => out.replaceAll(form, SANDBOX_PLACEHOLDER), text);
function normalised(golden, sandbox) {
  let batchIds = new Map();
  const walk = (value, key) => {
    if (typeof value === 'string') {
      if (BATCH_ID_KEYS.has(key)) {
        const seen = [...batchIds.keys()].filter((id) => batchIds.get(id).startsWith(`<${ID_PREFIX[key]}-`)).length;
        if (!batchIds.has(value)) batchIds.set(value, `<${ID_PREFIX[key]}-${seen + 1}>`);
        return batchIds.get(value);
      }
      return withoutSandbox(value, sandbox);
    }
    if (typeof value === 'number' && CLOCK_KEYS.has(key)) return 0;
    if (Array.isArray(value)) return value.map((item) => walk(item, key));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]));
    return value;
  };
  // A batch id is unique to its turn: the numbering restarts with each scenario (a row and the tool rows of its calls share one).
  return { ...golden, scenarios: golden.scenarios.map((scenario) => ((batchIds = new Map()), walk(scenario, ''))) };
}

/** Two raw runs, leaf by leaf: every difference must be one a declared normalisation replaces, and every declared rule must have
 *  replaced a difference (by key). Returns, per normalisation, the keys whose values differed; throws naming the first offenders. */
function compareRuns(a, b) {
  const differed = { sandboxPath: new Set(), clockValues: new Set(), batchIds: new Set() };
  const undeclared = [];
  const walk = (x, y, key, path) => {
    if (Array.isArray(x) || Array.isArray(y)) {
      if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) return void undeclared.push(`${path}: ${JSON.stringify(x)?.slice(0, 200)} / ${JSON.stringify(y)?.slice(0, 200)}`);
      return void x.forEach((item, i) => walk(item, y[i], key, `${path}[${i}]`));
    }
    if (x && y && typeof x === 'object' && typeof y === 'object') {
      if (Object.keys(x).join('\u0000') !== Object.keys(y).join('\u0000')) return void undeclared.push(`${path}: keys ${Object.keys(x)} / ${Object.keys(y)}`);
      return void Object.keys(x).forEach((k) => walk(x[k], y[k], k, `${path}.${k}`));
    }
    if (x === y) return;
    if (typeof x === 'string' && typeof y === 'string') {
      if (BATCH_ID_KEYS.has(key)) return void differed.batchIds.add(key);
      if (withoutSandbox(x, a.sandbox) === withoutSandbox(y, b.sandbox)) return void differed.sandboxPath.add(key);
    }
    if (typeof x === 'number' && typeof y === 'number' && CLOCK_KEYS.has(key)) return void differed.clockValues.add(key);
    undeclared.push(`${path}: ${JSON.stringify(x)?.slice(0, 200)} / ${JSON.stringify(y)?.slice(0, 200)}`);
  };
  walk(a.golden, b.golden, '', '');
  // Every rule must have replaced a difference. A key of a rule need not differ in every pair of runs: a measured duration of a few
  // milliseconds can come out the same twice (`postprocess_ms` did once in four pairs); the keys that did differ are printed.
  const wider = [
    ...(differed.clockValues.size ? [] : ['clockValues: no clock value differed']),
    ...(differed.batchIds.size ? [] : ['batchIds: no generated id differed']),
    ...(differed.sandboxPath.size ? [] : ['sandboxPath: no value held the sandbox']),
  ];
  if (undeclared.length || wider.length) {
    throw new Error(
      [
        ...(undeclared.length ? [`${undeclared.length} difference(s) between the two runs that no normalisation declares:`, ...undeclared.slice(0, 20)] : []),
        ...(wider.length ? ['normalisations no difference between the two runs needed:', ...wider] : []),
      ].join('\n')
    );
  }
  const left = JSON.stringify(normalised(a.golden, a.sandbox));
  if (left !== JSON.stringify(normalised(b.golden, b.sandbox))) throw new Error('the two runs differ after their normalisation');
  return Object.fromEntries(Object.entries(differed).map(([rule, keys]) => [rule, [...keys].sort()]));
}

// ---- a whole recording: two raw runs, compared, the first kept ---------------------------------------------------------------
if (!RAW_OUT && !ONLY) {
  const { FIXTURES_ROOT, commitStage, exactProductIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
  const args = parseArgs();
  const tree = resolveTree(args);
  const identity = exactProductIdentity(tree, NODE_COMMIT);
  const runs = [];
  const raws = [1, 2].map((n) => join(SANDBOX_ROOT, `raw-${n}.json`));
  let evidence;
  // The raw recordings are the run's own: they go whatever happens; a run's sandbox goes with that run (its janitor).
  try {
  for (const [index, out] of raws.entries()) {
    const n = index + 1;
    // One recording takes a few minutes; a run that is not over in 20 is the failure, and its janitor (the pipe's end) ends its sandbox.
    const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--tree', tree, '--raw', out], { stdio: 'inherit', timeout: 20 * 60_000, windowsHide: true });
    if (run.error || run.status !== 0) throw new Error(`raw run ${n} failed (${run.error?.message ?? `exit ${run.status}`}); what it left is under ${SANDBOX_ROOT}`);
    runs.push(JSON.parse(readFileSync(out, 'utf8')));
  }
  evidence = compareRuns(runs[0], runs[1]);
  } finally {
    for (const raw of raws) rmSync(raw, { force: true });
  }
  const [{ golden, sandbox }] = runs;
  const finalDir = join(FIXTURES_ROOT, 'call-tool');
  const stage = stageSet(finalDir);
  writeJson(join(stage, 'golden.json'), normalised(golden, sandbox));
  writeSetManifest(stage, {
    set: 'call-tool',
    recorder,
    command: `node ${recorder} --tree <exact export of ${NODE_COMMIT}>`,
    identity,
    extra: {
      scenarios: golden.scenarios.length,
      recorderSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
      nodeRuntime: process.version,
      ...runs[0].described,
      normalisations: {
        // Each rule covers one class of value; a key of the class need not differ in every pair of runs (a duration of a few ms can
        // come out the same twice), the rule must.
        classes: {
          sandboxPath: 'where the run lives: the per-run sandbox folder',
          clockValues: 'when the run happened: wall-clock instants and measured durations, in ms',
          batchIds: 'what the run generated: ids a run draws fresh',
        },
        sandboxPath: `the recorder's sandbox folder (and its forward-slash form), in every string, becomes ${SANDBOX_PLACEHOLDER}`,
        clockValues: `numbers under these keys become 0: ${[...CLOCK_KEYS].join(', ')}`,
        // The same keys as data, so a replay applies the very rule to what it compares.
        clockKeys: [...CLOCK_KEYS],
        batchIds: "generated ids: the batch_id of a trace row (and inside a tool row's payload.batch) becomes <BATCH-n>, and a stored row's meta.transcript.messageId becomes <MESSAGE-n>, n by first appearance of each kind within the scenario",
        keptWhole: 'everything else: system messages, stored and requested messages, events, cards, hooks, executed calls, the timeline, the human gate\'s audit records and every trace row of the session',
      },
      // `compareRuns` (the keys that differed in this recording's pair are printed by the run, not kept: they vary with timing).
      twoRunCheck: 'the recording was made twice, each run in a process and a sandbox of its own; nothing differed between the two but values the rules above replace, every rule replaced a difference, and the two normalised runs were the same bytes',
    },
  });
  commitStage(stage, finalDir);
  rmSync(SANDBOX_ROOT, { recursive: true, force: true });
  console.log(`scenarios=${golden.scenarios.length}; differed: ${JSON.stringify(evidence)}`);
  process.exit(0);
}

const sandbox = mkdtempSync(join(SANDBOX_ROOT, 'run-'));
for (const name of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[name] = join(sandbox, name.toLowerCase());
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
process.env.MIXDOG_AGENT_TRACE_DISABLE = '';
process.env.MIXDOG_AGENT_TRACE_LOCAL_DISABLE = '';
process.env.MIXDOG_AGENT_TRACE_PATH = join(sandbox, 'agent-trace.jsonl');
process.env.MIXDOG_RUNTIME_ROOT = join(sandbox, 'no-service');
mkdirSync(join(process.env.MIXDOG_DATA_DIR, 'history'), { recursive: true });

// What this recording leaves behind is ended by ownership, never through a pid found in a listing:
//   (a) the Node product's own stop: the daemon's PostgreSQL stop (`createDaemonPgStop`, standalone/daemon-pg-stop.mjs, which runs
//       `shutdownOwnedPg`), awaited under a deadline, below in `finishSandbox`;
//   (b) a cluster still running for the profile: `pg_ctl stop -m fast -D <the profile's data directory>` (sandbox-janitor.mjs `endSandbox`);
//   (c) what this recorder spawned, through the ChildProcess it holds: the janitor, below.
// The profile folder is then removed, after a failure too. A process that still names the profile is not killed: the run fails naming
// it, and the folder, which cannot go while that process holds it, stays under SANDBOX_ROOT until the next run empties that.
// The janitor is a detached process holding the other end of a pipe: the pipe reaches end-of-file when this process dies by any means,
// which makes it run (b) and the removal for a recording that could run nothing.
const janitor = spawn(process.execPath, [fileURLToPath(new URL('./sandbox-janitor.mjs', import.meta.url))], {
  env: { ...process.env, REC_SANDBOX: sandbox },
  detached: true,
  stdio: ['pipe', 'ignore', 'inherit'],
  windowsHide: true,
});
janitor.unref();
janitor.stdin.unref();
janitor.stdin.on('error', () => {});

const withDeadline = (promise, label, ms) => {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: not done after ${ms} ms`)), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
};
let productStop = null;
let sandboxEnded = false;
async function finishSandbox() {
  if (sandboxEnded) return;
  sandboxEnded = true;
  const failures = [];
  if (productStop) {
    try {
      await withDeadline(productStop(), "the Node product's PostgreSQL stop", 60_000);
    } catch (error) {
      failures.push(error.message);
    }
  }
  failures.push(...endSandbox(sandbox));
  for (const failure of failures) console.error(failure);
  if (failures.length) process.exitCode = 1;
  janitor.stdin.end();
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(signal, () => {
    void finishSandbox().finally(() => process.exit(130));
  });
}
// The rest of the recorder runs inside this block (not indented, to keep the recording's text as it was): a failure anywhere in it
// ends the sandbox the same way a normal end does.
try {
const { FIXTURES_ROOT, commitStage, exactProductIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
const tree = resolveTree(parseArgs());
const identity = exactProductIdentity(tree, NODE_COMMIT);
const imp = (rel) => import(pathToFileURL(join(tree, rel)).href);
{
  const { createDaemonPgStop } = await imp('src/standalone/daemon-pg-stop.mjs');
  productStop = () => createDaemonPgStop({ log: (message) => console.log(`[product stop] ${message}`), stopTimeoutMs: 20_000 }).finish();
}
const S = 'src/runtime/agent/orchestrator/';

// ---- the event loop the scenarios run on ----------------------------------------------------------------------------------------
// Every step a script controls (a hook, an executor, an approval card) takes one macrotask, so the microtask chains of all calls drain
// between two steps and the order of a batch's observable events is the order of the steps, whatever depth Node's own awaits have.
const macrotask = () => new Promise((resolve) => setImmediate(resolve));

// The approval path of an `ask` also touches files: it reads the grants file (human-gate/gate.mjs:288 `allowanceForHookAsk` ->
// store.mjs:59 `readGrants` -> shared/atomic-file.mjs:553 `readFileAsync`) and appends to the audit file after the answer
// (human-gate/gate.mjs:402 `recordAudit` -> store.mjs `appendFile`). Real asynchronous file I/O of two concurrent calls finishes in an
// order nothing controls, so each of the two is replaced by the same operation done synchronously after one macrotask: the position of a
// call in the event loop is then the script's, and a scenario can hold one (`gates`, stages `grants` and `audit`).
let fileStep = async () => {};
{
  const fsp = (await import('node:fs/promises')).default;
  const fsSync = await import('node:fs');
  const { syncBuiltinESMExports } = await import('node:module');
  const kindOf = (path) => (String(path).endsWith('grants.json') ? 'grants' : String(path).endsWith('audit.jsonl') ? 'audit' : null);
  const real = { readFile: fsp.readFile, appendFile: fsp.appendFile, mkdir: fsp.mkdir };
  fsp.readFile = async (path, ...rest) => {
    const kind = kindOf(path);
    if (!kind) return real.readFile(path, ...rest);
    await fileStep(kind);
    return fsSync.readFileSync(path, ...rest);
  };
  fsp.appendFile = async (path, ...rest) => {
    const kind = kindOf(path);
    if (!kind) return real.appendFile(path, ...rest);
    await fileStep(kind);
    return fsSync.appendFileSync(path, ...rest);
  };
  fsp.mkdir = async (path, ...rest) => (String(path).endsWith('human-gate') ? fsSync.mkdirSync(path, ...rest) : real.mkdir(path, ...rest));
  syncBuiltinESMExports();
}
const { createSession } = await imp(`${S}session/manager/session-lifecycle.mjs`);
const { askSession } = await imp(`${S}session/manager/ask-session.mjs`);
const { abortSessionTurn } = await imp(`${S}session/manager/session-close.mjs`);
const { loadSession, deleteSession, drainSessionStore } = await imp(`${S}session/store.mjs`);
const { drainAgentTrace } = await imp(`${S}agent-trace-io.mjs`);
const { humanGateStore } = await imp(`${S}session/human-gate/store.mjs`);
const { _withRegisteredProviderForTestAsync } = await imp(`${S}providers/registry.mjs`);
const { setInternalToolsProvider } = await imp(`${S}internal-tools.mjs`);
const { _registerMcpServerForTest, disconnectAll } = await imp(`${S}mcp/client.mjs`);
const { applyDeferredToolSurface, refreshDeferredMcpToolCatalog, renderToolSearch } = await imp(`${S}runtime-core/tool-catalog.mjs`);
// The product's own `goal` tool, as the session runtime wires it (session-runtime/boot/tools.mjs `wireGoalRuntime`,
// internal-tool-executor/workspace-tools.mjs:341): the scenarios that a built core can run too (`live`) call it.
const { createGoalRuntime, GOAL_TOOL_DEFS } = await imp(`${S}runtime-core/goal-runtime.mjs`);
const goalRuntime = createGoalRuntime({ dataDir: process.env.MIXDOG_DATA_DIR });
const { pickDoneVerb } = await imp('src/tui/session/labels.mjs');

const clone = (value) => JSON.parse(JSON.stringify(value));
// What a host callback was handed, as JSON (`undefined` kept as null, a function as its name).
const cloneable = (value) => JSON.parse(JSON.stringify(value ?? null, (_, v) => (typeof v === 'function' ? `[function ${v.name}]` : v === undefined ? null : v)));
const LOOP_CALLBACKS = [
  'onTextDelta', 'onTextReset', 'onReasoningDelta', 'onAssistantText', 'onAssistantMessageCommitted', 'onAssistantToolCallObserved',
  'onStreamItemStart', 'onProviderSendStarted', 'onToolPhaseStarted', 'onToolPhaseCompleted', 'onUsageDelta', 'onCompactEvent',
  'onContextPressure', 'onSteerMessage', 'onSkillsApplied', 'onStageChange', 'onStreamDelta',
];
const workdir = join(sandbox, 'work');
mkdirSync(workdir, { recursive: true });
writeFileSync(join(workdir, 'x.txt'), 'FILE-SENTINEL\n');

// ---- the session's tools ------------------------------------------------------------------------------------------------------
// Deferred tools of the session: two plain ones (one read-only), one the session denies, and a connector's. Each answers with what it was called with.
const PROBE_TOOLS = [
  { name: 'probe_read', description: 'Reads a probe.', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, annotations: { readOnlyHint: true, idempotentHint: true } },
  { name: 'probe_write', description: 'Writes a probe.', inputSchema: { type: 'object', properties: { q: { type: 'string' }, n: { type: 'number' } } } },
  { name: 'probe_denied', description: 'A probe the session denies.', inputSchema: { type: 'object', properties: {} } },
];
const MCP_TOOLS = [
  { name: 'send', description: 'Sends a mail.', inputSchema: { type: 'object', properties: { to: { type: 'string' } } } },
  { name: 'gone', description: 'A tool the server no longer lists.', inputSchema: { type: 'object', properties: {} } },
];

const HOOK_ASK = 'needs approval';
const call = (id, name, args) => ({ id, name, arguments: args });
const bridged = (id, name, args) => call(id, 'call_tool', { name, arguments: args });
const round = (...calls) => ({ calls });
const FINAL = { text: 'all done' };
// The usage every completed reply reports, with the prompt figure a real adapter always gives (`promptTokens`).
const USAGE = { inputTokens: 1, outputTokens: 1, promptTokens: 1 };

const SCENARIOS = [
  { name: 'a deferred tool is described with load_tool, then run through call_tool', script: [round(call('c1', 'load_tool', { names: ['probe_write'] })), round(bridged('c2', 'probe_write', { q: 'x', n: 1 })), FINAL] },
  { name: 'a deferred tool is run through call_tool without load_tool', script: [round(bridged('c1', 'probe_write', { q: 'x' })), FINAL] },
  { name: 'a loaded deferred tool called directly', script: [round(call('c1', 'load_tool', { names: ['probe_write'] })), round(call('c2', 'probe_write', { q: 'x' })), FINAL] },
  { name: 'a deferred tool called directly without load_tool', script: [round(call('c1', 'probe_write', { q: 'x' })), FINAL] },
  { name: 'a read-only deferred tool through call_tool, twice in one turn and again in the next', script: [round(bridged('c1', 'probe_read', { q: 'a' }), bridged('c2', 'probe_read', { q: 'a' }), bridged('c3', 'probe_read', { q: 'b' })), round(bridged('c4', 'probe_read', { q: 'a' })), FINAL] },
  { name: 'a deferred tool matched case-blind and with spaces', script: [round(bridged('c1', ' PROBE_WRITE ', { q: 'x' })), FINAL] },
  {
    name: 'every refusal of call_tool in one batch',
    session: { disallowedTools: ['probe_denied'] },
    script: [
      round(
        bridged('c1', 'no_such_tool', {}),
        bridged('c2', 'call_tool', { name: 'probe_write', arguments: {} }),
        bridged('c3', 'load_tool', { names: ['probe_write'] }),
        bridged('c4', 'read', { path: 'x.txt' }),
        bridged('c5', 'probe_denied', {}),
        bridged('c6', '', {}),
        bridged('c7', 'x'.repeat(200), {}),
        call('c8', 'call_tool', { name: 'probe_write', arguments: 'q=1' }),
        call('c9', 'call_tool', { name: 'probe_write' }),
        call('c10', 'call_tool', { name: 'probe_write', arguments: {}, extra: 1, more: 2 }),
        call('c11', 'call_tool', 'probe_write'),
        call('c12', 'call_tool', { arguments: {} }),
        call('c13', 'call_tool', { name: 7, arguments: {} }),
        call('c14', 'call_tool', { name: 'probe_write', arguments: [] }),
        call('c15', 'call_tool', null)
      ),
      FINAL,
    ],
  },
  { name: 'the same refusals twice and then a third time: the repeat guard', script: [round(bridged('c1', 'no_such_tool', {})), round(bridged('c2', 'no_such_tool', {})), round(bridged('c3', 'no_such_tool', {})), round(bridged('c4', 'no_such_tool', {})), FINAL] },
  { name: 'an MCP tool of a connected server through call_tool', mcp: true, script: [round(bridged('c1', 'mcp__mail__send', { to: 'a@b.c' })), FINAL] },
  { name: 'an MCP tool the server no longer lists, and one it never listed', mcp: true, script: [round(bridged('c1', 'mcp__mail__gone', {}), bridged('c2', 'mcp__mail__nope', {})), FINAL] },
  { name: 'a target that needs approval, approved', ask: ['probe_write'], answers: [{ approved: true }], script: [round(bridged('c1', 'probe_write', { q: 'x' })), FINAL] },
  { name: 'a target that needs approval, denied with a reason', ask: ['probe_write'], answers: [{ approved: false, reason: 'not now' }], script: [round(bridged('c1', 'probe_write', { q: 'x' })), FINAL] },
  { name: 'a target that needs approval, called directly', ask: ['probe_write'], answers: [{ approved: true }], script: [round(call('c1', 'probe_write', { q: 'x' })), FINAL] },
  { name: 'call_tool itself is never asked about', ask: ['call_tool'], answers: [], script: [round(bridged('c1', 'probe_write', { q: 'x' })), FINAL] },
  { name: 'an MCP target that needs approval, approved', mcp: true, ask: ['mcp__mail__send'], answers: [{ approved: true }], script: [round(bridged('c1', 'mcp__mail__send', { to: 'a@b.c' })), FINAL] },
  // Two cards in one batch are not recorded: Node serves them concurrently and two recordings of the same turn interleave them differently. One card is stable.
  { name: 'a mix: an approval, a refusal and a plain run in one batch', ask: ['probe_write'], answers: [{ approved: true }], script: [round(bridged('c1', 'probe_write', { q: '1' }), bridged('c2', 'nope', {}), bridged('c3', 'probe_read', { q: 'r' })), FINAL] },
  { name: 'a session that denies a tool', session: { disallowedTools: ['probe_write'] }, script: [round(bridged('c1', 'probe_write', { q: 'x' }), call('c2', 'probe_write', { q: 'x' }), bridged('c3', 'probe_read', {})), FINAL] },
  { name: 'a session whose settings closed a tool', session: { featureDeniedTools: ['probe_write'], disallowedTools: ['probe_write'] }, script: [round(call('c1', 'probe_write', { q: 'x' }), bridged('c2', 'probe_write', {})), FINAL] },
  { name: 'a session with a schema allowlist', session: { schemaAllowedTools: ['read', 'load_tool', 'call_tool', 'probe_read'] }, script: [round(call('c1', 'load_tool', { names: ['probe_write'] }), bridged('c2', 'probe_write', {}), bridged('c3', 'probe_read', {}), call('c4', 'probe_write', {})), FINAL] },
  { name: 'a read-only session', session: { toolSpec: 'readonly' }, script: [round(call('c1', 'load_tool', { names: ['probe_write', 'probe_read'] }), bridged('c2', 'probe_write', {}), bridged('c3', 'probe_read', {}), call('c4', 'probe_write', {})), FINAL] },
  { name: 'a session with no resolved tool mode', session: { toolSpec: null }, script: [round(bridged('c1', 'probe_write', {}), bridged('c2', 'probe_read', {}), call('c3', 'probe_write', {}), call('c4', 'probe_read', {})), FINAL] },
  { name: 'MCP tools called directly: connected, no longer listed, never listed', mcp: true, script: [round(call('c1', 'mcp__mail__send', { to: 'a@b.c' }), call('c2', 'mcp__mail__gone', {}), call('c3', 'mcp__mail__nope', {})), FINAL] },
  { name: 'a kept MCP definition the live server no longer lists, through call_tool and called directly', mcp: true, staleMcp: true, script: [round(bridged('c1', 'mcp__mail__gone', {}), call('c2', 'mcp__mail__gone', {}), bridged('c3', 'mcp__mail__send', { to: 'a@b.c' })), FINAL] },
  { name: 'a session that is not a bridge session', nonBridge: true, script: [round(bridged('c1', 'probe_write', { q: 'x' }), call('c2', 'probe_write', { q: 'x' })), FINAL] },
  { name: 'a hook that rewrites the target', hookRewrite: { probe_read: { name: 'probe_write', args: { q: 'rewritten' } } }, script: [round(bridged('c1', 'probe_read', { q: 'x' })), FINAL] },
  { name: 'a PreToolUse hook that denies the target', hookDeny: ['probe_write'], script: [round(bridged('c1', 'probe_write', { q: 'x' }), call('c2', 'probe_write', { q: 'x' })), FINAL] },
];

SCENARIOS.push({
  name: 'a hook-denied edit, and a read-only target behind it that streamed',
  hookDeny: ['edit'],
  stream: true,
  script: [round(call('c1', 'edit', { file_path: 'x.txt', old_string: 'a', new_string: 'b' }), bridged('c2', 'probe_read', { q: 'z' })), FINAL],
});

SCENARIOS.push({
  name: 'a denied edit, and a read-only target behind it that streamed',
  session: { disallowedTools: ['edit'] },
  stream: true,
  script: [round(call('c1', 'edit', { file_path: 'x.txt', old_string: 'a', new_string: 'b' }), bridged('c2', 'probe_read', { q: 'z' })), FINAL],
});

// A mutation streamed ahead of the calls behind it: a read waits for it and is run again, a write behind it is never run twice, and a conflicting edit waits (eager-dispatch/barriers.mjs).
SCENARIOS.push({
  name: 'an edit with a read, a write and another edit behind it, all streamed',
  internal: ['edit'],
  stream: true,
  script: [round(call('c1', 'edit', { file_path: 'x.txt', old_string: 'a', new_string: 'b' }), bridged('c2', 'probe_read', { q: 'r' }), bridged('c3', 'probe_write', { q: 'w' }), call('c4', 'edit', { file_path: 'x.txt', old_string: 'b', new_string: 'c' })), FINAL],
});

// `computer` is run once per assistant turn (isSingleCallPerTurnTool): the second call of a streamed turn is answered, not started.
SCENARIOS.push({
  name: 'computer called twice in one streamed turn',
  internal: ['computer'],
  stream: true,
  script: [round(call('c1', 'computer', { action: 'screenshot' }), call('c2', 'computer', { action: 'click' })), FINAL],
});


// ---- calls that take time ----------------------------------------------------------------------------------------------------------
// A scenario holds one step of one call (`gates`) until something else has happened. The batch only comes out in the recorded order if the
// calls really run together (a loop that ran them one after another waits forever for the entry that releases the gate).
const at = (ev, extra = {}) => ({ ev, ...extra });
const CONCURRENT = [
  {
    name: 'the first call is held in its tool while the second call runs through its hook, tool and post hook',
    gates: [{ stage: 'tool', args: { q: '1' }, until: at('post', { name: 'probe_read' }) }],
    script: [round(call('c1', 'probe_write', { q: '1' }), call('c2', 'probe_read', { q: '2' })), FINAL],
  },
  {
    name: 'the first call is held in its PreToolUse hook until the second call has run',
    gates: [{ stage: 'pre', args: { q: '1' }, until: at('ran', { name: 'probe_read' }) }],
    script: [round(call('c1', 'probe_write', { q: '1' }), call('c2', 'probe_read', { q: '2' })), FINAL],
  },
  {
    name: 'three calls finish in the reverse order of the batch',
    gates: [
      { stage: 'tool', args: { q: '1' }, until: at('post', { args: { q: '2' } }) },
      { stage: 'tool', args: { q: '2' }, until: at('post', { args: { q: '3' } }) },
    ],
    script: [round(call('c1', 'probe_write', { q: '1' }), call('c2', 'probe_read', { q: '2' }), call('c3', 'probe_read', { q: '3' })), FINAL],
  },
  {
    name: 'the first call is held in its PostToolUse hook until the second call has finished',
    gates: [{ stage: 'post', args: { q: '1' }, until: at('post', { args: { q: '2' } }) }],
    script: [round(call('c1', 'probe_write', { q: '1' }), call('c2', 'probe_read', { q: '2' })), FINAL],
  },
  {
    name: 'a call waiting for its approval does not hold the calls behind it',
    ask: ['probe_write'],
    answers: [{ approved: true }],
    gates: [{ stage: 'card', until: at('post', { name: 'probe_read' }) }],
    script: [round(call('c1', 'probe_write', { q: '1' }), call('c2', 'probe_read', { q: '2' })), FINAL],
  },
  {
    name: 'edits of two files run together and the second edit of a file waits for the first',
    internal: ['edit'],
    gates: [{ stage: 'tool', args: { file_path: 'x.txt', old_string: 'a', new_string: 'b' }, until: at('post', { args: { file_path: 'y.txt', old_string: 'a', new_string: 'b' } }) }],
    script: [round(call('c1', 'edit', { file_path: 'x.txt', old_string: 'a', new_string: 'b' }), call('c2', 'edit', { file_path: 'y.txt', old_string: 'a', new_string: 'b' }), call('c3', 'edit', { file_path: 'x.txt', old_string: 'b', new_string: 'c' })), FINAL],
  },
  {
    name: 'a shell command waits for the patch before it while the read after it runs',
    internal: ['apply_patch', 'shell'],
    gates: [{ stage: 'tool', name: 'apply_patch', until: at('post', { name: 'probe_read' }) }],
    script: [round(call('c1', 'apply_patch', { patch: 'p' }), call('c2', 'shell', { command: 'echo ok' }), call('c3', 'probe_read', { q: 'r' })), FINAL],
  },
  {
    name: 'a shell command is skipped when the patch before it failed',
    internal: ['apply_patch', 'shell'],
    script: [round(call('c1', 'apply_patch', { patch: 'p', fail: true }), call('c2', 'shell', { command: 'echo ok' }), call('c3', 'probe_read', { q: 'r' })), FINAL],
  },
  {
    name: 'the first call is held in its tool while the second call, streamed behind it, finishes',
    stream: true,
    gates: [{ stage: 'tool', args: { q: '1' }, until: at('post', { name: 'probe_read' }) }],
    script: [round(call('c1', 'probe_write', { q: '1' }), call('c2', 'probe_read', { q: '2' })), FINAL],
  },
];
SCENARIOS.push(...CONCURRENT);

// ---- two approvals in one batch ----------------------------------------------------------------------------------------------------
// Each ask reads the grants file before its card is shown (human-gate/gate.mjs:288 `allowanceForHookAsk`) and appends to the audit file once
// it is answered (gate.mjs:402 `recordAudit`). Those two operations of the two calls are the only things whose completion order varies
// between runs; a scenario fixes it by holding the n-th read or append (stages `grants`, `audit`).
const TWO_ASKS = { ask: ['probe_write'], script: [round(bridged('c1', 'probe_write', { q: '1' }), bridged('c2', 'probe_write', { q: '2' })), FINAL] };
SCENARIOS.push(
  {
    ...TWO_ASKS,
    name: 'two approvals in one batch, the first call asked first',
    answers: [{ approved: true }, { approved: false, reason: 'no' }],
    gates: [
      { stage: 'grants', nth: 2, until: at('card', { args: { q: '1' } }) },
      { stage: 'audit', nth: 2, until: at('ran', { args: { q: '1' } }) },
    ],
  },
  {
    ...TWO_ASKS,
    name: 'two approvals in one batch, the second call asked first',
    answers: [{ approved: true }, { approved: false, reason: 'no' }],
    gates: [
      { stage: 'grants', nth: 1, until: at('card', { args: { q: '2' } }) },
      { stage: 'audit', nth: 2, until: at('ran', { args: { q: '2' } }) },
    ],
  }
);

// ---- arguments that were not JSON, and a guard that waits for the calls before it -------------------------------------------------
// A provider that could not parse a call's arguments hands the loop a marker instead (`makeInvalidToolArgsMarker`,
// providers/lib/openai-tool-args.mjs:22); the call is answered with the retry notice, never admitted for an eager run and never dispatched
// (tool-batch/execute-call.mjs `executeBatchCall`, eager-dispatch/admission.mjs `admit`).
const NOT_JSON = { __invalidToolArgs: true, __rawArguments: '{"q":', __parseError: 'Unexpected end of JSON input' };
SCENARIOS.push(
  {
    name: 'calls whose arguments were not JSON: a tool, call_tool and a tool of the session',
    script: [round(call('c1', 'probe_read', NOT_JSON), call('c2', 'call_tool', NOT_JSON), call('c3', 'read', NOT_JSON), call('c4', 'probe_write', { q: 'ok' })), FINAL],
  },
  {
    // The 4th decision waits for the failures before it (repeat-failure guard, limit 3): the calls after it still get their results.
    name: 'a repeat-failure guard that waits for the failures before it in one batch',
    script: [
      round(call('c1', 'probe_write', { q: 'x', fail: true })),
      round(call('c2', 'probe_write', { q: 'x', fail: true })),
      round(call('c3', 'probe_write', { q: 'x', fail: true }), call('c4', 'probe_write', { q: 'x', fail: true }), call('c5', 'probe_read', { q: 'r' })),
      FINAL,
    ],
  }
);
// An invalid first `computer` call still takes the turn's single slot (eager-dispatch/admission.mjs:55-63 reserves, then refuses it): the
// valid one behind it is answered, never run, whether the provider streams or not.
const INVALID_COMPUTER = [{ name: 'an invalid first computer call and a valid one behind it', internal: ['computer'], script: [round(call('c1', 'computer', NOT_JSON), call('c2', 'computer', { action: 'click' })), FINAL] }];
SCENARIOS.push(...INVALID_COMPUTER, { ...INVALID_COMPUTER[0], name: 'an invalid first computer call and a valid one behind it (streamed)', stream: true });
// A session whose persisted deferred surface is read-only although its tool mode is not (tool-bridge.mjs:187 `isBridgeReadonlySession`,
// session/loop/deferred-call-through.mjs:108): a deferred tool that is not read-only selectable is refused, one that is selectable runs.
SCENARIOS.push({
  name: 'a session whose deferred surface is read-only under a full tool mode',
  session: { toolSpec: 'full', deferredSurfaceMode: 'readonly' },
  script: [round(bridged('c1', 'probe_write', { q: 'x' }), bridged('c2', 'probe_read', { q: 'r' }), call('c3', 'probe_write', { q: 'x' })), FINAL],
});
// ---- a turn cancelled while its calls are in flight, and a stream cut with a call still streaming --------------------------------------
// The turn is cancelled (`abortSessionTurn`, session/manager/session-close.mjs:306, the abort a client's interrupt reaches) once every entry of
// `abortWhen` has happened: the edit and the read behind it in the batch are running (held in their tools), the second edit of the same file
// waits behind the first (eager-dispatch/barriers.mjs `precedingFor`) and the write waits for its approval (its card is held). Every held step
// is released by the cancellation itself (`aborted`); the scenario then waits until each call of `settled` has told the host it settled.
const ABORTED = at('aborted');
const ABORT_REASON = 'cancelled by the scenario';
SCENARIOS.push({
  name: 'a turn cancelled while an edit and a read run, a second edit waits behind the first and a write waits for its approval',
  internal: ['edit'],
  ask: ['probe_write'],
  answers: [{ approved: true }],
  abortWhen: [at('ran', { name: 'probe_read' }), at('ran', { name: 'edit' }), at('card', { name: 'probe_write' })],
  settled: ['c1', 'c2', 'c3', 'c4'],
  gates: [
    { stage: 'tool', name: 'probe_read', until: ABORTED },
    { stage: 'tool', name: 'edit', until: ABORTED },
    { stage: 'card', until: ABORTED },
  ],
  script: [round(call('c1', 'edit', { file_path: 'x.txt', old_string: 'a', new_string: 'b' }), bridged('c2', 'probe_read', { q: 'r' }), call('c3', 'edit', { file_path: 'x.txt', old_string: 'b', new_string: 'c' }), bridged('c4', 'probe_write', { q: 'w' })), FINAL],
});
// A write that ignores the cancel: its tool is held until the client has learnt that the turn ended (`turnEnded`), so it settles
// after that; a loop that waited for it before ending the turn would never get there (the hold fails the recording).
const TURN_ENDED = at('turnEnded');
SCENARIOS.push({
  name: 'a turn cancelled while a write runs that ignores the cancel and settles after the turn has ended',
  abortWhen: [at('ran', { name: 'probe_write' })],
  settled: ['c1'],
  gates: [{ stage: 'tool', name: 'probe_write', until: TURN_ENDED }],
  script: [round(call('c1', 'probe_write', { q: 'w' })), FINAL],
});
// The cancel reaches the batch while it waits for the result of an edit: a refused call before it has its answer staged (never run,
// so never told early), a read before it has settled, the edit runs on until after the turn ended, and a second edit of the same
// file waits behind it.
SCENARIOS.push({
  name: 'a turn cancelled while the batch waits for an edit, a refusal staged and a read settled before it and an edit of the same file queued behind it',
  internal: ['edit'],
  abortWhen: [at('toolResult', { id: 'c2', early: true }), at('ran', { name: 'edit' })],
  settled: ['c2', 'c3', 'c4'],
  gates: [{ stage: 'tool', name: 'edit', args: { file_path: 'x.txt', old_string: 'a', new_string: 'b' }, until: TURN_ENDED }],
  script: [round(bridged('c1', 'no_such_tool', {}), bridged('c2', 'probe_read', { q: '1' }), call('c3', 'edit', { file_path: 'x.txt', old_string: 'a', new_string: 'b' }), call('c4', 'edit', { file_path: 'x.txt', old_string: 'b', new_string: 'c' })), FINAL],
});
// A streaming provider whose stream is cut (`TRUNCATED_STREAM`) after two complete calls, while a third call's arguments were still streaming
// (`pendingToolUse`): the turn goes on with the complete calls, the partial one is dropped unrun and the model is told to split it
// (send-with-recovery.mjs:720 `recoverableToolCalls`, :767 `recoverPartialToolCalls`, :737 the notice). One complete call names no tool.
SCENARIOS.push({
  name: 'a stream cut while a third call was still streaming: the complete calls go on, the partial one is dropped',
  stream: true,
  script: [{ ...round(bridged('c1', 'probe_read', { q: 'r' }), bridged('c2', 'no_such_tool', {})), cut: true }, FINAL],
});

// The product's `goal` tool through the bridge, which a built core runs too (`live`: `replay-call-tool-live.mjs` replays these
// against mixdogd; the in-process replay has no goal tool).
const GOAL_STATUS = { action: 'status' };
SCENARIOS.push(
  { name: 'live: goal described with load_tool, then run through call_tool', live: true, internal: ['goal'], script: [round(call('c1', 'load_tool', { names: ['goal'] })), round(bridged('c2', 'goal', GOAL_STATUS)), FINAL] },
  { name: 'live: goal run through call_tool without load_tool', live: true, internal: ['goal'], script: [round(bridged('c1', 'goal', GOAL_STATUS)), FINAL] },
  { name: 'live: goal described with load_tool, then called directly', live: true, internal: ['goal'], script: [round(call('c1', 'load_tool', { names: ['goal'] })), round(call('c2', 'goal', GOAL_STATUS)), FINAL] }
);

// The same turns with a provider that streams its tool calls: each call reaches the loop (and starts its eager dispatch) before the response ends.
const STREAMED = [
  'calls whose arguments were not JSON: a tool, call_tool and a tool of the session',
  'a read-only deferred tool through call_tool, twice in one turn and again in the next',
  'every refusal of call_tool in one batch',
  'a target that needs approval, approved',
  'a mix: an approval, a refusal and a plain run in one batch',
  'a session that denies a tool',
  'a read-only session',
  'a session with no resolved tool mode',
  'a loaded deferred tool called directly',
  'an MCP tool of a connected server through call_tool',
  'a PreToolUse hook that denies the target',
  'a hook that rewrites the target',
];
for (const name of STREAMED) {
  const base = SCENARIOS.find((s) => s.name === name);
  SCENARIOS.push({ ...base, name: `${name} (streamed)`, stream: true });
}

// ---- one scenario --------------------------------------------------------------------------------------------------------------
const AUDIT_PATH = join(process.env.MIXDOG_DATA_DIR, 'human-gate', 'audit.jsonl');
let auditOffset = 0;
// `twin`: the same scenario with a provider that streams nothing, run only to learn which calls of each round the loop dispatches
// (and so tells the host about as they settle): a streaming response ends once those have settled.
async function runScenario(scenario, twin = false) {
  const n = twin ? scenario.twinN : scenario.n;
  const scopeId = `call-tool-scope-${n}`;
  const sessionId = `sess_call_tool_${String(n).padStart(2, '0')}`;
  const providerName = `scripted-call-tool-${n}`;
  const executed = [];
  const hooks = { before: [], after: [] };
  const cards = [];
  const events = [];
  const callbacks = [];
  const sends = [];
  // Everything observable, in the order it happened: the requests, the hooks, the cards, the tool events and the executors.
  const timeline = [];
  const waiters = [];
  const note = (entry) => {
    timeline.push(entry);
    for (const waiter of waiters.splice(0)) if (!waiter.hit(entry)) waiters.push(waiter);
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // Resolves once an entry of the timeline has every field of `match` (now or later); a deadline that names it ends a scenario that never gets there.
  const until = (match, label) => {
    const hit = (entry) => Object.entries(match).every(([key, value]) => same(entry[key], value));
    if (timeline.some(hit)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${scenario.name}: ${label} never happened (waiting for ${JSON.stringify(match)})`)), 10_000);
      waiters.push({
        hit: (entry) => {
          if (!hit(entry)) return false;
          clearTimeout(timer);
          resolve();
          return true;
        },
      });
    });
  };
  // One step a script controls. A scenario can hold the n-th occurrence of a step (`gates`) until an entry of the timeline appears.
  const gateSeen = new Map();
  const heldTooLong = [];
  const step = async (stage, name = '', args = {}) => {
    for (const gate of scenario.gates ?? []) {
      if (gate.stage !== stage || (gate.name !== undefined && gate.name !== name) || (gate.args !== undefined && !same(gate.args, args))) continue;
      const seen = (gateSeen.get(gate) ?? 0) + 1;
      gateSeen.set(gate, seen);
      if (seen !== (gate.nth ?? 1)) continue;
      // A hold that never ends is the recording's failure, not the product's: the step's own error would otherwise be recorded as the
      // call's result.
      await until(gate.until, `${stage} of ${name || 'a call'} (held)`).catch((error) => {
        heldTooLong.push(error.message);
        throw error;
      });
      break;
    }
    await macrotask();
  };
  fileStep = (kind) => step(kind);
  // Every script step in progress (an executor, a hook, a card): a cancelled turn ends before the calls it started, which the scenario
  // then waits for, each by its own settlement.
  const inflight = new Set();
  const track = (promise) => {
    inflight.add(promise);
    const done = () => inflight.delete(promise);
    promise.then(done, done);
    return promise;
  };
  let sessionRef = null;
  const restoreInternal = setInternalToolsProvider({
    scopeId,
    tools: [{ name: 'load_tool', description: 'Describes tools.', inputSchema: { type: 'object', properties: { names: {} } }, annotations: { readOnlyHint: true } }, ...PROBE_TOOLS, ...(scenario.internal ?? []).map((name) => (name === 'goal' ? GOAL_TOOL_DEFS[0] : { name, description: `${name} probe`, inputSchema: { type: 'object', properties: {} } }))],
    executor: (name, args) =>
      track(
        (async () => {
          if (name === 'load_tool') return renderToolSearch(args, sessionRef, 'lead', {});
          executed.push({ name, args: clone(args) });
          note({ ev: 'ran', name, args: clone(args) });
          await step('tool', name, args);
          if (name === 'goal') return goalRuntime.executeTool(name, args ?? {}, { callerSessionId: sessionRef.id });
          if (args?.fail) throw new Error(`${name} failed`);
          return `ran ${name} ${JSON.stringify(args)}`;
        })()
      ),
  });
  if (scenario.mcp) {
    _registerMcpServerForTest(
      scopeId,
      'mail',
      MCP_TOOLS.slice(0, 1).map((tool) => ({ ...tool, annotations: { readOnlyHint: false } })),
      {
        callTool: async (params) => {
          executed.push({ name: `mcp__mail__${params.name}`, args: clone(params.arguments ?? {}) });
          note({ ev: 'ran', name: `mcp__mail__${params.name}`, args: clone(params.arguments ?? {}) });
          await step('tool', `mcp__mail__${params.name}`, params.arguments ?? {});
          return { content: [{ type: 'text', text: `ran ${params.name} ${JSON.stringify(params.arguments ?? {})}` }] };
        },
      }
    );
  }
  const provider = {
    name: providerName,
    contextWindow: 128000,
    async send(messages, _model, _tools, sendOpts) {
      const i = sends.length;
      sends.push(clone(messages));
      note({ ev: 'sent', n: i + 1 });
      const reply = scenario.script[i];
      if (!reply) throw new Error(`${scenario.name}: the script ran out at request ${i + 1}`);
      if (reply.calls) {
        // A streaming provider hands the loop each tool call the moment it is complete (`opts.onToolCall`, which starts the
        // call's eager dispatch) and the response only at the end; a whole-response provider hands nothing before it returns.
        if (scenario.stream) {
          for (const streamed of reply.calls) {
            sendOpts.onToolCall(clone(streamed));
            await macrotask();
          }
          // The response ends once every call the loop dispatches has settled and told the host (`notifyEarlyResult`, eager-dispatch/entry.mjs:98).
          for (const id of reply.settles) await until({ ev: 'toolResult', id, early: true }, `the settlement of ${id}`);
          // A cut stream: what an adapter throws when the connection ends without the terminal frame while the next call's arguments
          // are still arriving (the complete calls so far, `pendingToolUse`).
          if (reply.cut) {
            note({ ev: 'cut', n: i + 1 });
            throw Object.assign(new Error('the stream ended without its terminal frame'), {
              code: 'TRUNCATED_STREAM',
              truncatedStream: true,
              partialToolCalls: clone(reply.calls),
              pendingToolUse: true,
            });
          }
        }
        note({ ev: 'answered', n: i + 1 });
        return { content: '', toolCalls: clone(reply.calls), stopReason: 'tool_use', usage: USAGE };
      }
      note({ ev: 'answered', n: i + 1 });
      return { content: reply.text, usage: USAGE };
    },
  };
  const answers = [...(scenario.answers ?? [])];
  let result = null;
  let traceRows = [];
  let auditRecords = [];
  await _withRegisteredProviderForTestAsync(providerName, provider, async () => {
    const session = createSession({ id: sessionId, provider: providerName, model: 'fake-model', cwd: workdir, skipSkills: true, mcpScopeId: scopeId, ...(scenario.session ?? {}) });
    sessionRef = session;
    // An internal tool answers before the built-in one of its name (dispatch.mjs:145), so the executor is the recorder's; `computer` is no tool of a plain session, the scenario adds it.
    if (scenario.internal?.includes('computer')) session.tools.push({ name: 'computer', description: 'computer probe', inputSchema: { type: 'object', properties: {} } });
    if (scenario.mcp) refreshDeferredMcpToolCatalog(session);
    // A definition the discovery history keeps although the live server snapshot no longer lists it (isDeferredToolAvailable).
    if (scenario.staleMcp) session.deferredLateToolCatalog = [{ ...MCP_TOOLS[1], name: 'mcp__mail__gone' }];
    if (!scenario.nonBridge) applyDeferredToolSurface(session, 'lead', [], { provider: providerName });
    // Not createSession options: the session runtime sets them on the session after it is built.
    for (const key of ['toolSpec', 'featureDeniedTools', 'deferredSurfaceMode']) if (scenario.session && key in scenario.session) session[key] = scenario.session[key];
    session.beforeToolHook = (hookCall) =>
      track(
        (async () => {
          hooks.before.push({ name: hookCall.name, args: clone(hookCall.args) });
          note({ ev: 'pre', name: hookCall.name, args: clone(hookCall.args) });
          await step('pre', hookCall.name, hookCall.args);
          const rewrite = scenario.hookRewrite?.[hookCall.name];
          if (rewrite) return { action: 'modify', ...rewrite };
          if (scenario.hookDeny?.includes(hookCall.name)) return { action: 'deny', reason: 'hook says no' };
          if (scenario.ask?.includes(hookCall.name)) return { action: 'ask', reason: HOOK_ASK };
          return null;
        })()
      );
    session.afterToolHook = (hookCall) =>
      track(
        (async () => {
          hooks.after.push({ name: hookCall.name, args: clone(hookCall.args), result: hookCall.result });
          note({ ev: 'post', name: hookCall.name, args: clone(hookCall.args) });
          await step('post', hookCall.name, hookCall.args);
        })()
      );
    const surface = { exposure: session.toolExposureMode ?? null, toolSpec: session.toolSpec ?? null, deferredSurfaceMode: session.deferredSurfaceMode ?? null, tools: session.tools.map((t) => t.name), catalog: [...(session.deferredToolCatalog ?? []), ...(session.deferredLateToolCatalog ?? [])].map((t) => t.name), mcpNames: session.deferredMcpToolNames ?? null };
    const asked = askSession(
      session.id,
      'go',
      null,
      (iteration, calls) => {
        events.push({ ev: 'toolCall', iteration, calls: clone(calls) });
        note({ ev: 'toolCall', ids: calls.map((c) => c.id) });
      },
      null,
      null,
      {
        // The verb a client names the finished turn with: the TUI's first turn's (tui/session/turn.mjs:130 `pickDoneVerb(index)`),
        // which a core picks for its protocol clients (`live_end.rs` `done_verb`).
        transcriptMeta: { completionVerb: pickDoneVerb(0) },
        // Every other callback the turn raises for its host (ask-turn-loop-options.mjs:113-236), in the order raised, with what it was given.
        ...Object.fromEntries(
          LOOP_CALLBACKS.map((ev) => [
            ev,
            (...args) => {
              callbacks.push({ ev, args: args.map(cloneable) });
            },
          ])
        ),
        onToolApproval: (card) =>
          track(
            (async () => {
              cards.push(clone(card));
              note({ ev: 'card', name: card.name, args: clone(card.args) });
              // A person answers later: every call that needs no answer runs first.
              await step('card', card.name, card.args);
              const answer = answers.shift();
              if (!answer) throw new Error(`${scenario.name}: an approval card nobody scripted`);
              return { ...answer, device: 'Pixel' };
            })()
          ),
        onToolResult: (message) => {
          events.push({ ev: 'toolResult', message: clone(message) });
          note({ ev: 'toolResult', id: message.toolCallId, early: message.__earlyNotify === true });
        },
      }
    );
    // The client's interrupt, the moment every entry of `abortWhen` has happened.
    const cancelled = scenario.abortWhen
      ? Promise.all(scenario.abortWhen.map((match) => until(match, 'the moment to cancel'))).then(() => {
          abortSessionTurn(session.id, ABORT_REASON);
          note({ ev: 'aborted' });
        })
      : null;
    let turn = null;
    let turnError = null;
    try {
      turn = await withDeadline(asked, `the turn of ${scenario.name}`, 120_000);
    } catch (error) {
      if (!cancelled) throw error;
      turnError = { name: error?.name ?? null, message: error?.message ?? String(error) };
    }
    // The moment the client learns the cancelled turn is over, noted where a step is held until it (elsewhere where it falls among the
    // calls' own steps is only how many steps the unwinding takes).
    if (cancelled && (scenario.gates ?? []).some((gate) => gate.until.ev === 'turnEnded')) note({ ev: 'turnEnded' });
    if (cancelled) {
      await cancelled;
      if (!turnError) throw new Error(`${scenario.name}: the cancelled turn ended without an error`);
      // A cancelled turn ends before the calls it started: each one is waited for until it has told the host it settled, and then every
      // script step still in progress.
      for (const id of scenario.settled ?? []) await until({ ev: 'toolResult', id, early: true }, `the settlement of ${id} after the cancellation`);
      while (inflight.size) await withDeadline(Promise.allSettled([...inflight]), 'the script steps still running after the cancellation', 10_000);
    }
    // The tails Node leaves after a turn: the debounced session save (session/store.mjs:305 `drainSessionStore`) and the local trace spool's timed append (orchestrator/agent-trace-io.mjs:344 `drainAgentTrace`, which awaits the append in flight).
    drainSessionStore();
    await withDeadline(drainAgentTrace(), 'the agent trace drain', 10_000);
    // Every row the loop wrote for this session (batch rows, tool rows, ...), whole, and the human gate's audit records of its decisions.
    traceRows = (existsSync(process.env.MIXDOG_AGENT_TRACE_PATH) ? readFileSync(process.env.MIXDOG_AGENT_TRACE_PATH, 'utf8') : '').split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.session_id === sessionId);
    const audit = existsSync(AUDIT_PATH) ? readFileSync(AUDIT_PATH) : Buffer.alloc(0);
    auditRecords = audit.subarray(auditOffset).toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    auditOffset = audit.length;
    const stored = loadSession(session.id);
    result = { surface, answer: turn?.content ?? null, turnError, stored: clone(stored.messages) };
    deleteSession(session.id);
  });
  restoreInternal();
  if (scenario.mcp) await disconnectAll({ scopeId });
  // Every gate the scenario holds must have been reached its n-th time: a gate nobody reaches would silently record an unheld order.
  for (const gate of scenario.gates ?? []) {
    if ((gateSeen.get(gate) ?? 0) < (gate.nth ?? 1)) throw new Error(`${scenario.name}: the gate ${JSON.stringify(gate)} was never reached`);
  }
  if (answers.length) throw new Error(`${scenario.name}: ${answers.length} scripted answer(s) never used`);
  if (heldTooLong.length) throw new Error(`${scenario.name}: ${heldTooLong.join('; ')}`);
  return {
    name: scenario.name,
    sessionId,
    session: scenario.session ?? {},
    mcp: scenario.mcp === true,
    nonBridge: scenario.nonBridge === true,
    live: scenario.live === true,
    stream: scenario.stream === true,
    internal: scenario.internal ?? [],
    workdir,
    ask: scenario.ask ?? [],
    answers: scenario.answers ?? [],
    hookRewrite: scenario.hookRewrite ?? null,
    hookDeny: scenario.hookDeny ?? [],
    gates: scenario.gates ?? [],
    abortWhen: scenario.abortWhen ?? null,
    abortReason: scenario.abortWhen ? ABORT_REASON : null,
    settled: scenario.settled ?? [],
    script: scenario.script,
    ...result,
    requests: sends,
    events,
    callbacks,
    cards,
    hooks,
    executed,
    timeline,
    audit: auditRecords,
    trace: traceRows,
  };
}

// The first approval of a process builds the human gate's store (human-gate/store.mjs:186 `humanGateStore`, a dynamic import): once, before any scenario.
await humanGateStore();

const scenarios = [];
let streamedSoFar = 0;
for (const [index, scenario] of SCENARIOS.entries()) {
  // A scenario's session is numbered by its place in the list, so that `--only` records it under the id a whole run gives it.
  scenario.n = index + 1;
  if (scenario.stream) scenario.twinN = 1000 + (streamedSoFar += 1);
  if (ONLY && !scenario.name.includes(ONLY)) continue;
  if (scenario.stream) {
    const twin = await runScenario({ ...scenario, stream: false }, true);
    const sent = twin.timeline.flatMap((entry, at) => (entry.ev === 'sent' ? [at] : []));
    scenario.script = scenario.script.map((reply, round) => {
      if (!reply.calls) return reply;
      const settles = twin.timeline.slice(sent[round], sent[round + 1]).filter((entry) => entry.ev === 'toolResult' && entry.early).map((entry) => entry.id);
      return { ...reply, settles };
    });
  }
  scenarios.push(await runScenario(scenario));
}

const golden = {
  note: 'a real askSession turn over a bridge session (call_tool / load_tool, deferred probe tools, one connected MCP server) at b6f10295a',
  // The definitions of the tools the scenarios register: the probes, and the product's `goal` for the `live` ones.
  tools: [...PROBE_TOOLS, ...GOAL_TOOL_DEFS],
  scenarios,
};
const described = {
    // Everything in the recording that is the recorder's own and not the product's.
    syntheticInputs: [
      'the provider: a scripted `send` that returns each scenario\'s replies in order; for a streamed scenario it hands every call to `onToolCall` one macrotask apart and ends the response once the calls the twin run saw settle early (`settles`)',
      'the session\'s tools: internal tools registered with `setInternalToolsProvider` (load_tool, the probe_* tools, and edit / apply_patch / shell / computer when a scenario names them) whose executors only record their arguments and answer `ran <name> <args>`, or fail when `fail` is set',
      'the connected MCP server: `_registerMcpServerForTest` with one listed tool (`send`) whose callTool answers `ran <tool> <args>`; the catalog entries `gone` and `nope` are never listed or never live',
      'the approvals: `onToolApproval` answers each card from the scenario\'s `answers`, in order, as the device `Pixel`',
      'the hooks: `beforeToolHook` asks / denies / rewrites per the scenario (`ask`, `hookDeny`, `hookRewrite`), `afterToolHook` only records',
      'the gates (`gates`): a step of one call (`pre`, `tool`, `post`, `card`, `grants`, `audit`) held until an entry of the timeline appears; each step also takes one macrotask',
      'the cancellation (`abortWhen`): once every listed timeline entry has happened the recorder calls `abortSessionTurn(<session>, \'cancelled by the scenario\')` and notes `aborted`; the turn\'s rejection is recorded as `turnError`, and the recorder then waits until each call of `settled` has told the host it settled and every script step still in progress has ended',
      'the cut stream (`cut` on a reply): after handing its calls to `onToolCall` and waiting for their settlement, the streaming provider throws `{ code: TRUNCATED_STREAM, truncatedStream: true, partialToolCalls: <the calls>, pendingToolUse: true }` and notes `cut`',
      'synchronous file work: `fs/promises` readFile / appendFile / mkdir of the human gate\'s grants.json and audit.jsonl are replaced by the same operation done synchronously after one macrotask (the recorder\'s `fileStep`), so the order of two concurrent approvals is the scenario\'s',
      'the session: createSession with the sandbox profile (MIXDOG_DATA_DIR and the home variables under the sandbox), a fixed id per scenario, a work directory holding x.txt',
    ],
};
if (RAW_OUT) {
  writeFileSync(RAW_OUT, JSON.stringify({ sandbox, golden, described }));
} else {
  // `--only`: the scenarios recorded now are printed and compared with golden.json's; nothing is written (a whole recording writes).
  const kept = new Map(JSON.parse(readFileSync(join(FIXTURES_ROOT, 'call-tool', 'golden.json'), 'utf8')).scenarios.map((s) => [s.name, s]));
  for (const fresh of normalised(golden, sandbox).scenarios) {
    console.log(JSON.stringify(fresh));
    const old = kept.get(fresh.name);
    const verdict = !old ? 'not in golden.json' : JSON.stringify(old) === JSON.stringify(fresh) ? 'the same as golden.json' : 'DIFFERS from golden.json';
    console.log(`${fresh.name}: ${verdict}`);
  }
}
console.log(`scenarios=${scenarios.length}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await finishSandbox();
}
// Open handles of the product's modules (its pools, timers) would keep the process alive.
process.exit(process.exitCode ?? 0);
