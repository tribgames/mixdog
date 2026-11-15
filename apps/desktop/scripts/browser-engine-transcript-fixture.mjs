// Turns the engine transcript the host recorded (MIXDOG_BROWSER_TRANSCRIPT, `engine-<pid>.jsonl`: one row per request the core made
// (`in`), per answer the host gave (`out`) and per notification the host volunteered (`push`)) into the replay the Rust golden test
// reads (native/core/fixtures/desktop-host/browser-engine-transcript.jsonl: one row per call with its answer, the pushes that
// came before the answer ahead of it; see crates/mixdog-browser-engine/src/fake.rs).
//
//   node apps/desktop/scripts/browser-engine-transcript-fixture.mjs <engine-pid.jsonl> <browser-engine-transcript.jsonl>
//
// The recording comes from a run of the golden twin on the core harness (`--engine core`, every step the same as the corpus): the
// session the harness used is named as the replay's thread; each call keeps the time its answer was given (`t`).
import { readFileSync, writeFileSync } from 'node:fs';

const HARNESS_SESSION = 'core-harness-session';
const REPLAY_SESSION = 'golden-bridge';
const PUSH_KINDS = {
  'host/browser/events': 'events',
  'host/browser/page/facts': 'facts',
  'host/browser/userInput': 'userInput',
};

const [from, to] = process.argv.slice(2);
if (!from || !to) {
  console.error('usage: browser-engine-transcript-fixture.mjs <engine-pid.jsonl> <browser-engine-transcript.jsonl>');
  process.exit(2);
}

const rows = readFileSync(from, 'utf8')
  .split('\n')
  .filter((line) => line.trim())
  .map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${from}: line ${index + 1} is not JSON: ${error.message}`);
    }
  });

const calls = [];
const waiting = new Map();
let pushes = [];
for (const row of rows) {
  if (row.dir === 'in') {
    const call = { method: row.method, params: row.params, pushes: [] };
    calls.push(call);
    if (!waiting.has(row.method)) waiting.set(row.method, []);
    waiting.get(row.method).push(call);
  } else if (row.dir === 'push') {
    const push = PUSH_KINDS[row.method];
    if (!push) throw new Error(`a push of ${row.method} has no kind in the replay`);
    pushes.push({ push, params: row.params });
  } else if (row.dir === 'out') {
    const call = waiting.get(row.method)?.shift();
    if (!call) throw new Error(`an answer of ${row.method} has no request`);
    if (row.error) call.error = row.error;
    else call.result = row.result === undefined ? null : row.result;
    call.pushes = pushes;
    call.t = row.t;
    pushes = [];
  } else {
    throw new Error(`unknown row direction ${row.dir}`);
  }
}
for (const [method, left] of waiting) {
  if (left.length) throw new Error(`${left.length} request(s) of ${method} were never answered`);
}

const lines = [];
for (const call of calls) {
  for (const push of call.pushes) lines.push(JSON.stringify(push));
  const row = { method: call.method, ...(call.params === undefined ? {} : { params: call.params }) };
  // `t` (when the host answered, epoch milliseconds) is the engine's clock in the replay.
  lines.push(JSON.stringify({ ...row, ...(call.error ? { error: call.error } : { result: call.result }), t: call.t }));
}
// The upload fixture of the recording run is a file of its profile folder: the replay names it `<UPLOAD>`, and the test puts the path
// its corpus request names in its place.
// (the host canonicalised it, `\\?\` led on Windows; the test's file port hands the path over as it is).
const UPLOAD_PATH = /(?:\\\\\\\\\?\\\\)?[A-Za-z]:[^"]*?mixdog-browser-golden-profile-[A-Za-z0-9]+(?:\\\\|\/)browser-upload-fixture\.txt/g;
writeFileSync(to, `${lines.join('\n').replaceAll(HARNESS_SESSION, REPLAY_SESSION).replace(UPLOAD_PATH, '<UPLOAD>')}\n`);
console.log(`${calls.length} calls, ${lines.length} rows -> ${to}`);
