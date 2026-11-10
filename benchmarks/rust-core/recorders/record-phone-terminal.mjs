#!/usr/bin/env node
// What the phone's terminal and folder-watch calls and pushes answer at the Node baseline (b6f10295a): the real remote methods
// (`createRemoteMethods` and `executeRemoteFrame`, the frame a phone sends), over the real desktop operations (a real TerminalManager
// on Node's real PTY (ConPTY) and the machine's own shell, the real shell-profile detection and folder-watch registry), with the real relay push lanes projecting the
// events. The script is lib/phone-terminal-script.mjs; apps/mobile replays it through the protocol adapter against a built mixdogd.
//
//   node benchmarks/rust-core/recorders/record-phone-terminal.mjs --tree <git archive of b6f10295a with node_modules>
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REPO_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { callEntry, immediateScript, play, record, sizeClaimScript, terminalScript } from './lib/phone-terminal-script.mjs';
import { varianceReport } from './lib/trace-variance.mjs';
import { assertNoPowerShellProfile, isolatedProfile } from './lib/shell-isolation.mjs';

const REF = 'b6f10295a2f698afc85332467192de28500bd146';
const ROOT = 'D:\\mixdog-build\\tmp\\ph2-terminal';
const CONNECTION = 'conn-1';
const TRACE_START = '@@TRACE@@';
const TRACE_END = '@@END@@';
// A wait that never ends fails with what it waited for. These are the real timers, taken before the recording's virtual clock replaces them.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const WAIT_MS = 60_000;
// A touched file's content changes with every touch (what the watcher reports is the change, not the time).
let touches = 0;
const RECORDING_MS = 15 * 60_000;
// Why the comparison takes the PowerShell disposal pair out on every allow-listed tab and not only where the five kept runs differ.
const DISPOSAL_PAIR_EVIDENCE =
  'A 20-run recording with this recorder (the script before 17658be467: 116 entries, runs.json sha256 fe8fe7060db1b780fc67c4507b06f97a91911e6a7db3253b2f830d153dea03fb, not kept in the repository) had a running/null pair after the dispose answer on term_ph2a in 25 of 60 disposals, term_ph2_l1 2/20, term_ph2_l2 5/20, term_ph2_l4 2/20, term_ph2_l5 6/20, term_ph2_l6 3/20, term_ph2_i1 3/20, term_ph2_i2 0/20, and never on a non-PowerShell tab; the mechanism (PSConsoleHostReadLine C marker against the console close) is the same on every PowerShell tab at its prompt.';
/** The recording's ConPTY shells are children of the child: the whole tree ends. A pid that no longer exists is fine (taskkill answers 128 for it);
 *  any other status, or a killer that does not finish in 30 s, is a tree left running. */
function endTree(child) {
  const ended = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  // 255 is what taskkill answers when a descendant ended on its own while the tree was being ended ("no running instance of the task"); it is
  // the same outcome as long as the root itself is gone, which is checked, not assumed.
  const rootGone = () => {
    try {
      process.kill(child.pid, 0);
      return false;
    } catch {
      return true;
    }
  };
  if (ended.error || (ended.status !== 0 && ended.status !== 128 && !(ended.status === 255 && rootGone()))) {
    throw new Error(`taskkill did not end the recording's process tree (pid ${child.pid}) within 30000 ms (status ${ended.status}): ${ended.error?.message ?? `${ended.stdout}${ended.stderr}`}`);
  }
}
const args = parseArgs();
const tree = resolveTree(args);

if (!args.has('child')) {
  // The recording runs in a process of its own (the test environment's loader hooks only a fresh process takes). Node's real PTY
  // (ConPTY) leaves that process alive at exit, so the parent waits for the trace's end marker, which is the child's own completion
  // signal, and then ends the child it started.
  // The shells run with a profile folder the recording owns (lib/shell-isolation.mjs): a new folder for each run, allocated beside the
  // run's work folder and removed when the run ends, whatever its outcome.
  const recordOnce = async () => {
  const PROFILE = mkdtempSync(`${ROOT}-profile-`);
  try {
    return await recordIn(PROFILE);
  } finally {
    rmSync(PROFILE, { recursive: true, force: true });
  }
  };
  const recordIn = async (PROFILE) => {
  const env = { ...process.env, ...isolatedProfile(PROFILE) };
  assertNoPowerShellProfile(env);
  const here = fileURLToPath(import.meta.url);
  const hook = (rel) => pathToFileURL(join(REPO_ROOT, rel)).href;
  const child = spawn(
    process.execPath,
    ['--import', hook('apps/desktop/scripts/test-env.mjs'), '--import', hook('apps/desktop/scripts/test-tsx.mjs'), here, '--tree', tree, '--child'],
    { stdio: ['ignore', 'pipe', 'pipe'], env }
  );
  const trace = await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const deadline = realSetTimeout(
      () => reject(Object.assign(new Error(`the recording sent no end marker (${TRACE_END}) within ${RECORDING_MS} ms:\n${stdout.slice(-2000)}\n${stderr.slice(-4000)}`), { output: { stdout, stderr } })),
      RECORDING_MS
    );
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
      const end = stdout.indexOf(TRACE_END);
      if (end < 0) return;
      realClearTimeout(deadline);
      resolve(JSON.parse(stdout.slice(stdout.lastIndexOf(TRACE_START, end) + TRACE_START.length, end)));
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.once('exit', (status) => {
      realClearTimeout(deadline);
      reject(Object.assign(new Error(`recording failed (${status}):\n${stdout.slice(-2000)}\n${stderr.slice(-4000)}`), { output: { stdout, stderr } }));
    });
  }).then(
    (value) => {
      endTree(child);
      return value;
    },
    (failure) => {
      // The recording's own failure is the one that explains; a tree left running is reported beside it.
      try {
        endTree(child);
      } catch (left) {
        console.error(left.message);
      }
      throw failure;
    }
  );
  return trace;
  };
  // Node is recorded `--runs` times (default 5), every run kept (runs.json): what all runs agree on is compared exactly and only what they
  // disagree on varies, within what they recorded (remote-protocol-terminal-compare.mjs). No run is dropped and no batch is picked.
  const runs = Number(args.get('runs') ?? 5);
  const traces = [];
  for (let run = 1; run <= runs; run += 1) {
    try {
      traces.push(await recordOnce());
    } catch (failure) {
      // The whole failure (the child's output tails are in its message) and which run it was, kept beside the work folder.
      const log = `${ROOT}-failure-run${run}-pid${process.pid}.log`;
      const output = failure?.output ? `\n--- the recording's stdout ---\n${failure.output.stdout}\n--- its stderr ---\n${failure.output.stderr}\n` : '';
      writeFileSync(log, `run ${run} of ${runs}\n${failure?.stack ?? String(failure)}\n${output}`);
      throw new Error(`run ${run} of ${runs} failed; the whole error is in ${log}`, { cause: failure });
    }
  }
  const trace = traces[0];
  const variance = { runs, ...varianceReport(traces) };
  // `--out` writes the set elsewhere (a probe of Node's variance over more runs than the fixture keeps).
  const finalOut = args.get('out') ?? join(REPO_ROOT, 'apps', 'mobile', 'fixtures', 'phone-terminal');
  const out = stageSet(finalOut);
  writeJson(join(out, 'golden.json'), {
    note: 'Node terminal and folder-watch calls and pushes as a phone sees them: one ordered list of each call\'s answer or error text, each push its listeners got and each output frame. Output no answered call causes is waited for before the next call (see the manifest\'s `settled` and lib/phone-terminal-script.mjs); every run is in runs.json.',
    root: ROOT,
    trace,
  });
  writeJson(join(out, 'variance.json'), variance);
  writeJson(join(out, 'runs.json'), traces.map((run) => ({ order: run.order, claims: { order: run.claims.order }, immediate: { order: run.immediate.order } })));
  writeSetManifest(out, {
    set: 'phone-terminal',
    recorder: 'benchmarks/rust-core/recorders/record-phone-terminal.mjs',
    command: `node benchmarks/rust-core/recorders/record-phone-terminal.mjs --tree <git archive of ${REF} (src, apps) with node_modules>`,
    identity: exactProductIdentity(tree, REF),
    extra: {
      entries: trace.order.length,
      settled:
        'Output no answered call causes (a resize re-render, a prompt after idle, a closing output against the next dispose) is waited for before the next call: its place among later calls is call latency, 0 ms in this in-process recorder and a socket round trip for a phone. The immediate part keeps the answer-ordered sequences (ensure then first output, dispose then closing output) unsettled.',
      // The script the runs were played from, as read by this recording (a later edit of the script shows as a different hash).
      scriptSha256: createHash('sha256').update(readFileSync(new URL('./lib/phone-terminal-script.mjs', import.meta.url))).digest('hex'),
      disposalPairEvidence: DISPOSAL_PAIR_EVIDENCE,
    },
  });
  commitStage(out, finalOut);
  console.log(`phone-terminal: ${trace.order.length} entries`);
  process.exit(0);
}

rmSync(ROOT, { recursive: true, force: true });
const script = terminalScript(ROOT);
for (const dir of [script.cwd, script.watched, join(ROOT, 'userdata')]) mkdirSync(dir, { recursive: true });
// A path without a drive resolves onto the working directory's: the replay's core runs in the same folder.
process.chdir(ROOT);

const { createDesktopOperations } = await importFrom(tree, 'apps/desktop/src/main/desktop-operations.ts');
const { createRemoteMethods, executeRemoteFrame } = await importFrom(tree, 'apps/desktop/src/main/remote-methods.ts');
const { createRelayPushLanes } = await importFrom(tree, 'apps/desktop/src/main/remote-relay-push-lanes.ts');
const { createRelayEncryptedDelivery } = await importFrom(tree, 'apps/desktop/src/main/remote-relay-delivery.ts');
const { remoteTerminalRun, TERMINAL_RUN_REQUESTED_DESKTOP_EVENT } = await importFrom(tree, 'apps/desktop/src/shared/terminal-command.ts');

// The size-claim leases are Node timers of exactly 30 s (terminal-manager.ts SIZE_OWNER_LEASE_MS); they run on a virtual clock the script steps,
// and every other timer (the relay's 16 ms output buffer, the shells') stays real.
const LEASE_MS = 30_000;
const virtual = { on: false, now: 0, timers: new Set() };
const realTimers = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
globalThis.setTimeout = function (fn, ms, ...rest) {
  if (!virtual.on || ms !== LEASE_MS) return realTimers.setTimeout(fn, ms, ...rest);
  const timer = { due: virtual.now + ms, run: () => fn(...rest), unref: () => timer, ref: () => timer, hasRef: () => true };
  virtual.timers.add(timer);
  return timer;
};
globalThis.clearTimeout = (timer) => (virtual.timers.delete(timer) ? undefined : realTimers.clearTimeout(timer));
const tickVirtual = (ms) => {
  virtual.now += ms;
  for (;;) {
    const due = [...virtual.timers].filter((timer) => timer.due <= virtual.now).sort((a, b) => a.due - b.due)[0];
    if (!due) return;
    virtual.timers.delete(due);
    due.run();
  }
};

// The phone's connection as the relay holds it: its lanes decide which pushes it reads. Every frame for the phone leaves through the relay's
// own `sendEncryptedFrame` (remote-relay-delivery.ts), whose transport records it: replies, terminal data and every other push in the one
// order they were sent.
const sentFrames = [];
const transportOf = (connection) => ({
  async send(payload) {
    if (connection === CONNECTION) sentFrames.push(payload);
    return 1;
  },
});
const state = { lanes: new Set(), channel: {}, transport: transportOf(CONNECTION) };
const clients = new Map([[CONNECTION, state]]);
const registry = { clients, get: (id) => clients.get(id), close: () => {} };
const events = { activity: [], sizeOwner: [], folder: [], run: [], order: [], output: {} };
const waiting = new Set();
const changed = () => {
  for (const check of [...waiting]) check();
};
const desktopListeners = new Set();
// What the phone's page hears of each push: the shim's dispatch (renderer/remote-shim-dispatch.ts, b6f10295a) read it through these.
const { readTerminalActivityEvent } = await importFrom(tree, 'apps/desktop/src/shared/terminal-activity.ts');
const { readRemoteTerminalRun } = await importFrom(tree, 'apps/desktop/src/shared/terminal-command.ts');
const pushes = {
  termActivity: (payload) => {
    const event = readTerminalActivityEvent(payload);
    if (event) record(events, 'activity', event);
  },
  termSizeOwner: (payload) =>
    record(events, 'sizeOwner', { id: String(payload.id || ''), cols: Number(payload.cols) || 0, rows: Number(payload.rows) || 0, own: payload.own === true }),
  folderChanged: (payload) => {
    if (String(payload || '')) record(events, 'folder', String(payload));
  },
  terminalRunRequested: (payload) => {
    const request = readRemoteTerminalRun(payload);
    if (request) record(events, 'run', request);
  },
};
// The terminal's output reaches the page through the relay's own 16 ms buffer, in chunks whose boundaries are timing; the page's text is
// what they concatenate to.
pushes.termData = (payload) => {
  const id = String(payload.id || '');
  const data = String(payload.data ?? '');
  events.order.push({ push: 'termData', event: { id, data } });
  events.output[id] = (events.output[id] ?? '') + data;
};
// A frame as the relay's transport took it: a reply (`id`, `ok`) answers the call that sent it; anything else is a push the page's listener hears.
const calls = new Map();
const received = () => {
  for (const frame of sentFrames.splice(0)) {
    if ('ok' in frame && 'id' in frame) {
      const { name, params } = calls.get(frame.id);
      calls.delete(frame.id);
      events.order.push(callEntry(name, params, frame.ok ? { value: frame.value ?? null } : { error: frame.error }));
    } else pushes[frame.event](frame.payload);
  }
  changed();
};
const delivery = createRelayEncryptedDelivery({ clients: registry, relayBinaryFrames: () => false, relayFrameLimit: () => Infinity, sendRawAndWait: async () => {}, byteMeter: { record: () => null } });
const emit = (event) => {
  for (const listener of [...desktopListeners]) listener(event);
};
// The relay names this leg by the same id the size-owner events carry.
const operations = createDesktopOperations({
  userDataPath: join(ROOT, 'userdata'),
  packaged: false,
  resourcesPath: '',
  appPath: '',
  loadConfig: async () => ({}),
  emit,
});
const lanes = createRelayPushLanes({
  clients,
  broadcastEncrypted(frame, droppable, include) {
    delivery.broadcastEncrypted(frame, droppable, include);
    received();
  },
  subscribeDesktopEvents: (listener) => {
    desktopListeners.add(listener);
    return () => desktopListeners.delete(listener);
  },
  subscribeTerminalData: (listener) => operations.subscribeTerminalData(listener),
});
// The relay's data push goes through its own 16 ms buffer; the text the page gets is the output as it was written.
// A disposed tab's shell is killed and its exit text arrives a moment later; a marker it wrote before dying makes Node push a late activity
// event for it, so the first script's tabs must have exited before the second script turns the lane on again.
const ensured = new Set();
const exited = new Set();
operations.subscribeTerminalData((event) => {
  if (event.data.includes('[process exited with code')) {
    exited.add(event.id);
    changed();
  }
});
const methodsOf = (connection) =>
  createRemoteMethods(
    { host: { invokeDesktopOperation: (name, params) => operations.invoke(name, params) }, userDataPath: join(ROOT, 'userdata'), terminals: operations.terminals },
    { connectionId: () => connection }
  );
const methods = methodsOf(CONNECTION);
// A second paired connection, for the size-claim cases: it reads no lane, and closing it only removes it from the relay's client table.
const OTHER = 'conn-2';
const otherMethods = methodsOf(OTHER);
let frameId = 0;
const driver = {
  async call(name, params) {
    if (name === 'termEnsure' && typeof params[0] === 'string') ensured.add(params[0]);
    const id = ++frameId;
    calls.set(id, { name, params });
    const response = await executeRemoteFrame(methods, JSON.stringify({ id, method: name, params }));
    // The relay's own send of the answer (remote-relay-client-calls.ts), which is where the reply is recorded.
    await delivery.sendEncryptedFrame(CONNECTION, response);
    received();
    if (!response.ok) throw new Error(response.error);
    return response.value;
  },
  recordsReplies: true,
  fire(name, params, from) {
    void executeRemoteFrame(from === 'other' ? otherMethods : methods, JSON.stringify({ method: name, params }));
  },
  // The leases are Node timers; the virtual clock holds them from here and `advance` moves it.
  clock() {
    virtual.on = true;
    clients.set(OTHER, { lanes: new Set(), channel: {}, transport: transportOf(OTHER) });
  },
  advance(ms) {
    tickVirtual(ms);
  },
  close(who) {
    if (who === 'other') clients.delete(OTHER);
  },
  lane(lane, on) {
    state.lanes[on ? 'add' : 'delete'](lane);
  },
  touch: (file) => writeFileSync(file, `${(touches += 1)}`),
  run(request, redeliver) {
    // The core's redelivery after a reconnect is not something Node had.
    if (redeliver) return;
    emit({ name: TERMINAL_RUN_REQUESTED_DESKTOP_EVENT, value: remoteTerminalRun(request) });
  },
  waitFor: (test, what) =>
    new Promise((resolve, reject) => {
      const timer = realSetTimeout(() => {
        waiting.delete(check);
        reject(new Error(`timed out after ${WAIT_MS} ms waiting for ${what}`));
      }, WAIT_MS);
      const check = () => {
        if (!test(events)) return;
        realClearTimeout(timer);
        waiting.delete(check);
        resolve();
      };
      waiting.add(check);
      check();
    }),
  events: () => events,
};
// A script that never gets its event ends with the unsettled wait; this says where it stood.
process.on('exit', () =>
  process.stderr.write(`\nstate at exit: ${JSON.stringify({ ...events, output: Object.fromEntries(Object.entries(events.output).map(([id, text]) => [id, text.slice(-200)])) })}\n`)
);
// `play` returns the driver's own event lists; the first trace is copied before the second script reuses them.
const trace = JSON.parse(JSON.stringify(await play(script, driver)));
await driver.waitFor(() => [...ensured].every((id) => exited.has(id)), `the shell of every tab of the first script to exit (${[...ensured].join(', ')})`);
// The size-claim cases run after, on their own tabs; the lists are emptied so the second trace holds its own events, all of them.
for (const list of Object.values(events)) if (Array.isArray(list)) list.length = 0;
events.output = {};
const claimScript = sizeClaimScript(ROOT);
const claimTrace = await play(claimScript, driver);
virtual.on = false;
trace.claims = JSON.parse(JSON.stringify(claimTrace));
// The immediate sequences, on tabs of their own.
for (const list of Object.values(events)) if (Array.isArray(list)) list.length = 0;
events.output = {};
trace.immediate = JSON.parse(JSON.stringify(await play(immediateScript(ROOT), driver)));
// The replay window a late reader gets (TerminalReplayBuffer, 200,000 UTF-16 units), at its boundary: exactly full, one unit over, a
// non-BMP character whose first unit is the one dropped, the same when it arrives in its own chunk, and two-byte characters (units, not bytes).
const { TerminalReplayBuffer } = await importFrom(tree, 'apps/desktop/src/main/terminal-manager.ts');
const EMOJI = '\u{1F600}';
const units = (text) => [...text].map((c) => c.codePointAt(0)).flatMap((cp) => (cp > 0xffff ? [0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff)] : [cp]));
// A chunk is `[text, count]` parts, each text repeated count times.
const part = (...parts) => parts;
trace.replayWindow = [
  { name: 'exactly full', chunks: [part(['a', 199_999]), part(['b', 1])] },
  { name: 'one unit over', chunks: [part(['a', 200_000]), part(['b', 1])] },
  { name: 'cut inside a non-BMP character, one chunk', chunks: [part([EMOJI, 1], ['a', 199_999])] },
  { name: 'cut inside a non-BMP character, its own chunk', chunks: [part([EMOJI, 1]), part(['a', 199_999])] },
  { name: 'non-BMP character wholly inside', chunks: [part(['a', 1]), part([EMOJI, 1], ['b', 199_997]), part(['c', 1])] },
  { name: 'two-byte characters count as one unit', chunks: [part(['\u00e9', 200_001])] },
].map(({ name, chunks }) => {
  const buffer = new TerminalReplayBuffer();
  for (const chunk of chunks) buffer.append(chunk.map(([text, count]) => text.repeat(count)).join(''));
  const read = buffer.read();
  const all = units(read);
  // `json`: the start of the JSON text Node's relay writes for the window (a lone surrogate is an escape there).
  return { name, chunks, length: read.length, head: all.slice(0, 4), tail: all.slice(-4), json: JSON.stringify(read).slice(0, 16), cursor: buffer.cursor, trimmed: buffer.trimmed };
});
await operations.dispose();
lanes.dispose();
process.stdout.write(`\n${TRACE_START}${JSON.stringify(trace)}${TRACE_END}\n`);
// The parent ends this process once it has read the end marker.
