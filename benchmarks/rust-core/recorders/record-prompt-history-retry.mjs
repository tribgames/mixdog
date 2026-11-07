#!/usr/bin/env node
// What Node's prompt-history store does when a write-behind flush fails: the REAL
// `appendPromptHistory` (src/tui/prompt-history-store.mjs) with its history directory made
// unwritable, under node:test's mock clock (setTimeout and Date), ticked 1 ms at a time. Each flush
// attempt is stamped where it reaches `mkdir` (the first call of `writeEntriesAsync`).
//   A: one append, six failed flushes, then the directory becomes writable: the gaps between attempts.
//   B: a second append arrives during the second backoff wait: when the next attempt comes.
// Also `writeRetryDelayMs(0..12)`. Rust `session::prompt_history` (`AppendQueue`, `write_retry_delay`)
// must match.
//   node benchmarks/rust-core/recorders/record-prompt-history-retry.mjs [--tree <dir>]
// Output: native/core/fixtures/prompt-history-retry/golden.json.
process.env.TZ = 'UTC';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mock } from 'node:test';
import { FIXTURES_ROOT, commitStage, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const finalDir = join(FIXTURES_ROOT, 'prompt-history-retry');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-prompt-history-retry.mjs';

const root = mkdtempSync(join(tmpdir(), 'prompt-history-retry-'));
process.env.MIXDOG_DATA_DIR = root;
const inTheWay = join(root, 'tui-prompt-history');
const block = () => {
  rmSync(inTheWay, { recursive: true, force: true });
  writeFileSync(inTheWay, 'in the way');
};
const unblock = () => rmSync(inTheWay, { recursive: true, force: true });

const stamps = [];
let onAttempt = () => {};
const realMkdir = fsp.mkdir;
// Real file I/O takes real time, which the mock clock does not count: a tick waits until the
// attempt in flight has failed, so the gaps are the timers' and not the disk's.
let inFlight = 0;
fsp.mkdir = (...args) => {
  // Only the store's own call (mode 0o700); the atomic writer makes its own directories too.
  if (args[1]?.mode !== 0o700) return realMkdir(...args);
  stamps.push(Date.now());
  onAttempt(stamps.length);
  inFlight += 1;
  return realMkdir(...args).finally(() => {
    inFlight -= 1;
  });
};
syncBuiltinESMExports();

mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
const settle = () => new Promise((done) => setImmediate(done));
async function run(ms, until = () => false) {
  for (let i = 0; i < 10; i += 1) await settle();
  for (let i = 0; i < ms && !until(); i += 1) {
    mock.timers.tick(1);
    await settle();
    while (inFlight) await settle();
    for (let j = 0; j < 3; j += 1) await settle();
  }
}
const gaps = () => stamps.slice(1).map((stamp, i) => stamp - stamps[i]);

const load = (tag) => import(pathToFileURL(join(tree, 'src', 'tui', 'prompt-history-store.mjs')).href + '?' + tag);

// A
let store = await load('a');
block();
const startA = Date.now();
onAttempt = (n) => {
  if (n === 7) unblock();
};
store.appendPromptHistory(join(root, 'proj-a'), 'first');
await run(400_000, () => stamps.length >= 7);
await run(100_000);
const scenarioA = { firstAttemptAtMs: stamps[0] - startA, attempts: stamps.length, gapsMs: gaps() };

// B
stamps.length = 0;
store = await load('b');
block();
const cwd = join(root, 'proj-b');
let startB = Date.now();
onAttempt = (n) => {
  if (n === 5) unblock();
};
store.appendPromptHistory(cwd, 'first');
await run(400_000, () => stamps.length >= 2);
const secondAttemptAt = stamps[1];
await run(100);
store.appendPromptHistory(cwd, 'second');
await run(400_000, () => stamps.length >= 3);
const thirdAttemptAfterArrivalMs = stamps[2] - Date.now() + 0;
const scenarioB = { secondAttemptAtMs: secondAttemptAt - startB, arrivedAfterSecondAttemptMs: 100, thirdAttemptAfterSecondAttemptMs: stamps[2] - secondAttemptAt, backoffWouldHaveBeenMs: store.writeRetryDelayMs(2) };
await run(300_000, () => stamps.length >= 5);
await run(100_000);
mock.timers.reset();

const golden = {
  retryDelaysMs: Object.fromEntries(Array.from({ length: 13 }, (_, n) => [n, store.writeRetryDelayMs(n)])),
  windowMs: 250,
  scenarioA,
  scenarioB,
};
writeJson(join(stage, 'golden.json'), golden);
writeSetManifest(stage, { set: 'prompt-history-retry', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);