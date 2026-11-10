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
//
// Output: native/core/fixtures/call-tool/golden.json (+ MANIFEST.json). The `script` of each scenario is the recorder's input.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-call-tool.mjs';

const sandbox = mkdtempSync(join(process.env.MIXDOG_RECORDER_SCRATCH ?? tmpdir(), 'rec-call-tool-'));
for (const name of ['MIXDOG_DATA_DIR', 'MIXDOG_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  process.env[name] = join(sandbox, name.toLowerCase());
}
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
process.env.MIXDOG_AGENT_TRACE_DISABLE = '';
process.env.MIXDOG_AGENT_TRACE_LOCAL_DISABLE = '';
process.env.MIXDOG_AGENT_TRACE_PATH = join(sandbox, 'agent-trace.jsonl');
process.env.MIXDOG_RUNTIME_ROOT = join(sandbox, 'no-service');
mkdirSync(process.env.MIXDOG_DATA_DIR, { recursive: true });

const { FIXTURES_ROOT, commitStage, exactProductIdentity, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } = await import('./lib/common.mjs');
const tree = resolveTree(parseArgs());
const identity = exactProductIdentity(tree, NODE_COMMIT);
const imp = (rel) => import(pathToFileURL(join(tree, rel)).href);
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
const { loadSession, deleteSession, drainSessionStore } = await imp(`${S}session/store.mjs`);
const { drainPathSync } = await imp('src/runtime/shared/buffered-appender.mjs');
const { humanGateStore } = await imp(`${S}session/human-gate/store.mjs`);
const { _withRegisteredProviderForTestAsync } = await imp(`${S}providers/registry.mjs`);
const { setInternalToolsProvider } = await imp(`${S}internal-tools.mjs`);
const { _registerMcpServerForTest, disconnectAll } = await imp(`${S}mcp/client.mjs`);
const { applyDeferredToolSurface, refreshDeferredMcpToolCatalog, renderToolSearch } = await imp(`${S}runtime-core/tool-catalog.mjs`);

const clone = (value) => JSON.parse(JSON.stringify(value));
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
    gates: [{ stage: 'tool', args: { file_path: 'x.txt', old_string: 'a' }, until: at('post', { args: { file_path: 'y.txt', old_string: 'a', new_string: 'b' } }) }],
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
// The same turns with a provider that streams its tool calls: each call reaches the loop (and starts its eager dispatch) before the response ends.
const STREAMED = [
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
let serial = 0;
let twins = 0;
// `twin`: the same scenario with a provider that streams nothing, run only to learn which calls of each round the loop dispatches
// (and so tells the host about as they settle): a streaming response ends once those have settled.
async function runScenario(scenario, twin = false) {
  const n = twin ? 1000 + (twins += 1) : (serial += 1);
  const scopeId = `call-tool-scope-${n}`;
  const sessionId = `sess_call_tool_${String(n).padStart(2, '0')}`;
  const providerName = `scripted-call-tool-${n}`;
  const executed = [];
  const hooks = { before: [], after: [] };
  const cards = [];
  const events = [];
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
  const step = async (stage, name = '', args = {}) => {
    for (const gate of scenario.gates ?? []) {
      if (gate.stage !== stage || (gate.name !== undefined && gate.name !== name) || (gate.args !== undefined && !same(gate.args, args))) continue;
      const seen = (gateSeen.get(gate) ?? 0) + 1;
      gateSeen.set(gate, seen);
      if (seen !== (gate.nth ?? 1)) continue;
      await until(gate.until, `${stage} of ${name || 'a call'} (held)`);
      break;
    }
    await macrotask();
  };
  fileStep = (kind) => step(kind);
  let sessionRef = null;
  const restoreInternal = setInternalToolsProvider({
    scopeId,
    tools: [{ name: 'load_tool', description: 'Describes tools.', inputSchema: { type: 'object', properties: { names: {} } }, annotations: { readOnlyHint: true } }, ...PROBE_TOOLS, ...(scenario.internal ?? []).map((name) => ({ name, description: `${name} probe`, inputSchema: { type: 'object', properties: {} } }))],
    executor: async (name, args) => {
      if (name === 'load_tool') return renderToolSearch(args, sessionRef, 'lead', {});
      executed.push({ name, args: clone(args) });
      note({ ev: 'ran', name, args: clone(args) });
      await step('tool', name, args);
      if (args?.fail) throw new Error(`${name} failed`);
      return `ran ${name} ${JSON.stringify(args)}`;
    },
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
      sends.push(clone(messages.filter((m) => m.role !== 'system')));
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
        }
        note({ ev: 'answered', n: i + 1 });
        return { content: '', toolCalls: clone(reply.calls), stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } };
      }
      note({ ev: 'answered', n: i + 1 });
      return { content: reply.text, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const answers = [...(scenario.answers ?? [])];
  let result = null;
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
    for (const key of ['toolSpec', 'featureDeniedTools']) if (scenario.session && key in scenario.session) session[key] = scenario.session[key];
    session.beforeToolHook = async (hookCall) => {
      hooks.before.push({ name: hookCall.name, args: clone(hookCall.args) });
      note({ ev: 'pre', name: hookCall.name, args: clone(hookCall.args) });
      await step('pre', hookCall.name, hookCall.args);
      const rewrite = scenario.hookRewrite?.[hookCall.name];
      if (rewrite) return { action: 'modify', ...rewrite };
      if (scenario.hookDeny?.includes(hookCall.name)) return { action: 'deny', reason: 'hook says no' };
      if (scenario.ask?.includes(hookCall.name)) return { action: 'ask', reason: HOOK_ASK };
      return null;
    };
    session.afterToolHook = async (hookCall) => {
      hooks.after.push({ name: hookCall.name, args: clone(hookCall.args), result: hookCall.result });
      note({ ev: 'post', name: hookCall.name, args: clone(hookCall.args) });
      await step('post', hookCall.name, hookCall.args);
    };
    const surface = { exposure: session.toolExposureMode ?? null, toolSpec: session.toolSpec ?? null, tools: session.tools.map((t) => t.name), catalog: [...(session.deferredToolCatalog ?? []), ...(session.deferredLateToolCatalog ?? [])].map((t) => t.name), mcpNames: session.deferredMcpToolNames ?? null };
    const turn = await askSession(
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
        onToolApproval: async (card) => {
          cards.push(clone(card));
          note({ ev: 'card', name: card.name, args: clone(card.args) });
          // A person answers later: every call that needs no answer runs first.
          await step('card', card.name, card.args);
          const answer = answers.shift();
          if (!answer) throw new Error(`${scenario.name}: an approval card nobody scripted`);
          return { ...answer, device: 'Pixel' };
        },
        onToolResult: (message) => {
          events.push({ ev: 'toolResult', message: stripTiming(message) });
          note({ ev: 'toolResult', id: message.toolCallId, early: message.__earlyNotify === true });
        },
      }
    );
    // The tails Node leaves after a turn: the debounced session save (session/store.mjs:305 `drainSessionStore`) and the buffered trace append (shared/buffered-appender.mjs:223 `drainPathSync`).
    drainSessionStore();
    drainPathSync(process.env.MIXDOG_AGENT_TRACE_PATH, { exiting: true });
    const stored = loadSession(session.id);
    result = { surface, answer: turn.content, stored: stored.messages.filter((m) => m.role !== 'system').map(stripTiming) };
    deleteSession(session.id);
  });
  restoreInternal();
  if (scenario.mcp) await disconnectAll({ scopeId });
  if (answers.length) throw new Error(`${scenario.name}: ${answers.length} scripted answer(s) never used`);
  return {
    name: scenario.name,
    session: scenario.session ?? {},
    mcp: scenario.mcp === true,
    nonBridge: scenario.nonBridge === true,
    stream: scenario.stream === true,
    internal: scenario.internal ?? [],
    workdir,
    ask: scenario.ask ?? [],
    answers: scenario.answers ?? [],
    hookRewrite: scenario.hookRewrite ?? null,
    hookDeny: scenario.hookDeny ?? [],
    gates: scenario.gates ?? [],
    script: scenario.script,
    ...result,
    requests: sends,
    events,
    cards,
    hooks,
    executed,
    timeline,
  };
}

function stripTiming(message) {
  const { toolTiming: _timing, ...rest } = clone(message);
  return rest;
}

// The first approval of a process builds the human gate's store (human-gate/store.mjs:186 `humanGateStore`, a dynamic import): once, before any scenario.
await humanGateStore();

const scenarios = [];
for (const scenario of SCENARIOS) {
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

// The audit: the batch rows the loop wrote (`recordToolBatch`), in order, by scenario session.
const trace = readFileSync(process.env.MIXDOG_AGENT_TRACE_PATH, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter((row) => row.kind === 'batch');
for (const [index, scenario] of scenarios.entries()) {
  const id = `sess_call_tool_${String(index + 1).padStart(2, '0')}`;
  scenario.batches = trace
    .filter((row) => row.session_id === id)
    .map((row) => ({ iteration: row.payload.iteration, toolCallCount: row.payload.tool_call_count, calls: row.payload.calls }));
}

const finalDir = join(FIXTURES_ROOT, 'call-tool');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), {
  note: 'a real askSession turn over a bridge session (call_tool / load_tool, deferred probe tools, one connected MCP server) at b6f10295a',
  tools: PROBE_TOOLS,
  scenarios,
});
writeSetManifest(stage, { set: 'call-tool', recorder, command: `node ${recorder} --tree <exact export of ${NODE_COMMIT}>`, identity, extra: { scenarios: scenarios.length } });
commitStage(stage, finalDir);
console.log(`scenarios=${scenarios.length}`);
process.exit(0);
