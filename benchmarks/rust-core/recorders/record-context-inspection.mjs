#!/usr/bin/env node
// What the desktop's Context inspector gets, recorded through Node's own request path: a real session runtime
// (`createMixdogSessionRuntime`, the headless profile the exec creates) whose session is built by real turns (`runtime.ask`, the
// session loop, the `read` tool) against a scripted Anthropic endpoint (lib/intercept.mjs answers every provider request on
// loopback), then the calls the inspector makes, each through the runtime's async boundary the desktop's IPC uses
// (`runtime.contextStatusSettled`, boot/tools.mjs:271): the list (`{ inspect: true }`, ContextInspector.tsx /
// command-surface-lifecycle.ts:145), a preview of every listed entry against the list's revision (ContextInspector.tsx:178), an
// entry id the list never had, a listed entry under the revision of a list read before a restart and the session's second turn
// (stale) and under a revision no list had, and the list again.
//
// The session's data directory is kept (`.mixdog/data/sessions`), so the replay opens the very session these answers were read
// from. The clock is fixed and the sandbox path is a fixed one (`<tmp>/context-inspection-live`), so two recordings write the
// same bytes.
//
//   node benchmarks/rust-core/recorders/record-context-inspection.mjs --tree <exact export of b6f10295a with node_modules>
// Output: native/core/fixtures/context-inspection/{golden.json,.mixdog/data/sessions,MANIFEST.json}
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { recorderProvenance } from './lib/provenance.mjs';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, within, writeJson, writeSetManifest } from './lib/common.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-context-inspection.mjs';
const NOW = 1_800_000_000_000;
const MODEL = 'claude-sonnet-4-6';

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
const root = join(tmpdir(), 'context-inspection-live');
rmSync(root, { recursive: true, force: true, maxRetries: 5 });
const home = join(root, '.mixdog');
const data = join(home, 'data');
const work = join(root, 'work');
for (const dir of [data, work]) mkdirSync(dir, { recursive: true });
writeFileSync(join(work, 'a.txt'), 'hello\n');
for (const key of ['HOME', 'USERPROFILE']) process.env[key] = root;
for (const [key, sub] of [['APPDATA', 'appdata'], ['LOCALAPPDATA', 'localappdata'], ['MIXDOG_CONFIG_DIR', 'config'], ['MIXDOG_RUNTIME_ROOT', 'runtime']]) process.env[key] = join(root, sub);
process.env.MIXDOG_HOME = home;
process.env.MIXDOG_DATA_DIR = data;
for (const [k, v] of Object.entries(JSON.parse(readFileSync(join(tree, 'src/runtime/shared/pristine-execution-contract.json'), 'utf8')).guardEnv)) process.env[k] = v;
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';
process.env.TZ = 'UTC';
process.env.ANTHROPIC_API_KEY = 'sk-fake';
// The session id is minted from the process id and the clock: both are fixed.
Object.defineProperty(process, 'pid', { value: 4242 });

const { install } = await import('./lib/intercept.mjs');
const hub = await install(tree);
// The provider gzips its request body; the hub reads bodies as text, so the transport stand-in inflates it on the way in.
const hubFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const headers = new Headers(init?.headers ?? {});
  if (headers.get('content-encoding') !== 'gzip' || init?.body === undefined) return hubFetch(input, init);
  headers.delete('content-encoding');
  headers.delete('content-length');
  return hubFetch(input, { ...init, headers, body: gunzipSync(init.body) });
};
Date.now = () => NOW;

// The model's turns: a `read` of the working file, then the answer.
const TURNS = [{ text: 'Reading it.', calls: [['read', { path: 'a.txt' }]] }, { text: 'The file says hello.' }];
const sse = (type, value) => `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
function messageSse(turn, index) {
  const parts = [sse('message_start', { type: 'message_start', message: { id: `msg_${index}`, type: 'message', role: 'assistant', model: MODEL, content: [], usage: { input_tokens: 1200 + index, output_tokens: 1 } } })];
  let block = 0;
  parts.push(sse('content_block_start', { type: 'content_block_start', index: block, content_block: { type: 'text', text: '' } }));
  parts.push(sse('content_block_delta', { type: 'content_block_delta', index: block, delta: { type: 'text_delta', text: turn.text } }));
  parts.push(sse('content_block_stop', { type: 'content_block_stop', index: block }));
  block += 1;
  for (const [name, input] of turn.calls ?? []) {
    parts.push(sse('content_block_start', { type: 'content_block_start', index: block, content_block: { type: 'tool_use', id: `toolu_${index}_${block}`, name, input: {} } }));
    parts.push(sse('content_block_delta', { type: 'content_block_delta', index: block, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }));
    parts.push(sse('content_block_stop', { type: 'content_block_stop', index: block }));
    block += 1;
  }
  parts.push(sse('message_delta', { type: 'message_delta', delta: { stop_reason: turn.calls ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 10 + index } }));
  parts.push(sse('message_stop', { type: 'message_stop' }));
  return parts.join('');
}
let served = 0;
const script = {
  http: (record) => {
    if (!/\/v1\/messages$/.test(record.path)) return { status: 404, contentType: 'text/plain', body: 'no script' };
    served += 1;
    return { body: messageSse(TURNS[Math.min(served - 1, TURNS.length - 1)], served) };
  },
};

const { createMixdogSessionRuntime } = await importFrom(tree, 'src/mixdog-session-runtime.mjs');
const { settleRecorder } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/store/session-writers.mjs');
const { awaitPreviousTurnDurable } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/manager/turn-durability.mjs');
const calls = [];
let sessionId = null;
let route = null;
const options = {
  provider: 'anthropic',
  model: MODEL,
  cwd: work,
  toolMode: 'full',
  toolProfile: 'headless',
  approvalMode: 'implicit',
  disallowDelegation: true,
  autoWakeCompletions: false,
};
await hub.run(script, async () => {
  const first = await within('create the runtime', createMixdogSessionRuntime(options));
  await within('the turn', first.ask('Please read a.txt.', {}));
  sessionId = first.id;
  await within('the turn durable', awaitPreviousTurnDurable(sessionId));
  // The list an inspector held before the core restarted and the session took another turn: its revision is the stale one
  // asked below (a running core keeps its last readings, `createInspectionSnapshots`; a restarted one has none).
  const { revision: stale } = (await within('the earlier list', first.contextStatusSettled({ inspect: true }))).inspection;
  await within('the writer settled', settleRecorder(sessionId));
  await within('close the first runtime', first.close('restart'));
  const runtime = await within('create the runtime again', createMixdogSessionRuntime(options));
  await within('resume the session', runtime.resume(sessionId));
  await within('the second turn', runtime.ask('Thanks.', {}));
  await within('the second turn durable', awaitPreviousTurnDurable(sessionId));
  await within('the writer settled', settleRecorder(sessionId));
  const ask = async (options) => {
    const status = await within('contextStatus', runtime.contextStatusSettled(options));
    calls.push({ options, status: JSON.parse(JSON.stringify(status)) });
    return status;
  };
  const listed = await ask({ inspect: true });
  const { revision, entries } = listed.inspection;
  for (const entry of entries) await ask({ inspect: true, entryId: entry.id, revision });
  await ask({ inspect: true, entryId: 'message:999', revision });
  await ask({ inspect: true, entryId: entries[0].id, revision: stale });
  await ask({ inspect: true, entryId: entries[0].id, revision: 'not-a-revision' });
  await ask({ inspect: true });
  route = { provider: listed.provider, model: listed.model, contextWindow: listed.rawContextWindow };
  await within('close the runtime', runtime.close('done'));
}, 'context-inspection');
await hub.close();

const finalOut = join(FIXTURES_ROOT, 'context-inspection');
const out = stageSet(finalOut);
cpSync(join(data, 'sessions'), join(out, '.mixdog', 'data', 'sessions'), { recursive: true, filter: (path) => !path.endsWith('.lock') && !path.endsWith('.lock-journal') });
writeJson(join(out, 'golden.json'), {
  note: 'runtime.contextStatusSettled(options) of a real session runtime over a session built by a real turn, every call in the order made',
  now: NOW,
  sessionId,
  route,
  calls,
});
writeSetManifest(out, {
  set: 'context-inspection',
  recorder,
  command: `node ${recorder} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    calls: calls.length,
    syntheticInputs: [
      'the provider: a scripted Anthropic endpoint answering a read of a.txt, then a text',
      'the working folder: a.txt holding "hello"',
      'the clock: fixed at `now`',
    ],
    keptWhole: 'per call: the options and the whole status returned (inspection included); the session store the answers were read from',
  },
});
commitStage(out, finalOut);
// The runtime's usage ledger stays open after its close (the exec closes it on its way out, headless-exec.mjs:77).
(await importFrom(tree, 'src/runtime/shared/llm/usage-ledger.mjs')).closeUsageLedgers();
rmSync(root, { recursive: true, force: true, maxRetries: 5 });
console.log(`calls=${calls.length}`);
process.exit(0);
