// What the windows of THIS checkout do when the core tells them to read their reviews again: the replay half of
// `record-turn-review-signal.mjs`, through the production delivery path and nothing substituted but the socket:
//
//   the core's app-feed frames (`app/snapshot`, then each `review/diff/updated`)
//   -> the client library over its mock connector (`packages/protocol-client`, `connect`)
//   -> the main process's `createProtocolConnection` (its section relay, one push per change)
//   -> each window's `registerProtocolWindowIpc` -> that window's preload (the checkout's own file, bundled and run per window)
//   -> the renderer's section store and the `TurnReviewBar` panes.
//
// A frame is folded, relayed and rendered before the next one is sent, so a second frame in one tell, or a tell split
// across frames, reaches the panes as the separate pushes it would be (the relay coalesces only changes that arrive before
// its flush). Windows attach in the order the recording opened them and panes mount in its order.
//
//   node --import <test-env> --import <test-tsx> review-reread-replay.mjs <checkout> <input.json>
//
// The input comes from the Rust test: the app feed's snapshot frame and, per operation, the deliveries the core made (each the
// frames it published) and after how many answered requests each was made. The requests the bars send are answered with the
// answers Node's recording holds for the same request; one the recording lacks fails the replay by name. Every wait has a
// deadline and names what it waited for. The output is the trace per operation.
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { pathToFileURL } from 'node:url';
import { ReviewWindows, loadWindowKit } from './review-windows.mjs';

const [tree, inputPath] = process.argv.slice(2);
if (!tree || !inputPath) throw new Error('usage: review-reread-replay.mjs <checkout> <input.json>');
const input = JSON.parse(readFileSync(inputPath, 'utf8'));
const fromTree = (rel) => import(pathToFileURL(join(tree, rel)).href);
// The checkout's own protocol package: a workspace link in node_modules may point at another checkout's copy, and the client
// library reads its method table (which notifications are section updates) from it.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@mixdog/protocol') return { url: pathToFileURL(join(tree, 'packages/protocol/src/index.ts')).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const kit = await loadWindowKit(tree);
const { connect, sessionReducer, MockNetwork } = await fromTree('packages/protocol-client/src/index.ts');
const { createProtocolConnection } = await fromTree('apps/desktop/src/main/protocol/connection.ts');
const { registerProtocolWindowIpc } = await fromTree('apps/desktop/src/main/protocol/window-ipc.ts');
const { DESKTOP_IPC } = await fromTree('apps/desktop/src/shared/contract.ts');
const { build } = await import(pathToFileURL(createRequire(join(tree, 'apps/desktop/package.json')).resolve('esbuild')).href);
const preload = (await build({ entryPoints: [join(tree, 'apps/desktop/src/preload/index.ts')], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['electron'] })).outputFiles[0].text;
const options = JSON.parse(readFileSync(join(tree, 'packages/protocol-client/conformance/options.json'), 'utf8'));

const DEADLINE_MS = 30_000;
/** A wait that fails by name instead of hanging; the timer is only the failure path. */
const within = (what, wait) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not happen within ${DEADLINE_MS} ms`)), DEADLINE_MS);
    wait.then(
      (value) => (clearTimeout(timer), resolve(value)),
      (error) => (clearTimeout(timer), reject(error))
    );
  });

const canonical = (value) => JSON.stringify(value, (_key, item) => (item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item));

let unanswered = [];
const windows = new ReviewWindows(kit, async ({ session, request }) => {
  const at = unanswered.findIndex((recorded) => recorded.client === session && canonical(recorded.request) === canonical(request));
  if (at < 0) throw new Error(`the window of ${session} asked ${canonical(request)}, which the recording never saw at this point`);
  return unanswered.splice(at, 1)[0].answer;
});

// The connection to the core: the socket is the only stand-in. The relay's deferrals are run by `flushRelay`, one frame at a time.
const network = new MockNetwork();
const deferred = [];
const connection = createProtocolConnection({
  open: () =>
    connect({
      target: { id: 'core' },
      connector: network,
      clientInfo: options.clientInfo,
      capabilities: options.capabilities,
      threadReducer: sessionReducer,
      clock: { sleep: () => new Promise(() => {}) },
      random: () => options.jitterUnit,
    }),
  defer: (flush) => deferred.push(flush),
});
const flushRelay = async () => {
  await kit.act(async () => {
    while (deferred.length) deferred.shift()();
  });
};
const started = connection.start();
const socket = await within('the client dialing the core', network.accept());
const initialize = JSON.parse(await within('the client sending initialize', socket.nextSent()));
socket.serverSend({ id: initialize.id, result: { ...options.initializeResult, serverInstanceId: 'replay' } });
await within('the client sending initialized', socket.nextSent());
const subscribe = JSON.parse(await within('the client sending app/subscribe', socket.nextSent()));
const feed = input.snapshot.feed;
socket.serverSend({ id: subscribe.id, result: { subscription: { id: 'app', mode: 'snapshot', epoch: feed.epoch, startSeq: feed.seq + 1 } } });
socket.serverSend(input.snapshot);
await within('the connection folding the core\'s app snapshot', Promise.all([started, connection.whenSynced()]));
await flushRelay();

/** One window of the connection per recorded window name: its IPC, its handlers and its preload. */
const appWindows = new Map();
const attachWindow = (name) => {
  const ipc = new EventEmitter();
  const handlers = new Map();
  ipc.send = () => {};
  ipc.invoke = (channel, ...args) => {
    if (channel === DESKTOP_IPC.invokeCapability) return windows.invoke(args[0]);
    return Promise.resolve().then(() => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`the window ${name} invoked ${channel}, which main does not handle`);
      return handler({}, ...args);
    });
  };
  registerProtocolWindowIpc({
    connection,
    handle: (channel, handler) => handlers.set(channel, handler),
    send: (channel, value) => ipc.emit(channel, {}, value),
    removeHandler: (channel) => handlers.delete(channel),
  });
  let api;
  runInNewContext(preload, {
    process: { argv: [], env: {} },
    window: { addEventListener() {} },
    require: (specifier) => {
      if (specifier !== 'electron') throw new Error(`the preload required ${specifier}`);
      return { ipcRenderer: ipc, contextBridge: { exposeInMainWorld: (_name, value) => (api = value) }, sharedTexture: { setSharedTextureReceiver() {} }, webUtils: {} };
    },
  });
  return api;
};
const open = async ({ session, checkpoint, window }) => {
  if (!appWindows.has(window)) appWindows.set(window, attachWindow(window));
  await windows.open({ session, checkpoint, api: appWindows.get(window) });
};

/** One frame of a tell: sent over the socket, folded by the client, relayed by main, and rendered by every pane that listens. */
const deliverFrame = async (frame) => {
  const folded = new Promise((resolve) => {
    const stop = connection.watchSection('reviewDiff', () => (stop(), resolve()));
  });
  socket.serverSend(frame);
  await within(`the client folding ${frame.method} (seq ${frame.feed.seq})`, folded);
  await flushRelay();
};

const traces = [];
for (const [index, op] of input.ops.entries()) {
  const rust = input.rust[index];
  unanswered = [...input.recorded[index].requests];
  windows.startOperation();
  if (op.op === 'client') await open(op);
  await flushRelay();
  let delivered = 0;
  const deliverUpTo = async (count) => {
    while (delivered < count) {
      windows.deliveries += 1;
      for (const frame of rust.deliveries[delivered++]) await deliverFrame(frame);
    }
  };
  await deliverUpTo(rust.before);
  await windows.settle(async (answered) => deliverUpTo(rust.afterAnswer[answered - 1] ?? delivered));
  // Deliveries the windows' answers did not wait for (a window that asked less than the recording): they still reach the windows.
  await deliverUpTo(rust.deliveries.length);
  await windows.settle();
  traces.push({ op: index, ...windows.trace() });
}
await windows.close();
await connection.close();
// The client library's liveness ticker would keep the process open; the trace is written, so leave once it is flushed.
process.stdout.write(JSON.stringify(traces), () => process.exit(0));
