#!/usr/bin/env node
// The `cache_break` trace rows (`traceCacheBreak`, cache-break-trace.mjs). Two parts:
// - `loop`: Node's agent loop (`agentLoop`) over a provider that refuses the turn's image once ("Could not process
//   image", status 400) and answers the replay: the request-local strip settles with the intentional
//   `image_strip_nonpersistent_rebaseline` row (send-phase.mjs `settleImageStrip`). Kept: every request's message count
//   and image count, the `cache_break` rows of the local trace file, and the `[cache-break]` stderr lines.
// - `payloads`: `traceCacheBreak` over records that reach every field of `buildCacheBreakPayload` and the stderr line
//   (text cleaning, hash cut, number coercion, the null drop), with the row it hands its trace function.
//
//   node benchmarks/rust-core/recorders/record-cache-break.mjs --tree <exact export of b6f10295a>
// Output: native/core/fixtures/cache-break/golden.json
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recorderProvenance } from './lib/provenance.mjs';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-cache-break.mjs';
const T0 = 1700000000000;

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
const root = mkdtempSync(join(tmpdir(), 'mixdog-cache-break-'));
process.env.MIXDOG_DATA_DIR = root;
process.env.MIXDOG_DIAGNOSTICS = '1';
delete process.env.NODE_TEST_CONTEXT;
Date.now = () => T0;

const orch = 'src/runtime/agent/orchestrator';
const { drainAgentTrace } = await importFrom(tree, `${orch}/agent-trace-io.mjs`);
const { traceCacheBreak } = await importFrom(tree, `${orch}/cache-break-trace.mjs`);
const { agentLoop } = await importFrom(tree, `${orch}/session/agent-loop.mjs`);

const stderrLines = [];
const writeStderr = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => {
  const text = String(chunk);
  for (const line of text.split('\n')) if (line.startsWith('[cache-break] ')) stderrLines.push(line);
  return writeStderr(chunk, ...rest);
};

const tracePath = join(root, 'history', 'agent-trace.jsonl');
const traceRows = () => {
  try {
    return readFileSync(tracePath, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

// The loop: the system prompt and one user turn with an image; the first send is refused, the replay answers.
const images = (message) => (Array.isArray(message.content) ? message.content.filter((part) => part?.type === 'image').length : 0);
const requests = [];
const messages = [
  { role: 'system', content: 'Stable instructions.' },
  { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }] },
];
const session = { id: 'sess_cache_break', owner: 'user', provider: 'anthropic', cwd: root, messages: messages.slice() };
await agentLoop(
  {
    name: 'anthropic',
    async send(sent) {
      requests.push({ messages: sent.length, images: sent.reduce((n, m) => n + images(m), 0) });
      if (requests.length === 1) throw Object.assign(new Error('Could not process image'), { status: 400 });
      return { content: 'ok', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2 } };
    },
  },
  messages,
  'claude-test',
  [],
  null,
  root,
  { session, sessionId: session.id }
);
await drainAgentTrace();
const loopRows = traceRows().filter((line) => JSON.parse(line).kind === 'cache_break');
const loopStderr = stderrLines.splice(0);

// The payload builder and the stderr line over every field.
const records = [
  {
    sessionId: 's-all', iteration: 3, classification: 'unexpected\nline', reason: 'prefix\tchanged', source: 'request_prefix',
    provider: 'openai-oauth', model: 'gpt-test', transport: 'websocket', intentionalTransition: 'automatic_compaction',
    index: 4, previousCount: 9, nextCount: '10', previousHash: 'abcdef0123456789abcdef', nextHash: 'fedcba9876543210fedcba',
    previousRequestPrefixHash: '0011223344556677889900', nextRequestPrefixHash: '9988776655443322110011', requestPrefixChanged: true,
    cachedTokens: 1200, promptTokens: 5000, uncachedTokens: 3800, cacheRatio: 0.24, actualCacheMiss: true,
    previousCachedPrefixTokens: 4800, idleMs: 61000, missingPrefixGuardBaseline: true,
    inputPrefixMismatchIndex: 2, inputPrefixMismatchPreviousCount: 7, inputPrefixMismatchCurrentCount: 8,
    inputPrefixMismatchExpectedType: 'message', inputPrefixMismatchExpectedHash: '1234567890abcdef1234',
    inputPrefixMismatchActualType: 'function_call', inputPrefixMismatchActualHash: 'abcdef1234567890abcd',
    changedBlocks: 'tools,s1', markersChanged: false, lostMessageBreakpoints: 'm12',
  },
  { sessionId: 's-empty' },
  { sessionId: '', iteration: '7', classification: '', reason: null, index: null, previousCount: 'x', cachedTokens: '', idleMs: true, missingPrefixGuardBaseline: false, markersChanged: 'yes', requestPrefixChanged: 'true', actualCacheMiss: 1 },
  { sessionId: 's-long', iteration: 1.5, classification: 'c'.repeat(130), model: 'é'.repeat(125), previousHash: '\n\nabc\tdef', changedBlocks: 'none', markersChanged: true },
];
const payloads = records.map((record) => {
  const rows = [];
  const lines = [];
  const payload = traceCacheBreak(structuredClone(record), { traceFn: (row) => rows.push(row), stderrFn: (line) => lines.push(line) });
  return { record, payload, row: rows[0] ?? null, stderr: lines.join('') };
});

process.stderr.write = writeStderr;
rmSync(root, { recursive: true, force: true });

const finalOut = join(FIXTURES_ROOT, 'cache-break');
const out = stageSet(finalOut);
writeJson(join(out, 'golden.json'), {
  note: 'traceCacheBreak: the rows and stderr lines of the image-strip replay of agentLoop, and the payload of every field',
  now: T0,
  loop: { session: session.id, model: 'claude-test', provider: 'anthropic', requests, rows: loopRows, stderr: loopStderr },
  payloads,
});
writeSetManifest(out, {
  set: 'cache-break',
  recorder,
  command: `node ${recorder} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    syntheticInputs: [
      'the loop: a system prompt and one user turn of text and one image; a provider named anthropic whose first send throws "Could not process image" with status 400 and whose second answers "ok"',
      'Date.now fixed at 1700000000000; MIXDOG_DIAGNOSTICS=1 so the local trace file is written',
      'the payload records: synthetic values reaching every buildCacheBreakPayload field',
    ],
    keptWhole: 'the cache_break lines of the local trace file, the [cache-break] stderr lines, each request\'s message and image count, and per payload record its payload, row and stderr line',
  },
});
commitStage(out, finalOut);
console.log(`loopRows=${loopRows.length} stderr=${loopStderr.length} payloads=${payloads.length}`);
process.exit(0);
