#!/usr/bin/env node
// How Node's relay push lane frames terminal output for a phone (b6f10295a, `remote-relay-push-lanes.ts:82-101`: a TerminalDataBufferer with
// `{ delayMs: 16, leadingEdge: true }`, every frame acknowledged as it is sent), on a virtual clock: a scripted sequence of output chunks at
// scripted times goes through the real lane, and each frame it sends is recorded with the time it was sent. The chunks are bytes, decoded
// per tab as node-pty decodes the PTY's output (a socket with setEncoding('utf8'), i.e. a StringDecoder). The script covers chunks 15, 16
// and 17 ms after a frame, a chunk over the 256 Ki-unit frame cap (cut between characters and inside a surrogate pair), a character split
// across chunks (sent apart and joined), two tabs interleaved, and an exit line and a disposal in between (the lane sees only the exit
// line: it never releases a tab). mixdog-spawn `service::relay_buffer` replays the same steps on its passed-in clock.
//
//   node --import ./apps/desktop/scripts/test-env.mjs --import ./apps/desktop/scripts/test-tsx.mjs \
//     benchmarks/rust-core/recorders/record-relay-framing.mjs --tree <git archive of b6f10295a with node_modules>
import { StringDecoder } from 'node:string_decoder';
import { join } from 'node:path';
import { REPO_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const REF = 'b6f10295a2f698afc85332467192de28500bd146';
const tree = resolveTree(parseArgs());

// The virtual clock: the lane's timers and its `performance.now()` read it; it moves only to the next step or the next due timer.
let clock = 0;
let nextTimer = 1;
const timers = new Map();
globalThis.setTimeout = (fn, ms, ...rest) => {
  const id = nextTimer++;
  timers.set(id, { due: clock + Math.max(0, ms), run: () => fn(...rest), id });
  return id;
};
globalThis.clearTimeout = (id) => void timers.delete(id);
performance.now = () => clock;
/** Runs every timer due by `until`, earliest first (a timer added by one that runs is run too when due). */
const runTimers = (until) => {
  for (;;) {
    const next = [...timers.values()].filter((timer) => timer.due <= until).sort((a, b) => a.due - b.due || a.id - b.id)[0];
    if (!next) break;
    timers.delete(next.id);
    clock = next.due;
    next.run();
  }
  clock = until;
};

const { createRelayPushLanes } = await importFrom(tree, 'apps/desktop/src/main/remote-relay-push-lanes.ts');

// A segment is `{ text, times }` (the text repeated) or `{ hex }` (raw bytes: half a character).
const CAP = 256 * 1024;
const exitLine = (code) => ({ text: `\r\n[process exited with code ${code}]\r\n` });
const steps = [
  { at: 0, tab: 'A', bytes: [{ text: 'a0' }] },
  { at: 3, tab: 'B', bytes: [{ text: 'b0' }] },
  { at: 10, tab: 'B', bytes: [{ text: 'b1' }] },
  // 15 ms after A's frame: it waits until 16 ms after it.
  { at: 15, tab: 'A', bytes: [{ text: 'a1' }] },
  // 16 ms after A's frame at 16: at once.
  { at: 32, tab: 'A', bytes: [{ text: 'a2' }] },
  // A character split across chunks, sent apart: B's last frame was at 19, so the first half goes at once with its 'x'.
  { at: 40, tab: 'B', bytes: [{ text: 'x' }, { hex: 'f09f' }] },
  { at: 41, tab: 'B', bytes: [{ hex: '9880' }, { text: 'y' }] },
  // 17 ms after A's frame at 32: at once.
  { at: 49, tab: 'A', bytes: [{ text: 'a3' }] },
  { at: 50, tab: 'A', bytes: [{ text: 'a4' }] },
  { at: 55, tab: 'A', bytes: [{ text: 'a5' }] },
  // A character split across chunks that join in one frame.
  { at: 60, tab: 'B', bytes: [{ text: 'p' }, { hex: 'f09f' }] },
  { at: 62, tab: 'B', bytes: [{ hex: '9880' }, { text: 'q' }] },
  // Output, then the exit line within 16 ms: one frame when due.
  { at: 70, tab: 'A', bytes: [{ text: 'bye' }] },
  { at: 72, tab: 'A', bytes: [exitLine(0)], exit: true },
  // A disposal (nothing reaches the lane), then the killed shell's last output and its exit line.
  { at: 80, tab: 'B', dispose: true },
  { at: 85, tab: 'B', bytes: [{ text: 'after' }] },
  { at: 86, tab: 'B', bytes: [exitLine(-1073741510)], exit: true },
  // Over the cap: the frame is cut at 256 Ki units, between characters, and the rest follows at once.
  { at: 100, tab: 'C', bytes: [{ text: 'c' }] },
  { at: 101, tab: 'C', bytes: [{ text: 'z', times: CAP + 10 }] },
  // Over the cap with a non-BMP character on the cut: Node's frame ends with its high surrogate and the next starts with the low one.
  { at: 200, tab: 'D', bytes: [{ text: 'd' }] },
  { at: 201, tab: 'D', bytes: [{ text: 'a', times: CAP - 1 }, { text: '😀b' }] },
];
const bytesOf = (segments) =>
  Buffer.concat(segments.map((segment) => (segment.hex !== undefined ? Buffer.from(segment.hex, 'hex') : Buffer.from(segment.text.repeat(segment.times ?? 1), 'utf8'))));

/** A frame as a phone holds it: the lone units at its edges apart, and its text as runs of one character (`[char, count]`). */
function frameOf(data) {
  const first = data.charCodeAt(0);
  const last = data.charCodeAt(data.length - 1);
  const lead = first >= 0xdc00 && first <= 0xdfff ? first : null;
  const tail = data.length > (lead === null ? 0 : 1) && last >= 0xd800 && last <= 0xdbff ? last : null;
  const text = data.slice(lead === null ? 0 : 1, tail === null ? data.length : -1);
  const runs = [];
  for (const char of text) {
    const top = runs.at(-1);
    if (top && top[0] === char) top[1] += 1;
    else runs.push([char, 1]);
  }
  return { lead, runs, tail };
}

const frames = [];
let listener = null;
const lanes = createRelayPushLanes({
  clients: new Map([['phone', { lanes: new Set(['terminal']), channel: {} }]]),
  broadcastEncrypted: (payload) => {
    if (payload?.event === 'termData') frames.push({ at: clock, tab: payload.payload.id, ...frameOf(payload.payload.data) });
  },
  subscribeTerminalData: (fn) => {
    listener = fn;
    return () => (listener = null);
  },
});
const decoders = new Map();
for (const step of steps) {
  runTimers(step.at);
  if (!step.bytes) continue;
  if (!decoders.has(step.tab)) decoders.set(step.tab, new StringDecoder('utf8'));
  const data = decoders.get(step.tab).write(bytesOf(step.bytes));
  if (data) listener({ id: step.tab, data });
}
runTimers(Number.MAX_SAFE_INTEGER);
lanes.dispose();

const finalOut = join(REPO_ROOT, 'apps', 'mobile', 'fixtures', 'relay-framing');
const out = stageSet(finalOut);
writeJson(join(out, 'golden.json'), {
  note: "Node's relay push lane on a virtual clock: the steps (bytes per tab at a time in ms; `exit` after the exit line, `dispose` reaching nothing) and every frame it sent, with its time, the lone UTF-16 units at its edges and its text as runs of one character.",
  steps,
  frames,
});
writeSetManifest(out, {
  set: 'relay-framing',
  recorder: 'benchmarks/rust-core/recorders/record-relay-framing.mjs',
  command: `node --import ./apps/desktop/scripts/test-env.mjs --import ./apps/desktop/scripts/test-tsx.mjs benchmarks/rust-core/recorders/record-relay-framing.mjs --tree <git archive of ${REF} (src, apps) with node_modules>`,
  identity: exactProductIdentity(tree, REF),
  extra: { frames: frames.length },
});
commitStage(out, finalOut);
console.log(`relay-framing: ${frames.length} frames`);
