#!/usr/bin/env node
// A built mixdogd driven through the causes Node's phone path was recorded with (`record-frame-order.mjs` →
// `native/core/fixtures/frame-order/golden.json`): a room renamed, a thread marked favorite. Per run the cause and then the marker
// are sent back to back, as the recorder sends them; every frame the connection gets from the cause's send until both answers is
// named the way the recording names Node's (`answer:cause`, `answer:marker`, `event:<name>`), each frame on its own (one core
// frame is one publication), and that whole order must be one of the orders Node's phone got. A frame without a name fails the run;
// the only kind left out is `core/health/updated` (UNRELATED; listed with its reason in the set's manifest), each one printed.
//
// One connection carries one order on the core (the transport's writer, the same for a WebSocket and a relay connection: hub.rs
// `attach`), so the replay runs over the app-server socket. Readers: `prompt`, and `stalled`: the socket is not read from before the
// cause is sent until the cause's publication and the marker's place are proven (a second connection's view), then drained. The
// recorder's stall is a barrier on Node's own socket writes; a client of a built core cannot hold the core's socket write (the
// kernel's buffers take these frames), and a backlog of calls to fill them is no stimulus Node takes (it closes a phone with more
// than 256 calls unanswered, remote-relay-clients.ts:214-218). The core's withheld write is therefore tested where it can be held,
// at the transport's socket (mixdog-app-server-transport order tests, every recorded run).
//
// Not replayed here: `terminal-dispose` and `activity-after-answer` wait on the terminal branch (o1's core has no `terminal/dispose`
// handler nor terminal activity feed); `state-latest-wins` has no core counterpart (the core has no state mailbox: its droppable
// lanes lag and recover, tested in the transport crate); `thread-favorite` waits on the chat/publication owner and `room-rename`
// on the rooms/catalog publication owner (FEATURE_TIMING below; `--feature-timing` compares them whole and fails until they land).
//
// Every wait is on an event (the discovery file, a frame on a socket, the core's exit) under a deadline naming it. The world is a
// folder of its own; the core is ended through its own stop (`mixdogd ctl stop --when-idle`) and awaited on its exit.
//
//   node benchmarks/rust-core/recorders/replay-frame-order-live.mjs --exe <mixdogd.exe> --harness <real-turn-harness dir> [--only <scenario>] [--runs N]
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, REPO_ROOT, parseArgs } from './lib/common.mjs';
import { endSandbox } from './sandbox-janitor.mjs';

const args = parseArgs();
const exe = args.get('exe');
const harness = args.get('harness');
const only = args.get('only');
const golden = JSON.parse(readFileSync(join(FIXTURES_ROOT, 'frame-order', 'golden.json'), 'utf8'));
const RUNS = Number(args.get('runs') ?? golden.inputs.runs);
const REPLAYED = ['room-rename', 'thread-favorite'];
/** Replayed only with `--feature-timing`: the core publishes a favourite's row from the thread-edges background task
 *  (mixdog-core-session/src/session/thread_edges.rs:299, `ThreadEdges::start`), which the reply does not wait for, so even a
 *  promptly read connection can get the answer first; when a feature queues its event belongs to the chat/publication owner
 *  (Lead, 2026-11-11), not the writer. */
const FEATURE_TIMING = {
  'thread-favorite': 'the chat/publication owner (the row is published by the background task at mixdog-core-session/src/session/thread_edges.rs:299, after the reply)',
  // Node sends one roster frame per catalog publication and none for a publication that changes nothing (remote-relay-catalog.ts:79-91,
  // `isNoListDelta`); a rename on the core publishes the room's row three times and every listed row once more, each frame before
  // the answer (the writer's order holds), so the whole order has four `sessions` events where Node's has one.
  'room-rename':
    "the rooms/catalog publication owner (one rename publishes the room's row at mixdog-core-session/src/session/thread_edges.rs:268 (row write), thread_list.rs:418 (whole listing, via mixdog-core/src/run_host/room_publication.rs:84) and thread_list.rs:480 (room rows, via rooms/service.rs:251), and every other listed row at thread_list.rs:418)",
};
const WAITING = {
  'terminal-dispose': 'the terminal branch (o1 has no terminal/dispose handler)',
  'activity-after-answer': 'the terminal branch (o1 has no terminal activity feed)',
  'state-latest-wins': "no core counterpart (the core has no state mailbox; its droppable lanes' rule is tested in mixdog-app-server-transport)",
};
if (!exe || !existsSync(exe) || !harness) {
  console.error('usage: replay-frame-order-live.mjs --exe <mixdogd.exe> --harness <real-turn-harness dir> [--only <scenario>] [--runs N]');
  process.exit(2);
}
for (const name of Object.keys(golden.scenarios)) {
  if (!REPLAYED.includes(name) && !WAITING[name]) throw new Error(`the recording has a scenario this replay does not know: ${name}`);
}
if (only && !golden.scenarios[only]) throw new Error(`--only ${only}: not a recorded scenario`);
/** Node's name of each core frame. Node sends a catalog publication as one `sessions` roster frame (remote-relay-catalog.ts:77-91);
 *  the core sends one `thread/summary/updated` frame per publication of a row, so each such frame is one `event:sessions`: two
 *  frames are two publications, never folded into one. */
const NODE_NAME = { 'thread/summary/updated': 'event:sessions' };
/** Frames the core may send on any connection at any time that no cause of this replay makes and Node never sends a phone; each one
 *  seen is printed with its run, never compared. Reported for decisions.md (owner: Lead). */
const UNRELATED = {
  'core/health/updated': "the core's stall monitor (app-server-daemon lifecycle/real.rs `health`), published when the runtime stalls",
};

const WebSocket = createRequire(join(REPO_ROOT, 'package.json'))('ws');
const hload = (name) => import(pathToFileURL(join(harness, 'lib', name)).href);
const { daemonEnv, isolatedPaths } = await hload('env.mjs');
const { seedPgRuntime } = await hload('stage.mjs');
const { startFakeProvider } = await hload('fake-provider.mjs');
const { parseDiscovery } = await import(pathToFileURL(join(REPO_ROOT, 'apps/desktop/src/main/protocol/discovery.ts')).href);
const { uuidv7 } = await import(pathToFileURL(join(REPO_ROOT, 'packages/protocol-client/src/client.ts')).href);

const world = mkdtempSync(join(process.env.MIXDOG_RECORDER_SCRATCH ?? 'D:\\mixdog-build\\tmp', 'frame-order-live-'));
const paths = isolatedPaths(world);
const failures = [];
let child = null;
let provider = null;
let coreEnv = null;
let stderr = '';
const sockets = [];

// Resolves with the first truthy `probe()`, tried now and at every event `subscribe` reports; rejects naming `label` at the deadline.
const waitOn = (label, ms, subscribe, probe) =>
  new Promise((resolve, reject) => {
    let done = false;
    let stop = () => {};
    const timer = setTimeout(() => finish(reject, new Error(`${label}: not done after ${ms} ms`)), ms);
    const finish = (settle, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stop();
      settle(value);
    };
    const attempt = async () => {
      try {
        const value = await probe();
        if (value) finish(resolve, value);
      } catch (error) {
        finish(reject, error);
      }
    };
    stop = subscribe(attempt);
    void attempt();
  });

async function endWorld() {
  const ended = [];
  for (const socket of sockets) {
    try {
      socket.terminate();
    } catch (error) {
      ended.push(`closing a socket: ${error.message}`);
    }
  }
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  const onExit = (attempt) => (child.once('exit', attempt), () => child.off('exit', attempt));
  if (child && !exited()) {
    const stop = spawnSync(exe, ['ctl', 'stop', '--when-idle', '--reason', 'quit'], { env: coreEnv, encoding: 'utf8', timeout: 30_000, windowsHide: true });
    if (stop.error || stop.status !== 0) ended.push(`mixdogd ctl stop answered ${stop.error?.message ?? stop.status}: ${stop.stderr}`);
    try {
      await waitOn('mixdogd exiting after its stop', 60_000, onExit, async () => exited());
    } catch (error) {
      // The core this replay started (its pid, recorded at spawn) and every process under it end now.
      ended.push(error.message);
      const kill = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
      if (kill.error || kill.status !== 0) ended.push(`taskkill /T of mixdogd ${child.pid} answered ${kill.error?.message ?? kill.status}: ${kill.stderr}`);
      try {
        await waitOn(`mixdogd ${child.pid} exiting after taskkill`, 30_000, onExit, async () => exited());
      } catch (killError) {
        ended.push(killError.message);
      }
    }
  }
  if (provider) {
    let closed = false;
    try {
      await waitOn('the fake provider closing', 30_000, (attempt) => (provider.close().then(() => (closed = true)).then(attempt, attempt), () => {}), async () => closed);
    } catch (error) {
      ended.push(error.message);
    }
  }
  // What still names the world after its core ended is a failure, named (endSandbox ends nothing it finds by a listing).
  ended.push(...endSandbox(world, 0, paths.dataDir));
  return ended;
}

/** One app-server connection: every frame it gets, in order, and its calls. */
async function connection(endpoint, name) {
  const socket = new WebSocket(endpoint.url, { headers: { Authorization: `Bearer ${endpoint.token}` }, perMessageDeflate: false });
  sockets.push(socket);
  await waitOn(`${name}: the app-server socket opening`, 30_000, (attempt) => (socket.once('open', attempt), socket.once('error', attempt), () => {}), async () => {
    if (socket.readyState === WebSocket.CLOSED) throw new Error(`${name}: the socket closed while opening`);
    return socket.readyState === WebSocket.OPEN;
  });
  const frames = [];
  const listeners = new Set();
  socket.on('message', (data) => {
    frames.push(JSON.parse(data.toString('utf8')));
    for (const listener of [...listeners]) listener();
  });
  const onFrame = (attempt) => (listeners.add(attempt), () => listeners.delete(attempt));
  let nextId = 1;
  const conn = {
    socket,
    frames,
    /** Sends a request; its id. */
    send(method, params) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params }));
      return id;
    },
    until: (label, probe) => waitOn(`${name}: ${label}`, 120_000, onFrame, async () => probe()),
    async call(method, params) {
      const id = conn.send(method, params);
      const frame = await conn.until(`the answer to ${method}`, () => frames.find((f) => f.id === id));
      if (frame.error) throw new Error(`${method}: ${JSON.stringify(frame.error)}`);
      return frame.result;
    },
    op: (method, params) => conn.call(method, { ...params, opId: uuidv7(Date.now()) }),
  };
  await conn.call('initialize', { clientInfo: { name: `frame-order-${name}`, title: 'frame order replay', version: '1.4.5', kind: 'tui' }, capabilities: {} });
  socket.send(JSON.stringify({ method: 'initialized' }));
  await conn.call('app/subscribe', {});
  return conn;
}

try {
  for (const d of [paths.dataDir, paths.runtimeRoot, paths.appData, paths.localAppData, paths.tmp, paths.workspace]) mkdirSync(d, { recursive: true });
  const project = join(paths.workspace, 'p');
  mkdirSync(project, { recursive: true });
  seedPgRuntime(paths.dataDir);
  provider = await startFakeProvider({ workspace: paths.workspace });
  writeFileSync(join(paths.dataDir, 'mixdog-config.json'), JSON.stringify({ agent: { providers: { 'custom-harness': { type: 'custom', schemaVersion: 2, name: 'harness', protocol: 'openai-chat', baseURL: provider.baseURL, auth: 'none', enabled: true, modelOverrides: { 'harness-model': { manual: true } } } } } }));
  const route = { provider: 'custom-harness', model: 'harness-model' };

  coreEnv = daemonEnv(paths, { RUST_LOG: 'warn' });
  // The install layout: the manifest beside the binary names the JS runtime (a build output has none of its own).
  const manifest = join(exe, '..', 'js-runtime.json');
  if (!existsSync(manifest)) writeFileSync(manifest, JSON.stringify({ program: process.execPath, packageRoot: REPO_ROOT }));
  child = spawn(exe, ['serve'], { env: coreEnv, cwd: world, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-20_000);
  });
  const file = join(paths.runtimeRoot, 'daemon.json');
  const endpoint = await waitOn(
    'mixdogd publishing its discovery file',
    120_000,
    (attempt) => {
      const watcher = watch(paths.runtimeRoot, attempt);
      child.once('exit', attempt);
      return () => (watcher.close(), child.off('exit', attempt));
    },
    async () => {
      if (child.exitCode !== null) throw new Error(`mixdogd exited ${child.exitCode}`);
      try {
        return parseDiscovery(readFileSync(file, 'utf8'));
      } catch {
        return null;
      }
    }
  );
  const client = await connection(endpoint, 'client');
  const observer = await connection(endpoint, 'observer');
  /** The last summary row the observer saw for `threadId` matches `ready`. */
  const rowOf = (threadId) => observer.frames.filter((f) => f.method === 'thread/summary/updated' && f.params?.thread?.id === threadId).at(-1)?.params.thread;

  // The world the causes act on, made on the observer's connection (a thread it starts is attached there, not on the client's):
  // a room of two bots, and a thread of a project.
  const saveBot = async (name) => {
    const saved = await observer.op('agent/saveAgentDefinition', { payload: { kind: 'bot', name, description: `${name} bot`, body: `You are ${name}.`, route } });
    return (saved.value ?? saved).id;
  };
  const bots = [await saveBot('Order One'), await saveBot('Order Two')];
  const room = await observer.op('room/create', { input: { name: 'Order room', members: bots } });
  await observer.until('the room log row', () => rowOf(room.sessionId)?.title === 'Order room');
  const thread = (await observer.op('thread/start', { kind: 'project', projectPath: project, draft: { route } })).thread.id;
  // A listed conversation has spoken (Node's favorite session lists two messages): one turn, answered by the harness's model.
  await observer.call('thread/resume', { threadId: thread, window: { lastItems: 200 } });
  await observer.op('turn/start', { threadId: thread, input: { prompt: 'hello order', options: { clientSubmissionId: 'frame-order-hello' } } });
  await observer.until('the turn to complete', () => observer.frames.some((f) => f.method === 'turn/completed' && f.params?.threadId === thread));
  await observer.until('the thread row after its turn', () => rowOf(thread)?.messageCount === 2 && rowOf(thread).activityAt === rowOf(thread).updatedAt);
  // The client has seen every frame of the setup: the observer's row of the thread reached it too.
  const settledRow = (row) => row?.messageCount === 2 && row.activityAt === row.updatedAt;
  await client.until('the setup to reach the client', () => client.frames.some((f) => f.method === 'thread/summary/updated' && f.params?.thread?.id === thread && settledRow(f.params.thread)));

  let renames = 0;
  let favorites = 0;
  const SCENARIOS = {
    'room-rename': {
      subject: room.sessionId,
      cause: () => {
        const name = `Order room ${++renames}`;
        return { id: client.send('room/update', { opId: uuidv7(Date.now()), input: { roomId: room.roomId, name } }), settled: (row) => row?.title === name };
      },
      // The marker: an update of a room that does not exist, an exclusive request of the cause's key (`global("room")`, methods.rs
      // `RoomUpdate`) that publishes nothing. Sent right after the cause, as Node's marker is; the key's queue runs it only after
      // the cause's run ended (Node's call queue ran its marker after the cause in every recorded run).
      marker: () => client.send('room/update', { opId: uuidv7(Date.now()), input: { roomId: 'frame-order-marker-no-room', name: 'none' } }),
      // The same request from the observer, queued on the key after the client's marker: its answer proves the cause's and the
      // marker's runs ended, and each run queues its answer before it ends (server.rs `handle_request`: `work.await` then `finish`).
      fence: async () => {
        const id = observer.send('room/update', { opId: uuidv7(Date.now()), input: { roomId: 'frame-order-fence-no-room', name: 'none' } });
        const frame = await observer.until('the fence after the marker', () => observer.frames.find((f) => f.id === id));
        if (!frame.error) throw new Error(`the fence updated a room: ${JSON.stringify(frame)}`);
      },
    },
    'thread-favorite': {
      subject: thread,
      cause: () => {
        const favorite = ++favorites % 2 === 1;
        // An unset favorite leaves the row without the field.
        return { id: client.send('thread/metadata/update', { opId: uuidv7(Date.now()), threadId: thread, favorite }), settled: (row) => (row?.favorite === true) === favorite };
      },
      marker: () => client.send('project/taskWorkspace', {}),
      // No request of this key proves the marker's answer queued: the stall ends at the cause's publication (this scenario runs
      // only with --feature-timing, waiting on the chat/publication owner).
      fence: async () => {},
    },
  };

  for (const name of only ? [only] : Object.keys(golden.scenarios)) {
    if (WAITING[name]) {
      console.log(`WAITING ${name}: replayed by ${WAITING[name]}`);
      continue;
    }
    if (FEATURE_TIMING[name] && !args.has('feature-timing')) {
      console.log(`WAITING ${name}: replayed by ${FEATURE_TIMING[name]}; run with --feature-timing to see the core's order`);
      continue;
    }
    const scenario = SCENARIOS[name];
    for (const reader of ['prompt', 'stalled']) {
      // Node's orders for this reader, both modes, each distinct one once.
      const recorded = Object.entries(golden.scenarios[name].modes)
        .filter(([mode]) => mode.endsWith(`/${reader}`))
        .flatMap(([, mode]) => mode.orders.map((o) => o.order));
      const nodeOrders = recorded.filter((order, i) => recorded.findIndex((other) => isDeepStrictEqual(other, order)) === i);
      const seen = new Map();
      for (let run = 1; run <= RUNS; run += 1) {
        const from = client.frames.length;
        const observedFrom = observer.frames.length;
        if (reader === 'stalled') client.socket._socket.pause();
        const { id: cause, settled } = scenario.cause();
        const marker = scenario.marker();
        if (reader === 'stalled') {
          await observer.until(`${name}: the cause's publication (run ${run})`, () => observer.frames.slice(observedFrom).some((f) => f.method === 'thread/summary/updated' && f.params?.thread?.id === scenario.subject && settled(f.params.thread)));
          await scenario.fence();
          client.socket._socket.resume();
        }
        await client.until(`${name}: the cause's and the marker's answers (run ${run})`, () => [cause, marker].every((id) => client.frames.slice(from).some((f) => f.id === id)));
        const window = client.frames.slice(from);
        const order = [];
        for (const frame of window) {
          if (UNRELATED[frame.method]) {
            console.log(`${name} (${reader}, run ${run}): unrelated ${frame.method} (${UNRELATED[frame.method]}): ${JSON.stringify(frame)}`);
            continue;
          }
          let named;
          if (frame.id === cause) {
            if (frame.error) throw new Error(`${name}: the cause failed: ${JSON.stringify(frame.error)}`);
            named = 'answer:cause';
          } else if (frame.id === marker) {
            named = 'answer:marker';
          } else {
            named = NODE_NAME[frame.method];
            if (!named) throw new Error(`${name} (${reader}, run ${run}): a frame Node's recording has no name for: ${JSON.stringify(frame)}`);
          }
          order.push(named);
        }
        const key = JSON.stringify(order);
        seen.set(key, (seen.get(key) ?? 0) + 1);
        if (!nodeOrders.some((nodeOrder) => isDeepStrictEqual(nodeOrder, order))) {
          failures.push(`${name} (${reader}, run ${run}): the core's order ${order.join(' > ')} is none of Node's: ${nodeOrders.map((o) => o.join(' > ')).join(' | ')}\nframes: ${JSON.stringify(window)}`);
        }
      }
      console.log(`${name} ${reader}: ${[...seen].map(([order, count]) => `${JSON.parse(order).join(' > ')} x${count}`).join(' | ')}`);
    }
  }
} catch (error) {
  failures.push(`${error.message}${stderr ? `\nmixdogd stderr (tail):\n${stderr.slice(-3000)}` : ''}`);
} finally {
  failures.push(...(await endWorld()));
}
for (const failure of failures) console.error(`FAIL frame-order-live: ${failure}`);
process.exit(failures.length ? 1 : 0);
